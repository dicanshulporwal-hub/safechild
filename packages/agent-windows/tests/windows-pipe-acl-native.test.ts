process.env.NODE_ENV = 'test';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as net from 'net';
import { execFile } from 'child_process';
import {
  BlockIpcServer,
  BlockPresentationMessage,
  HelperRegisterAck,
  configureWindowsPipeSecurity,
} from '../src/block-ipc';
import { ResolvedUserPolicy, MultiSessionCheckResult } from '../src/account-manager';

describe('SafeBrowse Windows Stage C.5.3: Windows Named Pipe ACL & Delivery Reliability Suite', () => {
  let testPipePath: string;
  let ipcServer: BlockIpcServer;
  let activePolicyState: ResolvedUserPolicy | null = null;
  let multiSessionState: MultiSessionCheckResult = {
    hasMultipleSessions: false,
    hasMultipleActiveInteractiveSessions: false,
    sessionCount: 1,
    activeUsers: ['mporwal'],
    warning: null,
  };

  beforeEach(() => {
    testPipePath = process.platform === 'win32'
      ? `\\\\.\\pipe\\sb-acl-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
      : path.join(
          os.tmpdir(),
          `sb-acl-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}.sock`
        );

    ipcServer = new BlockIpcServer(testPipePath, 10000, 100);
    ipcServer.setActivePolicyProvider(() => activePolicyState);
    ipcServer.setMultiSessionChecker(() => multiSessionState);

    // Active session: child Manjari in session 5
    activePolicyState = {
      accountName: 'Anshul\\mporwal',
      isManaged: true,
      childId: 'child-manjari-uuid',
      childName: 'Manjari',
      sid: 'S-1-5-21-1000-1005',
      sessionId: 5,
    };
  });

  afterEach(async () => {
    if (ipcServer.isRunning()) {
      await ipcServer.stop();
    }
  });

  test('Test 1: NO_CONNECTED_HELPER does NOT consume domain debounce state', async () => {
    await ipcServer.start();

    // Call presentBlock with no helper connected
    const res1 = ipcServer.presentBlock('www.roblox.com', 'category_blocked', 8880);
    assert.strictEqual(res1.sent, false);
    assert.strictEqual(res1.reason, 'NO_CONNECTED_HELPER');

    // Immediately call presentBlock again for the same domain
    // It should STILL report NO_CONNECTED_HELPER, NOT DOMAIN_DEBOUNCED!
    const res2 = ipcServer.presentBlock('www.roblox.com', 'category_blocked', 8880);
    assert.strictEqual(res2.sent, false);
    assert.strictEqual(res2.reason, 'NO_CONNECTED_HELPER');
    assert.notStrictEqual(res2.reason, 'DOMAIN_DEBOUNCED');
  });

  test('Test 2: Pending presentation is automatically retried when helper registers', async () => {
    await ipcServer.start();

    // 1. Initial block attempt while helper is not yet connected
    const resBefore = ipcServer.presentBlock('www.roblox.com', 'category_blocked', 8880);
    assert.strictEqual(resBefore.sent, false);
    assert.strictEqual(resBefore.reason, 'NO_CONNECTED_HELPER');

    // 2. Client helper connects for session 5
    const receivedMessages: any[] = [];
    const client = net.connect(testPipePath);

    await new Promise<void>((resolve, reject) => {
      client.on('connect', resolve);
      client.on('error', reject);
    });

    client.on('data', (data) => {
      const lines = data.toString('utf8').trim().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        receivedMessages.push(JSON.parse(line));
      }
    });

    // Send REGISTER_HELPER for session 5
    const regMsg = JSON.stringify({
      type: 'REGISTER_HELPER',
      version: '1.0.4-validation',
      accountName: 'mporwal',
      pid: 5432,
      sessionId: 5,
    }) + '\n';
    client.write(regMsg);

    // Wait for helper to receive REGISTER_ACK and the pending PRESENT_BLOCK
    await new Promise((r) => setTimeout(r, 200));

    // Client should have received REGISTER_ACK followed immediately by retried PRESENT_BLOCK
    assert.strictEqual(receivedMessages.length, 2);
    assert.strictEqual(receivedMessages[0].type, 'REGISTER_ACK');
    assert.strictEqual(receivedMessages[0].status, 'OK');

    assert.strictEqual(receivedMessages[1].type, 'PRESENT_BLOCK');
    assert.strictEqual(receivedMessages[1].domain, 'www.roblox.com');
    assert.strictEqual(receivedMessages[1].reason, 'category_blocked');
    assert.match(receivedMessages[1].url, /http:\/\/127\.0\.0\.1:8880\/blocked\?domain=www\.roblox\.com/);

    // Now debounce SHOULD be active because the block was successfully delivered
    const resAfter = ipcServer.presentBlock('www.roblox.com', 'category_blocked', 8880);
    assert.strictEqual(resAfter.sent, false);
    assert.strictEqual(resAfter.reason, 'DOMAIN_DEBOUNCED');

    client.destroy();
  });

  test('Test 3: Fast User Switching - Session 4 (Disc Parent) receives no block, Session 5 (Active Child) receives block', async () => {
    await ipcServer.start();

    // Connect Parent helper in Session 4 (switched out / disconnected)
    const parentClient = net.connect(testPipePath);
    const parentMessages: any[] = [];
    await new Promise<void>((r) => parentClient.on('connect', r));
    parentClient.on('data', (d) => {
      const lines = d.toString('utf8').trim().split('\n');
      for (const l of lines) if (l.trim()) parentMessages.push(JSON.parse(l));
    });
    parentClient.write(JSON.stringify({
      type: 'REGISTER_HELPER',
      accountName: 'anshulporwal',
      pid: 1111,
      sessionId: 4,
    }) + '\n');

    // Connect Child helper in Session 5 (active console)
    const childClient = net.connect(testPipePath);
    const childMessages: any[] = [];
    await new Promise<void>((r) => childClient.on('connect', r));
    childClient.on('data', (d) => {
      const lines = d.toString('utf8').trim().split('\n');
      for (const l of lines) if (l.trim()) childMessages.push(JSON.parse(l));
    });
    childClient.write(JSON.stringify({
      type: 'REGISTER_HELPER',
      accountName: 'mporwal',
      pid: 2222,
      sessionId: 5,
    }) + '\n');

    await new Promise((r) => setTimeout(r, 100));

    // Active session is session 5
    activePolicyState = {
      accountName: 'Anshul\\mporwal',
      isManaged: true,
      childId: 'child-manjari-uuid',
      childName: 'Manjari',
      sid: 'S-1-5-21-1000-1005',
      sessionId: 5,
    };
    multiSessionState = {
      hasMultipleSessions: false,
      hasMultipleActiveInteractiveSessions: false,
      sessionCount: 1,
      activeUsers: ['mporwal'],
      activeInteractiveSessions: [{ sessionId: 5, username: 'mporwal', isConsole: true }],
      disconnectedSessions: [{ sessionId: 4, username: 'anshulporwal' }],
      warning: null,
    };

    const presResult = ipcServer.presentBlock('www.roblox.com', 'category_blocked', 8880);
    assert.strictEqual(presResult.sent, true);
    assert.strictEqual(presResult.reason, 'PRESENTED');

    await new Promise((r) => setTimeout(r, 100));

    // Verify Session 4 (Parent) received ZERO PRESENT_BLOCK messages (only REGISTER_ACK)
    assert.strictEqual(parentMessages.length, 1);
    assert.strictEqual(parentMessages[0].type, 'REGISTER_ACK');

    // Verify Session 5 (Child) received PRESENT_BLOCK
    assert.strictEqual(childMessages.length, 2);
    assert.strictEqual(childMessages[0].type, 'REGISTER_ACK');
    assert.strictEqual(childMessages[1].type, 'PRESENT_BLOCK');
    assert.strictEqual(childMessages[1].domain, 'www.roblox.com');

    parentClient.destroy();
    childClient.destroy();
  });

  // Windows Native Specific Tests
  if (process.platform === 'win32') {
    test('Test 4 (Windows Native): configureWindowsPipeSecurity applies DACL with extracted PACL', async () => {
      await ipcServer.start();

      // Explicitly run configureWindowsPipeSecurity with force=true
      const configured = await configureWindowsPipeSecurity(testPipePath, true);
      assert.strictEqual(configured, true, 'configureWindowsPipeSecurity must return true on Windows');

      // Query Win32 security info on the named pipe via PowerShell to inspect DACL
      const inspectScript = `
$pipe = '${testPipePath}'
$code = @'
using System;
using System.Runtime.InteropServices;
public class PipeInspect {
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern uint GetNamedSecurityInfo(
        string pObjectName, int objectType, uint securityInfo,
        out IntPtr ppsidOwner, out IntPtr ppsidGroup, out IntPtr ppDacl, out IntPtr ppSacl,
        out IntPtr ppSecurityDescriptor
    );
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(
        IntPtr pSecurityDescriptor, uint requestedRevision, uint securityInformation,
        out IntPtr stringSecurityDescriptor, out uint stringSecurityDescriptorLen
    );
    [DllImport("kernel32.dll")]
    public static extern IntPtr LocalFree(IntPtr hMem);

    public static string GetPipeSddl(string pipePath) {
        IntPtr pOwner = IntPtr.Zero, pGroup = IntPtr.Zero, pDacl = IntPtr.Zero, pSacl = IntPtr.Zero, pSD = IntPtr.Zero;
        uint res = GetNamedSecurityInfo(pipePath, 1, 4, out pOwner, out pGroup, out pDacl, out pSacl, out pSD);
        if (res != 0 || pSD == IntPtr.Zero) return "FAIL:" + res;
        try {
            IntPtr pStr = IntPtr.Zero; uint len = 0;
            if (ConvertSecurityDescriptorToStringSecurityDescriptor(pSD, 1, 4, out pStr, out len)) {
                string sddl = Marshal.PtrToStringUni(pStr);
                LocalFree(pStr);
                return "SDDL:" + sddl;
            }
            return "CONVERT_FAIL";
        } finally {
            LocalFree(pSD);
        }
    }
}
'@
if (-not ([System.Management.Automation.PSTypeName]'PipeInspect').Type) {
    Add-Type -TypeDefinition $code -Language CSharp
}
[PipeInspect]::GetPipeSddl($pipe)
`;

      const sddlOutput = await new Promise<string>((resolve) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', inspectScript],
          { timeout: 5000 },
          (err, stdout) => {
            resolve((stdout || '').trim());
          }
        );
      });

      assert.match(sddlOutput, /^SDDL:D:/, 'Pipe must have a valid DACL string representation');
      // Must contain SYSTEM Full Control
      assert.match(sddlOutput, /\(A;;GA;;;SY\)/, 'DACL must grant SYSTEM Full Control');
      // Must contain Builtin Administrators Full Control
      assert.match(sddlOutput, /\(A;;GA;;;BA\)/, 'DACL must grant Builtin Administrators Full Control');
      // Must contain Interactive Users Read/Write
      assert.match(sddlOutput, /\(A;;GRGW;;;IU\)/, 'DACL must grant Interactive Users Read/Write');
      // Must contain Authenticated Users Read/Write
      assert.match(sddlOutput, /\(A;;GRGW;;;AU\)/, 'DACL must grant Authenticated Users Read/Write');
      // Must contain Network Logon Deny
      assert.match(sddlOutput, /\(D;;GA;;;NU\)/, 'DACL must deny Network Logon');
    });

    test('Test 5 (Windows Native): Standard client connects to named pipe and completes duplex handshake', async () => {
      await ipcServer.start();
      await configureWindowsPipeSecurity(testPipePath, true);

      // Verify a client can connect and duplex write/read
      const client = net.connect(testPipePath);
      const incoming: any[] = [];

      await new Promise<void>((resolve, reject) => {
        client.on('connect', resolve);
        client.on('error', reject);
      });

      client.on('data', (d) => {
        const lines = d.toString('utf8').trim().split('\n');
        for (const l of lines) if (l.trim()) incoming.push(JSON.parse(l));
      });

      client.write(JSON.stringify({
        type: 'REGISTER_HELPER',
        version: '1.0.4-validation',
        accountName: 'mporwal',
        pid: process.pid,
        sessionId: 5,
      }) + '\n');

      await new Promise((r) => setTimeout(r, 150));
      assert.strictEqual(incoming.length, 1);
      assert.strictEqual(incoming[0].type, 'REGISTER_ACK');
      assert.strictEqual(incoming[0].status, 'OK');

      // Present block and receive message
      const res = ipcServer.presentBlock('www.roblox.com', 'category_blocked', 8880);
      assert.strictEqual(res.sent, true);

      await new Promise((r) => setTimeout(r, 150));
      assert.strictEqual(incoming.length, 2);
      assert.strictEqual(incoming[1].type, 'PRESENT_BLOCK');
      assert.strictEqual(incoming[1].domain, 'www.roblox.com');

      client.destroy();
    });
  }
});
