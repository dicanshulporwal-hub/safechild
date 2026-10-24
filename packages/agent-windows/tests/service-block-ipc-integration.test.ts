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
      // Clear debounce by waiting debounce window (500ms in test)
      await new Promise((r) => setTimeout(r, 550));

      const retryResult = ipcServer.presentBlock('blocked-site.com', 'BLOCKED', 8880);
      assert.strictEqual(retryResult.sent, true);
      assert.strictEqual(retryResult.reason, 'PRESENTED');

      await new Promise((r) => setTimeout(r, 60));
      assert.strictEqual(healedClient.receivedMessages.length, 1);
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
});
