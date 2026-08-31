import http from 'http';
import url from 'url';

export class BlockPageServer {
  private server: http.Server | null = null;
  private backendUrl: string;
  private childId: string;
  private deviceId: string;

  constructor(backendUrl: string, childId: string, deviceId: string) {
    this.backendUrl = backendUrl;
    this.childId = childId;
    this.deviceId = deviceId;
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
              const response = await fetch(`${this.backendUrl}/api/requests`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  childId: this.childId,
                  deviceId: this.deviceId,
                  domain: data.domain,
                  reason: data.reason,
                }),
              });

              if (response.ok) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
              } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to submit request' }));
              }
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Internal server error' }));
            }
          });
          return;
        }

        // Render Block Landing Page
        const blockedDomain = (parsed.query.domain as string) || 'This website';

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SafeBrowse — Website Restricted</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&display=swap" rel="stylesheet">
  <style>
    body {
      font-family: 'Plus Jakarta Sans', sans-serif;
      background-color: #0b0f19;
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
    }
    .card {
      background: #131b2e;
      border: 1px solid rgba(239, 68, 68, 0.3);
      border-radius: 28px;
      padding: 40px;
      max-width: 480px;
      width: 100%;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    }
    .badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: #f87171;
      background: rgba(239, 68, 68, 0.15);
      padding: 6px 14px;
      border-radius: 20px;
      margin-bottom: 20px;
    }
    h1 {
      font-size: 24px;
      font-weight: 800;
      margin: 0 0 10px 0;
      letter-spacing: -0.5px;
    }
    p {
      color: #94a3b8;
      font-size: 14px;
      line-height: 1.6;
      margin: 0 0 28px 0;
    }
    .domain-pill {
      font-weight: 800;
      color: #ffffff;
      background: #1e293b;
      padding: 3px 8px;
      border-radius: 8px;
    }
    .btn {
      background: linear-gradient(135deg, #16a34a, #0d9488);
      color: #ffffff;
      border: none;
      border-radius: 18px;
      padding: 14px 28px;
      font-size: 15px;
      font-weight: 800;
      cursor: pointer;
      width: 100%;
      transition: all 0.2s;
      box-shadow: 0 10px 15px -3px rgba(22, 163, 74, 0.3);
    }
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 20px 25px -5px rgba(22, 163, 74, 0.4);
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
      background: #0b0f19;
      border: 1px solid #334155;
      color: white;
      font-size: 13px;
      margin-bottom: 12px;
    }
    input:focus { outline: 2px solid #22c55e; }
    .success-msg {
      display: none;
      background: rgba(34, 197, 94, 0.2);
      border: 1px solid rgba(34, 197, 94, 0.3);
      color: #4ade80;
      padding: 14px;
      border-radius: 16px;
      font-size: 13px;
      font-weight: 700;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">SafeBrowse Protection</div>
    <h1>${blockedDomain} is restricted</h1>
    <p>This website is restricted by your family settings on this device.</p>

    <button id="askBtn" class="btn" onclick="openAskForm()">Ask Parent for Access</button>

    <div id="askForm" class="form-group">
      <label style="font-size: 12px; font-weight: 700; color: #cbd5e1; display: block; margin-bottom: 6px;">
        Why do you need this website?
      </label>
      <input type="text" id="reasonInput" placeholder="e.g. Need a tutorial for maths class">
      <button class="btn" onclick="submitRequest('${blockedDomain}')">Send Request to Parent</button>
    </div>

    <div id="successMsg" class="success-msg">
      ✓ Request sent to your parent! Check with them for approval.
    </div>
  </div>

  <script>
    function openAskForm() {
      document.getElementById('askBtn').style.display = 'none';
      document.getElementById('askForm').style.display = 'block';
      document.getElementById('reasonInput').focus();
    }

    async function submitRequest(domain) {
      const reason = document.getElementById('reasonInput').value;
      try {
        const res = await fetch('/submit-request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain, reason })
        });
        if (res.ok) {
          document.getElementById('askForm').style.display = 'none';
          document.getElementById('successMsg').style.display = 'block';
        }
      } catch (e) {
        alert('Could not submit request');
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
