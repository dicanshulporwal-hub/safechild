import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { accountManager } from '../src/account-manager';
import { sessionMonitor } from '../src/session-monitor';
import { guiServer } from '../src/gui-server';
import { PolicySyncClient } from '../src/sync-client';

test('SafeBrowse Windows Pilot v1.0 — Device Management & Multi-Session Safety Guard Suite', async (t) => {
  // Reset any mock sessions
  accountManager.setMockInteractiveSessionsForTesting(null);

  await t.test('1. Multi-Session Safety Guard: detects single vs multiple interactive sessions', async () => {
    // Single interactive session
    accountManager.setMockInteractiveSessionsForTesting(['Manjari']);
    const singleResult = await accountManager.detectMultipleInteractiveSessions();
    assert.strictEqual(singleResult.hasMultipleSessions, false);
    assert.strictEqual(singleResult.sessionCount, 1);
    assert.deepStrictEqual(singleResult.activeUsers, ['Manjari']);
    assert.strictEqual(singleResult.warning, null);

    // Multiple interactive sessions (e.g. parent acer and child Manjari both signed in)
    accountManager.setMockInteractiveSessionsForTesting(['acer', 'Manjari']);
    const multiResult = await accountManager.detectMultipleInteractiveSessions();
    assert.strictEqual(multiResult.hasMultipleSessions, true);
    assert.strictEqual(multiResult.sessionCount, 2);
    assert.deepStrictEqual(multiResult.activeUsers, ['acer', 'Manjari']);
    assert.ok(multiResult.warning);
    assert.ok(multiResult.warning?.includes('Multiple Windows users are currently signed in'));
  });

  await t.test('2. SessionMonitor: tracks multi-session state and provides accessors', async () => {
    accountManager.setMockInteractiveSessionsForTesting(['acer', 'Rahul']);
    await sessionMonitor.checkSessionNow();

    const multiState = sessionMonitor.getMultiSessionState();
    assert.strictEqual(multiState.hasMultipleSessions, true);
    assert.strictEqual(multiState.sessionCount, 2);
    assert.strictEqual(sessionMonitor.hasMultipleSessions(), true);
    assert.ok(sessionMonitor.getSessionWarning()?.includes('Multiple Windows users are currently signed in'));
  });

  await t.test('3. Windows Setup GUI Server: GET /api/status exposes multi-session and protectionState telemetry', async () => {
    accountManager.setMockInteractiveSessionsForTesting(['ParentAccount', 'ChildAccount']);
    await sessionMonitor.checkSessionNow();
    await guiServer.start(48885);

    try {
      const res = await new Promise<{ statusCode: number; data: any }>((resolve, reject) => {
        http.get('http://127.0.0.1:48885/api/status', (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              resolve({ statusCode: res.statusCode || 0, data: JSON.parse(body) });
            } catch (err) {
              reject(err);
            }
          });
        }).on('error', reject);
      });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.data.hasMultipleSessions, true);
      assert.strictEqual(res.data.activeUsers.length, 2);
      assert.ok(res.data.sessionWarning?.includes('Multiple Windows users are currently signed in'));
      assert.strictEqual(res.data.protectionState, 'ATTENTION_REQUIRED');
    } finally {
      await guiServer.stop();
    }
  });

  await t.test('4. Windows Setup GUI: HTML interface hides raw SIDs and provides friendly user-facing labels', async () => {
    accountManager.setMockAccountsForTesting([
      { name: 'acer', sid: 'S-1-5-21-99999-1000', disabled: false, isCurrentConsoleUser: true },
      { name: 'Manjari', sid: 'S-1-5-21-99999-1001', disabled: false, isCurrentConsoleUser: false },
    ]);

    await guiServer.start(48886);

    try {
      // 1. Check API endpoint returns friendly names
      const apiRes = await new Promise<{ statusCode: number; data: any }>((resolve, reject) => {
        http.get('http://127.0.0.1:48886/api/accounts', (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              resolve({ statusCode: res.statusCode || 0, data: JSON.parse(body) });
            } catch (err) {
              reject(err);
            }
          });
        }).on('error', reject);
      });

      assert.strictEqual(apiRes.statusCode, 200);
      assert.strictEqual(apiRes.data.accounts.length, 2);
      assert.strictEqual(apiRes.data.accounts[0].name, 'acer');
      assert.strictEqual(apiRes.data.accounts[1].name, 'Manjari');

      // 2. Check HTML document: verifies multiSessionBanner and that raw SIDs are not rendered in table
      const htmlRes = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        http.get('http://127.0.0.1:48886/', (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            resolve({ statusCode: res.statusCode || 0, body });
          });
        }).on('error', reject);
      });

      assert.strictEqual(htmlRes.statusCode, 200);
      assert.ok(htmlRes.body.includes('id="multiSessionBanner"'));
      assert.ok(htmlRes.body.includes('Multiple Windows users are currently signed in'));
      assert.ok(htmlRes.body.includes('Standard Windows Account'));
      // Raw SID pattern is NOT hardcoded into client-facing HTML table
      assert.ok(!htmlRes.body.includes('S-1-5-21-'));
    } finally {
      await guiServer.stop();
    }
  });

  await t.test('5. PolicySyncClient Device State Provider: transmits multi-session telemetry in heartbeat payload', async () => {
    let capturedHeartbeat: any = null;

    const mockServer = http.createServer((req, res) => {
      if (req.url === '/api/devices/heartbeat' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          capturedHeartbeat = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', policyVersion: 2 }));
        });
      } else {
        res.writeHead(404).end();
      }
    });

    await new Promise<void>((resolve) => mockServer.listen(48887, '127.0.0.1', () => resolve()));

    try {
      const client = new PolicySyncClient({
        backendUrl: 'http://127.0.0.1:48887',
        deviceId: 'dev-pilot-test-1',
        deviceToken: 'tok-pilot-test-secret',
        childId: 'child-123',
        parentId: 'parent-123',
        deviceName: 'Family Laptop',
      });

      client.setDeviceStateProvider(() => ({
        mappedAccountName: 'DESKTOP-PC\\Rahul',
        hasMultipleSessions: true,
        protectionStatus: 'DEGRADED',
      }));

      await client.sendHeartbeat();

      assert.ok(capturedHeartbeat, 'Heartbeat was received by backend');
      assert.strictEqual(capturedHeartbeat.deviceId, 'dev-pilot-test-1');
      assert.strictEqual(capturedHeartbeat.agentVersion, '1.0.0-pilot');
      assert.strictEqual(capturedHeartbeat.mappedAccountName, 'DESKTOP-PC\\Rahul');
      assert.strictEqual(capturedHeartbeat.hasMultipleSessions, true);
      assert.strictEqual(capturedHeartbeat.protectionStatus, 'DEGRADED');

      client.stop();
    } finally {
      mockServer.close();
      accountManager.setMockInteractiveSessionsForTesting(null);
      accountManager.setMockAccountsForTesting(null);
    }
  });
});
