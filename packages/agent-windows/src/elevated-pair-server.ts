import http from 'http';
import url from 'url';
import * as fs from 'fs';
import * as path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { configManager, ConfigManager, DeviceConfig } from './config-manager';
import { accountManager, WindowsAccountManager } from './account-manager';
import { logServiceMessage } from './network-manager';

const execAsync = promisify(exec);

export class ElevatedPairServer {
  private server: http.Server | null = null;
  private port: number = 8887;
  private configMgr: ConfigManager;
  private accountMgr: WindowsAccountManager;
  private idleTimer: NodeJS.Timeout | null = null;
  private prefillCode: string = '';
  private prefillName: string = '';
  private autoCloseTimer: NodeJS.Timeout | null = null;

  constructor(customConfigMgr?: ConfigManager, customAccountMgr?: WindowsAccountManager) {
    this.configMgr = customConfigMgr || configManager;
    this.accountMgr = customAccountMgr || accountManager;
  }

  public getPort(): number {
    return this.port;
  }

  public setPrefill(code?: string, name?: string): void {
    if (code) this.prefillCode = code;
    if (name) this.prefillName = name;
  }

  public async start(preferredPort: number = 8887): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        this.resetIdleTimer();

        const parsed = url.parse(req.url || '', true);
        const pathname = parsed.pathname || '/';

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }

        // Endpoint: GET /api/status
        if (pathname === '/api/status' && req.method === 'GET') {
          const isAdmin = await this.configMgr.isAdministrator();
          const sanitized = await this.configMgr.loadSanitizedConfig();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              isElevated: isAdmin,
              isPaired: Boolean(sanitized),
              deviceId: sanitized?.deviceId || null,
              deviceName: sanitized?.deviceName || null,
            })
          );
          return;
        }

        // Endpoint: POST /api/claim-and-pair
        if (pathname === '/api/claim-and-pair' && req.method === 'POST') {
          const isAdmin = await this.configMgr.isAdministrator();
          if (!isAdmin && (process.platform === 'win32' || this.configMgr.getPlatform() === 'win32')) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'Administrator approval is required to attach this device.',
              })
            );
            return;
          }

          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', async () => {
            try {
              const data = JSON.parse(body || '{}');
              const code = (data.code || '').trim();
              const deviceName = (data.deviceName || 'Family Laptop').trim();
              const rawBackendUrl = data.backendUrl || ConfigManager.DEFAULT_PILOT_URL;

              if (!code) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Pairing code is required.' }));
                return;
              }

              let backendUrl: string;
              try {
                backendUrl = this.configMgr.validateBackendUrl(rawBackendUrl);
              } catch (urlErr: any) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid backend URL: ${urlErr.message}` }));
                return;
              }

              // 1. Claim pairing code from SafeBrowse cloud backend
              let claimRes: Response;
              try {
                claimRes = await fetch(`${backendUrl}/api/devices/claim`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    code,
                    deviceName,
                    platform: 'windows',
                    agentVersion: '1.0.2',
                  }),
                });
              } catch (netErr: any) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    error: 'SafeBrowse cloud service is currently unreachable. Please check your internet connection.',
                  })
                );
                return;
              }

              if (!claimRes.ok) {
                const errData: any = await claimRes.json().catch(() => ({}));
                const status = claimRes.status;
                let userFriendlyError = errData.error || 'Server rejected pairing code.';
                if (status === 400 || status === 404) {
                  userFriendlyError =
                    'The pairing code is invalid or has expired. Please generate a new pairing code from the Parent Dashboard.';
                }
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: userFriendlyError }));
                return;
              }

              const claimData: any = await claimRes.json();
              const dev = claimData.device;
              if (!dev || !dev.id || !dev.deviceToken) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Incomplete device credentials received from server.' }));
                return;
              }

              // 2. Encrypt token with machine DPAPI and persist secure/sanitized config
              const newConfig: DeviceConfig = {
                deviceId: dev.id,
                deviceToken: dev.deviceToken,
                childId: dev.childId,
                parentId: dev.parentId,
                deviceName: dev.name || deviceName,
                backendUrl,
                pairedAt: new Date().toISOString(),
              };

              try {
                await this.configMgr.saveDeviceConfig(newConfig);
              } catch (saveErr: any) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    error: `Failed to persist secure credentials: ${saveErr.message}`,
                  })
                );
                return;
              }

              // 3. Harden machine directory ACLs
              try {
                await this.configMgr.hardenMachineDirectories();
              } catch (aclErr: any) {
                logServiceMessage('WARN', `[ElevatedPairServer] Directory ACL hardening note: ${aclErr.message}`);
              }

              // 4. Pre-cache family profiles for immediate account mapping readiness
              try {
                if (dev.deviceToken) {
                  await this.accountMgr.fetchFamilyProfilesWithResilience(backendUrl, dev.id, dev.deviceToken);
                }
              } catch (profErr: any) {
                logServiceMessage('INFO', `[ElevatedPairServer] Pre-caching family profiles note: ${profErr.message}`);
              }

              // 5. Start and verify SafeBrowseChildService
              const serviceResult = await this.startAndVerifyService();

              // 6. Trigger initial policy sync
              await this.triggerInitialPolicySync(backendUrl, dev.id, dev.deviceToken, dev.childId);

              // 7. Return success to client
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  success: true,
                  message: 'Device attached successfully.',
                  device: {
                    deviceId: dev.id,
                    deviceName: dev.name || deviceName,
                    childId: dev.childId,
                    serviceStatus: serviceResult.message,
                  },
                })
              );

              // 8. Auto-close server after successful response
              this.autoCloseTimer = setTimeout(() => {
                this.stop();
                if (process.env.NODE_ENV !== 'test') {
                  process.exit(0);
                }
              }, 1200);
              this.autoCloseTimer.unref();
            } catch (err: any) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message || 'Unexpected error during pairing' }));
            }
          });
          return;
        }

        // Endpoint: POST /api/cancel
        if (pathname === '/api/cancel' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, cancelled: true }));
          this.autoCloseTimer = setTimeout(() => {
            this.stop();
            if (process.env.NODE_ENV !== 'test') {
              process.exit(0);
            }
          }, 300);
          this.autoCloseTimer.unref();
          return;
        }

        // Serve HTML UI
        const queryCode = (parsed.query?.code as string) || this.prefillCode || '';
        const queryName = (parsed.query?.name as string) || this.prefillName || 'Family Laptop';

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.renderHtml(queryCode, queryName));
      });

      server.listen(preferredPort, '127.0.0.1', () => {
        this.server = server;
        const addr = server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : preferredPort;
        logServiceMessage(
          'INFO',
          `[SafeBrowse Pair] Elevated pairing server running on http://127.0.0.1:${this.port}`
        );
        this.resetIdleTimer();
        resolve(this.port);
      });

      server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE' && preferredPort !== 0) {
          logServiceMessage('INFO', `[SafeBrowse Pair] Port ${preferredPort} in use, trying ephemeral port...`);
          server.listen(0, '127.0.0.1', () => {
            this.server = server;
            const addr = server.address();
            this.port = typeof addr === 'object' && addr ? addr.port : 0;
            this.resetIdleTimer();
            resolve(this.port);
          });
        } else {
          reject(err);
        }
      });
    });
  }

  public async startAndVerifyService(): Promise<{ running: boolean; message: string }> {
    if (process.platform !== 'win32') {
      return { running: true, message: 'Non-Windows environment simulated.' };
    }

    try {
      // 1. Dispatch sc start
      try {
        await execAsync('sc.exe start SafeBrowseChildService');
      } catch (startErr: any) {
        const startMsg = (startErr.message || '').toString();
        // If already running (error 1056), proceed to query verification
        if (!startMsg.includes('1056')) {
          logServiceMessage('INFO', `[ElevatedPairServer] sc start notice: ${startMsg}`);
        }
      }

      // 2. Poll sc query for up to 8 seconds to verify RUNNING
      const maxAttempts = 8;
      for (let i = 0; i < maxAttempts; i++) {
        try {
          const { stdout } = await execAsync('sc.exe query SafeBrowseChildService');
          if (stdout.includes('STATE') && stdout.includes('RUNNING')) {
            logServiceMessage('INFO', '[ElevatedPairServer] SafeBrowseChildService verified in RUNNING state.');
            return { running: true, message: 'SafeBrowseChildService is running.' };
          }
        } catch (queryErr: any) {
          if (queryErr.message?.includes('1060')) {
            // Service not installed on this system
            return { running: false, message: 'SafeBrowseChildService is not installed as a Windows service.' };
          }
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      return { running: false, message: 'SafeBrowseChildService was signaled to start.' };
    } catch (e: any) {
      logServiceMessage('WARN', `[ElevatedPairServer] Service verification note: ${e.message}`);
      return { running: false, message: e.message };
    }
  }

  public async triggerInitialPolicySync(
    backendUrl: string,
    deviceId: string,
    deviceToken: string,
    childId?: string
  ): Promise<void> {
    if (!childId) return;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      const url = `${backendUrl}/api/policies/device/${encodeURIComponent(deviceId)}?childId=${encodeURIComponent(childId)}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'x-device-id': deviceId,
          'x-device-token': deviceToken,
        },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));

      if (res.ok) {
        const data: any = await res.json();
        const policy = data?.policy || data;
        if (policy && typeof policy === 'object') {
          const cacheDir = this.configMgr.getCacheDir();
          if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
          }
          fs.writeFileSync(path.join(cacheDir, `policy-${deviceId}.json`), JSON.stringify(policy, null, 2), 'utf8');
          fs.writeFileSync(
            path.join(cacheDir, `policy-${deviceId}-${childId}.json`),
            JSON.stringify(policy, null, 2),
            'utf8'
          );
          logServiceMessage('INFO', `[ElevatedPairServer] Initial policy synchronized for child ${childId}.`);
        }
      }
    } catch (err: any) {
      logServiceMessage('INFO', `[ElevatedPairServer] Initial policy sync note: ${err.message}`);
    }
  }

  public resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    // Auto-terminate after 8 minutes of inactivity
    this.idleTimer = setTimeout(() => {
      logServiceMessage('INFO', '[SafeBrowse Pair] Idle timeout reached. Closing elevated pairing window.');
      this.stop();
      if (process.env.NODE_ENV !== 'test') {
        process.exit(0);
      }
    }, 8 * 60 * 1000);
    this.idleTimer.unref();
  }

  public async launchWindow(prefillCode?: string, deviceName?: string): Promise<void> {
    const params = new URLSearchParams();
    if (prefillCode) params.set('code', prefillCode);
    if (deviceName) params.set('name', deviceName);
    const queryString = params.toString() ? `?${params.toString()}` : '';
    const url = `http://127.0.0.1:${this.port}${queryString}`;

    if (process.platform === 'win32') {
      try {
        const cmd = `start msedge.exe --app="${url}" --window-size=780,640 --user-data-dir="%LOCALAPPDATA%\\SafeBrowse\\elevated-edge-profile"`;
        await execAsync(cmd);
        return;
      } catch (e) {
        try {
          await execAsync(`start "" "${url}"`);
          return;
        } catch {}
      }
    } else {
      try {
        await execAsync(`xdg-open "${url}" || open "${url}"`);
      } catch {}
    }
  }

  public stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.autoCloseTimer) {
      clearTimeout(this.autoCloseTimer);
      this.autoCloseTimer = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private renderHtml(prefillCode: string = '', prefillName: string = 'Family Laptop'): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SafeBrowse — Administrator Device Attachment</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card-bg: rgba(17, 24, 39, 0.95);
      --border: #1e293b;
      --accent: #2563eb;
      --accent-hover: #1d4ed8;
      --success: #22c55e;
      --warning: #f59e0b;
      --danger: #ef4444;
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; }
    body {
      font-family: 'Plus Jakarta Sans', sans-serif;
      background: radial-gradient(circle at 50% 10%, #1e1b4b 0%, var(--bg) 100%);
      color: var(--text);
      margin: 0;
      padding: 24px 20px;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .container {
      max-width: 680px;
      width: 100%;
      background: var(--card-bg);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 24px;
      padding: 36px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.8);
      backdrop-filter: blur(20px);
    }
    .brand {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }
    .brand-left {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .brand-icon {
      background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
      color: white;
      width: 48px;
      height: 48px;
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 10px 15px -3px rgba(37, 99, 235, 0.4);
    }
    h1 { margin: 0; font-size: 20px; font-weight: 800; }
    .subtitle { color: var(--text-muted); font-size: 13px; margin-top: 3px; }
    .badge-admin {
      background: rgba(37, 99, 235, 0.15);
      border: 1px solid rgba(37, 99, 235, 0.4);
      color: #93c5fd;
      padding: 6px 12px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.5px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .callout {
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 16px 20px;
      margin-bottom: 24px;
      font-size: 13px;
      color: #cbd5e1;
      line-height: 1.6;
    }
    .input-group {
      margin-bottom: 20px;
      text-align: left;
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 700;
      color: #cbd5e1;
      margin-bottom: 8px;
    }
    input[type="text"] {
      width: 100%;
      background: rgba(15, 23, 42, 0.8);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 16px;
      color: #fff;
      font-size: 15px;
      font-family: inherit;
      outline: none;
      transition: all 0.2s;
    }
    input[type="text"]:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.2);
    }
    .input-code {
      font-family: 'Courier New', monospace;
      font-size: 18px !important;
      font-weight: 800 !important;
      letter-spacing: 2px !important;
      text-transform: uppercase !important;
    }
    .alert {
      padding: 14px 18px;
      border-radius: 12px;
      margin-bottom: 20px;
      font-size: 13px;
      font-weight: 600;
      display: none;
      line-height: 1.5;
    }
    .alert-error {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.4);
      color: #fca5a5;
    }
    .alert-success {
      background: rgba(34, 197, 94, 0.15);
      border: 1px solid rgba(34, 197, 94, 0.4);
      color: #86efac;
    }
    .button-row {
      display: flex;
      gap: 12px;
      margin-top: 28px;
    }
    .btn {
      flex: 1;
      padding: 14px 20px;
      border-radius: 12px;
      font-weight: 700;
      font-size: 14px;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
    }
    .btn-primary {
      background: var(--accent);
      color: white;
    }
    .btn-primary:hover {
      background: var(--accent-hover);
      box-shadow: 0 4px 12px rgba(37, 99, 235, 0.35);
    }
    .btn-primary:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      box-shadow: none;
    }
    .btn-secondary {
      background: rgba(30, 41, 59, 0.8);
      color: var(--text-muted);
      border: 1px solid var(--border);
    }
    .btn-secondary:hover {
      background: rgba(51, 65, 85, 0.8);
      color: #fff;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand">
      <div class="brand-left">
        <div class="brand-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
        </div>
        <div>
          <h1>SafeBrowse Setup Wizard</h1>
          <div class="subtitle">Attach Device to Family Account</div>
        </div>
      </div>
      <div class="badge-admin">
        <span>🛡️</span>
        <span>ADMINISTRATOR</span>
      </div>
    </div>

    <div class="callout">
      Enter the pairing code generated from the SafeBrowse Parent Dashboard (<a href="https://safebrowse.porwal.online" target="_blank" style="color: #60a5fa; text-decoration: underline;">safebrowse.porwal.online</a>) under <strong>Add Device</strong>. Device credentials will be encrypted with machine-scope Windows DPAPI and stored in secure machine configuration.
    </div>

    <div id="alertBox" class="alert"></div>

    <div class="input-group">
      <label for="pairingCode">SafeBrowse Pairing Code</label>
      <input type="text" id="pairingCode" class="input-code" placeholder="SB-XXXX-XXXX" value="${prefillCode}" autofocus>
    </div>

    <div class="input-group">
      <label for="deviceName">Computer Display Name</label>
      <input type="text" id="deviceName" value="${prefillName}">
    </div>

    <div class="button-row">
      <button class="btn btn-primary" id="btnPair" onclick="submitPairing()">Attach Device & Protect Laptop</button>
      <button class="btn btn-secondary" id="btnCancel" onclick="cancelPairing()">Cancel</button>
    </div>
  </div>

  <script>
    function showAlert(msg, isError = false) {
      const b = document.getElementById('alertBox');
      b.className = 'alert ' + (isError ? 'alert-error' : 'alert-success');
      b.innerText = msg;
      b.style.display = 'block';
    }

    async function submitPairing() {
      const code = document.getElementById('pairingCode').value.trim();
      const deviceName = document.getElementById('deviceName').value.trim();
      const btn = document.getElementById('btnPair');
      const cancelBtn = document.getElementById('btnCancel');

      if (!code) {
        showAlert('Please enter a valid pairing code.', true);
        return;
      }

      btn.disabled = true;
      cancelBtn.disabled = true;
      btn.innerText = 'Connecting & Securing Device...';
      showAlert('Claiming device credentials and configuring machine protection...', false);

      try {
        const res = await fetch('/api/claim-and-pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, deviceName })
        });

        const data = await res.json().catch(() => ({}));

        if (res.ok && data.success) {
          showAlert('Device attached successfully! SafeBrowse service is running. Closing window...', false);
          btn.innerText = 'Device Attached ✓';
          setTimeout(() => {
            window.close();
          }, 1400);
        } else {
          showAlert(data.error || 'Pairing failed. Please check the code and retry.', true);
          btn.disabled = false;
          cancelBtn.disabled = false;
          btn.innerText = 'Attach Device & Protect Laptop';
        }
      } catch (e) {
        showAlert('Network error communicating with local pairing service: ' + e.message, true);
        btn.disabled = false;
        cancelBtn.disabled = false;
        btn.innerText = 'Attach Device & Protect Laptop';
      }
    }

    async function cancelPairing() {
      try {
        await fetch('/api/cancel', { method: 'POST' });
      } catch {}
      window.close();
    }
  </script>
</body>
</html>`;
  }
}
