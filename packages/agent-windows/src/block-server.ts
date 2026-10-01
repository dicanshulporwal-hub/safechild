import http from 'http';
import url from 'url';
import fs from 'fs';
import { spawn, exec } from 'child_process';

export interface ActiveChildContext {
  childId: string | null;
  childName: string | null;
}

export function escapeHtml(str: string): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function formatFriendlyReason(rawReason: string): string {
  if (!rawReason) {
    return 'This site has been restricted by your family protection settings.';
  }

  const upper = rawReason.trim().toUpperCase();

  if (
    upper === 'PAUSED_INTERNET' ||
    upper === 'DINNER_TIME' ||
    upper === 'PAUSED' ||
    upper.includes('PAUSE') ||
    upper.includes('DINNER')
  ) {
    return 'Internet is paused for family time.';
  }
  if (upper === 'BEDTIME_RESTRICTION') {
    return 'Bedtime rule active. Internet access is paused until morning.';
  }
  if (
    upper === 'BEDTIME_ACTIVE' ||
    upper.includes('BEDTIME') ||
    upper.includes('CURFEW')
  ) {
    return 'Bedtime restrictions are active.';
  }
  if (upper === 'ADULT_CONTENT' || upper.includes('ADULT')) {
    return 'This website has content that is not suitable for children.';
  }
  if (upper === 'GAMBLING') {
    return 'Gambling websites are blocked to keep you safe.';
  }
  if (upper === 'MALWARE_SECURITY' || upper.includes('MALWARE') || upper.includes('SECURITY')) {
    return 'This website was blocked because it may harm your computer.';
  }
  if (upper === 'GAMES' || upper.includes('GAMING') || upper.includes('GAME')) {
    return 'Gaming time is currently restricted by your family protection settings.';
  }
  if (upper === 'SOCIAL_MEDIA' || upper.includes('SOCIAL')) {
    return 'Social media websites are restricted by your family protection settings.';
  }
  if (upper === 'STUDY_MODE') {
    return 'Study Mode is active. Only educational websites are permitted right now.';
  }
  if (upper.includes('PARENT') || upper.includes('BLACKLIST') || upper.includes('BLOCK') || upper === 'CUSTOM_RULE') {
    return 'Blocked by your parent in family rules.';
  }

  // If already a human sentence, sanitize and return
  if (!upper.includes('_') && rawReason.length > 5) {
    return rawReason;
  }

  return 'This site has been restricted by your family protection settings.';
}

export class BlockPageServer {
  private server: http.Server | null = null;
  private redirectServer: http.Server | null = null;
  private backendUrl: string;
  private defaultChildId: string;
  private deviceId: string;
  private deviceToken: string;
  private activeChildProvider?: () => ActiveChildContext;
  private port: number = 8880;

  private lastTriggeredTimes: Map<string, number> = new Map();
  public lastTriggeredExperience: { domain: string; reason: string; timestamp: number } | null = null;
  private onBlockExperienceCallback?: (domain: string, reason: string) => void;

  constructor(
    backendUrl: string,
    defaultChildId: string,
    deviceId: string,
    activeChildProvider?: () => ActiveChildContext,
    deviceToken: string = ''
  ) {
    this.backendUrl = backendUrl;
    this.defaultChildId = defaultChildId;
    this.deviceId = deviceId;
    this.deviceToken = deviceToken;
    this.activeChildProvider = activeChildProvider;
  }

  public setActiveChildProvider(provider: () => ActiveChildContext): void {
    this.activeChildProvider = provider;
  }

  public setOnBlockExperience(cb: (domain: string, reason: string) => void): void {
    this.onBlockExperienceCallback = cb;
  }

