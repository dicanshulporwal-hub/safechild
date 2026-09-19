import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as dgram from 'dgram';
import { WindowsNetworkManager, TargetAdapterInfo } from '../src/network-manager';

/**
 * Helper to spin up a local UDP server that immediately echoes standard DNS query responses.
 */
function createMockDnsServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = dgram.createSocket('udp4');
    server.on('message', (msg, rinfo) => {
      const response = Buffer.from(msg);
      response[2] |= 0x80; // Set QR flag to indicate response
      server.send(response, rinfo.port, rinfo.address);
    });
    server.bind(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        port: addr.port,
        close: () =>
          new Promise((res) => {
            try {
              server.close(() => res());
            } catch {
              res();
            }
          }),
      });
    });
  });
}

describe('SafeBrowse Windows NetworkManager & Fail-Safe Activation Tests', () => {
  it('1. should create DNS backup on call', async () => {
    const backupPath = path.join(os.tmpdir(), 'sb-test-backup-isolated-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    const mockExecutor = async (script: string) => {
      if (script.includes('Get-NetIPConfiguration')) {
        return {
          stdout: JSON.stringify([
            { InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Description: 'Intel Wi-Fi Test Adapter' },
          ]),
          stderr: '',
        };
      }
      if (script.includes('Get-DnsClientServerAddress')) {
        return {
          stdout: JSON.stringify([
            { InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', ServerAddresses: ['192.168.1.1'] },
          ]),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const backup = await net.backupCurrentDnsConfig();
      assert.ok(Array.isArray(backup));
      assert.strictEqual(backup.length, 1);
      assert.strictEqual(backup[0].InterfaceIndex, 6);
      assert.deepStrictEqual(backup[0].ServerAddresses, ['192.168.1.1']);
      assert.strictEqual(fs.existsSync(backupPath), true);
      const saved = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
      assert.ok(Array.isArray(saved));
      assert.strictEqual(saved.length, 1);
      assert.strictEqual(saved[0].InterfaceIndex, 6);
      assert.deepStrictEqual(saved[0].ServerAddresses, ['192.168.1.1']);
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      try {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      } catch {}
    }
  });

  it('2. should fail probe when DNS proxy is not listening on given port', async () => {
    const net = new WindowsNetworkManager();
    // Port 54321 is unused in test
    const isResponding = await net.verifyDnsProxyResponding(54321, 300);
    assert.strictEqual(isResponding, false);
  });

  it('3. should abort fail-safe DNS activation if proxy is not responding', async () => {
    const backupPath = path.join(os.tmpdir(), 'sb-test-proxy-fail-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    const executedCommands: string[] = [];
    const mockExecutor = async (script: string) => {
      executedCommands.push(script);
      if (script.includes('Get-NetIPConfiguration')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi' }]),
          stderr: '',
        };
      }
      if (script.includes('Get-DnsClientServerAddress')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', ServerAddresses: ['192.168.1.1'] }]),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      // Use an unassigned port with a short timeout to guarantee probe failure
      const result = await net.activateFailSafeDns(54322);
      assert.strictEqual(result.success, false);
      assert.match(result.message, /failed health probe/);
      assert.ok(
        !executedCommands.some(
          (c) => c.includes('Set-DnsClientServerAddress') && c.includes('127.0.0.1')
        ),
        'Must not configure 127.0.0.1 when DNS proxy health check fails'
      );
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      try {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      } catch {}
    }
  });

  it('4. should run restoreOriginalDns cleanly without throwing on non-Windows platform', async () => {
    const net = new WindowsNetworkManager();
    net.setPlatformForTesting('linux');
    try {
      await assert.doesNotReject(async () => {
        await net.restoreOriginalDns();
      });
    } finally {
      net.setPlatformForTesting(null);
    }
  });

  it('5. should select target adapter with default gateway and exclude tunnel without default gateway', async () => {
    const net = new WindowsNetworkManager();
    net.setPlatformForTesting('win32');

    let capturedScript = '';
    const mockExecutor = async (script: string) => {
      capturedScript = script;
      if (script.includes('Get-NetIPConfiguration')) {
        // Simulates PowerShell output where only WiFi (index 6) has default gateway,
        // while Tailscale (index 11) had no IPv4 default gateway and was filtered out
        return {
          stdout: JSON.stringify([
            { InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Description: 'Intel Wi-Fi 6 AX201' },
          ]),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const targets = await net.getTargetAdapters();
      assert.strictEqual(targets.length, 1);
      assert.strictEqual(targets[0].InterfaceIndex, 6);
      assert.strictEqual(targets[0].InterfaceAlias, 'Wi-Fi');
      assert.ok(capturedScript.includes("IPv4DefaultGateway -ne $null"));
      assert.ok(capturedScript.includes("Status -eq 'Up'"));
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
    }
  });

  it('6. should ensure tunnel/up adapter without default gateway is not modified', async () => {
    const dnsServer = await createMockDnsServer();
    const backupPath = path.join(os.tmpdir(), 'sb-test-tunnel-isolation-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    const executedCommands: string[] = [];
    const mockExecutor = async (script: string) => {
      executedCommands.push(script);
      if (script.includes('Get-NetIPConfiguration')) {
        // Returns WiFi 6 only; Tailscale 11 is not returned because it has no default gateway
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi' }]),
          stderr: '',
        };
      }
      if (script.includes('Get-DnsClientServerAddress') && script.includes('Select-Object InterfaceIndex, ServerAddresses')) {
        return {
          stdout: JSON.stringify({ InterfaceIndex: 6, ServerAddresses: ['127.0.0.1'] }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const result = await net.activateFailSafeDns(dnsServer.port);
      assert.strictEqual(result.success, true);
      // Interface 11 (Tailscale) must NEVER be targeted by Set-DnsClientServerAddress
      assert.ok(!executedCommands.some((c) => c.includes('InterfaceIndex 11')));
      // Only Interface 6 was targeted
      assert.ok(executedCommands.some((c) => c.includes('InterfaceIndex 6')));
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      await dnsServer.close();
      try {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      } catch {}
    }
  });

  it('7. should succeed with DNS assignment and read-back verification', async () => {
    const dnsServer = await createMockDnsServer();
    const backupPath = path.join(os.tmpdir(), 'sb-test-success-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    const executedCommands: string[] = [];
    const mockExecutor = async (script: string) => {
      executedCommands.push(script);
      if (script.includes('Get-NetIPConfiguration')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi' }]),
          stderr: '',
        };
      }
      if (script.includes('Get-DnsClientServerAddress') && script.includes('Select-Object InterfaceIndex, ServerAddresses')) {
        // Successful read-back verification: adapter has 127.0.0.1
        return {
          stdout: JSON.stringify({ InterfaceIndex: 6, ServerAddresses: ['127.0.0.1'] }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const result = await net.activateFailSafeDns(dnsServer.port);
      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.interfaceIndexes, [6]);
      assert.ok(executedCommands.some((c) => c.includes('Set-DnsClientServerAddress') && c.includes('127.0.0.1') && c.includes('-ErrorAction Stop')));
      assert.ok(executedCommands.some((c) => c.includes('Get-DnsClientServerAddress') && c.includes('-ErrorAction Stop')));
      assert.ok(executedCommands.some((c) => c.includes('Clear-DnsClientCache')));
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      await dnsServer.close();
      try {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      } catch {}
    }
  });

  it('8. should initiate rollback when Set-DnsClientServerAddress fails', async () => {
    const dnsServer = await createMockDnsServer();
    const backupPath = path.join(os.tmpdir(), 'sb-test-set-fail-' + Date.now() + '.json');
    fs.writeFileSync(
      backupPath,
      JSON.stringify([{ InterfaceIndex: 6, ServerAddresses: ['192.168.1.1'], InterfaceAlias: 'Wi-Fi' }]),
      'utf8'
    );
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    const executedCommands: string[] = [];
    const mockExecutor = async (script: string) => {
      executedCommands.push(script);
      if (script.includes('Get-NetIPConfiguration')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi' }]),
          stderr: '',
        };
      }
      if (script.includes('Set-DnsClientServerAddress') && script.includes('127.0.0.1')) {
        throw new Error('PowerShell access denied setting 127.0.0.1');
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const result = await net.activateFailSafeDns(dnsServer.port);
      assert.strictEqual(result.success, false);
      assert.match(result.message, /PowerShell access denied setting 127\.0\.0\.1/);
      // Rollback must have attempted to restore original 192.168.1.1
      assert.ok(
        executedCommands.some(
          (c) => c.includes('Set-DnsClientServerAddress') && c.includes('192.168.1.1')
        )
      );
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      await dnsServer.close();
      try {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      } catch {}
    }
  });

  it('9. should initiate rollback when read-back verification detects mismatched DNS', async () => {
    const dnsServer = await createMockDnsServer();
    const backupPath = path.join(os.tmpdir(), 'sb-test-mismatch-' + Date.now() + '.json');
    fs.writeFileSync(
      backupPath,
      JSON.stringify([{ InterfaceIndex: 6, ServerAddresses: ['192.168.1.1'], InterfaceAlias: 'Wi-Fi' }]),
      'utf8'
    );
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    const executedCommands: string[] = [];
    const mockExecutor = async (script: string) => {
      executedCommands.push(script);
      if (script.includes('Get-NetIPConfiguration')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi' }]),
          stderr: '',
        };
      }
      if (script.includes('Get-DnsClientServerAddress') && script.includes('Select-Object InterfaceIndex, ServerAddresses')) {
        // Read-back returns original IP instead of 127.0.0.1 (verification mismatch)
        return {
          stdout: JSON.stringify({ InterfaceIndex: 6, ServerAddresses: ['192.168.1.1'] }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const result = await net.activateFailSafeDns(dnsServer.port);
      assert.strictEqual(result.success, false);
      assert.match(result.message, /Read-back verification failed/);
      // Rollback triggered
      assert.ok(executedCommands.some((c) => c.includes('Set-DnsClientServerAddress') && c.includes('192.168.1.1')));
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      await dnsServer.close();
      try {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      } catch {}
    }
  });

  it('10. should return failure and not alter DNS when no eligible adapters exist', async () => {
    const dnsServer = await createMockDnsServer();
    const net = new WindowsNetworkManager();
    net.setPlatformForTesting('win32');

    const executedCommands: string[] = [];
    const mockExecutor = async (script: string) => {
      executedCommands.push(script);
      if (script.includes('Get-NetIPConfiguration')) {
        return { stdout: '[]', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const result = await net.activateFailSafeDns(dnsServer.port);
      assert.strictEqual(result.success, false);
      assert.match(result.message, /No active IPv4 internet-facing adapters with default gateway found/);
      assert.ok(!executedCommands.some((c) => c.includes('Set-DnsClientServerAddress')));
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      await dnsServer.close();
    }
  });

  it('11. should preserve existing valid original DNS backup (e.g. 192.168.1.1)', async () => {
    const backupPath = path.join(os.tmpdir(), 'sb-test-preserve-orig-' + Date.now() + '.json');
    const originalContent = [{ InterfaceIndex: 6, ServerAddresses: ['192.168.1.1'], InterfaceAlias: 'Wi-Fi' }];
    fs.writeFileSync(backupPath, JSON.stringify(originalContent, null, 2), 'utf8');

    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    try {
      const explicitTarget: TargetAdapterInfo = {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        IpAddresses: ['192.168.1.8'],
        Gateway: '192.168.1.1',
      };
      const backup = await net.backupCurrentDnsConfig([explicitTarget]);
      assert.strictEqual(backup.length, 1);
      assert.deepStrictEqual(backup[0].ServerAddresses, ['192.168.1.1']);
      // File on disk must remain untouched
      const onDisk = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
      assert.deepStrictEqual(onDisk, originalContent);
    } finally {
      net.setPlatformForTesting(null);
      try {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      } catch {}
    }
  });

  it('12. should surface critical failure when both activation and rollback fail', async () => {
    const dnsServer = await createMockDnsServer();
    const backupPath = path.join(os.tmpdir(), 'sb-test-crit-fail-' + Date.now() + '.json');
    fs.writeFileSync(
      backupPath,
      JSON.stringify([{ InterfaceIndex: 6, ServerAddresses: ['192.168.1.1'], InterfaceAlias: 'Wi-Fi' }]),
      'utf8'
    );
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    const mockExecutor = async (script: string) => {
      if (script.includes('Set-DnsClientServerAddress') && script.includes('127.0.0.1')) {
        throw new Error('Primary DNS assignment failed');
      }
      if (script.includes('Set-DnsClientServerAddress') && script.includes('192.168.1.1')) {
        throw new Error('Rollback DNS assignment failed');
      }
      if (script.includes('Get-NetIPConfiguration')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi' }]),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const result = await net.activateFailSafeDns(dnsServer.port);
      assert.strictEqual(result.success, false);
      assert.match(result.message, /CRITICAL/);
      assert.match(result.message, /rollback failed \(Rollback DNS assignment failed\)/);
      assert.match(result.details || '', /Rollback Error: Rollback DNS assignment failed/);
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      await dnsServer.close();
      try {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      } catch {}
    }
  });

  it('13. should restore static 192.168.1.1 configuration from backup on restoreOriginalDns', async () => {
    const backupPath = path.join(os.tmpdir(), 'sb-test-restore-static-' + Date.now() + '.json');
    fs.writeFileSync(
      backupPath,
      JSON.stringify([{ InterfaceIndex: 6, ServerAddresses: ['192.168.1.1'], InterfaceAlias: 'Wi-Fi' }]),
      'utf8'
    );
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    const executedCommands: string[] = [];
    const mockExecutor = async (script: string) => {
      executedCommands.push(script);
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      await net.restoreOriginalDns();
      assert.ok(
        executedCommands.some(
          (c) =>
            c.includes('Set-DnsClientServerAddress') &&
            c.includes('InterfaceIndex 6') &&
            c.includes("'192.168.1.1'") &&
            c.includes('-ErrorAction Stop')
        )
      );
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      try {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      } catch {}
    }
  });

  it('14. should restore DHCP configuration for adapters backed up with empty addresses', async () => {
    const backupPath = path.join(os.tmpdir(), 'sb-test-restore-dhcp-' + Date.now() + '.json');
    fs.writeFileSync(
      backupPath,
      JSON.stringify([{ InterfaceIndex: 6, ServerAddresses: [], InterfaceAlias: 'Wi-Fi' }]),
      'utf8'
    );
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    const executedCommands: string[] = [];
    const mockExecutor = async (script: string) => {
      executedCommands.push(script);
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      await net.restoreOriginalDns();
      assert.ok(
        executedCommands.some(
          (c) =>
            c.includes('Set-DnsClientServerAddress') &&
            c.includes('InterfaceIndex 6') &&
            c.includes('-ResetServerAddresses') &&
            c.includes('-ErrorAction Stop')
        )
      );
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      try {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      } catch {}
    }
  });

  it('15. should not modify Tailscale-like virtual adapter during DHCP fallback restoration', async () => {
    const nonExistentBackup = path.join(os.tmpdir(), 'sb-non-existent-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(nonExistentBackup);
    net.setPlatformForTesting('win32');

    const executedScripts: string[] = [];
    const mockExecutor = async (script: string) => {
      executedScripts.push(script);
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      await net.restoreOriginalDns();
      // Fallback script must only target adapters with IPv4DefaultGateway -ne $null
      assert.ok(executedScripts.some((s) => s.includes("IPv4DefaultGateway -ne $null")));
      assert.ok(executedScripts.some((s) => s.includes("Status -eq 'Up'")));
      // Interface 11 (Tailscale) was not targeted
      assert.ok(!executedScripts.some((s) => s.includes("InterfaceIndex 11")));
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
    }
  });

  it('16. should reject and throw when Windows DNS restoration fails', async () => {
    const backupPath = path.join(os.tmpdir(), 'sb-test-restore-fail-' + Date.now() + '.json');
    fs.writeFileSync(
      backupPath,
      JSON.stringify([{ InterfaceIndex: 6, ServerAddresses: ['192.168.1.1'], InterfaceAlias: 'Wi-Fi' }]),
      'utf8'
    );
    const net = new WindowsNetworkManager(backupPath);
    const failingExecutor = async () => {
      throw new Error('PowerShell Set-DnsClientServerAddress access denied');
    };
    net.setPlatformForTesting('win32');
    net.setCommandExecutorForTesting(failingExecutor);

    try {
      await assert.rejects(
        async () => {
          await net.restoreOriginalDns();
        },
        /PowerShell Set-DnsClientServerAddress access denied/
      );
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      try {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      } catch {}
    }
  });

  it('17. should select WiFi via route-table discovery with InterfaceIndex 6 and NextHop 192.168.1.1', async () => {
    const net = new WindowsNetworkManager();
    net.setPlatformForTesting('win32');

    const mockExecutor = async (script: string) => {
      if (script.includes('Get-NetRoute')) {
        return {
          stdout: JSON.stringify({
            DefaultRouteCount: 1,
            Eligible: [
              {
                InterfaceIndex: 6,
                InterfaceAlias: 'WiFi',
                Description: 'Intel Wi-Fi 6 AX201 160MHz',
                Gateway: '192.168.1.1',
                IPv4Addresses: ['192.168.1.8'],
              },
            ],
            Evaluations: [
              {
                InterfaceIndex: 6,
                InterfaceAlias: 'WiFi',
                NextHop: '192.168.1.1',
                Status: 'Up',
                IPv4Addresses: ['192.168.1.8'],
                Eligible: true,
                RejectionReason: '',
              },
            ],
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const discovery = await net.discoverTargetAdapters();
      assert.strictEqual(discovery.method, 'route-table');
      assert.strictEqual(discovery.reason, 'ELIGIBLE_ADAPTER_FOUND');
      assert.strictEqual(discovery.defaultRouteCount, 1);
      assert.strictEqual(discovery.adapters.length, 1);
      assert.strictEqual(discovery.adapters[0].InterfaceIndex, 6);
      assert.strictEqual(discovery.adapters[0].InterfaceAlias, 'WiFi');
      assert.strictEqual(discovery.adapters[0].Gateway, '192.168.1.1');
      assert.deepStrictEqual(discovery.adapters[0].IpAddresses, ['192.168.1.8']);
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
    }
  });

  it('18. should exclude Tailscale-like virtual interface with no usable physical gateway', async () => {
    const net = new WindowsNetworkManager();
    net.setPlatformForTesting('win32');

    const mockExecutor = async (script: string) => {
      if (script.includes('Get-NetRoute')) {
        return {
          stdout: JSON.stringify({
            DefaultRouteCount: 1,
            Eligible: [],
            Evaluations: [
              {
                InterfaceIndex: 11,
                InterfaceAlias: 'Tailscale',
                NextHop: '',
                Status: 'Up',
                IPv4Addresses: ['100.98.155.122'],
                Eligible: false,
                RejectionReason: 'Invalid or zero NextHop',
              },
            ],
          }),
          stderr: '',
        };
      }
      if (script.includes('Get-NetIPConfiguration')) {
        return { stdout: '[]', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const discovery = await net.discoverTargetAdapters();
      assert.strictEqual(discovery.adapters.length, 0);
      assert.strictEqual(discovery.reason, 'NO_NETWORK_ROUTE');
      assert.ok(
        discovery.evaluations.some(
          (e) => e.interfaceIndex === 11 && e.eligible === false && e.rejectionReason?.includes('NextHop')
        )
      );
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
    }
  });

  it('19. should exclude route with NextHop 0.0.0.0', async () => {
    const net = new WindowsNetworkManager();
    net.setPlatformForTesting('win32');

    const mockExecutor = async (script: string) => {
      if (script.includes('Get-NetRoute')) {
        return {
          stdout: JSON.stringify({
            DefaultRouteCount: 2,
            Eligible: [
              {
                InterfaceIndex: 6,
                InterfaceAlias: 'WiFi',
                Gateway: '192.168.1.1',
                IPv4Addresses: ['192.168.1.8'],
              },
            ],
            Evaluations: [
              {
                InterfaceIndex: 11,
                InterfaceAlias: 'Tailscale',
                NextHop: '0.0.0.0',
                Status: 'Up',
                IPv4Addresses: ['100.98.155.122'],
                Eligible: false,
                RejectionReason: 'Invalid or zero NextHop',
              },
              {
                InterfaceIndex: 6,
                InterfaceAlias: 'WiFi',
                NextHop: '192.168.1.1',
                Status: 'Up',
                IPv4Addresses: ['192.168.1.8'],
                Eligible: true,
                RejectionReason: '',
              },
            ],
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const discovery = await net.discoverTargetAdapters();
      assert.strictEqual(discovery.adapters.length, 1);
      assert.strictEqual(discovery.adapters[0].InterfaceIndex, 6);
      assert.ok(
        discovery.evaluations.some(
          (e) => e.interfaceIndex === 11 && e.nextHop === '0.0.0.0' && e.eligible === false
        )
      );
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
    }
  });

  it('20. should exclude disconnected adapter from route discovery', async () => {
    const net = new WindowsNetworkManager();
    net.setPlatformForTesting('win32');

    const mockExecutor = async (script: string) => {
      if (script.includes('Get-NetRoute')) {
        return {
          stdout: JSON.stringify({
            DefaultRouteCount: 1,
            Eligible: [],
            Evaluations: [
              {
                InterfaceIndex: 7,
                InterfaceAlias: 'Ethernet',
                NextHop: '192.168.2.1',
                Status: 'Disconnected',
                IPv4Addresses: [],
                Eligible: false,
                RejectionReason: "Adapter status is 'Disconnected', expected 'Up'",
              },
            ],
          }),
          stderr: '',
        };
      }
      if (script.includes('Get-NetIPConfiguration')) {
        return { stdout: '[]', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const discovery = await net.discoverTargetAdapters();
      assert.strictEqual(discovery.adapters.length, 0);
      assert.ok(
        discovery.evaluations.some(
          (e) => e.interfaceIndex === 7 && e.status === 'Disconnected' && e.eligible === false
        )
      );
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
    }
  });

  it('21. should exclude APIPA-only adapter from route discovery', async () => {
    const net = new WindowsNetworkManager();
    net.setPlatformForTesting('win32');

    const mockExecutor = async (script: string) => {
      if (script.includes('Get-NetRoute')) {
        return {
          stdout: JSON.stringify({
            DefaultRouteCount: 1,
            Eligible: [],
            Evaluations: [
              {
                InterfaceIndex: 8,
                InterfaceAlias: 'VirtualBox Host-Only',
                NextHop: '169.254.1.1',
                Status: 'Up',
                IPv4Addresses: ['169.254.50.2'],
                Eligible: false,
                RejectionReason: 'Adapter has only APIPA or loopback IPv4 addresses',
              },
            ],
          }),
          stderr: '',
        };
      }
      if (script.includes('Get-NetIPConfiguration')) {
        return { stdout: '[]', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const discovery = await net.discoverTargetAdapters();
      assert.strictEqual(discovery.adapters.length, 0);
      assert.ok(
        discovery.evaluations.some(
          (e) => e.interfaceIndex === 8 && e.rejectionReason?.includes('APIPA')
        )
      );
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
    }
  });

  it('22. should deduplicate multiple valid physical default routes for the same adapter', async () => {
    const net = new WindowsNetworkManager();
    net.setPlatformForTesting('win32');

    const mockExecutor = async (script: string) => {
      if (script.includes('Get-NetRoute')) {
        return {
          stdout: JSON.stringify({
            DefaultRouteCount: 3,
            Eligible: [
              {
                InterfaceIndex: 6,
                InterfaceAlias: 'WiFi',
                Gateway: '192.168.1.1',
                IPv4Addresses: ['192.168.1.8'],
              },
              {
                InterfaceIndex: 12,
                InterfaceAlias: 'Ethernet',
                Gateway: '10.0.0.1',
                IPv4Addresses: ['10.0.0.50'],
              },
            ],
            Evaluations: [
              {
                InterfaceIndex: 6,
                InterfaceAlias: 'WiFi',
                NextHop: '192.168.1.1',
                Status: 'Up',
                Eligible: true,
              },
              {
                InterfaceIndex: 6,
                InterfaceAlias: 'WiFi',
                NextHop: '192.168.1.1',
                Status: 'Up',
                Eligible: true,
              },
              {
                InterfaceIndex: 12,
                InterfaceAlias: 'Ethernet',
                NextHop: '10.0.0.1',
                Status: 'Up',
                Eligible: true,
              },
            ],
          }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const discovery = await net.discoverTargetAdapters();
      assert.strictEqual(discovery.adapters.length, 2);
      const indexes = discovery.adapters.map((a) => a.InterfaceIndex);
      assert.deepStrictEqual(indexes, [6, 12]);
      assert.strictEqual(new Set(indexes).size, 2);
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
    }
  });

  it('23. should distinguish route discovery PowerShell failure from no routes', async () => {
    const net = new WindowsNetworkManager();
    net.setPlatformForTesting('win32');

    let failMode = true;
    const mockExecutor = async (script: string) => {
      if (failMode) {
        throw new Error('PowerShell CIM query error: Access is denied');
      } else {
        if (script.includes('Get-NetRoute')) {
          return {
            stdout: JSON.stringify({
              DefaultRouteCount: 0,
              Eligible: [],
              Evaluations: [],
            }),
            stderr: '',
          };
        }
        if (script.includes('Get-NetIPConfiguration')) {
          return { stdout: '[]', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      // With failMode = true: DISCOVERY_COMMAND_FAILED
      const failureResult = await net.discoverTargetAdapters();
      assert.strictEqual(failureResult.reason, 'DISCOVERY_COMMAND_FAILED');
      assert.strictEqual(failureResult.adapters.length, 0);
      assert.match(failureResult.errorMessage || '', /Access is denied/);

      // With failMode = false: NO_NETWORK_ROUTE
      failMode = false;
      const noRouteResult = await net.discoverTargetAdapters();
      assert.strictEqual(noRouteResult.reason, 'NO_NETWORK_ROUTE');
      assert.strictEqual(noRouteResult.adapters.length, 0);
      assert.strictEqual(noRouteResult.errorMessage, undefined);
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
    }
  });

  it('24. should fall back to Get-NetIPConfiguration if primary route discovery returns none', async () => {
    const net = new WindowsNetworkManager();
    net.setPlatformForTesting('win32');

    const executedScripts: string[] = [];
    const mockExecutor = async (script: string) => {
      executedScripts.push(script);
      if (script.includes('Get-NetRoute')) {
        return {
          stdout: JSON.stringify({
            DefaultRouteCount: 0,
            Eligible: [],
            Evaluations: [],
          }),
          stderr: '',
        };
      }
      if (script.includes('Get-NetIPConfiguration')) {
        return {
          stdout: JSON.stringify([
            {
              InterfaceIndex: 6,
              InterfaceAlias: 'Wi-Fi',
              Description: 'Intel Wi-Fi Adapter',
              Gateway: '192.168.1.1',
            },
          ]),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const discovery = await net.discoverTargetAdapters();
      assert.strictEqual(discovery.method, 'net-ip-config');
      assert.strictEqual(discovery.reason, 'ELIGIBLE_ADAPTER_FOUND');
      assert.strictEqual(discovery.adapters.length, 1);
      assert.strictEqual(discovery.adapters[0].InterfaceIndex, 6);
      assert.strictEqual(discovery.adapters[0].Gateway, '192.168.1.1');
      assert.ok(executedScripts.some((s) => s.includes('Get-NetRoute')));
      assert.ok(executedScripts.some((s) => s.includes('Get-NetIPConfiguration')));
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
    }
  });

  it('25. should produce NO_NETWORK_ROUTE when neither primary nor fallback has default routes', async () => {
    const net = new WindowsNetworkManager();
    net.setPlatformForTesting('win32');

    const mockExecutor = async (script: string) => {
      if (script.includes('Get-NetRoute')) {
        return {
          stdout: JSON.stringify({
            DefaultRouteCount: 0,
            Eligible: [],
            Evaluations: [],
          }),
          stderr: '',
        };
      }
      if (script.includes('Get-NetIPConfiguration')) {
        return { stdout: '[]', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const discovery = await net.discoverTargetAdapters();
      assert.strictEqual(discovery.reason, 'NO_NETWORK_ROUTE');
      assert.strictEqual(discovery.adapters.length, 0);
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
    }
  });

  it('26. should retry activation for NO_NETWORK_ROUTE and succeed upon network arrival', async () => {
    const dnsServer = await createMockDnsServer();
    const backupPath = path.join(os.tmpdir(), 'sb-test-retry-arrival-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    let attemptCount = 0;
    const mockExecutor = async (script: string) => {
      if (script.includes('Get-NetRoute')) {
        attemptCount++;
        if (attemptCount === 1) {
          // Attempt 1: Offline / booting (no default route yet)
          return {
            stdout: JSON.stringify({ DefaultRouteCount: 0, Eligible: [], Evaluations: [] }),
            stderr: '',
          };
        } else {
          // Attempt 2: Wi-Fi connected!
          return {
            stdout: JSON.stringify({
              DefaultRouteCount: 1,
              Eligible: [
                {
                  InterfaceIndex: 6,
                  InterfaceAlias: 'Wi-Fi',
                  Gateway: '192.168.1.1',
                  IPv4Addresses: ['192.168.1.8'],
                },
              ],
              Evaluations: [
                {
                  InterfaceIndex: 6,
                  InterfaceAlias: 'Wi-Fi',
                  NextHop: '192.168.1.1',
                  Status: 'Up',
                  IPv4Addresses: ['192.168.1.8'],
                  Eligible: true,
                },
              ],
            }),
            stderr: '',
          };
        }
      }
      if (script.includes('Get-NetIPConfiguration')) {
        return { stdout: '[]', stderr: '' };
      }
      if (script.includes('Get-DnsClientServerAddress') && script.includes('Select-Object InterfaceIndex, ServerAddresses')) {
        return {
          stdout: JSON.stringify({ InterfaceIndex: 6, ServerAddresses: ['127.0.0.1'] }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const attemptsRecorded: number[] = [];
      const result = await net.activateFailSafeDnsWithRetry({
        dnsPort: dnsServer.port,
        retryDelaysMs: [10, 10],
        onAttempt: (att) => attemptsRecorded.push(att),
      });

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.interfaceIndexes, [6]);
      assert.strictEqual(attemptCount, 2);
      assert.ok(attemptsRecorded.includes(2));
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      await dnsServer.close();
      try {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      } catch {}
    }
  });

  it('27. should not retry indefinitely and stop once retry limit is reached', async () => {
    const dnsServer = await createMockDnsServer();
    const net = new WindowsNetworkManager();
    net.setPlatformForTesting('win32');

    let attemptCount = 0;
    const mockExecutor = async (script: string) => {
      if (script.includes('Get-NetRoute')) {
        attemptCount++;
        return {
          stdout: JSON.stringify({ DefaultRouteCount: 0, Eligible: [], Evaluations: [] }),
          stderr: '',
        };
      }
      if (script.includes('Get-NetIPConfiguration')) {
        return { stdout: '[]', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const delays = [5, 5, 5]; // 3 retries (total 4 attempts)
      const attemptsRecorded: number[] = [];
      const result = await net.activateFailSafeDnsWithRetry({
        dnsPort: dnsServer.port,
        retryDelaysMs: delays,
        onAttempt: (att) => attemptsRecorded.push(att),
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, 'NO_NETWORK_ROUTE');
      assert.strictEqual(attemptCount, 4);
      assert.strictEqual(attemptsRecorded.length, 4);
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      await dnsServer.close();
    }
  });

  it('28. should not enter network-arrival retry when failure is critical DNS apply error', async () => {
    const dnsServer = await createMockDnsServer();
    const backupPath = path.join(os.tmpdir(), 'sb-test-no-retry-crit-' + Date.now() + '.json');
    fs.writeFileSync(
      backupPath,
      JSON.stringify([{ InterfaceIndex: 6, ServerAddresses: ['192.168.1.1'], InterfaceAlias: 'Wi-Fi' }]),
      'utf8'
    );
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    let attemptCount = 0;
    const mockExecutor = async (script: string) => {
      if (script.includes('Get-NetRoute')) {
        attemptCount++;
        return {
          stdout: JSON.stringify({
            DefaultRouteCount: 1,
            Eligible: [
              {
                InterfaceIndex: 6,
                InterfaceAlias: 'Wi-Fi',
                Gateway: '192.168.1.1',
                IPv4Addresses: ['192.168.1.8'],
              },
            ],
            Evaluations: [],
          }),
          stderr: '',
        };
      }
      if (script.includes('Set-DnsClientServerAddress') && script.includes('127.0.0.1')) {
        throw new Error('PowerShell access denied setting 127.0.0.1');
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const attemptsRecorded: number[] = [];
      const result = await net.activateFailSafeDnsWithRetry({
        dnsPort: dnsServer.port,
        retryDelaysMs: [10, 10, 10],
        onAttempt: (att) => attemptsRecorded.push(att),
      });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, 'DNS_ASSIGNMENT_FAILED');
      assert.strictEqual(attemptCount, 1);
      assert.strictEqual(attemptsRecorded.length, 1);
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      await dnsServer.close();
      try {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      } catch {}
    }
  });

  it('29. should trigger DEGRADED to ACTIVE transition callback upon retry success', async () => {
    const dnsServer = await createMockDnsServer();
    const backupPath = path.join(os.tmpdir(), 'sb-test-transition-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    let attempt = 0;
    const mockExecutor = async (script: string) => {
      if (script.includes('Get-NetRoute')) {
        attempt++;
        if (attempt === 1) {
          return { stdout: JSON.stringify({ DefaultRouteCount: 0, Eligible: [], Evaluations: [] }), stderr: '' };
        } else {
          return {
            stdout: JSON.stringify({
              DefaultRouteCount: 1,
              Eligible: [{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Gateway: '192.168.1.1' }],
              Evaluations: [],
            }),
            stderr: '',
          };
        }
      }
      if (script.includes('Get-NetIPConfiguration')) {
        return { stdout: '[]', stderr: '' };
      }
      if (script.includes('Get-DnsClientServerAddress') && script.includes('Select-Object InterfaceIndex, ServerAddresses')) {
        return {
          stdout: JSON.stringify({ InterfaceIndex: 6, ServerAddresses: ['127.0.0.1'] }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const transitions: Array<{ from: string; to: string }> = [];
      const statuses: string[] = [];

      const result = await net.activateFailSafeDnsWithRetry({
        dnsPort: dnsServer.port,
        retryDelaysMs: [10],
        onStatusChange: (status) => statuses.push(status),
        onTransition: (from, to) => transitions.push({ from, to }),
      });

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(transitions, [{ from: 'DEGRADED', to: 'ACTIVE' }]);
      assert.ok(statuses.includes('DEGRADED'));
      assert.ok(statuses.includes('ACTIVE'));
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      await dnsServer.close();
      try {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      } catch {}
    }
  });

  it('30. should enforce read-back verification during route-based activation', async () => {
    const dnsServer = await createMockDnsServer();
    const backupPath = path.join(os.tmpdir(), 'sb-test-rb-verify-' + Date.now() + '.json');
    fs.writeFileSync(
      backupPath,
      JSON.stringify([{ InterfaceIndex: 6, ServerAddresses: ['192.168.1.1'], InterfaceAlias: 'Wi-Fi' }]),
      'utf8'
    );
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    const executedCommands: string[] = [];
    const mockExecutor = async (script: string) => {
      executedCommands.push(script);
      if (script.includes('Get-NetRoute')) {
        return {
          stdout: JSON.stringify({
            DefaultRouteCount: 1,
            Eligible: [{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Gateway: '192.168.1.1' }],
            Evaluations: [],
          }),
          stderr: '',
        };
      }
      if (script.includes('Get-DnsClientServerAddress') && script.includes('Select-Object InterfaceIndex, ServerAddresses')) {
        return {
          stdout: JSON.stringify({ InterfaceIndex: 6, ServerAddresses: ['192.168.1.1'] }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const result = await net.activateFailSafeDns(dnsServer.port);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, 'READBACK_MISMATCH');
      assert.match(result.message, /Read-back verification failed/);
      assert.ok(executedCommands.some((c) => c.includes('192.168.1.1')));
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      await dnsServer.close();
      try {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      } catch {}
    }
  });

  it('31. should guarantee Tailscale virtual adapter is untouched during discovery, activation, and rollback', async () => {
    const dnsServer = await createMockDnsServer();
    const backupPath = path.join(os.tmpdir(), 'sb-test-ts-untouched-' + Date.now() + '.json');
    fs.writeFileSync(
      backupPath,
      JSON.stringify([{ InterfaceIndex: 6, ServerAddresses: ['192.168.1.1'], InterfaceAlias: 'Wi-Fi' }]),
      'utf8'
    );
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    const executedCommands: string[] = [];
    const mockExecutor = async (script: string) => {
      executedCommands.push(script);
      if (script.includes('Get-NetRoute')) {
        return {
          stdout: JSON.stringify({
            DefaultRouteCount: 2,
            Eligible: [{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Gateway: '192.168.1.1' }],
            Evaluations: [
              {
                InterfaceIndex: 11,
                InterfaceAlias: 'Tailscale',
                NextHop: '0.0.0.0',
                Status: 'Up',
                IPv4Addresses: ['100.98.155.122'],
                Eligible: false,
                RejectionReason: 'Invalid or zero NextHop',
              },
              {
                InterfaceIndex: 6,
                InterfaceAlias: 'Wi-Fi',
                NextHop: '192.168.1.1',
                Status: 'Up',
                IPv4Addresses: ['192.168.1.8'],
                Eligible: true,
              },
            ],
          }),
          stderr: '',
        };
      }
      if (script.includes('Get-DnsClientServerAddress') && script.includes('Select-Object InterfaceIndex, ServerAddresses')) {
        return {
          stdout: JSON.stringify({ InterfaceIndex: 6, ServerAddresses: ['127.0.0.1'] }),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    net.setCommandExecutorForTesting(mockExecutor);

    try {
      const result = await net.activateFailSafeDns(dnsServer.port);
      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.interfaceIndexes, [6]);

      // Verify that InterfaceIndex 11 (Tailscale) was NEVER modified
      const tsModifications = executedCommands.filter(
        (c) => c.includes('InterfaceIndex 11') && c.includes('Set-DnsClientServerAddress')
      );
      assert.strictEqual(tsModifications.length, 0, 'Tailscale adapter must never be modified by Set-DnsClientServerAddress');

      // Now test rollback
      await net.restoreOriginalDns();
      const tsRollback = executedCommands.filter(
        (c) => c.includes('InterfaceIndex 11') && c.includes('Set-DnsClientServerAddress')
      );
      assert.strictEqual(tsRollback.length, 0, 'Tailscale adapter must never be modified during rollback');
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      await dnsServer.close();
      try {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
      } catch {}
    }
  });
});
