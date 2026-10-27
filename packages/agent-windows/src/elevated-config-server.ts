import http from 'http';
import url from 'url';
import * as fs from 'fs';
import * as path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { configManager, ConfigManager, DeviceConfig } from './config-manager';
import {
  accountManager,
  WindowsAccountManager,
  WindowsAccount,
  WindowsProfileMapping,
  FamilyChildProfile,
} from './account-manager';
import { logServiceMessage } from './network-manager';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export class ElevatedConfigServer {
  private server: http.Server | null = null;
  private port: number = 8886;
  private configMgr: ConfigManager;
  private accountMgr: WindowsAccountManager;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(customConfigMgr?: ConfigManager, customAccountMgr?: WindowsAccountManager) {
    this.configMgr = customConfigMgr || configManager;
    this.accountMgr = customAccountMgr || accountManager;
  }

  public getPort(): number {
    return this.port;
  }

  public async start(preferredPort: number = 8886): Promise<number> {
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

        // Endpoint: GET /api/config-state
        if (pathname === '/api/config-state' && req.method === 'GET') {
          try {
            let secureConfig: DeviceConfig | null = null;
            try {
              secureConfig = await this.configMgr.loadDeviceConfig();
            } catch (err: any) {
              console.warn(`[ElevatedConfigServer] Warning loading secure config: ${err.message}`);
            }

            if (!secureConfig || !secureConfig.deviceId) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Device is not yet paired. Complete pairing first.' }));
              return;
            }

            const accounts = await this.accountMgr.discoverAccounts();
            const mappings = await this.accountMgr.loadProfileMappings();
            const activeSession = await this.accountMgr.getActiveConsoleSession();

            const markedAccounts = accounts.map((acc: WindowsAccount) => ({
              ...acc,
              isCurrentConsoleUser:
                (activeSession.sid && acc.sid.toUpperCase() === activeSession.sid.toUpperCase()) ||
                (activeSession.username && acc.name.toLowerCase() === activeSession.username.toLowerCase()),
            }));

            // Live fetch family profiles from cloud using secure credentials
            let familyProfiles: FamilyChildProfile[] = [];
            let fromCache = false;
            let cloudError: string | null = null;

            try {
              if (secureConfig.deviceToken) {
                const profileRes = await this.accountMgr.fetchFamilyProfilesWithResilience(
                  secureConfig.backendUrl,
                  secureConfig.deviceId,
                  secureConfig.deviceToken
                );
                familyProfiles = profileRes.profiles;
                fromCache = Boolean(profileRes.fromCache);
              }
            } catch (fetchErr: any) {
              cloudError = fetchErr.message;
              const cached = await this.accountMgr.getCachedFamilyProfiles();
              if (cached && Array.isArray(cached.profiles)) {
                familyProfiles = cached.profiles;
                fromCache = true;
              }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                deviceId: secureConfig.deviceId,
                deviceName: secureConfig.deviceName,
                backendUrl: secureConfig.backendUrl,
                accounts: markedAccounts,
                mappings,
                familyProfiles,
                fromCache,
                cloudError,
                activeSession: {
                  username: activeSession.username,
                  sid: activeSession.sid,
                },
              })
            );
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
          }
          return;
        }

        // Endpoint: POST /api/save-mappings
        if (pathname === '/api/save-mappings' && req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', async () => {
            try {
              const data = JSON.parse(body);
              const mappings: WindowsProfileMapping[] = Array.isArray(data.mappings) ? data.mappings : [];

              let secureConfig: DeviceConfig | null = null;
              try {
                secureConfig = await this.configMgr.loadDeviceConfig();
              } catch {}

              const deviceId = secureConfig?.deviceId || 'dev-local';
              const deviceName = secureConfig?.deviceName || 'Family Laptop';

              // Discover valid local machine accounts
              const accounts = await this.accountMgr.discoverAccounts();
              const allowedSids = accounts.map((a) => a.sid);

              // Gather valid child IDs from cloud or cache
              let allowedChildIds: string[] | undefined = undefined;
              const cached = await this.accountMgr.getCachedFamilyProfiles();
              if (cached && Array.isArray(cached.profiles)) {
                allowedChildIds = cached.profiles.map((p) => p.id);
              }

              // Persist directly inside this elevated process
              await this.accountMgr.saveProfileMappingsTransaction(mappings, deviceId, deviceName, {
                isElevated: true,
                allowedSids,
                allowedChildIds,
              });

              // Synchronize mappings to SafeBrowse cloud backend
              if (secureConfig?.backendUrl && secureConfig?.deviceId && secureConfig?.deviceToken) {
                try {
                  await this.accountMgr.syncAccountMappingsToCloud(
                    secureConfig.backendUrl,
                    secureConfig.deviceId,
                    secureConfig.deviceToken,
                    mappings
                  );
                } catch (syncErr: any) {
                  logServiceMessage('WARN', `[ElevatedConfigServer] Cloud sync warning: ${syncErr.message}`);
                }
              }

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, count: mappings.length }));

              // Gracefully shut down after sending response
              setTimeout(() => {
                this.stop();
                if (process.env.NODE_ENV !== 'test') {
                  process.exit(0);
                }
              }, 1200);
            } catch (e: any) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: e.message }));
            }
          });
          return;
        }

        // Endpoint: POST /api/cancel
        if (pathname === '/api/cancel' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, cancelled: true }));
          setTimeout(() => {
            this.stop();
            if (process.env.NODE_ENV !== 'test') {
              process.exit(0);
            }
          }, 300);
          return;
        }

        // Serve Elevated Configuration HTML UI
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.renderHtml());
      });

      // Try preferredPort, fallback to ephemeral port 0 if busy
      server.listen(preferredPort, '127.0.0.1', () => {
        this.server = server;
        const addr = server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : preferredPort;
        logServiceMessage('INFO', `[SafeBrowse Config] Elevated configuration server running on http://127.0.0.1:${this.port}`);
        this.resetIdleTimer();
        resolve(this.port);
      });

      server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE' && preferredPort !== 0) {
          logServiceMessage('INFO', `[SafeBrowse Config] Port ${preferredPort} in use, trying ephemeral port...`);
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

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    // Auto-terminate after 8 minutes of inactivity to prevent hanging processes
    this.idleTimer = setTimeout(() => {
      logServiceMessage('INFO', '[SafeBrowse Config] Idle timeout reached. Closing elevated configuration window.');
      this.stop();
      if (process.env.NODE_ENV !== 'test') {
        process.exit(0);
      }
    }, 8 * 60 * 1000);
  }

  public async launchWindow(): Promise<void> {
    const url = `http://127.0.0.1:${this.port}`;
    if (process.platform === 'win32') {
      const edgeCandidates = [
        path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ].filter(Boolean);
      const edgePath = edgeCandidates.find((candidate) => fs.existsSync(candidate));
      const localAppData = process.env.LOCALAPPDATA || process.env.TEMP || 'C:\\Windows\\Temp';
      const userDataDir = path.join(localAppData, 'SafeBrowse', 'elevated-edge-profile');

      if (edgePath) {
        try {
          await execFileAsync(
            edgePath,
            [`--app=${url}`, '--start-maximized', `--user-data-dir=${userDataDir}`],
            { windowsHide: true }
          );
          return;
        } catch {}
      }

      try {
        await execFileAsync(
          'rundll32.exe',
          ['url.dll,FileProtocolHandler', url],
          { windowsHide: true }
        );
        return;
      } catch {}
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
  <title>SafeBrowse — Administrator Account Configuration</title>
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
      padding: 24px;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: flex-start;
    }
    .container {
      max-width: 1180px;
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
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 800;
      background: rgba(34, 197, 94, 0.15);
      border: 1px solid rgba(34, 197, 94, 0.3);
      color: #86efac;
      padding: 6px 12px;
      border-radius: 20px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

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
    .alert-info { background: rgba(59, 130, 246, 0.15); border: 1px solid rgba(59, 130, 246, 0.3); color: #93c5fd; }

    .sync-status {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 20px;
    }

    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0 10px;
      margin: 16px 0 28px 0;
    }
    tr {
      background: #0f172a;
      border-radius: 14px;
    }
    td {
      padding: 14px 16px;
      border-top: 1px solid #1e293b;
      border-bottom: 1px solid #1e293b;
    }
    td:first-child { border-left: 1px solid #1e293b; border-top-left-radius: 14px; border-bottom-left-radius: 14px; }
    td:last-child { border-right: 1px solid #1e293b; border-top-right-radius: 14px; border-bottom-right-radius: 14px; }

    .user-pill { font-weight: 800; font-size: 15px; color: #ffffff; display: flex; align-items: center; gap: 8px; }
    .badge-current { font-size: 10px; font-weight: 800; background: #0369a1; color: #bae6fd; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; }
    .desc-text { font-size: 11px; color: #64748b; margin-top: 3px; }

    select {
      width: 100%;
      padding: 12px 16px;
      background: #090d16;
      border: 1px solid #334155;
      border-radius: 12px;
      color: white;
      font-size: 13px;
      font-family: inherit;
      outline: none;
      transition: border-color 0.2s;
    }
    select:focus { border-color: var(--accent); }

    .tag-protected { color: var(--success); font-weight: 800; font-size: 13px; }
    .tag-bypass { color: var(--warning); font-weight: 800; font-size: 13px; }
    .busy-panel {
      min-height: 360px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      gap: 14px;
      color: var(--text-muted);
    }
    .spinner {
      width: 46px;
      height: 46px;
      border: 4px solid rgba(148, 163, 184, 0.22);
      border-top-color: #60a5fa;
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }
    .busy-title { color: var(--text); font-size: 18px; font-weight: 800; }
    .busy-copy { max-width: 560px; font-size: 13px; line-height: 1.5; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .button-row {
      display: flex;
      gap: 12px;
      justify-content: flex-end;
      margin-top: 24px;
    }
    .btn {
      padding: 14px 24px;
      border-radius: 12px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
      font-family: inherit;
    }
    .btn-primary {
      background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
      color: white;
      box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);
    }
    .btn-primary:hover {
      background: linear-gradient(135deg, #1d4ed8 0%, #1e40af 100%);
    }
    .btn-primary:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .btn-secondary {
      background: #1e293b;
      color: #cbd5e1;
    }
    .btn-secondary:hover {
      background: #334155;
      color: white;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand">
      <div class="brand-left">
        <div class="brand-icon">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            <path d="M9 12l2 2 4-4"/>
          </svg>
        </div>
        <div>
          <h1>SafeBrowse Family Protection</h1>
          <div class="subtitle">Administrator Setup: Configure Computer Accounts</div>
        </div>
      </div>
      <div class="badge-admin">
        🛡️ Administrator Approved
      </div>
    </div>

    <div id="alertBox" class="alert"></div>

    <div id="syncStatus" class="sync-status" style="display:none;"></div>

    <div id="loading" class="busy-panel" role="status" aria-live="polite">
      <div class="spinner" aria-hidden="true"></div>
      <div class="busy-title">Synchronizing SafeBrowse...</div>
      <div class="busy-copy">Please wait while SafeBrowse loads Windows accounts, verifies saved mappings and synchronizes child profiles from the Family Cloud. No changes can be made until this finishes.</div>
    </div>

    <div id="content" style="display:none;">
      <div class="alert alert-info" style="display:block; margin-bottom:16px;">
        Windows requires administrator approval to change protected account mappings. This secure settings window will close automatically after Save, and the main SafeBrowse window will refresh.
      </div>
      <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 8px;">
        Assign each distinct Windows account to a child profile, or leave it as Parent / Unmanaged. Similar account names can represent different Windows identities.
      </p>
      <p style="color: #64748b; font-size: 12px; margin: 0 0 16px 0;">
        A change is not applied until you click <strong style="color:#cbd5e1;">Save Settings & Protect Laptop</strong>.
      </p>

      <table>
        <thead>
          <tr style="color: var(--text-muted); font-size: 12px; font-weight: 700; text-transform: uppercase; text-align: left;">
            <th style="padding: 10px 16px;">Windows Account</th>
            <th style="padding: 10px 16px;">Assignment</th>
            <th style="padding: 10px 16px;">Saved / Pending</th>
          </tr>
        </thead>
        <tbody id="accountsBody">
          <!-- Populated dynamically -->
        </tbody>
      </table>

      <div class="button-row">
        <button class="btn btn-secondary" id="btnCancel" onclick="handleCancel()">Cancel</button>
        <button class="btn btn-primary" id="btnSave" onclick="handleSave()">Save Settings & Protect Laptop</button>
      </div>
    </div>
  </div>

  <script>
    let configData = {
      accounts: [],
      familyProfiles: [],
      mappings: []
    };

    function showAlert(msg, type = 'error') {
      const b = document.getElementById('alertBox');
      b.className = 'alert ' + (type === 'error' ? 'alert-error' : type === 'info' ? 'alert-info' : 'alert-success');
      b.innerText = msg;
      b.style.display = 'block';
    }

    async function loadData() {
      try {
        const res = await fetch('/api/config-state');
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showAlert(err.error || 'Failed to load configuration state.');
          document.getElementById('loading').style.display = 'none';
          return;
        }

        configData = await res.json();
        document.getElementById('loading').style.display = 'none';
        document.getElementById('content').style.display = 'block';
        document.getElementById('content').setAttribute('aria-busy', 'false');

        // Render sync status
        const syncEl = document.getElementById('syncStatus');
        if (configData.fromCache) {
          syncEl.style.display = 'flex';
          syncEl.className = 'sync-status alert-info';
          syncEl.innerText = 'ℹ Using previously synchronized family profiles.';
        } else if (configData.cloudError) {
          syncEl.style.display = 'flex';
          syncEl.className = 'sync-status alert-error';
          syncEl.innerText = '⚠️ Cloud sync note: ' + configData.cloudError;
        } else {
          syncEl.style.display = 'flex';
          syncEl.className = 'sync-status alert-success';
          syncEl.innerText = '✓ Synchronized live with SafeBrowse Family Cloud';
        }

        renderAccounts();
      } catch (e) {
        showAlert('Error communicating with SafeBrowse service: ' + e.message);
        document.getElementById('loading').style.display = 'none';
      }
    }

    function renderAccounts() {
      const tbody = document.getElementById('accountsBody');
      tbody.innerHTML = '';

      if (!configData.accounts || configData.accounts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:20px; color:#64748b;">No interactive human accounts detected.</td></tr>';
        return;
      }

      configData.accounts.forEach((acc, idx) => {
        const existing = (configData.mappings || []).find(m => m.windowsSid === acc.sid || m.windowsUsername.toLowerCase() === acc.name.toLowerCase());
        const selectedChildId = existing && existing.enabled ? existing.childId : '';

        const tr = document.createElement('tr');

        let optionsHtml = '<option value="">Parent / Unmanaged (No child filtering)</option>';
        (configData.familyProfiles || []).forEach(p => {
          const isSelected = selectedChildId === p.id ? 'selected' : '';
          optionsHtml += '<option value="' + p.id + '" ' + isSelected + '>Child: ' + p.name + ' (Protected)</option>';
        });

        const isProtected = Boolean(selectedChildId);
        const isCurrent = Boolean(acc.isCurrentConsoleUser);
        tr.dataset.savedChildId = selectedChildId || '';

        tr.innerHTML =
          '<td>' +
            '<div class="user-pill">' +
              acc.name +
              (isCurrent ? ' <span class="badge-current">ACTIVE USER</span>' : '') +
            '</div>' +
            '<div class="desc-text">' +
              (isCurrent ? 'Active Console Account' : 'Windows Account') +
              (acc.sid ? ' · SID …' + acc.sid.slice(-8) : '') +
            '</div>' +
          '</td>' +
          '<td>' +
            '<select id="sel_' + idx + '" onchange="updateTag(' + idx + ')">' +
              optionsHtml +
            '</select>' +
          '</td>' +
          '<td>' +
            '<span id="tag_' + idx + '" class="' + (isProtected ? 'tag-protected' : 'tag-bypass') + '">' +
              (isProtected ? '● CHILD PROTECTED · SAVED' : '○ PARENT / UNMANAGED · SAVED') +
            '</span>' +
          '</td>';

        tbody.appendChild(tr);
      });
    }

    function updateTag(idx) {
      const sel = document.getElementById('sel_' + idx);
      const tag = document.getElementById('tag_' + idx);
      const row = sel ? sel.closest('tr') : null;
      const savedChildId = row ? (row.dataset.savedChildId || '') : '';
      const selectedChildId = sel ? (sel.value || '') : '';
      const changed = savedChildId !== selectedChildId;
      const isProtected = Boolean(selectedChildId);
      tag.className = isProtected ? 'tag-protected' : 'tag-bypass';

      if (changed) {
        const selectedText = sel.options[sel.selectedIndex]?.text || '';
        tag.innerText = '● PENDING: ' + selectedText;
        tag.style.color = '#93c5fd';
      } else {
        tag.style.color = '';
        tag.innerText = isProtected ? '● CHILD PROTECTED · SAVED' : '○ PARENT / UNMANAGED · SAVED';
      }
    }

    async function handleSave() {
      const btn = document.getElementById('btnSave');
      const cancelBtn = document.getElementById('btnCancel');
      btn.disabled = true;
      if (cancelBtn) cancelBtn.disabled = true;
      document.querySelectorAll('select').forEach(el => el.disabled = true);
      btn.innerText = 'Saving & applying protection...';
      showAlert('Applying account mappings and synchronizing protection. Please wait...', 'info');

      const mappings = [];
      configData.accounts.forEach((acc, idx) => {
        const sel = document.getElementById('sel_' + idx);
        const childId = sel ? (sel.value || null) : null;
        const profile = (configData.familyProfiles || []).find(p => p.id === childId);

        mappings.push({
          windowsSid: acc.sid,
          windowsUsername: acc.name,
          childId: childId,
          childName: profile ? profile.name : null,
          enabled: Boolean(childId)
        });
      });

      try {
        const res = await fetch('/api/save-mappings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mappings })
        });

        const data = await res.json().catch(() => ({}));

        if (res.ok && data.success) {
          const count = Number(data.count || mappings.length);
          showAlert(count + ' account assignment' + (count === 1 ? '' : 's') + ' saved successfully. Returning to Protection Status...', 'success');
          configData.mappings = mappings;
          configData.accounts.forEach((_, idx) => {
            const sel = document.getElementById('sel_' + idx);
            const row = sel ? sel.closest('tr') : null;
            if (row && sel) row.dataset.savedChildId = sel.value || '';
            updateTag(idx);
          });
          setTimeout(() => {
            window.close();
          }, 1600);
        } else {
          showAlert(data.error || 'Failed to save settings.');
          btn.disabled = false;
          if (cancelBtn) cancelBtn.disabled = false;
          document.querySelectorAll('select').forEach(el => el.disabled = false);
          btn.innerText = 'Save Settings & Protect Laptop';
        }
      } catch (e) {
        showAlert('Network error: ' + e.message);
        btn.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;
        document.querySelectorAll('select').forEach(el => el.disabled = false);
        btn.innerText = 'Save Settings & Protect Laptop';
      }
    }

    async function handleCancel() {
      try {
        await fetch('/api/cancel', { method: 'POST' });
      } catch {}
      window.close();
    }

    window.addEventListener('DOMContentLoaded', loadData);
  </script>
</body>
</html>`;
  }
}
