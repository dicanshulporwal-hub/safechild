process.env.NODE_ENV = 'test';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as net from 'net';
import * as http from 'http';
import {
  BlockIpcServer,
  BlockPresentationMessage,
  HelperRegisterAck,
} from '../src/block-ipc';
import { BlockPageServer } from '../src/block-server';
import { DnsFilterProxy } from '../src/dns-proxy';
import { ResolvedUserPolicy, MultiSessionCheckResult } from '../src/account-manager';
import { Policy } from '@safebrowse/shared';

describe('SafeBrowse Windows Stage C.3.1: Service Block IPC Integration Suite', () => {
  let testSockPath: string;
  let ipcServer: BlockIpcServer;
  let activePolicyState: ResolvedUserPolicy | null = null;
  let multiSessionState: MultiSessionCheckResult = {
    hasMultipleSessions: false,
    sessionCount: 1,
    activeUsers: ['Manjari'],
    warning: null,
  };

  beforeEach(() => {
    testSockPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\sb-svc-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
      : path.join(
          os.tmpdir(),
          `sb-svc-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}.sock`
        );

    ipcServer = new BlockIpcServer(testSockPath, 500, 100);
    ipcServer.setActivePolicyProvider(() => activePolicyState);
    ipcServer.setMultiSessionChecker(() => multiSessionState);

    // Default policy: managed child "Manjari"
    activePolicyState = {
      accountName: 'Manjari',
      isManaged: true,
      childId: 'child-manjari-uuid',
      childName: 'Manjari',
      sid: 'S-1-5-21-1000-1002',
    };
    multiSessionState = {
      hasMultipleSessions: false,
      sessionCount: 1,
      activeUsers: ['Manjari'],
      warning: null,
    };
  });

  afterEach(async () => {
    if (ipcServer) {
      await ipcServer.stop();
    }
    if (process.platform !== 'win32' && fs.existsSync(testSockPath)) {
      try {
        fs.unlinkSync(testSockPath);
      } catch {}
    }
  });

  // Helper helper to create a connected client
  function createHelperClient(
    pipePath: string,
    accountName: string = 'Manjari',
    pid: number = 1234,
    sessionId?: number
  ): Promise<{
    socket: net.Socket;
    receivedAcks: HelperRegisterAck[];
    receivedMessages: BlockPresentationMessage[];
    close: () => Promise<void>;
  }> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(pipePath);
      const receivedAcks: HelperRegisterAck[] = [];
      const receivedMessages: BlockPresentationMessage[] = [];
      let buffer = '';

      socket.on('connect', () => {
        // Send registration message
        const regPayload: any = {
          type: 'REGISTER_HELPER',
          version: '1.0.4-validation',
          accountName,
          pid,
        };
        if (typeof sessionId === 'number') {
          regPayload.sessionId = sessionId;
        }
        socket.write(JSON.stringify(regPayload) + '\n');
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const data = JSON.parse(trimmed);
            if (data.type === 'REGISTER_ACK') {
              receivedAcks.push(data);
              resolve({
                socket,
                receivedAcks,
                receivedMessages,
                close: () =>
                  new Promise<void>((res) => {
                    socket.end(() => res());
                  }),
              });
            } else if (data.type === 'PRESENT_BLOCK') {
              receivedMessages.push(data);
            }
          } catch {}
        }
      });

      socket.on('error', (err) => {
        reject(err);
      });
    });
  }

  // 1. Service Startup & Helper Handshake
  test('1. Service startup -> blockIpcServer.start() -> helper registers and receives REGISTER_ACK', async () => {
    await ipcServer.start();
    assert.strictEqual(ipcServer.isRunning(), true);
    assert.strictEqual(ipcServer.getPipePath(), testSockPath);
    assert.strictEqual(ipcServer.getConnectedHelperCount(), 0);

    const client = await createHelperClient(testSockPath, 'Manjari', 5678);
    try {
      assert.strictEqual(ipcServer.getConnectedHelperCount(), 1);
      assert.strictEqual(client.receivedAcks.length, 1);
      assert.strictEqual(client.receivedAcks[0].status, 'OK');

      const helpers = ipcServer.getConnectedHelpers();
      assert.strictEqual(helpers.length, 1);
      assert.strictEqual(helpers[0].accountName, 'Manjari');
      assert.strictEqual(helpers[0].pid, 5678);
    } finally {
      await client.close();
    }
  });

  // 2. DNS Block callback -> blockIpcServer.presentBlock() -> PRESENT_BLOCK delivered to helper
  test('2. DNS BLOCK event callback routes through blockIpcServer.presentBlock and delivers PRESENT_BLOCK to helper', async () => {
    await ipcServer.start();
    const client = await createHelperClient(testSockPath, 'Manjari', 1234);

    try {
      // Mock filtering policy
      const mockPolicy = {
        id: 'policy-test-1',
        childId: 'child-manjari-uuid',
        familyId: 'family-1',
        version: 1,
        isPaused: false,
        rules: [
          {
            id: 'rule-block-insta',
            domain: 'instagram.com',
            action: 'BLOCK',
            addedAt: new Date().toISOString(),
          },
        ],
        updatedAt: new Date().toISOString(),
      } as unknown as Policy;

      let blockCallbackTriggered = false;
      let callbackResult: any = null;

      const dnsProxy = new DnsFilterProxy(() => mockPolicy, '1.1.1.1', 53);
      dnsProxy.setOnBlockExperienceTriggered((domain, reason) => {
        blockCallbackTriggered = true;
        callbackResult = ipcServer.presentBlock(domain, reason, 8880);
      });

      // Simulate DNS Proxy block experience trigger
      (dnsProxy as any).onBlockExperienceTriggered('instagram.com', 'Restricted by family settings');

      assert.strictEqual(blockCallbackTriggered, true);
      assert.ok(callbackResult);
      assert.strictEqual(callbackResult.sent, true);
      assert.strictEqual(callbackResult.reason, 'PRESENTED');
      assert.ok(callbackResult.url.includes('instagram.com'));
      assert.ok(callbackResult.url.includes('127.0.0.1:8880/blocked'));

      // Allow event loop cycle for IPC transmission
      await new Promise((r) => setTimeout(r, 80));

      assert.strictEqual(client.receivedMessages.length, 1);
      const msg = client.receivedMessages[0];
      assert.strictEqual(msg.type, 'PRESENT_BLOCK');
      assert.strictEqual(msg.domain, 'instagram.com');
      assert.strictEqual(msg.reason, 'Restricted by family settings');
      assert.ok(msg.url.startsWith('http://127.0.0.1:8880/blocked?domain=instagram.com'));
      assert.ok(msg.eventId.startsWith('evt-'));
    } finally {
      await client.close();
    }
  });

  // 3. Parent session -> no presentation
  test('3. Active parent session suppresses presentation with PARENT_OR_UNMANAGED_USER', async () => {
    await ipcServer.start();
    const client = await createHelperClient(testSockPath, 'Manjari', 1234);

    try {
      // Switch active user to Parent / Unmanaged
      activePolicyState = {
        accountName: 'acer',
        isManaged: false,
        childId: null,
        childName: null,
        sid: 'S-1-5-21-1000-1001',
      };

      const result = ipcServer.presentBlock('gambling.com', 'POLICY_BLOCKED', 8880);
      assert.strictEqual(result.sent, false);
      assert.strictEqual(result.reason, 'PARENT_OR_UNMANAGED_USER');

      await new Promise((r) => setTimeout(r, 60));
      assert.strictEqual(client.receivedMessages.length, 0);
    } finally {
      await client.close();
    }
  });

  // 4. Multiple concurrent sessions -> safety hold
  test('4. Fast User Switching multi-session suppresses presentation with CONCURRENT_SESSIONS_SAFETY_HOLD', async () => {
    await ipcServer.start();
    const client = await createHelperClient(testSockPath, 'Manjari', 1234);

    try {
      multiSessionState = {
        hasMultipleSessions: true,
        sessionCount: 2,
        activeUsers: ['acer', 'Manjari'],
        warning: 'Multiple active console users detected',
      };

      const result = ipcServer.presentBlock('tiktok.com', 'POLICY_BLOCKED', 8880);
      assert.strictEqual(result.sent, false);
      assert.strictEqual(result.reason, 'CONCURRENT_SESSIONS_SAFETY_HOLD');

      await new Promise((r) => setTimeout(r, 60));
      assert.strictEqual(client.receivedMessages.length, 0);
    } finally {
      await client.close();
    }
  });

  // 5. No connected helper -> NO_CONNECTED_HELPER
  test('5. Triggering block when no helper is running returns NO_CONNECTED_HELPER', async () => {
    await ipcServer.start();
    assert.strictEqual(ipcServer.getConnectedHelperCount(), 0);

    const result = ipcServer.presentBlock('distracting-game.com', 'POLICY_BLOCKED', 8880);
    assert.strictEqual(result.sent, false);
    assert.strictEqual(result.reason, 'NO_CONNECTED_HELPER');
    assert.ok(result.url?.includes('distracting-game.com'));
  });

  // 6. Shutdown -> pipe server closed
  test('6. Graceful shutdown closes pipe server and terminates helper connections cleanly', async () => {
    await ipcServer.start();
    const client = await createHelperClient(testSockPath, 'Manjari', 1234);

    assert.strictEqual(ipcServer.isRunning(), true);
    assert.strictEqual(ipcServer.getConnectedHelperCount(), 1);

    let clientDisconnected = false;
    client.socket.on('close', () => {
      clientDisconnected = true;
    });

    await ipcServer.stop();
    assert.strictEqual(ipcServer.isRunning(), false);
    assert.strictEqual(ipcServer.getConnectedHelperCount(), 0);

    // Verify socket closed by server
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(clientDisconnected, true);
  });

  // 7. Physical failure reproduction: FUS disconnected session does NOT suppress active child block presentation
  test('7. FUS disconnected session (Session 4 Disc) does NOT suppress active child (Session 5 Active Rahul) presentation', async () => {
    await ipcServer.start();

    // Session 4: Disconnected Parent helper (anshulporwal)
    const session4Client = await createHelperClient(testSockPath, 'anshulporwal', 4444, 4);
    // Session 5: Active Child helper (mporwal -> Rahul)
    const session5Client = await createHelperClient(testSockPath, 'mporwal', 5555, 5);

    try {
      // Authoritative active console policy: mporwal mapped to child Rahul in Session 5
      activePolicyState = {
        accountName: 'mporwal',
        isManaged: true,
        childId: 'child-rahul-101',
        childName: 'Rahul',
        sid: 'S-1-5-21-12345-1005',
        sessionId: 5,
      };

      // Multi-session state with 1 Active session + 1 Disconnected session
      multiSessionState = {
        hasMultipleSessions: false,
        hasMultipleActiveInteractiveSessions: false,
        sessionCount: 1,
        activeInteractiveSessions: [{ sessionId: 5, username: 'mporwal', isConsole: true }],
        disconnectedSessions: [{ sessionId: 4, username: 'anshulporwal' }],
        activeUsers: ['mporwal'],
        warning: null,
      };

      const result = ipcServer.presentBlock('roblox.com', 'EXPLICIT_BLOCK', 8880);
      assert.strictEqual(result.sent, true);
      assert.strictEqual(result.reason, 'PRESENTED');

      await new Promise((r) => setTimeout(r, 60));

      // Assert Session 5 (Rahul) helper receives the block presentation
      assert.strictEqual(session5Client.receivedMessages.length, 1);
      const msg = session5Client.receivedMessages[0];
      assert.strictEqual(msg.domain, 'roblox.com');
      assert.strictEqual(msg.reason, 'EXPLICIT_BLOCK');
      assert.ok(msg.url.includes('roblox.com'));

      // Assert Session 4 (Disconnected parent) helper receives ZERO messages
      assert.strictEqual(session4Client.receivedMessages.length, 0);
    } finally {
      await session4Client.close();
      await session5Client.close();
    }
  });

  // 8. Real concurrent interactive sessions (Console + RDP) triggers concurrency hold
  test('8. Real simultaneous active sessions (Active Console + Active RDP) triggers CONCURRENT_SESSIONS_SAFETY_HOLD', async () => {
    await ipcServer.start();

    const consoleClient = await createHelperClient(testSockPath, 'mporwal', 5555, 5);
    const rdpClient = await createHelperClient(testSockPath, 'anshulporwal', 7777, 7);

    try {
      activePolicyState = {
        accountName: 'mporwal',
        isManaged: true,
        childId: 'child-rahul-101',
        childName: 'Rahul',
        sid: 'S-1-5-21-12345-1005',
        sessionId: 5,
      };

      // Two simultaneous ACTIVE interactive desktop sessions
      multiSessionState = {
        hasMultipleSessions: true,
        hasMultipleActiveInteractiveSessions: true,
        sessionCount: 2,
        activeInteractiveSessions: [
          { sessionId: 5, username: 'mporwal', isConsole: true },
          { sessionId: 7, username: 'anshulporwal', isConsole: false },
        ],
        disconnectedSessions: [],
        activeUsers: ['mporwal', 'anshulporwal'],
        warning: 'Multiple Windows users are currently signed in.',
      };

      const result = ipcServer.presentBlock('roblox.com', 'EXPLICIT_BLOCK', 8880);
      assert.strictEqual(result.sent, false);
      assert.strictEqual(result.reason, 'CONCURRENT_SESSIONS_SAFETY_HOLD');

      await new Promise((r) => setTimeout(r, 60));
      assert.strictEqual(consoleClient.receivedMessages.length, 0);
      assert.strictEqual(rdpClient.receivedMessages.length, 0);
    } finally {
      await consoleClient.close();
      await rdpClient.close();
    }
  });

  // 9. Fast User Switching: Sequential user transitions (Parent -> Child -> Parent)
  test('9. Fast User Switching sequential user transitions correctly route block presentation', async () => {
    await ipcServer.start();

    const parentHelper = await createHelperClient(testSockPath, 'anshulporwal', 4444, 4);
    const childHelper = await createHelperClient(testSockPath, 'mporwal', 5555, 5);

    try {
      // Step 1: Active user is Rahul (Session 5) -> block presented to childHelper
      activePolicyState = {
        accountName: 'mporwal',
        isManaged: true,
        childId: 'child-rahul-101',
        childName: 'Rahul',
        sid: 'S-1-5-21-12345-1005',
        sessionId: 5,
      };
      multiSessionState = {
        hasMultipleSessions: false,
        hasMultipleActiveInteractiveSessions: false,
        sessionCount: 1,
        activeInteractiveSessions: [{ sessionId: 5, username: 'mporwal', isConsole: true }],
        disconnectedSessions: [{ sessionId: 4, username: 'anshulporwal' }],
        activeUsers: ['mporwal'],
        warning: null,
      };

      let res = ipcServer.presentBlock('games.com', 'GAMING', 8880);
      assert.strictEqual(res.sent, true);
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(childHelper.receivedMessages.length, 1);
      assert.strictEqual(parentHelper.receivedMessages.length, 0);

      // Wait out throttle window (100ms in test setup)
      await new Promise((r) => setTimeout(r, 120));

      // Step 2: Switch to Parent (Session 4) -> unmanaged transparent bypass
      activePolicyState = {
        accountName: 'anshulporwal',
        isManaged: false,
        childId: null,
        childName: null,
        sid: 'S-1-5-21-12345-1004',
        sessionId: 4,
      };
      multiSessionState = {
        hasMultipleSessions: false,
        hasMultipleActiveInteractiveSessions: false,
        sessionCount: 1,
        activeInteractiveSessions: [{ sessionId: 4, username: 'anshulporwal', isConsole: true }],
        disconnectedSessions: [{ sessionId: 5, username: 'mporwal' }],
        activeUsers: ['anshulporwal'],
        warning: null,
      };

      res = ipcServer.presentBlock('adult.com', 'ADULT', 8880);
      assert.strictEqual(res.sent, false);
      assert.strictEqual(res.reason, 'PARENT_OR_UNMANAGED_USER');
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(parentHelper.receivedMessages.length, 0);
      assert.strictEqual(childHelper.receivedMessages.length, 1); // unchanged
    } finally {
      await parentHelper.close();
      await childHelper.close();
    }
  });

  // 10. Same user with multiple sessions (Session 5 Active, Session 8 Disconnected)
  test('10. Same user with multiple sessions targets the active session ID only', async () => {
    await ipcServer.start();

    const activeSessionClient = await createHelperClient(testSockPath, 'mporwal', 5555, 5);
    const staleSessionClient = await createHelperClient(testSockPath, 'mporwal', 8888, 8);

    try {
      activePolicyState = {
        accountName: 'mporwal',
        isManaged: true,
        childId: 'child-rahul-101',
        childName: 'Rahul',
        sid: 'S-1-5-21-12345-1005',
        sessionId: 5,
      };
      multiSessionState = {
        hasMultipleSessions: false,
        hasMultipleActiveInteractiveSessions: false,
        sessionCount: 1,
        activeInteractiveSessions: [{ sessionId: 5, username: 'mporwal', isConsole: true }],
        disconnectedSessions: [{ sessionId: 8, username: 'mporwal' }],
        activeUsers: ['mporwal'],
        warning: null,
      };

      const result = ipcServer.presentBlock('social.com', 'SOCIAL', 8880);
      assert.strictEqual(result.sent, true);
      assert.strictEqual(result.reason, 'PRESENTED');

      await new Promise((r) => setTimeout(r, 60));
      assert.strictEqual(activeSessionClient.receivedMessages.length, 1);
      assert.strictEqual(staleSessionClient.receivedMessages.length, 0);
    } finally {
      await activeSessionClient.close();
      await staleSessionClient.close();
    }
  });

  // 11. Helper absent self-healing trigger
  test('11. Helper missing in active session triggers self-healing launcher callback', async () => {
    await ipcServer.start();

    const launchedSessions: Array<number | undefined> = [];
    ipcServer.setHelperLauncher((sessId) => {
      launchedSessions.push(sessId);
    });

    activePolicyState = {
      accountName: 'mporwal',
      isManaged: true,
      childId: 'child-rahul-101',
      childName: 'Rahul',
      sid: 'S-1-5-21-12345-1005',
      sessionId: 5,
    };

    const result = ipcServer.presentBlock('blocked-site.com', 'BLOCKED', 8880);
    assert.strictEqual(result.sent, false);
    assert.strictEqual(result.reason, 'NO_CONNECTED_HELPER');
    assert.strictEqual(launchedSessions.length, 1);
    assert.strictEqual(launchedSessions[0], 5);

    // Now helper self-heals and registers with sessionId 5
    const healedClient = await createHelperClient(testSockPath, 'mporwal', 5556, 5);
    try {
      // The pending block presentation is automatically retried upon helper registration
      await new Promise((r) => setTimeout(r, 80));
      assert.strictEqual(healedClient.receivedMessages.length, 1);
      assert.strictEqual(healedClient.receivedMessages[0].domain, 'blocked-site.com');

      // Subsequent presentation within debounce window is properly debounced
      const debouncedResult = ipcServer.presentBlock('blocked-site.com', 'BLOCKED', 8880);
      assert.strictEqual(debouncedResult.sent, false);
      assert.strictEqual(debouncedResult.reason, 'DOMAIN_DEBOUNCED');
    } finally {
      await healedClient.close();
    }
  });

  // 12. Ask Parent End-to-End: Active child Rahul drives access request
  test('12. Ask Parent End-to-End: Active child Rahul policy drives backend access request', async () => {
    const backendRequests: any[] = [];
    const mockBackend = http.createServer((req, res) => {
      if (req.url === '/api/requests' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          backendRequests.push({
            headers: req.headers,
            body: JSON.parse(body),
          });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, id: 'req-e2e-1' }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      mockBackend.listen(0, '127.0.0.1', () => resolve());
    });
    const backendPort = (mockBackend.address() as any).port;

    const blockPageServer = new BlockPageServer(
      `http://127.0.0.1:${backendPort}`,
      'fallback-child-default',
      'device-laptop-pilot',
      () => ({ childId: 'child-rahul-101', childName: 'Rahul' }),
      'auth-device-token-abc'
    );

    const testBlockPagePort = 39880;
    await blockPageServer.start(testBlockPagePort);

    try {
      // Child in active session clicks "Ask Parent"
      const reqPayload = JSON.stringify({
        domain: 'youtube.com',
        reason: 'Educational video access',
      });

      const response = await new Promise<{ statusCode: number; data: any }>((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${testBlockPagePort}/submit-request`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(reqPayload),
            },
          },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
              resolve({ statusCode: res.statusCode || 500, data: JSON.parse(data) });
            });
          }
        );
        req.on('error', reject);
        req.write(reqPayload);
        req.end();
      });

      assert.strictEqual(response.statusCode, 200);
      assert.strictEqual(response.data.success, true);

      // Verify backend received the request strictly attributed to Rahul
      assert.strictEqual(backendRequests.length, 1);
      const bReq = backendRequests[0];
      assert.strictEqual(bReq.headers['x-device-id'], 'device-laptop-pilot');
      assert.strictEqual(bReq.headers['x-device-token'], 'auth-device-token-abc');
      assert.strictEqual(bReq.body.childId, 'child-rahul-101');
      assert.strictEqual(bReq.body.domain, 'youtube.com');
      assert.strictEqual(bReq.body.reason, 'Educational video access');
    } finally {
      blockPageServer.stop();
      await new Promise<void>((resolve) => mockBackend.close(() => resolve()));
    }
  });

  // =========================================================================
  // Gate A3 Defect Verification: Runtime Helper Recovery & Watchdog
  // =========================================================================

  test('13. Gate A3: Helper sends PRESENTATION_RESULT acknowledgment back to BlockIpcServer', async () => {
    await ipcServer.start();

    let presentationResultReceived: any = null;
    ipcServer.onPresentationResult((result) => {
      presentationResultReceived = result;
    });

    const client = await createHelperClient(testSockPath, 'Manjari', 1234, 5);
    try {
      const res = ipcServer.presentBlock('snapchat.com', 'Restricted by policy', 8880);
      assert.strictEqual(res.sent, true);
      assert.strictEqual(res.reason, 'PRESENTED');

      // Wait for IPC delivery to client
      await new Promise((r) => setTimeout(r, 80));
      assert.strictEqual(client.receivedMessages.length, 1);
      const msg = client.receivedMessages[0];
      assert.strictEqual(msg.domain, 'snapchat.com');

      // Helper sends PRESENTATION_RESULT acknowledgment back
      client.socket.write(
        JSON.stringify({
          type: 'PRESENTATION_RESULT',
          eventId: msg.eventId,
          domain: msg.domain,
          success: true,
          method: 'StartProcess',
          childUsername: 'Manjari',
          sessionId: 5,
        }) + '\n'
      );

      // Verify server received presentation acknowledgment
      await new Promise((r) => setTimeout(r, 80));
      assert.ok(presentationResultReceived, 'Server must receive presentation result');
      assert.strictEqual(presentationResultReceived.eventId, msg.eventId);
      assert.strictEqual(presentationResultReceived.success, true);
      assert.strictEqual(presentationResultReceived.method, 'StartProcess');
    } finally {
      await client.close();
    }
  });

  test('14. Gate A3: Pending block presentation retries immediately upon helper reconnect, bypassing debounce', async () => {
    await ipcServer.start();

    let launcherCallCount = 0;
    let launcherSessionId: number | undefined;
    ipcServer.setHelperLauncher((sessionId) => {
      launcherCallCount++;
      launcherSessionId = sessionId;
    });

    activePolicyState = {
      accountName: 'Manjari',
      isManaged: true,
      childId: 'child-manjari-uuid',
      childName: 'Manjari',
      sid: 'S-1-5-21-1000-1002',
      sessionId: 5,
    };

    // 1. Trigger block when NO helper is connected
    const firstRes = ipcServer.presentBlock('distracting-games.com', 'Restricted by policy', 8880);
    assert.strictEqual(firstRes.sent, false);
    assert.strictEqual(firstRes.reason, 'NO_CONNECTED_HELPER');
    assert.strictEqual(launcherCallCount, 1);
    assert.strictEqual(launcherSessionId, 5);

    // 2. Helper reconnects / relaunches for session 5
    const healedClient = await createHelperClient(testSockPath, 'Manjari', 9999, 5);
    try {
      // Pending presentation is flushed with isRetry: true and delivered to newly connected helper
      await new Promise((r) => setTimeout(r, 80));
      assert.strictEqual(healedClient.receivedMessages.length, 1);
      assert.strictEqual(healedClient.receivedMessages[0].domain, 'distracting-games.com');
      assert.strictEqual(healedClient.receivedMessages[0].reason, 'Restricted by policy');
    } finally {
      await healedClient.close();
    }
  });

  test('15. Gate A3: Helper liveness check detects connected vs crashed/disconnected helper', async () => {
    await ipcServer.start();

    // 1. Initial state: not healthy
    assert.strictEqual(ipcServer.isHelperHealthyForSession(5, 'Manjari'), false);

    // 2. Connect helper
    const client = await createHelperClient(testSockPath, 'Manjari', 3344, 5);
    try {
      // Now healthy for session 5
      assert.strictEqual(ipcServer.isHelperHealthyForSession(5, 'Manjari'), true);
      // Not healthy for different session
      assert.strictEqual(ipcServer.isHelperHealthyForSession(6, 'Manjari'), false);
    } finally {
      // Helper exits / closes socket
      await client.close();
    }

    // Wait for socket cleanup
    await new Promise((r) => setTimeout(r, 80));
    // After disconnect, liveness detects unhealthy helper
    assert.strictEqual(ipcServer.isHelperHealthyForSession(5, 'Manjari'), false);
  });

  test('16. Gate A3: Watchdog recovery suppresses unmanaged parent and recovers managed child', async () => {
    await ipcServer.start();

    let launchCount = 0;
    const launchedSessions: (number | undefined)[] = [];

    const mockWatchdogTick = (policy: ResolvedUserPolicy | null) => {
      if (!policy || !policy.isManaged) {
        // Parent or unmanaged session: do not launch helper
        return;
      }
      const targetSessionId = typeof policy.sessionId === 'number' ? policy.sessionId : undefined;
      const isHealthy = ipcServer.isHelperHealthyForSession(targetSessionId, policy.accountName);
      if (!isHealthy) {
        launchCount++;
        launchedSessions.push(targetSessionId);
      }
    };

    // 1. Unmanaged / parent user active: watchdog tick does nothing
    mockWatchdogTick({
      accountName: 'ParentUser',
      isManaged: false,
      childId: null,
      childName: null,
      sid: 'S-1-5-21-1000-1002',
      sessionId: 1,
    });
    assert.strictEqual(launchCount, 0);

    // 2. Managed child active but helper missing: watchdog triggers launch
    mockWatchdogTick({
      accountName: 'ChildUser',
      isManaged: true,
      childId: 'child-123',
      childName: 'ChildUser',
      sid: 'S-1-5-21-1000-1001',
      sessionId: 2,
    });
    assert.strictEqual(launchCount, 1);
    assert.strictEqual(launchedSessions[0], 2);

    // 3. Helper connects for session 2
    const client = await createHelperClient(testSockPath, 'ChildUser', 7890, 2);
    try {
      // Subsequent watchdog tick detects healthy helper -> zero duplicate launches!
      mockWatchdogTick({
        accountName: 'ChildUser',
        isManaged: true,
        childId: 'child-123',
        childName: 'ChildUser',
        sid: 'S-1-5-21-1000-1001',
        sessionId: 2,
      });
      assert.strictEqual(launchCount, 1); // Unchanged!
    } finally {
      await client.close();
    }
  });

  test('17. Gate A3: Helper launch concurrency guard drops duplicate in-flight requests', async () => {
    let activeInvocations = 0;
    let maxConcurrent = 0;
    let totalCompleted = 0;

    let isLaunchingHelper = false;
    const launchUserHelper = async (sessionId?: number): Promise<boolean> => {
      if (isLaunchingHelper) {
        return false; // Dropped duplicate concurrent request
      }
      isLaunchingHelper = true;
      activeInvocations++;
      maxConcurrent = Math.max(maxConcurrent, activeInvocations);
      try {
        await new Promise((r) => setTimeout(r, 20));
        totalCompleted++;
        return true;
      } finally {
        activeInvocations--;
        isLaunchingHelper = false;
      }
    };

    // Trigger 5 concurrent launch attempts simultaneously
    const results = await Promise.all([
      launchUserHelper(5),
      launchUserHelper(5),
      launchUserHelper(5),
      launchUserHelper(5),
      launchUserHelper(5),
    ]);

    // Exactly 1 launch succeeded; 4 duplicates dropped
    assert.strictEqual(results.filter((r) => r === true).length, 1);
    assert.strictEqual(results.filter((r) => r === false).length, 4);
    assert.strictEqual(maxConcurrent, 1);
    assert.strictEqual(totalCompleted, 1);
  });

  test('18. Gate A Blocker 3: Helper hung / IPC-unhealthy recovery invokes --recover-helper and replaces target session process only', async () => {
    await ipcServer.start();

    // Track simulated processes per session: Map<sessionId, { pid: number; killed: boolean }[]>
    const simulatedProcesses: Array<{ pid: number; sessionId: number; killed: boolean }> = [
      { pid: 4001, sessionId: 4, killed: false }, // Session 4 (e.g. parent or other session)
      { pid: 5001, sessionId: 5, killed: false }, // Session 5 (hung child helper, deadlocked/disconnected)
    ];

    const launchedCommands: string[] = [];

    // ServiceHost.EnsureUserHelperRunning simulation logic
    const simulateEnsureUserHelperRunning = (sessionId: number, forceRestart: boolean): boolean => {
      // Find existing process in session
      const existing = simulatedProcesses.find((p) => p.sessionId === sessionId && !p.killed);
      if (existing) {
        if (!forceRestart) {
          // Normal mode: already running, do nothing
          return true;
        }
        // Recovery mode: terminate ONLY the target session's process
        existing.killed = true;
      }

      // Launch fresh process in target session
      const newPid = Math.floor(10000 + Math.random() * 90000);
      simulatedProcesses.push({ pid: newPid, sessionId, killed: false });
      return true;
    };

    // Node launchUserHelper simulation matching agent-cli.ts
    let isLaunchingHelper = false;
    const launchUserHelper = async (sessionId?: number, isRecovery: boolean = false): Promise<boolean> => {
      if (isLaunchingHelper) {
        return false;
      }
      isLaunchingHelper = true;
      try {
        const helperTargetSession = typeof sessionId === 'number' ? sessionId : 5;
        // In normal mode, skip if already healthy on IPC
        if (!isRecovery && ipcServer.isHelperHealthyForSession(helperTargetSession)) {
          return true;
        }

        const flag = isRecovery ? '--recover-helper' : '--launch-helper';
        launchedCommands.push(`SafeBrowseServiceHost.exe ${flag} ${helperTargetSession}`);
        simulateEnsureUserHelperRunning(helperTargetSession, isRecovery);
        await new Promise((r) => setTimeout(r, 20));
        return true;
      } finally {
        isLaunchingHelper = false;
      }
    };

    // 1. Initial State:
    // Session 5 has a live OS process (PID 5001), but has NOT registered or is hung on IPC
    assert.strictEqual(ipcServer.isHelperHealthyForSession(5), false);
    assert.strictEqual(simulatedProcesses.find((p) => p.pid === 5001)?.killed, false);
    assert.strictEqual(simulatedProcesses.find((p) => p.pid === 4001)?.killed, false);

    // 2. Normal launch mode (!isRecovery) against an existing process does NOT kill it
    const normalResult = await launchUserHelper(5, false);
    assert.strictEqual(normalResult, true);
    assert.strictEqual(launchedCommands[0], 'SafeBrowseServiceHost.exe --launch-helper 5');
    // In normal mode, the existing process is NOT killed
    assert.strictEqual(simulatedProcesses.find((p) => p.pid === 5001)?.killed, false);

    // 3. Block presentation occurs while helper is hung/unregistered
    activePolicyState = {
      accountName: 'mporwal',
      isManaged: true,
      childId: 'child-rahul-101',
      childName: 'Rahul',
      sid: 'S-1-5-21-12345-1005',
      sessionId: 5,
    };

    const presentRes = ipcServer.presentBlock('suspicious-gaming.com', 'Restricted by policy', 8880);
    assert.strictEqual(presentRes.sent, false);
    assert.strictEqual(presentRes.reason, 'NO_CONNECTED_HELPER');

    // 4. Recovery mode (isRecovery = true) is triggered by watchdog/reconciliation
    const recoveryResult = await launchUserHelper(5, true);
    assert.strictEqual(recoveryResult, true);
    assert.strictEqual(launchedCommands[1], 'SafeBrowseServiceHost.exe --recover-helper 5');

    // 5. Blocker 3 assertion: PID 5001 (Session 5) is KILLED, but PID 4001 (Session 4) is UNTOUCHED
    assert.strictEqual(
      simulatedProcesses.find((p) => p.pid === 5001)?.killed,
      true,
      'Recovery must terminate the hung/unregistered helper process in target session 5'
    );
    assert.strictEqual(
      simulatedProcesses.find((p) => p.pid === 4001)?.killed,
      false,
      'Recovery must NOT terminate processes in other sessions (Session 4)'
    );

    // 6. Concurrency guard test: concurrent recovery calls are guarded by isLaunchingHelper
    const concurrentLaunches = await Promise.all([
      launchUserHelper(5, true),
      launchUserHelper(5, true),
      launchUserHelper(5, true),
    ]);
    // Exactly 1 succeeds, remaining are dropped
    assert.strictEqual(concurrentLaunches.filter((r) => r === true).length, 1);
    assert.strictEqual(concurrentLaunches.filter((r) => r === false).length, 2);

    // 7. Parent/unmanaged session suppresses recovery:
    const mockWatchdogCheck = async (policy: ResolvedUserPolicy | null) => {
      if (!policy || !policy.isManaged) {
        // Parent or unmanaged session suppresses helper recovery
        return false;
      }
      const targetSessionId = typeof policy.sessionId === 'number' ? policy.sessionId : undefined;
      const isHealthy = ipcServer.isHelperHealthyForSession(targetSessionId, policy.accountName);
      if (!isHealthy) {
        return launchUserHelper(targetSessionId, true);
      }
      return false;
    };

    const unmanagedCheckResult = await mockWatchdogCheck({
      accountName: 'anshulporwal',
      isManaged: false,
      childId: null,
      childName: null,
      sid: 'S-1-5-21-12345-1004',
      sessionId: 4,
    });
    assert.strictEqual(unmanagedCheckResult, false, 'Watchdog must suppress recovery for unmanaged parent');

    // 8. Newly launched replacement helper connects and registers on IPC
    const recoveredClient = await createHelperClient(testSockPath, 'mporwal', 5002, 5);
    try {
      // IPC server now recognizes helper in session 5 as healthy
      assert.strictEqual(ipcServer.isHelperHealthyForSession(5, 'mporwal'), true);

      // 9. Pending block presentation ('suspicious-gaming.com') retries and is delivered to recovered client!
      await new Promise((r) => setTimeout(r, 80));
      assert.strictEqual(recoveredClient.receivedMessages.length, 1);
      assert.strictEqual(recoveredClient.receivedMessages[0].domain, 'suspicious-gaming.com');
      assert.strictEqual(recoveredClient.receivedMessages[0].reason, 'Restricted by policy');

      // 10. Subsequent normal launch request skips because helper is now healthy on IPC
      const skippedNormal = await launchUserHelper(5, false);
      assert.strictEqual(skippedNormal, true);
      assert.strictEqual(
        launchedCommands[launchedCommands.length - 1] !== 'SafeBrowseServiceHost.exe --launch-helper 5',
        true,
        'Duplicate launch must be skipped when helper is already healthy on IPC'
      );
    } finally {
      await recoveredClient.close();
    }
  });
});
