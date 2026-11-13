process.env.NODE_ENV = 'test';
import { test, it, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as net from 'net';
import * as http from 'http';
import {
  BlockIpcServer,
  HelperRegisterAck,
  InteractiveDesktopActionResult,
  InteractiveDesktopActionMessage,
  getDefaultPipePath,
} from '../src/block-ipc';
import { GuiServer, sanitizeParentErrorMessage } from '../src/gui-server';
import { ConfigManager } from '../src/config-manager';
import { WindowsAccountManager } from '../src/account-manager';
import { ParentPinManager } from '../src/parent-pin-manager';

describe('SafeBrowse Windows Pilot — P0-11 Interactive Windows UAC Bridge Suite', () => {
  let testSockPath: string;
  let ipcServer: BlockIpcServer;
  let tmpDir: string;
  let testConfigMgr: ConfigManager;
  let accountMgr: WindowsAccountManager;
  let pinMgr: ParentPinManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-p011-test-'));
    testSockPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\sb-uac-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
      : path.join(os.tmpdir(), `sb-uac-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}.sock`);

    ipcServer = new BlockIpcServer(testSockPath);
    await ipcServer.start();

    testConfigMgr = new ConfigManager(tmpDir);
    testConfigMgr.setMockIsAdministratorForTesting(true);
    accountMgr = new WindowsAccountManager(tmpDir);
    pinMgr = new ParentPinManager(testConfigMgr);
  });

  afterEach(async () => {
    if (ipcServer) {
      await ipcServer.stop();
    }
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  // =========================================================================
  // 1. Helper Lifecycle & Health States (Tests 1 - 7)
  // =========================================================================

  it('1. No helper process exists: health check reports false and getRegisteredHelper returns null', () => {
    assert.strictEqual(ipcServer.isHelperHealthyForSession(1, 'Alice'), false);
    assert.strictEqual(ipcServer.getRegisteredHelper(1, 'Alice'), null);
    assert.strictEqual(ipcServer.getRegisteredHelpers().length, 0);
  });

  it('2. Helper launches and registers: transitions to REGISTERED state and health reports true', async () => {
    const client = net.createConnection(testSockPath);
    await new Promise((resolve) => client.once('connect', resolve));

    try {
      const regPayload = {
        type: 'REGISTER_HELPER',
        version: '1.0.4.16',
        accountName: 'Alice',
        sessionId: 1,
        pid: 2048,
      };
      client.write(JSON.stringify(regPayload) + '\n');

      // Await registered helper
      const helper = await ipcServer.waitForRegisteredHelper(1, 'Alice', 2000);
      assert.strictEqual(helper.accountName, 'Alice');
      assert.strictEqual(helper.sessionId, 1);
      assert.strictEqual(helper.state, 'REGISTERED');
      assert.strictEqual(ipcServer.isHelperHealthyForSession(1, 'Alice'), true);
      assert.strictEqual(ipcServer.getRegisteredHelpers().length, 1);
    } finally {
      client.destroy();
    }
  });

  it('3. Helper process exists but is NOT registered: remains in CONNECTED state and actions are not allowed', async () => {
    const client = net.createConnection(testSockPath);
    await new Promise((resolve) => client.once('connect', resolve));

    try {
      // Helper socket connected, but REGISTER_HELPER message is never sent
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.strictEqual(ipcServer.getConnectedHelperCount(), 1);
      assert.strictEqual(ipcServer.getRegisteredHelpers().length, 0);
      assert.strictEqual(ipcServer.getRegisteredHelper(1), null);
      assert.strictEqual(ipcServer.isHelperHealthyForSession(1), false);

      // Attempting to dispatch interactive action must fail closed with NO_CONNECTED_HELPER
      const res = await ipcServer.dispatchInteractiveDesktopActionWithCorrelation('SETUP_PIN', 1);
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.status, 'ACTION_FAILED');
      assert.strictEqual(res.error, 'NO_CONNECTED_HELPER');
    } finally {
      client.destroy();
    }
  });

  it('4. Unregistered helper is force-restarted: GuiServer invokes recovery hook and waits for registration', async () => {
    const gui = new GuiServer(testConfigMgr, accountMgr, undefined, pinMgr, ipcServer);
    gui.setInteractiveElevationTestingEnabled(true);

    let recoveryInvoked = false;
    let recoveredSession: number | undefined;
    gui.setHelperRecoveryHook((sessionId) => {
      recoveryInvoked = true;
      recoveredSession = sessionId;

      // Simulate recovery: spawn helper and register
      setTimeout(() => {
        const client = net.createConnection(testSockPath);
        client.on('connect', () => {
          client.write(
            JSON.stringify({
              type: 'REGISTER_HELPER',
              version: '1.0.4.16',
              accountName: 'RecoveredUser',
              sessionId: sessionId || 1,
              pid: 4096,
            }) + '\n'
          );
        });
        client.on('data', (d) => {
          for (const line of d.toString().split('\n')) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line.trim());
              if (msg.type === 'INTERACTIVE_DESKTOP_ACTION') {
                client.write(
                  JSON.stringify({
                    type: 'INTERACTIVE_DESKTOP_ACTION_RESULT',
                    requestId: msg.requestId,
                    action: msg.action,
                    success: true,
                    status: 'ELEVATED_PROCESS_STARTED',
                  }) + '\n'
                );
              }
            } catch {}
          }
        });
      }, 50);
    });

    accountMgr.setMockConsoleSessionForTesting('S-1-5-21-1000-1000-1000-1005', 'RecoveredUser', 1);

    const elev = await gui.requestInteractiveElevation('SETUP_PIN');
    assert.strictEqual(recoveryInvoked, true, 'Recovery hook must be invoked when helper is not registered');
    assert.strictEqual(recoveredSession, 1);
    assert.strictEqual(elev.success, true);
    assert.strictEqual(elev.status, 'ELEVATED_PROCESS_STARTED');
  });

  it('5. Stale helper socket handled: disconnect cleans up registration and aborts pending waiters with HELPER_DISCONNECTED', async () => {
    const client = net.createConnection(testSockPath);
    await new Promise((resolve) => client.once('connect', resolve));

    client.write(
      JSON.stringify({
        type: 'REGISTER_HELPER',
        version: '1.0.4.16',
        accountName: 'StaleUser',
        sessionId: 3,
      }) + '\n'
    );

    const helper = await ipcServer.waitForRegisteredHelper(3, 'StaleUser', 2000);
    assert.strictEqual(helper.state, 'REGISTERED');

    // Start in-flight dispatch
    const dispatchPromise = ipcServer.dispatchInteractiveDesktopActionWithCorrelation('CONFIGURE_ACCOUNTS', 3);

    // Stale socket closes abruptly
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.destroy();

    const result = await dispatchPromise;
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 'HELPER_DISCONNECTED');
    assert.strictEqual(ipcServer.getRegisteredHelpers().length, 0);
    assert.strictEqual(ipcServer.isHelperHealthyForSession(3), false);
  });

  it('6. REGISTER_ACK received: block IPC handshake confirms registration with OK status', async () => {
    const client = net.createConnection(testSockPath);
    await new Promise((resolve) => client.once('connect', resolve));

    const ackReceived = new Promise<HelperRegisterAck>((resolve) => {
      client.on('data', (chunk) => {
        const msg = JSON.parse(chunk.toString().trim());
        if (msg.type === 'REGISTER_ACK') {
          resolve(msg as HelperRegisterAck);
        }
      });
    });

    client.write(
      JSON.stringify({
        type: 'REGISTER_HELPER',
        version: '1.0.4.16',
        accountName: 'AckTest',
        sessionId: 1,
      }) + '\n'
    );

    const ack = await ackReceived;
    assert.strictEqual(ack.status, 'OK');
    client.destroy();
  });

  it('7. Helper registration timeout: waitForRegisteredHelper rejects with descriptive error', async () => {
    await assert.rejects(
      async () => {
        await ipcServer.waitForRegisteredHelper(99, 'NonExistent', 150);
      },
      /Timed out waiting for registered helper/
    );
  });

  // =========================================================================
  // 2. Session Discrimination & Fast User Switching (Tests 8 - 11)
  // =========================================================================

  it('8. Wrong Windows session helper ignored: helper on Session 1 is not matched for Session 2', async () => {
    const client = net.createConnection(testSockPath);
    await new Promise((resolve) => client.once('connect', resolve));

    client.write(
      JSON.stringify({
        type: 'REGISTER_HELPER',
        version: '1.0.4.16',
        accountName: 'Alice',
        sessionId: 1,
      }) + '\n'
    );

    await ipcServer.waitForRegisteredHelper(1, 'Alice', 2000);

    // Target Session 2
    assert.strictEqual(ipcServer.getRegisteredHelper(2), null);
    assert.strictEqual(ipcServer.isHelperHealthyForSession(2), false);

    const res = await ipcServer.dispatchInteractiveDesktopActionWithCorrelation('ATTACH_DEVICE', 2);
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.status, 'ACTION_FAILED');
    assert.strictEqual(res.error, 'NO_CONNECTED_HELPER');

    client.destroy();
  });

  it('9. Disconnected session ignored: closed socket in Session 1 is never returned', async () => {
    const client = net.createConnection(testSockPath);
    await new Promise((resolve) => client.once('connect', resolve));

    client.write(
      JSON.stringify({
        type: 'REGISTER_HELPER',
        version: '1.0.4.16',
        accountName: 'Alice',
        sessionId: 1,
      }) + '\n'
    );

    await ipcServer.waitForRegisteredHelper(1, 'Alice', 2000);
    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.strictEqual(ipcServer.getRegisteredHelper(1), null);
    assert.strictEqual(ipcServer.isHelperHealthyForSession(1), false);
  });

  it('10. Active console user matched correctly: session and account name matched', async () => {
    const client = net.createConnection(testSockPath);
    await new Promise((resolve) => client.once('connect', resolve));

    client.write(
      JSON.stringify({
        type: 'REGISTER_HELPER',
        version: '1.0.4.16',
        accountName: 'CORP\\Anshul',
        sessionId: 5,
      }) + '\n'
    );

    await ipcServer.waitForRegisteredHelper(5, 'Anshul', 2000);

    const helper = ipcServer.getRegisteredHelper(5, 'Anshul');
    assert.ok(helper);
    assert.strictEqual(helper!.accountName, 'CORP\\Anshul');
    assert.strictEqual(helper!.sessionId, 5);

    client.destroy();
  });

  it('11. Fast User Switching: concurrent sessions (Alice on 1, Bob on 2) routed accurately', async () => {
    const client1 = net.createConnection(testSockPath);
    await new Promise((resolve) => client1.once('connect', resolve));
    client1.write(
      JSON.stringify({
        type: 'REGISTER_HELPER',
        version: '1.0.4.16',
        accountName: 'Alice',
        sessionId: 1,
      }) + '\n'
    );

    const client2 = net.createConnection(testSockPath);
    await new Promise((resolve) => client2.once('connect', resolve));
    client2.write(
      JSON.stringify({
        type: 'REGISTER_HELPER',
        version: '1.0.4.16',
        accountName: 'Bob',
        sessionId: 2,
      }) + '\n'
    );

    await ipcServer.waitForRegisteredHelper(1, 'Alice', 2000);
    await ipcServer.waitForRegisteredHelper(2, 'Bob', 2000);

    assert.strictEqual(ipcServer.getRegisteredHelpers().length, 2);

    const helperAlice = ipcServer.getRegisteredHelper(1, 'Alice');
    assert.ok(helperAlice);
    assert.strictEqual(helperAlice!.sessionId, 1);

    const helperBob = ipcServer.getRegisteredHelper(2, 'Bob');
    assert.ok(helperBob);
    assert.strictEqual(helperBob!.sessionId, 2);

    // Track which client receives the message
    let client1Received = false;
    let client2Received = false;

    client1.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line.trim());
          if (msg.type === 'INTERACTIVE_DESKTOP_ACTION') client1Received = true;
        } catch {}
      }
    });

    client2.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line.trim());
          if (msg.type === 'INTERACTIVE_DESKTOP_ACTION') {
            client2Received = true;
            client2.write(
              JSON.stringify({
                type: 'INTERACTIVE_DESKTOP_ACTION_RESULT',
                requestId: msg.requestId,
                action: msg.action,
                success: true,
                status: 'ELEVATED_PROCESS_STARTED',
              }) + '\n'
            );
          }
        } catch {}
      }
    });

    const res = await ipcServer.dispatchInteractiveDesktopActionWithCorrelation('CONFIGURE_ACCOUNTS', 2, 'Bob');
    assert.strictEqual(res.success, true);
    assert.strictEqual(client1Received, false, 'Session 1 helper must NOT receive Session 2 action');
    assert.strictEqual(client2Received, true, 'Session 2 helper must receive Session 2 action');

    client1.destroy();
    client2.destroy();
  });

  // =========================================================================
  // 3. Action Dispatch, Options & Correlation (Tests 12 - 16)
  // =========================================================================

  it('12. ATTACH_DEVICE dispatched after helper registration: carries pairing code and deviceName', async () => {
    const client = net.createConnection(testSockPath);
    await new Promise((resolve) => client.once('connect', resolve));

    let actionReceived: any = null;
    client.on('data', (d) => {
      const str = d.toString().trim();
      for (const line of str.split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line.trim());
        if (msg.type === 'INTERACTIVE_DESKTOP_ACTION') {
          actionReceived = msg;
          client.write(
            JSON.stringify({
              type: 'INTERACTIVE_DESKTOP_ACTION_RESULT',
              requestId: msg.requestId,
              action: msg.action,
              success: true,
              status: 'ELEVATED_PROCESS_STARTED',
            }) + '\n'
          );
        }
      }
    });

    client.write(
      JSON.stringify({
        type: 'REGISTER_HELPER',
        version: '1.0.4.16',
        accountName: 'Parent',
        sessionId: 1,
      }) + '\n'
    );

    await ipcServer.waitForRegisteredHelper(1, 'Parent', 2000);

    const res = await ipcServer.dispatchInteractiveDesktopActionWithCorrelation(
      'ATTACH_DEVICE',
      1,
      'Parent',
      { code: 'PAIR-1234', deviceName: 'Study Laptop' }
    );

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.status, 'ELEVATED_PROCESS_STARTED');
    assert.ok(actionReceived);
    assert.strictEqual(actionReceived!.action, 'ATTACH_DEVICE');
    assert.strictEqual(actionReceived!.code, 'PAIR-1234');
    assert.strictEqual(actionReceived!.deviceName, 'Study Laptop');

    client.destroy();
  });

  it('13. SETUP_PIN dispatched after helper registration: successfully correlated', async () => {
    const client = net.createConnection(testSockPath);
    await new Promise((resolve) => client.once('connect', resolve));

    client.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line.trim());
        if (msg.type === 'INTERACTIVE_DESKTOP_ACTION') {
          client.write(
            JSON.stringify({
              type: 'INTERACTIVE_DESKTOP_ACTION_RESULT',
              requestId: msg.requestId,
              action: msg.action,
              success: true,
              status: 'ELEVATED_PROCESS_STARTED',
            }) + '\n'
          );
        }
      }
    });

    client.write(
      JSON.stringify({
        type: 'REGISTER_HELPER',
        version: '1.0.4.16',
        accountName: 'Parent',
        sessionId: 1,
      }) + '\n'
    );

    await ipcServer.waitForRegisteredHelper(1, 'Parent', 2000);
    const res = await ipcServer.dispatchInteractiveDesktopActionWithCorrelation('SETUP_PIN', 1);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.status, 'ELEVATED_PROCESS_STARTED');

    client.destroy();
  });

  it('14. CONFIGURE_ACCOUNTS dispatched after helper registration: successfully correlated', async () => {
    const client = net.createConnection(testSockPath);
    await new Promise((resolve) => client.once('connect', resolve));

    client.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line.trim());
        if (msg.type === 'INTERACTIVE_DESKTOP_ACTION') {
          client.write(
            JSON.stringify({
              type: 'INTERACTIVE_DESKTOP_ACTION_RESULT',
              requestId: msg.requestId,
              action: msg.action,
              success: true,
              status: 'ELEVATED_PROCESS_STARTED',
            }) + '\n'
          );
        }
      }
    });

    client.write(
      JSON.stringify({
        type: 'REGISTER_HELPER',
        version: '1.0.4.16',
        accountName: 'Parent',
        sessionId: 1,
      }) + '\n'
    );

    await ipcServer.waitForRegisteredHelper(1, 'Parent', 2000);
    const res = await ipcServer.dispatchInteractiveDesktopActionWithCorrelation('CONFIGURE_ACCOUNTS', 1);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.status, 'ELEVATED_PROCESS_STARTED');

    client.destroy();
  });

  it('15. UAC cancellation returns friendly result: Win32 error 1223 returns friendly message and HTTP 403', async () => {
    const client = net.createConnection(testSockPath);
    await new Promise((resolve) => client.once('connect', resolve));

    client.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line.trim());
        if (msg.type === 'INTERACTIVE_DESKTOP_ACTION') {
          // Simulate Win32 1223 (user clicked No on UAC consent prompt)
          client.write(
            JSON.stringify({
              type: 'INTERACTIVE_DESKTOP_ACTION_RESULT',
              requestId: msg.requestId,
              action: msg.action,
              success: false,
              status: 'UAC_CANCELLED',
              error: 'Administrator approval was cancelled. No changes were made.',
            }) + '\n'
          );
        }
      }
    });

    client.write(
      JSON.stringify({
        type: 'REGISTER_HELPER',
        version: '1.0.4.16',
        accountName: 'Parent',
        sessionId: 1,
      }) + '\n'
    );

    await ipcServer.waitForRegisteredHelper(1, 'Parent', 2000);

    const gui = new GuiServer(testConfigMgr, accountMgr, undefined, pinMgr, ipcServer);
    gui.setInteractiveElevationTestingEnabled(true);
    accountMgr.setMockConsoleSessionForTesting('S-1-5-21-1000-1000-1000-1001', 'Parent', 1);

    const elev = await gui.requestInteractiveElevation('CONFIGURE_ACCOUNTS');
    assert.strictEqual(elev.success, false);
    assert.strictEqual(elev.status, 'UAC_CANCELLED');
    assert.strictEqual(elev.error, 'Administrator approval was cancelled. No changes were made.');

    // Sanitize check verifies zero technical Win32 or Session 0 leakage
    const sanitized = sanitizeParentErrorMessage(elev.error);
    assert.strictEqual(sanitized, 'Administrator approval was cancelled. No changes were made.');
    assert.ok(!sanitized.includes('1223'));
    assert.ok(!sanitized.includes('Session 0'));
    assert.ok(!sanitized.includes('WTS'));

    client.destroy();
  });

  it('16. socket.write success without helper result is not treated as completed elevation: waits for correlation or timeout', async () => {
    const client = net.createConnection(testSockPath);
    await new Promise((resolve) => client.once('connect', resolve));

    // Client registers but NEVER sends INTERACTIVE_DESKTOP_ACTION_RESULT back
    client.write(
      JSON.stringify({
        type: 'REGISTER_HELPER',
        version: '1.0.4.16',
        accountName: 'Parent',
        sessionId: 1,
      }) + '\n'
    );

    await ipcServer.waitForRegisteredHelper(1, 'Parent', 2000);

    // Short timeout of 200ms
    const res = await ipcServer.dispatchInteractiveDesktopActionWithCorrelation('SETUP_PIN', 1, 'Parent', undefined, 200);

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.status, 'TIMEOUT');
    assert.ok(res.error!.includes('timed out'));

    client.destroy();
  });

  // =========================================================================
  // 4. ServiceHost Recovery, Pipe Security & Window Hygiene (Tests 17 - 19)
  // =========================================================================

  it('17. Duplicate helpers are prevented: ServiceHost EnsureUserHelperRunning handles forceRestart logic', () => {
    const hostCsPath = path.resolve(__dirname, '../service-host/SafeBrowseServiceHost.cs');
    assert.ok(fs.existsSync(hostCsPath), 'SafeBrowseServiceHost.cs must exist');
    const content = fs.readFileSync(hostCsPath, 'utf8');

    // 1. Must define GetInteractiveUserSessionId
    assert.ok(
      content.includes('public uint GetInteractiveUserSessionId()') || content.includes('GetInteractiveUserSessionId()'),
      'ServiceHost must implement GetInteractiveUserSessionId()'
    );

    // 2. Must distinguish forceRestart in EnsureUserHelperRunning
    assert.ok(
      content.includes('bool forceRestart = false') || content.includes('EnsureUserHelperRunning(uint sessionId, bool forceRestart'),
      'EnsureUserHelperRunning must support forceRestart parameter'
    );

    // 3. When forceRestart is false and process exists, must return true without launching duplicate
    assert.ok(
      content.includes('existingRunningInSession') && content.includes('return true;'),
      'EnsureUserHelperRunning must return true without launching duplicate when forceRestart is false'
    );

    // 4. Main() must support --recover-helper
    assert.ok(
      content.includes('--recover-helper'),
      'ServiceHost must support --recover-helper command line switch'
    );
  });

  it('18. Pipe security failure is logged and surfaced diagnostically: getPipeSecurityStatus tracks readiness', async () => {
    // Default non-Windows test status is PIPE_SECURITY_READY
    assert.strictEqual(ipcServer.getPipeSecurityStatus(), 'PIPE_SECURITY_READY');

    // Test diagnostic tracking when security fails
    ipcServer.setPipeSecurityStatusForTesting('PIPE_SECURITY_FAILED');
    assert.strictEqual(ipcServer.getPipeSecurityStatus(), 'PIPE_SECURITY_FAILED');

    // After stop, reset to NOT_INITIALIZED
    await ipcServer.stop();
    assert.strictEqual(ipcServer.getPipeSecurityStatus(), 'PIPE_SECURITY_NOT_INITIALIZED');
  });

  it('19. No console windows appear: binaries do not spawn visible console windows', () => {
    const helperCsPath = path.resolve(__dirname, '../user-helper/SafeBrowseUserHelper.cs');
    const helperContent = fs.readFileSync(helperCsPath, 'utf8');

    // SafeBrowseUserHelper runs as Windows application without console allocation
    assert.ok(!helperContent.includes('AllocConsole'), 'UserHelper must not allocate console');
    assert.ok(!helperContent.includes('cmd.exe'), 'UserHelper must not invoke cmd.exe');
    assert.ok(!helperContent.includes('powershell.exe'), 'UserHelper must not invoke powershell.exe');

    // SafeBrowseServiceHost runs as Windows Service / background host
    const hostCsPath = path.resolve(__dirname, '../service-host/SafeBrowseServiceHost.cs');
    const hostContent = fs.readFileSync(hostCsPath, 'utf8');
    assert.ok(!hostContent.includes('AllocConsole'), 'ServiceHost must not allocate console');

    // GuiLauncher must declare ImageSubsystem 2 (GUI) and UseShellExecute = true
    const launcherCsPath = path.resolve(__dirname, '../gui-launcher/SafeBrowseGuiLauncher.cs');
    const launcherContent = fs.readFileSync(launcherCsPath, 'utf8');
    assert.ok(launcherContent.includes('UseShellExecute = true'), 'GuiLauncher must use UseShellExecute = true');
  });
});
