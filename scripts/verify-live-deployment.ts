import http from 'http';
import https from 'https';

const BASE_URL = process.env.PUBLIC_URL || 'https://safebrowse.porwal.online';

interface CheckResult {
  name: string;
  expected: string;
  actual: string;
  passed: boolean;
  notes?: string;
}

const results: CheckResult[] = [];

async function fetchHttp(url: string, options: RequestInit = {}): Promise<{ statusCode: number; headers: any; body: string }> {
  const res = await fetch(url, options);
  const body = await res.text();
  return {
    statusCode: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body,
  };
}

async function runLiveVerification() {
  console.log(`=======================================================`);
  console.log(`SafeBrowse Windows Pilot v1.0 — Live Deployment Audit`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`=======================================================\n`);

  // Gate 1: Frontend SPA HTML & New Bundled Asset (index-nYpfwYH2.js)
  try {
    const res = await fetchHttp(`${BASE_URL}/`);
    const hasNewBundle = res.body.includes('index-nYpfwYH2.js');
    const isOldBundle = res.body.includes('index-DMzGDKo0.js');
    results.push({
      name: 'Gate 1: Frontend SPA Deployed Bundle',
      expected: 'Bundled with commit 8103755 (index-nYpfwYH2.js)',
      actual: hasNewBundle ? 'index-nYpfwYH2.js (Pilot v1.0 Devices UI)' : (isOldBundle ? 'index-DMzGDKo0.js (Previous build)' : 'Unknown bundle'),
      passed: hasNewBundle,
      notes: hasNewBundle ? 'Pilot Devices UI deployed' : 'Deployment required to update static frontend dist',
    });
  } catch (e: any) {
    results.push({
      name: 'Gate 1: Frontend SPA Deployed Bundle',
      expected: 'HTTP 200 with index-nYpfwYH2.js',
      actual: `Error: ${e.message}`,
      passed: false,
    });
  }

  // Gate 2: Windows Pilot MSI Distribution Route
  try {
    const res = await fetchHttp(`${BASE_URL}/api/downloads/info`);
    const data = JSON.parse(res.body);
    const hasWindowsMsi = data.windows?.filename === 'SafeBrowseChild-Pilot.msi' && data.windows?.version === '1.0.0';
    results.push({
      name: 'Gate 2: Windows MSI Download Metadata',
      expected: 'SafeBrowseChild-Pilot.msi v1.0.0',
      actual: hasWindowsMsi ? `${data.windows.filename} (${data.windows.platform})` : 'Unexpected metadata',
      passed: hasWindowsMsi,
    });
  } catch (e: any) {
    results.push({
      name: 'Gate 2: Windows MSI Download Metadata',
      expected: 'HTTP 200 with MSI download info',
      actual: `Error: ${e.message}`,
      passed: false,
    });
  }

  // Gate 3: WebSocket Upgrade Link (/ws)
  try {
    const wsRes = await new Promise<{ statusCode: number; upgradeHeader?: string }>((resolve, reject) => {
      const req = https.request(
        `${BASE_URL}/ws`,
        {
          method: 'GET',
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': 'MDEyMzQ1Njc4OWFiY2RlZg==',
          },
          timeout: 5000,
        }
      );
      req.on('upgrade', (res, socket, head) => {
        socket.destroy();
        resolve({
          statusCode: res.statusCode || 101,
          upgradeHeader: res.headers.upgrade,
        });
      });
      req.on('response', (res) => {
        resolve({
          statusCode: res.statusCode || 0,
          upgradeHeader: res.headers.upgrade,
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('WS handshake timeout'));
      });
      req.end();
    });

    const wsOk = wsRes.statusCode === 101 && wsRes.upgradeHeader?.toLowerCase() === 'websocket';
    results.push({
      name: 'Gate 3: Real-Time WebSocket /ws',
      expected: '101 Switching Protocols (websocket)',
      actual: `${wsRes.statusCode} Upgrade: ${wsRes.upgradeHeader || 'none'}`,
      passed: wsOk,
    });
  } catch (e: any) {
    results.push({
      name: 'Gate 3: Real-Time WebSocket /ws',
      expected: '101 Switching Protocols',
      actual: `Error: ${e.message}`,
      passed: false,
    });
  }

  // Gate 4: Device Management Route - GET /api/devices
  try {
    const res = await fetchHttp(`${BASE_URL}/api/devices`);
    const isAuthProtected = res.statusCode === 401 && res.body.includes('Unauthorized');
    results.push({
      name: 'Gate 4: GET /api/devices (Device Inventory Route)',
      expected: 'HTTP 401 Unauthorized (Auth Protected)',
      actual: `HTTP ${res.statusCode} ${res.body.slice(0, 60)}`,
      passed: isAuthProtected,
    });
  } catch (e: any) {
    results.push({
      name: 'Gate 4: GET /api/devices',
      expected: 'HTTP 401 Unauthorized',
      actual: `Error: ${e.message}`,
      passed: false,
    });
  }

  // Gate 5: Device Management Route - PATCH /api/devices/:id
  try {
    const res = await fetchHttp(`${BASE_URL}/api/devices/00000000-0000-0000-0000-000000000000`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Laptop' }),
    });

    const isRouteActive = res.statusCode === 401 && res.body.includes('Unauthorized');
    const isRouteMissing = res.statusCode === 404 && res.body.includes('Cannot PATCH');

    results.push({
      name: 'Gate 5: PATCH /api/devices/:id (Rename/Reassign Route)',
      expected: 'HTTP 401 Unauthorized (Active Route)',
      actual: isRouteMissing ? 'HTTP 404 Cannot PATCH (Old code running)' : (isRouteActive ? 'HTTP 401 Unauthorized (Route Active)' : `HTTP ${res.statusCode}`),
      passed: isRouteActive,
      notes: isRouteMissing ? 'Requires deployment of commit 8103755' : undefined,
    });
  } catch (e: any) {
    results.push({
      name: 'Gate 5: PATCH /api/devices/:id',
      expected: 'HTTP 401 Unauthorized',
      actual: `Error: ${e.message}`,
      passed: false,
    });
  }

  // Gate 6: Device Management Route - POST /api/devices/:id/sync
  try {
    const res = await fetchHttp(`${BASE_URL}/api/devices/00000000-0000-0000-0000-000000000000/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const isRouteActive = res.statusCode === 401 && res.body.includes('Unauthorized');
    const isRouteMissing = res.statusCode === 404 && res.body.includes('Cannot POST');

    results.push({
      name: 'Gate 6: POST /api/devices/:id/sync (Immediate Policy Sync)',
      expected: 'HTTP 401 Unauthorized (Active Route)',
      actual: isRouteMissing ? 'HTTP 404 Cannot POST (Old code running)' : (isRouteActive ? 'HTTP 401 Unauthorized (Route Active)' : `HTTP ${res.statusCode}`),
      passed: isRouteActive,
      notes: isRouteMissing ? 'Requires deployment of commit 8103755' : undefined,
    });
  } catch (e: any) {
    results.push({
      name: 'Gate 6: POST /api/devices/:id/sync',
      expected: 'HTTP 401 Unauthorized',
      actual: `Error: ${e.message}`,
      passed: false,
    });
  }

  // Gate 7: Device Pairing Code Endpoint - POST /api/devices/pairing-code
  try {
    const res = await fetchHttp(`${BASE_URL}/api/devices/pairing-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ childId: '00000000-0000-0000-0000-000000000000' }),
    });

    const isAuthProtected = res.statusCode === 401 && res.body.includes('Unauthorized');
    results.push({
      name: 'Gate 7: POST /api/devices/pairing-code (Pair New Device Route)',
      expected: 'HTTP 401 Unauthorized (Auth Protected)',
      actual: `HTTP ${res.statusCode} ${res.body.slice(0, 60)}`,
      passed: isAuthProtected,
    });
  } catch (e: any) {
    results.push({
      name: 'Gate 7: POST /api/devices/pairing-code',
      expected: 'HTTP 401 Unauthorized',
      actual: `Error: ${e.message}`,
      passed: false,
    });
  }

  // Gate 8: Device Heartbeat Telemetry - POST /api/devices/heartbeat
  try {
    const res = await fetchHttp(`${BASE_URL}/api/devices/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activePolicyVersion: 1,
        mappedAccountName: 'Manjari',
        hasMultipleSessions: false,
        protectionStatus: 'ACTIVE',
      }),
    });

    // Missing device auth headers returns 401
    const isDeviceAuthProtected = res.statusCode === 401 && (res.body.includes('Unauthorized') || res.body.includes('Device authentication failed') || res.body.includes('x-device-id'));
    results.push({
      name: 'Gate 8: POST /api/devices/heartbeat (Telemetry Route)',
      expected: 'HTTP 401 Unauthorized (Device Auth Protected)',
      actual: `HTTP ${res.statusCode} ${res.body.slice(0, 60)}`,
      passed: isDeviceAuthProtected,
    });
  } catch (e: any) {
    results.push({
      name: 'Gate 8: POST /api/devices/heartbeat',
      expected: 'HTTP 401 Unauthorized',
      actual: `Error: ${e.message}`,
      passed: false,
    });
  }

  // Print Summary Table
  console.log('| Check Name | Expected | Actual | Status |');
  console.log('| :--- | :--- | :--- | :--- |');
  for (const r of results) {
    const status = r.passed ? '✅ PASSED' : '❌ FAILED';
    console.log(`| ${r.name} | ${r.expected} | ${r.actual} | ${status} |`);
  }

  const passedCount = results.filter((r) => r.passed).length;
  console.log(`\nAudit Score: ${passedCount} / ${results.length} gates passed.\n`);
}

runLiveVerification().catch(console.error);
