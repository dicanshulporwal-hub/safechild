import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { WindowsNetworkManager, AdapterDnsBackup, MockAdapterState } from '../src/network-manager';
import { ConfigManager } from '../src/config-manager';
import { WindowsAccountManager } from '../src/account-manager';
import { ParentPinManager } from '../src/parent-pin-manager';
import { GuiServer, sanitizeParentErrorMessage } from '../src/gui-server';

describe('SafeBrowse Windows Pilot — P0-10 Transaction-Safe Disconnect & Stale Adapter Recovery Suite', () => {
  let tmpDir: string;
  let testConfigMgr: ConfigManager;
  let accountMgr: WindowsAccountManager;
  let netMgr: WindowsNetworkManager;
  let pinMgr: ParentPinManager;
  let mockBackendServer: http.Server | null = null;
  let mockBackendPort: number = 0;
  let mockBackendUrl: string = '';
  let cloudUnpairCalls: { deviceId: string; deviceToken: string }[] = [];
  let cloudUnpairShouldFail = false;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-p010-test-'));
    testConfigMgr = new ConfigManager(tmpDir);
    testConfigMgr.setMockIsAdministratorForTesting(true);

    accountMgr = new WindowsAccountManager(tmpDir);
    netMgr = new WindowsNetworkManager(path.join(tmpDir, 'network-backup.json'), testConfigMgr);
    netMgr.setUpstreamResolutionCheckerForTesting(async () => true);
    netMgr.setExternalDnsResolutionCheckerForTesting(async () => true);

    pinMgr = new ParentPinManager(testConfigMgr);

    cloudUnpairCalls = [];
    cloudUnpairShouldFail = false;

    // Start mock backend cloud server
    await new Promise<void>((resolve) => {
      mockBackendServer = http.createServer((req, res) => {
        if (req.url?.startsWith('/api/devices/') && req.url?.endsWith('/unpair') && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', () => {
            if (cloudUnpairShouldFail) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Service Unavailable' }));
              return;
            }
            try {
              const parsed = JSON.parse(body);
              cloudUnpairCalls.push({
                deviceId: parsed.deviceId,
                deviceToken: parsed.deviceToken,
              });
            } catch {}
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, unpaired: true }));
          });
          return;
        }

        res.writeHead(404);
        res.end();
      });

      mockBackendServer.listen(0, '127.0.0.1', () => {
        const addr = mockBackendServer!.address() as any;
        mockBackendPort = addr.port;
        mockBackendUrl = `http://127.0.0.1:${mockBackendPort}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (mockBackendServer) {
      await new Promise<void>((r) => mockBackendServer!.close(() => r()));
      mockBackendServer = null;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('1 & 2 & 3. Stale InterfaceIndex 16 remapped to current index 7 via InterfaceAlias and DNS restores successfully', async () => {
    // Stale backup recorded when Wi-Fi was at index 16
    const backupFile = path.join(tmpDir, 'network-backup.json');
    const backup: AdapterDnsBackup[] = [
      {
        InterfaceIndex: 16,
        InterfaceAlias: 'Wi-Fi',
        InterfaceGuid: '{11111111-2222-3333-4444-555555555555}',
        ServerAddresses: ['1.1.1.1', '1.0.0.1'],
        DhcpEnabled: false,
      },
    ];
    fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2), 'utf8');

    // Current adapter list: adapter 16 no longer exists. Wi-Fi is now at index 7 and trapped on 127.0.0.1
    const mockAdapters: MockAdapterState[] = [
      {
        InterfaceIndex: 7,
        InterfaceAlias: 'Wi-Fi',
        InterfaceGuid: '{11111111-2222-3333-4444-555555555555}',
        Gateway: '192.168.1.1',
        IpAddresses: ['192.168.1.50'],
        ServerAddresses: ['127.0.0.1'],
        DhcpEnabled: false,
        Status: 'Up',
      },
    ];
    netMgr.setMockAdaptersForTesting(mockAdapters);

    await netMgr.restoreOriginalDns();

    // Verification: adapter 7 received the restored static DNS from stale backup record 16
    assert.deepStrictEqual(mockAdapters[0].ServerAddresses, ['1.1.1.1', '1.0.0.1']);
  });

  it('4. Stale adapter no longer exists anywhere — skip safely without throwing error', async () => {
    // Backup contains a historical USB Ethernet adapter (index 22) that has been unplugged
    const backupFile = path.join(tmpDir, 'network-backup.json');
    const backup: AdapterDnsBackup[] = [
      {
        InterfaceIndex: 22,
        InterfaceAlias: 'USB-Ethernet-Dongle',
        ServerAddresses: ['192.168.2.1'],
        DhcpEnabled: false,
      },
    ];
    fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2), 'utf8');

    // Current adapters only have Wi-Fi (index 6); USB-Ethernet-Dongle does not exist
    const mockAdapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '192.168.1.1',
        IpAddresses: ['192.168.1.20'],
        ServerAddresses: ['192.168.1.1'],
        DhcpEnabled: true,
        Status: 'Up',
      },
    ];
    netMgr.setMockAdaptersForTesting(mockAdapters);

    // Must NOT throw
    await netMgr.restoreOriginalDns();
    assert.strictEqual(mockAdapters[0].InterfaceIndex, 6);
  });

  it('5. Multiple stale backup records: remapped, skipped, and restored cleanly', async () => {
    const backupFile = path.join(tmpDir, 'network-backup.json');
    const backup: AdapterDnsBackup[] = [
      {
        InterfaceIndex: 16, // Stale: now index 7 (Wi-Fi)
        InterfaceAlias: 'Wi-Fi',
        ServerAddresses: ['9.9.9.9'],
        DhcpEnabled: false,
      },
      {
        InterfaceIndex: 25, // Stale: absent from system
        InterfaceAlias: 'Old-Virtual-Adapter',
        ServerAddresses: ['10.0.0.1'],
        DhcpEnabled: false,
      },
      {
        InterfaceIndex: 30, // Stale: now index 12 (Dock-Ethernet, DHCP)
        InterfaceAlias: 'Dock-Ethernet',
        ServerAddresses: [],
        DhcpEnabled: true,
      },
    ];
    fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2), 'utf8');

    const mockAdapters: MockAdapterState[] = [
      {
        InterfaceIndex: 7,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '192.168.1.1',
        ServerAddresses: ['127.0.0.1'],
        DhcpEnabled: false,
        Status: 'Up',
      },
      {
        InterfaceIndex: 12,
        InterfaceAlias: 'Dock-Ethernet',
        Gateway: '192.168.1.2',
        ServerAddresses: ['127.0.0.1'],
        DhcpEnabled: true,
        Status: 'Up',
      },
    ];
    netMgr.setMockAdaptersForTesting(mockAdapters);

    await netMgr.restoreOriginalDns();

    // Adapter 7 restored to static 9.9.9.9
    assert.deepStrictEqual(mockAdapters[0].ServerAddresses, ['9.9.9.9']);
    // Adapter 12 reset to DHCP ([])
    assert.deepStrictEqual(mockAdapters[1].ServerAddresses, []);
  });

  it('6. Original DHCP adapter backed up with empty addresses resets to DHCP', async () => {
    const backupFile = path.join(tmpDir, 'network-backup.json');
    const backup: AdapterDnsBackup[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        ServerAddresses: [],
        DhcpEnabled: true,
      },
    ];
    fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2), 'utf8');

    const mockAdapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '192.168.1.1',
        ServerAddresses: ['127.0.0.1'],
        DhcpEnabled: true,
        Status: 'Up',
      },
    ];
    netMgr.setMockAdaptersForTesting(mockAdapters);

    await netMgr.restoreOriginalDns();
    assert.deepStrictEqual(mockAdapters[0].ServerAddresses, []);
  });

  it('7. Original static DNS adapter restores exact static IP addresses', async () => {
    const backupFile = path.join(tmpDir, 'network-backup.json');
    const backup: AdapterDnsBackup[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Ethernet',
        ServerAddresses: ['208.67.222.222', '208.67.220.220'],
        DhcpEnabled: false,
      },
    ];
    fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2), 'utf8');

    const mockAdapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Ethernet',
        Gateway: '10.0.0.1',
        ServerAddresses: ['127.0.0.1'],
        DhcpEnabled: false,
        Status: 'Up',
      },
    ];
    netMgr.setMockAdaptersForTesting(mockAdapters);

    await netMgr.restoreOriginalDns();
    assert.deepStrictEqual(mockAdapters[0].ServerAddresses, ['208.67.222.222', '208.67.220.220']);
  });

  it('8. Safety sweep resets currently trapped 127.0.0.1 adapter with NO backup to DHCP without guessing public DNS', async () => {
    // Backup file has NO record for this adapter
    const backupFile = path.join(tmpDir, 'network-backup.json');
    fs.writeFileSync(backupFile, '[]', 'utf8');

    const mockAdapters: MockAdapterState[] = [
      {
        InterfaceIndex: 9,
        InterfaceAlias: 'New-Wi-Fi',
        Gateway: '192.168.4.1',
        ServerAddresses: ['127.0.0.1'],
        DhcpEnabled: true,
        Status: 'Up',
      },
    ];
    netMgr.setMockAdaptersForTesting(mockAdapters);

    await netMgr.restoreOriginalDns();

    // Safety sweep must reset to DHCP ([]), NOT force Google 8.8.8.8
    assert.deepStrictEqual(mockAdapters[0].ServerAddresses, []);
  });

  it('9. VPN / Tailscale virtual adapter is strictly untouched during safety sweep', async () => {
    const backupFile = path.join(tmpDir, 'network-backup.json');
    fs.writeFileSync(backupFile, '[]', 'utf8');

    const mockAdapters: MockAdapterState[] = [
      {
        InterfaceIndex: 11,
        InterfaceAlias: 'Tailscale',
        ServerAddresses: ['100.100.100.100'],
        DhcpEnabled: false,
        Status: 'Up',
      },
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '192.168.1.1',
        ServerAddresses: ['127.0.0.1'],
        DhcpEnabled: true,
        Status: 'Up',
      },
    ];
    netMgr.setMockAdaptersForTesting(mockAdapters);

    await netMgr.restoreOriginalDns();

    // Tailscale must remain 100.100.100.100
    assert.deepStrictEqual(mockAdapters[0].ServerAddresses, ['100.100.100.100']);
    // Wi-Fi must be restored to DHCP
    assert.deepStrictEqual(mockAdapters[1].ServerAddresses, []);
  });

  it('10. Cloud unpair is NOT called when local DNS restoration fails (transaction safety)', async () => {
    await testConfigMgr.saveDeviceConfig({
      deviceId: 'dev_tx_fail',
      deviceToken: 'token_fail_123',
      childId: 'child_1',
      parentId: 'parent_1',
      deviceName: 'Test-PC',
      backendUrl: mockBackendUrl,
      pairedAt: new Date().toISOString(),
    });
    testConfigMgr.setOnboardingState('PROTECTED');

    await accountMgr.saveProfileMappings([
      { windowsSid: 'S-1-5-21-1-1', windowsUsername: 'Child', childId: 'child_1', enabled: true },
    ]);

    await pinMgr.setPin('123456');
    const session = await pinMgr.verifyPin('123456');

    // Force restoreOriginalDns to fail simulating permission or CIM failure
    netMgr.setExternalDnsResolutionCheckerForTesting(async () => {
      throw new Error('CIM_Error: Set-DnsClientServerAddress failed: Access Denied');
    });

    const guiServer = new GuiServer(testConfigMgr, accountMgr, netMgr, pinMgr);
    const port = await guiServer.start(0);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/disconnect`, {
        method: 'POST',
        headers: { 'x-management-session': session.sessionToken! },
      });

      // Must fail closed with 500
      assert.strictEqual(res.status, 500);
      const data = await res.json() as any;
      assert.strictEqual(data.success, false);

      // Cloud unpair must NOT have been called!
      assert.strictEqual(cloudUnpairCalls.length, 0);

      // Local credentials must still exist
      const config = await testConfigMgr.loadDeviceConfig();
      assert.ok(config !== null);
      assert.strictEqual(config?.deviceId, 'dev_tx_fail');

      // PIN must still be configured
      assert.strictEqual(await pinMgr.isPinSet(), true);
    } finally {
      guiServer.stop();
    }
  });

  it('11. Cloud unpair occurs after successful local restoration and clears local state', async () => {
    await testConfigMgr.saveDeviceConfig({
      deviceId: 'dev_tx_success',
      deviceToken: 'token_success_456',
      childId: 'child_1',
      parentId: 'parent_1',
      deviceName: 'Success-PC',
      backendUrl: mockBackendUrl,
      pairedAt: new Date().toISOString(),
    });
    testConfigMgr.setOnboardingState('PROTECTED');

    await accountMgr.saveProfileMappings([
      { windowsSid: 'S-1-5-21-1-1', windowsUsername: 'Child', childId: 'child_1', enabled: true },
    ]);

    await pinMgr.setPin('123456');
    const session = await pinMgr.verifyPin('123456');

    const guiServer = new GuiServer(testConfigMgr, accountMgr, netMgr, pinMgr);
    const port = await guiServer.start(0);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/disconnect`, {
        method: 'POST',
        headers: { 'x-management-session': session.sessionToken! },
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json() as any;
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.disconnected, true);

      // Cloud unpair was called with expected device identity
      assert.strictEqual(cloudUnpairCalls.length, 1);
      assert.strictEqual(cloudUnpairCalls[0].deviceId, 'dev_tx_success');
      assert.strictEqual(cloudUnpairCalls[0].deviceToken, 'token_success_456');

      // Local state is completely cleared
      assert.strictEqual(await testConfigMgr.loadDeviceConfig(), null);
      assert.strictEqual(await accountMgr.hasProfileMappings(), false);
      assert.strictEqual(await pinMgr.isPinSet(), false);
      assert.strictEqual(testConfigMgr.getOnboardingState(), 'DISCONNECTED');
    } finally {
      guiServer.stop();
    }
  });

  it('12. Cloud unavailable after local disconnect does not fail local disconnect or recreate pairing', async () => {
    await testConfigMgr.saveDeviceConfig({
      deviceId: 'dev_offline',
      deviceToken: 'token_offline_789',
      childId: 'child_1',
      parentId: 'parent_1',
      deviceName: 'Offline-PC',
      backendUrl: mockBackendUrl,
      pairedAt: new Date().toISOString(),
    });
    testConfigMgr.setOnboardingState('PROTECTED');

    await pinMgr.setPin('123456');
    const session = await pinMgr.verifyPin('123456');

    // Make mock cloud backend return 503
    cloudUnpairShouldFail = true;

    const guiServer = new GuiServer(testConfigMgr, accountMgr, netMgr, pinMgr);
    const port = await guiServer.start(0);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/disconnect`, {
        method: 'POST',
        headers: { 'x-management-session': session.sessionToken! },
      });

      // Disconnect must still succeed locally!
      assert.strictEqual(res.status, 200);
      const data = await res.json() as any;
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.disconnected, true);

      // Local state is cleared
      assert.strictEqual(await testConfigMgr.loadDeviceConfig(), null);

      // Pending revoke record was persisted for background retry
      const pendingFile = path.join(testConfigMgr.getSecureDir(), 'pending-cloud-revoke.json');
      assert.strictEqual(fs.existsSync(pendingFile), true);
    } finally {
      guiServer.stop();
    }
  });

  it('13. Backend token already revoked + local state present gives deterministic recovery UI (DEVICE_TOKEN_REVOKED)', async () => {
    await testConfigMgr.saveDeviceConfig({
      deviceId: 'dev_revoked',
      deviceToken: 'token_revoked_999',
      childId: 'child_1',
      parentId: 'parent_1',
      deviceName: 'Revoked-PC',
      backendUrl: mockBackendUrl,
      pairedAt: new Date().toISOString(),
    });
    // Set state machine to revoked attention state
    testConfigMgr.setOnboardingState('ATTENTION_REQUIRED', 'DEVICE_REVOKED');

    const guiServer = new GuiServer(testConfigMgr, accountMgr, netMgr, pinMgr);
    const port = await guiServer.start(0);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`);
      assert.strictEqual(res.status, 200);
      const data = await res.json() as any;

      // Authoritative cloudConnectionStatus must be DEVICE_TOKEN_REVOKED
      assert.strictEqual(data.cloudConnectionStatus, 'DEVICE_TOKEN_REVOKED');
      assert.strictEqual(data.onboardingReason, 'DEVICE_REVOKED');

      // Verify the rendered HTML contains the Attention Recovery Card with both Reconnect and Finish Disconnect
      const html = (guiServer as any).renderHtml() as string;
      assert.ok(html.includes('id="attentionRecoveryCard"'));
      assert.ok(html.includes('Reconnect Computer'));
      assert.ok(html.includes('Finish Disconnect'));
    } finally {
      guiServer.stop();
    }
  });

  it('14. Raw PowerShell/CLIXML/CIM never appears in parent-facing response', () => {
    const rawClixml = `#< CLIXML
<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">Set-DnsClientServerAddress : No MSFT_DNSClientServerAddress objects found with property 'InterfaceIndex' equal to '16'._x000D__x000A_</S><S S="Error">At line:1 char:1_x000D__x000A_</S><S S="Error">+ Set-DnsClientServerAddress -InterfaceIndex 16 -ResetServerAddresses -ErrorAction Stop_x000D__x000A_</S></Objs>`;

    const sanitized = sanitizeParentErrorMessage(rawClixml);
    assert.strictEqual(
      sanitized,
      "SafeBrowse could not safely restore this computer's network settings. No device settings were removed. Please try again."
    );

    // Verify absence of any PowerShell/CIM text
    assert.strictEqual(sanitized.includes('CLIXML'), false);
    assert.strictEqual(sanitized.includes('Set-DnsClientServerAddress'), false);
    assert.strictEqual(sanitized.includes('MSFT_'), false);
    assert.strictEqual(sanitized.includes('InterfaceIndex'), false);
    assert.strictEqual(sanitized.includes('16'), false);
  });

  it('15. Successful disconnect leaves zero active physical adapter using 127.0.0.1', async () => {
    const mockAdapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '192.168.1.1',
        ServerAddresses: ['127.0.0.1'],
        DhcpEnabled: true,
        Status: 'Up',
      },
      {
        InterfaceIndex: 8,
        InterfaceAlias: 'Ethernet',
        Gateway: '192.168.1.2',
        ServerAddresses: ['127.0.0.1'],
        DhcpEnabled: false,
        Status: 'Up',
      },
    ];
    netMgr.setMockAdaptersForTesting(mockAdapters);

    await netMgr.restoreOriginalDns();

    // Verify zero active physical adapters use 127.0.0.1
    const trapped = await netMgr.checkTrappedAdapters();
    assert.strictEqual(trapped.length, 0);

    const inspection = await netMgr.inspectCurrentEnforcement();
    assert.strictEqual(inspection.isProtected, false);
  });

  it('16. Normal external DNS resolution is verified after disconnect', async () => {
    let externalCheckCalled = false;
    netMgr.setExternalDnsResolutionCheckerForTesting(async () => {
      externalCheckCalled = true;
      return true;
    });

    const mockAdapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '192.168.1.1',
        ServerAddresses: ['127.0.0.1'],
        DhcpEnabled: true,
        Status: 'Up',
      },
    ];
    netMgr.setMockAdaptersForTesting(mockAdapters);

    await netMgr.restoreOriginalDns();

    assert.strictEqual(externalCheckCalled, true);
  });
});
