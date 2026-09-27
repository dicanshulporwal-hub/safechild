import http from 'http';
import url from 'url';

export interface ActiveChildContext {
  childId: string | null;
  childName: string | null;
}

export class BlockPageServer {
  private server: http.Server | null = null;
  private backendUrl: string;
  private defaultChildId: string;
  private deviceId: string;
  private activeChildProvider?: () => ActiveChildContext;

  constructor(
    backendUrl: string,
    defaultChildId: string,
    deviceId: string,
    activeChildProvider?: () => ActiveChildContext
  ) {
    this.backendUrl = backendUrl;
    this.defaultChildId = defaultChildId;
    this.deviceId = deviceId;
    this.activeChildProvider = activeChildProvider;
  }

  public setActiveChildProvider(provider: () => ActiveChildContext): void {
    this.activeChildProvider = provider;
  }

  public start(port: number = 8880): Promise<void> {
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
                headers: { 'Content-Type': 'application/json' },
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

        // Render Block Landing Page
        const blockedDomain = (parsed.query.domain as string) || 'This website';
        const rawReason = (parsed.query.reason as string) || '';
        const active = this.activeChildProvider ? this.activeChildProvider() : null;
        const profileDisplay = active?.childName || 'Child';

        let friendlyReason = 'This website is not allowed for your profile.';
        if (rawReason.toLowerCase().includes('bedtime') || rawReason.toLowerCase().includes('curfew')) {
          friendlyReason = 'Bedtime rule active. Internet access is paused until morning.';
        } else if (rawReason.toLowerCase().includes('gaming')) {
          friendlyReason = 'Restricted Category: Gaming & Entertainment.';
        } else if (rawReason.toLowerCase().includes('social')) {
          friendlyReason = 'Restricted Category: Social Media.';
        } else if (rawReason.toLowerCase().includes('parent') || rawReason.toLowerCase().includes('blacklist') || rawReason.toLowerCase().includes('block')) {
          friendlyReason = 'Blocked by your parent in family rules.';
        } else if (rawReason) {
          friendlyReason = `Restricted by family rules: ${rawReason}`;
        }

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
    .badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: #fca5a5;
      background: rgba(239, 68, 68, 0.2);
      padding: 6px 16px;
      border-radius: 20px;
      margin-bottom: 16px;
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
      word-break: break-all;
    }
    .reason-box {
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid #334155;
      border-radius: 16px;
      padding: 16px;
      margin: 20px 0 28px;
      font-size: 14px;
      line-height: 1.5;
      color: #cbd5e1;
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

    <div class="badge">SafeBrowse Family Protection</div>
    <div><span class="profile-pill">Profile: ${profileDisplay}</span></div>

    <h1>Access Restricted</h1>
    <div style="font-size: 15px; color: #94a3b8; margin-bottom: 16px;">
      <span class="domain-target">${blockedDomain}</span>
    </div>

    <div class="reason-box">
      <div class="reason-title">Why is this blocked?</div>
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
        <button class="btn btn-primary" style="flex: 2;" onclick="submitRequest('${blockedDomain}')">Send Request</button>
      </div>
    </div>

    <div id="successMsg" class="success-msg">
      ✓ Request sent to your parent! They will receive a notification.
    </div>
  </div>

  <script>
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

    async function submitRequest(domain) {
      const reason = document.getElementById('reasonInput').value.trim();
      try {
        const res = await fetch('/submit-request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain: domain, reason: reason })
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
    });
  }

  public stop() {
    this.server?.close();
  }
}