  /**
   * Triggers the child-visible SafeBrowse block experience outside of TLS/HTTPS interception.
   * Debounces duplicate queries for the same domain within 3 seconds.
   */
  public triggerBlockExperience(domain: string, reason: string): void {
    const now = Date.now();
    const last = this.lastTriggeredTimes.get(domain) || 0;
    if (now - last < 3000) {
      return;
    }
    this.lastTriggeredTimes.set(domain, now);
    this.lastTriggeredExperience = { domain, reason, timestamp: now };

    if (this.onBlockExperienceCallback) {
      this.onBlockExperienceCallback(domain, reason);
    }

    const safeDomain = encodeURIComponent(domain);
    const safeReason = encodeURIComponent(reason);
    const blockUrl = `http://127.0.0.1:${this.port}/blocked?domain=${safeDomain}&reason=${safeReason}`;

    if (process.platform === 'win32' && process.env.NODE_ENV !== 'test') {
      try {
        const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const progFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
        const edgeCandidates = [
          `${progFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${progFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ];
        let foundEdge: string | null = null;
        for (const candidate of edgeCandidates) {
          if (fs.existsSync(candidate)) {
            foundEdge = candidate;
            break;
          }
        }

        if (foundEdge) {
          const child = spawn(foundEdge, [`--app=${blockUrl}`], {
            detached: true,
            stdio: 'ignore',
          });
          child.on('error', () => {
            try {
              exec(`start "" "${blockUrl}"`);
            } catch {}
          });
          child.unref();
        } else {
          const child = spawn('cmd.exe', ['/c', 'start', '', blockUrl], {
            detached: true,
            stdio: 'ignore',
          });
          child.on('error', () => {});
          child.unref();
        }
      } catch (e) {
        try {
          exec(`start "" "${blockUrl}"`);
        } catch {}
      }
    }
  }

  public start(port: number = 8880): Promise<void> {
    this.port = port;
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        const parsed = url.parse(req.url || '', true);

        if (parsed.pathname === '/submit-request' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', async () => {
            try {
              const data = JSON.parse(body);
              const active = this.activeChildProvider ? this.activeChildProvider() : null;
              const targetChildId = active?.childId || data.childId || this.defaultChildId;

              const response = await fetch(`${this.backendUrl}/api/requests`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-device-id': this.deviceId,
                  'x-device-token': this.deviceToken,
                },
                body: JSON.stringify({
                  childId: targetChildId,
                  deviceId: this.deviceId,
                  domain: data.domain,
                  reason: data.reason || 'Child requested access to website',
                }),
              });

              if (response.ok) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
              } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to submit request' }));
              }
            } catch (e: any) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: 'SafeBrowse cloud service is temporarily unreachable. Please ask your parent directly.',
                  offline: true,
                })
              );
            }
          });
          return;
        }

        // Render Block Landing Page (/ or /blocked)
        const rawDomain = (parsed.query.domain as string) || 'This website';
        const rawReason = (parsed.query.reason as string) || '';
        const active = this.activeChildProvider ? this.activeChildProvider() : null;
        const profileDisplay = active?.childName || 'Child';

        const safeDomain = escapeHtml(rawDomain);
        const friendlyReason = escapeHtml(formatFriendlyReason(rawReason));
        const safeProfile = escapeHtml(profileDisplay);

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SafeBrowse — Access Restricted</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: radial-gradient(circle at 50% 20%, #1e1b4b 0%, #09090b 100%);
      color: #f8fafc;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 24px;
      box-sizing: border-box;
    }
    .card {
      background: rgba(17, 24, 39, 0.95);
      border: 1px solid rgba(239, 68, 68, 0.35);
      border-radius: 28px;
      padding: 44px 36px;
      max-width: 520px;
      width: 100%;
      text-align: center;
      box-shadow: 0 25px 60px -15px rgba(0, 0, 0, 0.7), 0 0 40px rgba(239, 68, 68, 0.1);
      backdrop-filter: blur(16px);
    }
    .shield-icon {
      width: 68px;
      height: 68px;
      margin: 0 auto 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(239, 68, 68, 0.15);
      border: 2px solid rgba(239, 68, 68, 0.4);
      border-radius: 20px;
      color: #f87171;
    }
    .brand-title {
      font-size: 13px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: #fca5a5;
      margin-bottom: 8px;
    }
    .profile-pill {
      display: inline-block;
      font-size: 12px;
      font-weight: 700;
      color: #93c5fd;
      background: rgba(59, 130, 246, 0.15);
      padding: 4px 12px;
      border-radius: 12px;
      margin-bottom: 20px;
    }
    h1 {
      font-size: 26px;
      font-weight: 800;
      margin: 0 0 12px 0;
      letter-spacing: -0.5px;
      color: #ffffff;
    }
    .domain-target {
      color: #f87171;
      font-family: monospace;
      font-size: 16px;
      font-weight: 700;
      word-break: break-all;
    }
    .subtitle-msg {
      font-size: 14px;
      color: #94a3b8;
      margin: 8px 0 20px 0;
      line-height: 1.4;
    }
    .reason-box {
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid #334155;
      border-radius: 16px;
      padding: 16px;
      margin: 0 0 28px;
      font-size: 14px;
      line-height: 1.5;
      color: #cbd5e1;
      text-align: left;
    }
    .reason-title {
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #94a3b8;
      margin-bottom: 6px;
    }
    .button-group {
      display: flex;
      gap: 12px;
      margin-top: 10px;
    }
    .btn {
      flex: 1;
      border: none;
      border-radius: 16px;
      padding: 14px 20px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
    }
    .btn-secondary {
      background: #1e293b;
      color: #e2e8f0;
      border: 1px solid #475569;
    }
    .btn-secondary:hover {
      background: #334155;
      color: #ffffff;
    }
    .btn-primary {
      background: linear-gradient(135deg, #2563eb, #1d4ed8);
      color: #ffffff;
      box-shadow: 0 10px 20px -5px rgba(37, 99, 235, 0.4);
    }
    .btn-primary:hover {
      background: linear-gradient(135deg, #1d4ed8, #1e40af);
      transform: translateY(-1px);
    }
    .footer-brand {
      margin-top: 24px;
      font-size: 12px;
      font-weight: 600;
      color: #64748b;
      letter-spacing: 0.5px;
    }
    .form-group {
      display: none;
      margin-top: 20px;
      text-align: left;
    }
    input {
      width: 100%;
      box-sizing: border-box;
      padding: 12px 16px;
      border-radius: 14px;
      background: #0f172a;
      border: 1px solid #334155;
      color: white;
      font-size: 13px;
      margin-bottom: 12px;
    }
    input:focus { outline: 2px solid #3b82f6; }
    .success-msg {
      display: none;
      background: rgba(34, 197, 94, 0.15);
      border: 1px solid rgba(34, 197, 94, 0.3);
      color: #4ade80;
      padding: 16px;
      border-radius: 16px;
      font-size: 14px;
      font-weight: 700;
      margin-top: 20px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="shield-icon">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
    </div>

    <div class="brand-title">SafeBrowse</div>
    <div><span class="profile-pill">Profile: ${safeProfile}</span></div>

    <h1>This site is blocked</h1>
    <div class="domain-target">${safeDomain}</div>
    <div class="subtitle-msg">This site has been restricted by your family protection settings.</div>

    <div class="reason-box">
      <div class="reason-title">Reason:</div>
      <div>${friendlyReason}</div>
    </div>

    <div class="button-group" id="mainActions">
      <button class="btn btn-secondary" onclick="goBack()">
        ← Go Back
      </button>
      <button class="btn btn-primary" id="askBtn" onclick="openAskForm()">
        Ask Parent
      </button>
    </div>

    <div id="askForm" class="form-group">
      <label style="font-size: 12px; font-weight: 700; color: #cbd5e1; display: block; margin-bottom: 8px;">
        Why do you need access? (Optional)
      </label>
      <input type="text" id="reasonInput" placeholder="e.g. Need this for homework or study">
      <div style="display: flex; gap: 8px;">
        <button class="btn btn-secondary" style="flex: 1;" onclick="cancelAskForm()">Cancel</button>
        <button class="btn btn-primary" style="flex: 2;" onclick="submitRequest()">Send Request</button>
      </div>
    </div>

    <div id="successMsg" class="success-msg">
      ✓ Request sent to your parent! They will receive a notification.
    </div>

    <div class="footer-brand">Protected by SafeBrowse</div>
  </div>

  <script>
    const TARGET_DOMAIN = ${JSON.stringify(rawDomain)};

    function goBack() {
      if (window.history.length > 1) {
        window.history.back();
      } else {
        window.location.href = 'https://www.google.com';
      }
    }

    function openAskForm() {
      document.getElementById('mainActions').style.display = 'none';
      document.getElementById('askForm').style.display = 'block';
      document.getElementById('reasonInput').focus();
    }

    function cancelAskForm() {
      document.getElementById('askForm').style.display = 'none';
      document.getElementById('mainActions').style.display = 'flex';
    }

    async function submitRequest() {
      const reason = document.getElementById('reasonInput').value.trim();
      try {
        const res = await fetch('/submit-request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain: TARGET_DOMAIN, reason: reason })
        });
        const respData = await res.json().catch(function() { return {}; });
        if (res.ok) {
          document.getElementById('askForm').style.display = 'none';
          document.getElementById('successMsg').style.display = 'block';
        } else {
          alert(respData.error || 'SafeBrowse service is temporarily unreachable. Please ask your parent directly.');
        }
      } catch (e) {
        alert('SafeBrowse service is temporarily unreachable. Please ask your parent directly.');
      }
    }
  </script>
</body>
</html>`;

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      });

      this.server.listen(port, () => {
        console.log(`[Agent] Local Block Landing Server running on http://127.0.0.1:${port}`);
        resolve();
      });

      // Optional Port 80 HTTP Redirector for plain unencrypted HTTP requests
      try {
        this.redirectServer = http.createServer((req, res) => {
          const hostHeader = req.headers.host || '';
          const hostOnly = hostHeader.split(':')[0];
          res.writeHead(302, {
            Location: `http://127.0.0.1:${port}/blocked?domain=${encodeURIComponent(hostOnly)}&reason=Blocked%20by%20family%20rules`,
          });
          res.end();
        });
        this.redirectServer.on('error', () => {
          // Port 80 busy or requires elevated privileges; graceful fallback
        });
        this.redirectServer.listen(80, '127.0.0.1');
      } catch (e) {}
    });
  }

  public stop(): void {
    try {
      this.server?.close();
    } catch {}
    try {
      this.redirectServer?.close();
    } catch {}
  }
}
