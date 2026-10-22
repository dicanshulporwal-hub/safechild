process.env.NODE_ENV = 'test';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as net from 'net';
import {
  BlockIpcServer,
  BlockPresentationMessage,
  HelperRegisterAck,
} from '../src/block-ipc';
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
    pid: number = 1234
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
        const regMsg = JSON.stringify({
          type: 'REGISTER_HELPER',
          version: '1.0.4-validation',
          accountName,
          pid,
        }) + '\n';
        socket.write(regMsg);
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
});
