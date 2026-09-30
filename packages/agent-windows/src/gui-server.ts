import http from 'http';
import url from 'url';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { configManager, DeviceConfig, ConfigManager } from './config-manager';
import {
  accountManager,
  WindowsAccountManager,
  WindowsAccount,
  WindowsProfileMapping,
} from './account-manager';
import { sessionMonitor } from './session-monitor';
import { evaluateSystemStatus } from './agent-cli';
import { logServiceMessage } from './network-manager';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export class GuiServer {
  private server: http.Server | null = null;
  private port: number = 8885;
  private configMgr: ConfigManager;
  private accountMgr: WindowsAccountManager;

  constructor(customConfigMgr?: ConfigManager, customAccountMgr?: WindowsAccountManager) {
    this.configMgr = customConfigMgr || configManager;
    this.accountMgr = customAccountMgr || accountManager;
  }

  public async start(port: number = 8885): Promise<number> {
    this.port = port;

    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const parsed = url.parse(req.url || '', true);
        const pathname = parsed.pathname || '/';

        // Enable CORS for loopback
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-device-id, x-device-token');

        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }

        // API Routes
        if (pathname === '/api/status' && req.method === 'GET') {
          try {
            const config = await this.configMgr.loadSanitizedConfig();
            const mappings = await this.accountMgr.loadProfileMappings();
            const activeSession = await this.accountMgr.getActiveConsoleSession();
            const activePolicy = await this.accountMgr.resolveUserPolicy(activeSession.sid, activeSession.username);
            let systemStatus: any = null;
            try {
              systemStatus = await evaluateSystemStatus();
            } catch {}

            const hasMultipleSessions = sessionMonitor.hasMultipleSessions();
            const sessionWarning = sessionMonitor.getSessionWarning();
            const multiSessionState = sessionMonitor.getMultiSessionState();
            const protectionState = hasMultipleSessions
              ? 'ATTENTION_REQUIRED'
              : activePolicy.isManaged
              ? 'PROTECTED'
              : 'PARENT_BYPASS';

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                isPaired: Boolean(config),
                config: config
                  ? {
                      deviceId: config.deviceId,
                      deviceName: config.deviceName,
                      childId: config.childId,
                      pairedAt: config.pairedAt,
                    }
                  : null,
                activeSession: {
                  username: activeSession.username,
                  isManaged: activePolicy.isManaged,
                  childId: activePolicy.childId,
                  childName: activePolicy.childName,
                },
                hasMultipleSessions,
                sessionWarning,
                activeUsers: multiSessionState.activeUsers,
                protectionState,
                mappings,
                systemStatus,
              })
            );
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
          }
          return;
        }

        if (pathname === '/api/accounts' && req.method === 'GET') {
          try {
            const accounts = await this.accountMgr.discoverAccounts();
            const activeSession = await this.accountMgr.getActiveConsoleSession();
            const marked = accounts.map((acc: WindowsAccount) => ({
              ...acc,
              isCurrentConsoleUser:
                (activeSession.sid && acc.sid === activeSession.sid) ||
                (activeSession.username && acc.name.toLowerCase() === activeSession.username.toLowerCase()),
            }));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ accounts: marked }));
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
          }
          return;
        }

        if (pathname === '/api/family-profiles' && req.method === 'GET') {
          try {
            const sanitized = await this.configMgr.loadSanitizedConfig();
            if (!sanitized) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Device is not yet paired.' }));
              return;
            }

            let profileRes: any = null;
            // 1. If elevated or credentials accessible, attempt live cloud fetch
            try {
              const fullConfig = await this.configMgr.loadDeviceConfig();
              if (fullConfig && fullConfig.deviceToken) {
                profileRes = await this.accountMgr.fetchFamilyProfilesWithResilience(
                  fullConfig.backendUrl,
                  fullConfig.deviceId,
                  fullConfig.deviceToken
                );
              }
            } catch (cloudErr: any) {
              console.warn(`[SafeBrowse GUI] Cloud profile fetch note: ${cloudErr.message}`);
            }

            // 2. If cloud fetch unavailable or caller is unelevated, fallback seamlessly to local cache
            if (!profileRes) {
              const cached = await this.accountMgr.getCachedFamilyProfiles();
              if (cached && Array.isArray(cached.profiles) && cached.profiles.length > 0) {
                profileRes = {
                  profiles: cached.profiles,
                  fromCache: true,
                  cachedAt: cached.cachedAt,
                };
              }
            }

            if (profileRes) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  profiles: profileRes.profiles,
                  fromCache: Boolean(profileRes.fromCache),
                  cachedAt: profileRes.cachedAt,
                })
              );
              return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                profiles: [],
                fromCache: true,
                error: 'No family profiles cached yet.',
              })
            );
          } catch (e: any) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: e.message || 'Unable to load family profiles. Check SafeBrowse connection and retry.',
                profiles: [],
              })
            );
          }
          return;
        }

        if (pathname === '/api/pair' && req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', async () => {
            try {
              const data = JSON.parse(body);
              const code = (data.code || '').trim();
              const deviceName = (data.deviceName || 'Family Laptop').trim();
              const backendUrl = data.backendUrl || ConfigManager.DEFAULT_PILOT_URL;

              if (!code) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Pairing code is required.' }));
                return;
              }

              const claimRes = await fetch(`${backendUrl}/api/devices/claim`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  code,
                  deviceName,
                  platform: 'windows',
                  agentVersion: '1.0.0',
                }),
              });

              if (!claimRes.ok) {
                const errData: any = await claimRes.json().catch(() => ({ error: 'Invalid pairing code' }));
                res.writeHead(claimRes.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: errData.error || 'Server rejected pairing code' }));
                return;
              }

              const claimData: any = await claimRes.json();
              const dev = claimData.device;
              if (!dev || !dev.id || !dev.deviceToken) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Incomplete device credentials received from server.' }));
                return;
              }

              const newConfig: DeviceConfig = {
                deviceId: dev.id,
                deviceToken: dev.deviceToken,
                childId: dev.childId,
                parentId: dev.parentId,
                deviceName: dev.name || deviceName,
                backendUrl,
                pairedAt: new Date().toISOString(),
              };

              await this.configMgr.saveDeviceConfig(newConfig);

              // Signal SafeBrowse service to start or reload if on Windows
              if (process.platform === 'win32') {
                try {
                  await execAsync('sc.exe start SafeBrowseChildService');
                } catch {}
              }

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  success: true,
                  device: {
                    deviceId: dev.id,
                    deviceName: dev.name,
                    childId: dev.childId,
                  },
                  familyProfiles: claimData.familyProfiles || [],
                })
              );
            } catch (e: any) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: e.message }));
            }
          });
          return;
        }

        if (pathname === '/api/mappings' && req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', async () => {
            try {
              const data = JSON.parse(body);
              const mappings: WindowsProfileMapping[] = Array.isArray(data.mappings) ? data.mappings : [];
              const config = await this.configMgr.loadSanitizedConfig();
              const deviceId = config?.deviceId || 'dev-local';
              const deviceName = config?.deviceName || 'Family Laptop';

              const isAdmin = await this.configMgr.isAdministrator();

              if (isAdmin || process.platform !== 'win32') {
                await this.accountMgr.saveProfileMappingsTransaction(
                  mappings,
                  deviceId,
                  deviceName,
                  { isElevated: true }
                );
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
                return;
              }

              // Unelevated execution on Windows: stage request and invoke elevated helper via UAC
              const { nonce, reqPath } = await this.accountMgr.createMappingSaveRequest(
                mappings,
                deviceId,
                deviceName
              );

              const psPath = this.configMgr.getPowerShellPath();
              const exePath = process.argv[0];
              const isNode = exePath.toLowerCase().endsWith('node.exe') || exePath.toLowerCase().endsWith('node');

              const psCmd = isNode
                ? `Start-Process -FilePath "${exePath}" -ArgumentList "${process.argv[1]} --apply-mappings-req ${nonce}" -Verb RunAs -Wait -PassThru`
                : `Start-Process -FilePath "${exePath}" -ArgumentList "--apply-mappings-req ${nonce}" -Verb RunAs -Wait -PassThru`;

              try {
                await execFileAsync(psPath, [
                  '-NoLogo',
                  '-NoProfile',
                  '-NonInteractive',
                  '-ExecutionPolicy',
                  'Bypass',
                  '-Command',
                  psCmd,
                ]);

                // Verify file was persisted
                const reloaded = await this.accountMgr.loadProfileMappings();
                if (reloaded.length === mappings.length) {
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ success: true }));
                  return;
                }

                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    error: 'Administrator approval is required to change account protection.',
                  })
                );
              } catch (uacErr: any) {
                try { if (fs.existsSync(reqPath)) fs.unlinkSync(reqPath); } catch {}
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    error: 'Administrator approval is required to change account protection.',
                  })
                );
              }
            } catch (e: any) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: e.message }));
            }
          });
          return;
        }

        // Serve Application HTML/UI
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.renderHtml());
      });

      this.server.listen(port, '127.0.0.1', () => {
        const addr = this.server?.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        this.port = actualPort;
        logServiceMessage('INFO', `[SafeBrowse GUI] Application server running on http://127.0.0.1:${actualPort}`);
        resolve(actualPort);
      });

      this.server.on('error', (err: any) => {
        reject(err);
      });
    });
  }

  public async launchWindow(): Promise<void> {
    const url = `http://127.0.0.1:${this.port}`;

    if (process.platform === 'win32') {
      try {
        // Attempt to launch Microsoft Edge in standalone desktop application mode
        const cmd = `start msedge.exe --app="${url}" --window-size=880,720 --user-data-dir="%LOCALAPPDATA%\\SafeBrowse\\gui-edge-profile"`;
        await execAsync(cmd);
        return;
      } catch (e) {
        // Fallback to standard Windows shell execution
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
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private renderHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SafeBrowse Family Protection</title>
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
      padding: 32px 20px;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .container {
      max-width: 720px;
      width: 100%;
      background: var(--card-bg);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 28px;
      padding: 40px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(20px);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 28px;
    }
    .brand-icon {
      width: 48px;
      height: 48px;
      background: linear-gradient(135deg, #2563eb, #1e40af);
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      box-shadow: 0 10px 20px -5px rgba(37, 99, 235, 0.5);
    }
    h1 { font-size: 26px; font-weight: 800; margin: 0; letter-spacing: -0.5px; }
    .subtitle { color: var(--text-muted); font-size: 14px; margin-top: 4px; }
    .screen { display: none; }
    .screen.active { display: block; animation: fadeIn 0.25s ease-out; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

    /* Button styles */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 14px 28px;
      font-size: 15px;
      font-weight: 700;
      border-radius: 14px;
      border: none;
      cursor: pointer;
      transition: all 0.2s ease;
      text-decoration: none;
    }
    .btn-primary {
      background: linear-gradient(135deg, var(--accent), var(--accent-hover));
      color: white;
      box-shadow: 0 10px 20px -5px rgba(37, 99, 235, 0.4);
    }
    .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 15px 25px -5px rgba(37, 99, 235, 0.5); }
    .btn-secondary {
      background: #1e293b;
      color: var(--text);
      border: 1px solid #334155;
    }
    .btn-secondary:hover { background: #334155; }
    .button-row { display: flex; gap: 12px; margin-top: 28px; }

    /* Inputs */
    .input-group { margin-bottom: 20px; text-align: left; }
    label { display: block; font-size: 13px; font-weight: 700; color: #cbd5e1; margin-bottom: 8px; }
    input[type="text"], select {
      width: 100%;
      padding: 14px 18px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 14px;
      color: white;
      font-size: 14px;
      font-family: inherit;
      outline: none;
      transition: border-color 0.2s;
    }
    input[type="text"]:focus, select:focus { border-color: var(--accent); }

    /* Table styles for Shared Laptop */
    .account-table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0 10px;
      margin: 20px 0;
    }
    .account-row {
      background: #0f172a;
      border-radius: 14px;
      transition: all 0.2s;
    }
    .account-row td {
      padding: 16px;
      border-top: 1px solid #1e293b;
      border-bottom: 1px solid #1e293b;
    }
    .account-row td:first-child { border-left: 1px solid #1e293b; border-top-left-radius: 14px; border-bottom-left-radius: 14px; }
    .account-row td:last-child { border-right: 1px solid #1e293b; border-top-right-radius: 14px; border-bottom-right-radius: 14px; }
    .user-pill { font-weight: 800; font-size: 15px; color: #ffffff; display: flex; align-items: center; gap: 8px; }
    .badge-current { font-size: 10px; font-weight: 800; background: #0369a1; color: #bae6fd; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; }
    .sid-text { font-size: 11px; color: #64748b; font-family: monospace; }

    /* Status cards */
    .status-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
      margin: 24px 0;
    }
    .status-card {
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 16px;
      padding: 18px;
      text-align: left;
    }
    .status-label { font-size: 12px; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
    .status-val { font-size: 16px; font-weight: 800; margin-top: 6px; }
    .status-sub { font-size: 12px; color: #64748b; margin-top: 4px; }

    .tag-protected { color: var(--success); }
    .tag-bypass { color: var(--warning); }
    .tag-danger { color: var(--danger); }

    .alert {
      padding: 14px 18px;
      border-radius: 14px;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 20px;
      display: none;
    }
    .alert-error { background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #fca5a5; }
    .alert-success { background: rgba(34, 197, 94, 0.15); border: 1px solid rgba(34, 197, 94, 0.3); color: #86efac; }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand">
      <div class="brand-icon">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          <path d="M9 12l2 2 4-4"/>
        </svg>
      </div>
      <div>
        <h1>SafeBrowse Family Protection</h1>
        <div class="subtitle">Shared Laptop Parental Control & Protection Setup</div>
      </div>
    </div>

    <div id="alertBox" class="alert"></div>

    <!-- SCREEN 1: WELCOME -->
    <div id="screenWelcome" class="screen active">
      <h2 style="font-size: 22px; font-weight: 800; margin: 0 0 12px 0;">Protect children using this Windows computer</h2>
      <p style="color: var(--text-muted); font-size: 15px; line-height: 1.6; margin-bottom: 28px;">
        SafeBrowse protects children on shared laptops without affecting parents or unmanaged accounts.
        Easily select which Windows accounts belong to children, and apply individualized web safety policies.
      </p>

      <div style="background: rgba(37, 99, 235, 0.1); border: 1px solid rgba(37, 99, 235, 0.25); border-radius: 16px; padding: 20px; margin-bottom: 28px; text-align: left;">
        <div style="font-size: 14px; font-weight: 800; color: #93c5fd; margin-bottom: 8px;">Key Capabilities:</div>
        <ul style="margin: 0; padding-left: 20px; color: #cbd5e1; font-size: 13px; line-height: 1.6;">
          <li><strong>Shared Laptop Support:</strong> Distinct child policies for each account (e.g. Manjari vs Rahul).</li>
          <li><strong>Parent Freedom:</strong> Parent accounts (e.g. acer) enjoy zero filtering with transparent bypass.</li>
          <li><strong>Fast User Switching:</strong> Instant policy transitions and automatic DNS cache flushing.</li>
        </ul>
      </div>

      <div class="button-row">
        <button class="btn btn-primary" onclick="handleGetStarted()">Get Started</button>
        <button class="btn btn-secondary" onclick="checkStatusAndNavigate()">View Protection Status</button>
      </div>
    </div>

    <!-- SCREEN 2: PAIR FAMILY -->
    <div id="screenPair" class="screen">
      <h2 style="font-size: 22px; font-weight: 800; margin: 0 0 8px 0;">Connect to your Family</h2>
      <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 24px;">
        Obtain a pairing code from the SafeBrowse Parent Portal (<a href="https://safebrowse.porwal.online" target="_blank" style="color: #60a5fa;">safebrowse.porwal.online</a>) under <strong>Add Device</strong>.
      </p>

      <div class="input-group">
        <label for="pairingCode">Pairing Code</label>
        <input type="text" id="pairingCode" placeholder="SB-XXXX-XXXX" style="letter-spacing: 2px; font-weight: 700; text-transform: uppercase;">
      </div>

      <div class="input-group">
        <label for="deviceName">Computer Name</label>
        <input type="text" id="deviceName" value="Family Laptop">
      </div>

      <div class="button-row">
        <button class="btn btn-primary" id="btnPair" onclick="submitPairing()">Connect to Family</button>
        <button class="btn btn-secondary" onclick="showScreen('screenWelcome')">Back</button>
      </div>
    </div>

    <!-- SCREEN 3: SHARED LAPTOP ACCOUNTS -->
    <div id="screenAccounts" class="screen">
      <h2 style="font-size: 22px; font-weight: 800; margin: 0 0 8px 0;">Who uses this computer?</h2>
      <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 20px;">
        SafeBrowse detected these Windows accounts. Choose which profile to apply to each account. Parent accounts can remain unmanaged with zero restrictions.
      </p>

      <div id="profilesBanner" style="display:none; margin-bottom: 16px; padding: 12px 16px; border-radius: 12px; font-size: 13px;"></div>
      <div id="accountsLoading" style="display:none; text-align: center; padding: 30px; color: var(--text-muted); font-size: 14px;">Loading family profiles...</div>

      <table class="account-table">
        <thead>
          <tr style="color: var(--text-muted); font-size: 12px; font-weight: 700; text-transform: uppercase; text-align: left;">
            <th style="padding: 10px 16px;">Windows Account</th>
            <th style="padding: 10px 16px;">Protect As (Child Profile)</th>
            <th style="padding: 10px 16px;">Protection</th>
          </tr>
        </thead>
        <tbody id="accountsBody">
          <!-- Populated dynamically -->
        </tbody>
      </table>

      <div class="button-row">
        <button class="btn btn-primary" id="btnSaveMappings" onclick="saveMappings()">Save Settings & Protect Laptop</button>
        <button class="btn btn-secondary" onclick="showScreen('screenStatus')">Skip to Status</button>
        <button class="btn btn-secondary" id="btnRetryProfiles" onclick="loadAccountsScreen()" style="display:none;">Retry</button>
      </div>
    </div>

    <!-- SCREEN 4: PROTECTION STATUS -->
    <div id="screenStatus" class="screen">
      <h2 style="font-size: 22px; font-weight: 800; margin: 0 0 8px 0;">Protection Status</h2>
      <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 24px;">
        Active protection telemetry and live console session state.
      </p>

      <div id="multiSessionBanner" style="display:none; background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.4); border-radius: 16px; padding: 18px; margin-bottom: 24px; text-align: left;">
        <div style="display: flex; align-items: flex-start; gap: 12px;">
          <span style="font-size: 20px;">⚠️</span>
          <div>
            <div style="font-weight: 800; color: #fde68a; font-size: 14px; margin-bottom: 4px;">Protection State: Attention Required</div>
            <div style="color: #cbd5e1; font-size: 13px; line-height: 1.5;" id="multiSessionText">
              Multiple Windows users are currently signed in. For reliable SafeBrowse protection on this Pilot version, sign out other Windows users before switching accounts.
            </div>
          </div>
        </div>
      </div>

      <div class="status-grid">
        <div class="status-card">
          <div class="status-label">Active Windows User</div>
          <div class="status-val" id="statUser">Loading...</div>
          <div class="status-sub" id="statUserSid"></div>
        </div>

        <div class="status-card">
          <div class="status-label">Current Mode</div>
          <div class="status-val" id="statMode">Checking...</div>
          <div class="status-sub" id="statModeSub"></div>
        </div>

        <div class="status-card">
          <div class="status-label">Device Registration</div>
          <div class="status-val" id="statDevice">Family Laptop</div>
          <div class="status-sub" id="statDeviceId"></div>
        </div>

        <div class="status-card">
          <div class="status-label">Service & DNS Resolver</div>
          <div class="status-val" id="statDns">127.0.0.1:53</div>
          <div class="status-sub" id="statService">SafeBrowseChildService</div>
        </div>
      </div>

      <div class="button-row">
        <button class="btn btn-primary" onclick="showScreen('screenAccounts')">Reconfigure Accounts</button>
        <button class="btn btn-secondary" onclick="loadStatusScreen()">Refresh Status</button>
      </div>
    </div>
  </div>

  <script>
    let appState = {
      isPaired: false,
      config: null,
      accounts: [],
      familyProfiles: [],
      mappings: []
    };

    function showAlert(msg, isError = false) {
      const b = document.getElementById('alertBox');
      b.className = 'alert ' + (isError ? 'alert-error' : 'alert-success');
      b.innerText = msg;
      b.style.display = 'block';
      setTimeout(() => { b.style.display = 'none'; }, 6000);
    }

    function showScreen(id) {
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      document.getElementById(id).classList.add('active');
      if (id === 'screenStatus') loadStatusScreen();
      if (id === 'screenAccounts') loadAccountsScreen();
    }

    async function handleGetStarted() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        if (data.isPaired) {
          showScreen('screenAccounts');
        } else {
          showScreen('screenPair');
        }
      } catch (e) {
        showScreen('screenPair');
      }
    }

    async function checkStatusAndNavigate() {
      showScreen('screenStatus');
    }

    async function submitPairing() {
      const code = document.getElementById('pairingCode').value.trim();
      const deviceName = document.getElementById('deviceName').value.trim();
      const btn = document.getElementById('btnPair');

      if (!code) {
        showAlert('Please enter a valid pairing code.', true);
        return;
      }

      btn.disabled = true;
      btn.innerText = 'Connecting...';

      try {
        const res = await fetch('/api/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, deviceName })
        });
        const data = await res.json();

        if (res.ok && data.success) {
          appState.isPaired = true;
          appState.config = data.device;
          appState.familyProfiles = data.familyProfiles || [];
          showAlert('Device paired successfully with family!');
          setTimeout(() => showScreen('screenAccounts'), 1000);
        } else {
          showAlert(data.error || 'Pairing failed. Check pairing code.', true);
        }
      } catch (e) {
        showAlert('Network error communicating with server: ' + e.message, true);
      } finally {
        btn.disabled = false;
        btn.innerText = 'Connect to Family';
      }
    }

    async function loadAccountsScreen() {
      const banner = document.getElementById('profilesBanner');
      const loading = document.getElementById('accountsLoading');
      const table = document.querySelector('.account-table');
      const saveBtn = document.getElementById('btnSaveMappings');
      const retryBtn = document.getElementById('btnRetryProfiles');

      if (banner) banner.style.display = 'none';
      if (retryBtn) retryBtn.style.display = 'none';
      if (loading) loading.style.display = 'block';
      if (table) table.style.display = 'none';
      if (saveBtn) saveBtn.disabled = true;

      try {
        const [accRes, profRes, statRes] = await Promise.all([
          fetch('/api/accounts').then(r => r.json()).catch(() => ({ accounts: [] })),
          fetch('/api/family-profiles').then(r => r.json()).catch(err => ({ error: err.message, profiles: [] })),
          fetch('/api/status').then(r => r.json()).catch(() => ({}))
        ]);

        appState.accounts = accRes.accounts || [];
        appState.mappings = statRes.mappings || [];

        if (profRes.error && (!profRes.profiles || profRes.profiles.length === 0)) {
          // Cloud fetch failed and no cache available
          appState.familyProfiles = [];
          if (banner) {
            banner.style.display = 'flex';
            banner.style.alignItems = 'center';
            banner.style.justifyContent = 'space-between';
            banner.style.background = 'rgba(239, 68, 68, 0.15)';
            banner.style.border = '1px solid rgba(239, 68, 68, 0.3)';
            banner.style.color = '#fca5a5';
            banner.innerHTML = '<span>⚠️ Unable to load family profiles. Check SafeBrowse connection and retry.</span>';
          }
          if (retryBtn) retryBtn.style.display = 'inline-block';
        } else {
          appState.familyProfiles = profRes.profiles || [];
          if (profRes.fromCache && banner) {
            banner.style.display = 'block';
            banner.style.background = 'rgba(59, 130, 246, 0.15)';
            banner.style.border = '1px solid rgba(59, 130, 246, 0.3)';
            banner.style.color = '#93c5fd';
            banner.innerText = 'ℹ Using previously synchronized family profiles.';
          }
        }

        renderAccountsTable();
      } catch (e) {
        showAlert('Failed to load accounts: ' + e.message, true);
      } finally {
        if (loading) loading.style.display = 'none';
        if (table) table.style.display = 'table';
        if (saveBtn) saveBtn.disabled = false;
      }
    }

    function renderAccountsTable() {
      const tbody = document.getElementById('accountsBody');
      tbody.innerHTML = '';

      if (appState.accounts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:20px; color:#64748b;">No interactive accounts detected.</td></tr>';
        return;
      }

      appState.accounts.forEach((acc, idx) => {
        const existing = appState.mappings.find(m => m.windowsSid === acc.sid || m.windowsUsername.toLowerCase() === acc.name.toLowerCase());
        const selectedChildId = existing && existing.enabled ? existing.childId : '';

        const tr = document.createElement('tr');
        tr.className = 'account-row';

        let optionsHtml = '<option value="">Parent / Unmanaged (Protection OFF)</option>';
        appState.familyProfiles.forEach(p => {
          const isSelected = selectedChildId === p.id ? 'selected' : '';
          optionsHtml += '<option value="' + p.id + '" ' + isSelected + '>' + p.name + ' (Child Profile)</option>';
        });

        const isProtected = Boolean(selectedChildId);
        const isCurrent = Boolean(acc.isCurrentConsoleUser);

        tr.innerHTML =
          '<td>' +
            '<div class="user-pill">' +
              acc.name +
              (isCurrent ? ' <span class="badge-current">ACTIVE USER</span>' : '') +
            '</div>' +
            '<div class="sid-text" style="color: #64748b; font-size: 11px;">' +
              (isCurrent ? 'Active Console Account' : 'Standard Windows Account') +
            '</div>' +
          '</td>' +
          '<td>' +
            '<select id="sel_' + idx + '" onchange="updateRowProtection(' + idx + ')">' +
              optionsHtml +
            '</select>' +
          '</td>' +
          '<td>' +
            '<span id="tag_' + idx + '" class="' + (isProtected ? 'tag-protected' : 'tag-bypass') + '" style="font-weight:800; font-size:13px;">' +
              (isProtected ? '● PROTECTED' : '○ BYPASSED') +
            '</span>' +
          '</td>';

        tbody.appendChild(tr);
      });
    }

    function updateRowProtection(idx) {
      const sel = document.getElementById('sel_' + idx);
      const tag = document.getElementById('tag_' + idx);
      const isProtected = Boolean(sel.value);
      tag.className = isProtected ? 'tag-protected' : 'tag-bypass';
      tag.innerText = isProtected ? '● PROTECTED' : '○ BYPASSED';
    }

    async function saveMappings() {
      const saveBtn = document.getElementById('btnSaveMappings');
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerText = 'Saving settings...';
      }

      const mappings = [];
      appState.accounts.forEach((acc, idx) => {
        const sel = document.getElementById('sel_' + idx);
        const childId = sel ? (sel.value || null) : null;
        const profile = appState.familyProfiles.find(p => p.id === childId);

        mappings.push({
          windowsSid: acc.sid,
          windowsUsername: acc.name,
          childId: childId,
          childName: profile ? profile.name : null,
          enabled: Boolean(childId)
        });
      });

      try {
        const res = await fetch('/api/mappings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mappings })
        });
        const data = await res.json().catch(() => ({}));

        if (res.ok && data.success) {
          showAlert('Shared laptop settings saved successfully!');
          setTimeout(() => showScreen('screenStatus'), 800);
        } else if (res.status === 403) {
          showAlert(data.error || 'Administrator approval is required to change account protection.', true);
        } else {
          showAlert(data.error || 'Failed to save settings.', true);
        }
      } catch (e) {
        showAlert('Network error: ' + e.message, true);
      } finally {
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.innerText = 'Save Settings & Protect Laptop';
        }
      }
    }

    async function loadStatusScreen() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();

        document.getElementById('statUser').innerText = data.activeSession.username || 'System Console';
        document.getElementById('statUserSid').innerText = data.activeSession.isManaged ? 'Child account' : 'Parent / unmanaged account';

        if (data.hasMultipleSessions) {
          document.getElementById('multiSessionBanner').style.display = 'block';
          if (data.sessionWarning) {
            document.getElementById('multiSessionText').innerText = data.sessionWarning;
          }
          document.getElementById('statMode').innerHTML = '<span class="tag-warning" style="color: #f59e0b; font-weight: 800;">⚠️ Attention Required</span>';
          document.getElementById('statModeSub').innerText = 'Multiple Windows users signed in';
        } else {
          document.getElementById('multiSessionBanner').style.display = 'none';
          if (data.activeSession.isManaged) {
            document.getElementById('statMode').innerHTML = '<span class="tag-protected">● Child Protected</span>';
            document.getElementById('statModeSub').innerText = 'Profile: ' + (data.activeSession.childName || 'Active Child');
          } else {
            document.getElementById('statMode').innerHTML = '<span class="tag-bypass">○ Parent Bypass</span>';
            document.getElementById('statModeSub').innerText = 'Unmanaged (Child rules bypassed)';
          }
        }

        document.getElementById('statDevice').innerText = data.config ? data.config.deviceName : 'Family Laptop';
        document.getElementById('statDeviceId').innerText = data.isPaired ? 'Registered with family' : 'Run pairing setup';

        const sys = data.systemStatus;
        if (sys) {
          document.getElementById('statDns').innerText = sys.dnsEnforced ? '127.0.0.1 (Enforced)' : 'Inactive';
          document.getElementById('statService').innerText = sys.serviceState || 'SafeBrowseChildService';
        }
      } catch (e) {
        showAlert('Failed to refresh status: ' + e.message, true);
      }
    }

    // Auto-load initial state
    window.addEventListener('DOMContentLoaded', () => {
      fetch('/api/status')
        .then(r => r.json())
        .then(data => {
          if (data.isPaired) {
            showScreen('screenStatus');
          } else {
            showScreen('screenWelcome');
          }
        })
        .catch(() => showScreen('screenWelcome'));
    });
  </script>
</body>
</html>`;
  }
}

export const guiServer = new GuiServer();
