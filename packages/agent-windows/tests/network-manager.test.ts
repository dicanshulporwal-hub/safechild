import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as dgram from 'dgram';
import { WindowsNetworkManager, TargetAdapterInfo, AdapterDnsQueryResult } from '../src/network-manager';
import { computeEngineStatus } from '../src/agent-cli';

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

  // ===========================================================================
  // Regression tests for Run #14 physical defect:
  // On Windows PowerShell 5.1, assigning a single PSCustomObject from foreach
  // collapsed the output to a scalar whose .Count property was empty/null.
  // The subsequent `if ($result.Count -gt 0)` evaluated false, outputting `[]`
  // and causing SafeBrowse to endlessly re-enforce an already-protected adapter.
  // Fix: direct querying, array-safe `@(foreach ...)` assignment, `@($results).Count`,
  // and single-string ServerAddresses normalization.
  // ===========================================================================

  it('32. queryDnsStateForAdapters: single-address 127.0.0.1 string normalises to ["127.0.0.1"] and IsEnforced=true', async () => {
    // Simulates PowerShell JSON where a single ServerAddresses value is emitted as a plain string
    // (not an array), which is valid PowerShell 5.1 ConvertTo-Json behavior for one-element collections.
    const backupPath = path.join(os.tmpdir(), 'sb-test-query-32-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    net.setCommandExecutorForTesting(async (_script: string) => ({
      stdout: JSON.stringify({
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        ServerAddresses: '127.0.0.1',   // ← single string, not array (PS 5.1 behavior)
        CleanNonLoopback: null,
        IsEnforced: true,
        DhcpEnabled: true,
        QueryStatus: 'OK',
      }),
      stderr: '',
    }));

    const targets: TargetAdapterInfo[] = [
      { InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Description: 'Wi-Fi', Gateway: '192.168.1.1', IpAddresses: ['192.168.1.8'] },
    ];

    try {
      const result = await net.queryDnsStateForAdapters(targets);
      assert.strictEqual(result.length, 1);
      assert.deepStrictEqual(result[0].ServerAddresses, ['127.0.0.1'], 'Single string must be normalised to array');
      assert.strictEqual(result[0].IsEnforced, true);
      assert.strictEqual(result[0].queryStatus, 'OK');
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
  });

  it('33. queryDnsStateForAdapters: multi-address array ["1.1.1.1","8.8.8.8"] normalises correctly and IsEnforced=false', async () => {
    const backupPath = path.join(os.tmpdir(), 'sb-test-query-33-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    net.setCommandExecutorForTesting(async (_script: string) => ({
      stdout: JSON.stringify([{
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        ServerAddresses: ['1.1.1.1', '8.8.8.8'],
        CleanNonLoopback: ['1.1.1.1', '8.8.8.8'],
        IsEnforced: false,
        DhcpEnabled: false,
        QueryStatus: 'OK',
      }]),
      stderr: '',
    }));

    const targets: TargetAdapterInfo[] = [
      { InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Description: 'Wi-Fi', Gateway: '192.168.1.1', IpAddresses: ['192.168.1.8'] },
    ];

    try {
      const result = await net.queryDnsStateForAdapters(targets);
      assert.strictEqual(result.length, 1);
      assert.deepStrictEqual(result[0].ServerAddresses, ['1.1.1.1', '8.8.8.8']);
      assert.strictEqual(result[0].IsEnforced, false);
      assert.strictEqual(result[0].DhcpEnabled, false);
      assert.strictEqual(result[0].queryStatus, 'OK');
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
  });

  it('34. queryDnsStateForAdapters: zero ServerAddresses returns [] (truly empty adapter)', async () => {
    const backupPath = path.join(os.tmpdir(), 'sb-test-query-34-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    net.setCommandExecutorForTesting(async (_script: string) => ({
      stdout: JSON.stringify([{
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        ServerAddresses: [],
        CleanNonLoopback: [],
        IsEnforced: false,
        DhcpEnabled: true,
        QueryStatus: 'OK',
      }]),
      stderr: '',
    }));

    const targets: TargetAdapterInfo[] = [
      { InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Description: 'Wi-Fi', Gateway: '192.168.1.1', IpAddresses: ['192.168.1.8'] },
    ];

    try {
      const result = await net.queryDnsStateForAdapters(targets);
      assert.strictEqual(result.length, 1);
      assert.deepStrictEqual(result[0].ServerAddresses, []);
      assert.strictEqual(result[0].IsEnforced, false);
      assert.strictEqual(result[0].queryStatus, 'OK');
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
  });

  it('35. queryDnsStateForAdapters: QUERY_FAILED when PS returns empty for a known-active adapter index', async () => {
    // Simulates adapter DNS query failure: PS returns no row for the adapter.
    // The helper returns queryStatus=QUERY_FAILED instead of silently treating as unenforced.
    const backupPath = path.join(os.tmpdir(), 'sb-test-query-35-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    net.setCommandExecutorForTesting(async (_script: string) => ({
      stdout: JSON.stringify([{
        InterfaceIndex: 6,
        InterfaceAlias: 'Interface 6',
        ServerAddresses: [],
        CleanNonLoopback: [],
        IsEnforced: false,
        DhcpEnabled: true,
        QueryStatus: 'QUERY_FAILED',   // ← explicit failure marker
      }]),
      stderr: '',
    }));

    const targets: TargetAdapterInfo[] = [
      { InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Description: 'Wi-Fi', Gateway: '192.168.1.1', IpAddresses: ['192.168.1.8'] },
    ];

    try {
      const result = await net.queryDnsStateForAdapters(targets);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].queryStatus, 'QUERY_FAILED');
      assert.strictEqual(result[0].IsEnforced, false);
      assert.deepStrictEqual(result[0].ServerAddresses, []);
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
  });

  it('36. reconcileAdapters: already-enforced adapter (127.0.0.1) returns IN_SYNC with no Set-DnsClientServerAddress call', async () => {
    // This is the exact physical regression: DNS was already 127.0.0.1 but reconciliation
    // kept re-enforcing because the old -contains query returned empty.
    const dnsServer = await createMockDnsServer();
    const backupPath = path.join(os.tmpdir(), 'sb-test-reconcile-36-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    const executedCommands: string[] = [];
    net.setCommandExecutorForTesting(async (script: string) => {
      executedCommands.push(script);
      // Route discovery
      if (script.includes('Get-NetRoute')) {
        return {
          stdout: JSON.stringify([{
            InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Description: 'Intel Wi-Fi',
            Gateway: '192.168.1.1', IPv4Addresses: ['192.168.1.8'],
          }]),
          stderr: '',
        };
      }
      // Per-adapter DNS query — returns 127.0.0.1 already enforced, QueryStatus=OK
      if (script.includes('Get-DnsClientServerAddress') && script.includes('[int]6')) {
        return {
          stdout: JSON.stringify([{
            InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi',
            ServerAddresses: ['127.0.0.1'],
            CleanNonLoopback: [],
            IsEnforced: true,
            DhcpEnabled: true,
            QueryStatus: 'OK',
          }]),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    try {
      const result = await net.reconcileAdapters(dnsServer.port);
      assert.strictEqual(result.status, 'IN_SYNC', 'Already-enforced adapter must report IN_SYNC');
      const setDnsCalls = executedCommands.filter((c) => c.includes('Set-DnsClientServerAddress'));
      assert.strictEqual(setDnsCalls.length, 0, 'No Set-DnsClientServerAddress must be invoked when already enforced');
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      await dnsServer.close();
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
  });

  it('37. reconcileAdapters: QUERY_FAILED for all adapters returns ERROR (never IN_SYNC) and zero Set-DnsClientServerAddress calls', async () => {
    const dnsServer = await createMockDnsServer();
    const backupPath = path.join(os.tmpdir(), 'sb-test-reconcile-37-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    const executedCommands: string[] = [];
    net.setCommandExecutorForTesting(async (script: string) => {
      executedCommands.push(script);
      if (script.includes('Get-NetRoute')) {
        return {
          stdout: JSON.stringify([{
            InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Description: 'Intel Wi-Fi',
            Gateway: '192.168.1.1', IPv4Addresses: ['192.168.1.8'],
          }]),
          stderr: '',
        };
      }
      // DNS query returns QUERY_FAILED — simulates adapter query failure
      if (script.includes('Get-DnsClientServerAddress')) {
        return {
          stdout: JSON.stringify([{
            InterfaceIndex: 6, InterfaceAlias: 'Interface 6',
            ServerAddresses: [], CleanNonLoopback: [],
            IsEnforced: false, DhcpEnabled: true,
            QueryStatus: 'QUERY_FAILED',
          }]),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    try {
      const result = await net.reconcileAdapters(dnsServer.port);
      // Must not blindly re-enforce; must return ERROR, NEVER IN_SYNC
      assert.strictEqual(result.status, 'ERROR', 'QUERY_FAILED for all adapters must return ERROR, never IN_SYNC');
      assert.deepStrictEqual(result.unenforcedIndexes, [6]);
      assert.ok(result.message.includes('DNS state query failed'));
      const setDnsCalls = executedCommands.filter((c) => c.includes('Set-DnsClientServerAddress'));
      assert.strictEqual(setDnsCalls.length, 0, 'No Set-DnsClientServerAddress when DNS query fails');
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      await dnsServer.close();
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
  });

  it('38. reconcileAdapters: hotspot external DNS 10.23.63.61 triggers exactly one RE_ENFORCED then next tick is IN_SYNC', async () => {
    const dnsServer = await createMockDnsServer();
    const backupPath = path.join(os.tmpdir(), 'sb-test-reconcile-38-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('linux');

    const adapters = [{
      InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Status: 'Up' as const,
      IpAddresses: ['10.23.63.201'], Gateway: '10.23.63.1',
      ServerAddresses: ['10.23.63.61'], DhcpEnabled: true,
    }];
    net.setMockAdaptersForTesting(adapters);

    try {
      // First tick: DNS is 10.23.63.61 — must RE_ENFORCE
      const r1 = await net.reconcileAdapters(dnsServer.port);
      assert.strictEqual(r1.status, 'RE_ENFORCED');
      assert.deepStrictEqual(adapters[0].ServerAddresses, ['127.0.0.1']);

      // Second tick: DNS is now 127.0.0.1 — must be IN_SYNC
      const r2 = await net.reconcileAdapters(dnsServer.port);
      assert.strictEqual(r2.status, 'IN_SYNC');
    } finally {
      net.setPlatformForTesting(null);
      await dnsServer.close();
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
  });

  it('39. inspectCurrentEnforcement: adapter with 127.0.0.1 reports isProtected=true and summary="Protected"', async () => {
    const backupPath = path.join(os.tmpdir(), 'sb-test-inspect-39-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    net.setCommandExecutorForTesting(async (script: string) => {
      if (script.includes('Get-NetRoute')) {
        return {
          stdout: JSON.stringify([{
            InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Description: 'Intel Wi-Fi',
            Gateway: '192.168.1.1', IPv4Addresses: ['192.168.1.8'],
          }]),
          stderr: '',
        };
      }
      if (script.includes('Get-DnsClientServerAddress') && script.includes('[int]6')) {
        return {
          stdout: JSON.stringify([{
            InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi',
            ServerAddresses: ['127.0.0.1'],
            CleanNonLoopback: [],
            IsEnforced: true,
            DhcpEnabled: true,
            QueryStatus: 'OK',
          }]),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    try {
      const inspection = await net.inspectCurrentEnforcement();
      assert.strictEqual(inspection.isProtected, true, 'Must report Protected when DNS is 127.0.0.1');
      assert.strictEqual(inspection.summary, 'Protected');
      assert.strictEqual(inspection.activeAdapters.length, 1);
      assert.strictEqual(inspection.activeAdapters[0].isEnforced, true);
      assert.deepStrictEqual(inspection.activeAdapters[0].dnsServers, ['127.0.0.1']);
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
  });

  it('40. inspectCurrentEnforcement and reconcileAdapters use the same queryDnsStateForAdapters helper (same PS script shape)', async () => {
    // Verifies both callers emit the same -InterfaceIndex [int]N query shape,
    // confirming they share the helper and are immune to the type-mismatch regression.
    const dnsServer = await createMockDnsServer();
    const backupPath = path.join(os.tmpdir(), 'sb-test-shared-40-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    const reconcileScripts: string[] = [];
    const inspectScripts: string[] = [];
    let phase: 'reconcile' | 'inspect' = 'reconcile';

    const dnsResponse = JSON.stringify([{
      InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi',
      ServerAddresses: ['127.0.0.1'],
      CleanNonLoopback: [],
      IsEnforced: true,
      DhcpEnabled: true,
      QueryStatus: 'OK',
    }]);
    const routeResponse = JSON.stringify([{
      InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Description: 'Intel Wi-Fi',
      Gateway: '192.168.1.1', IPv4Addresses: ['192.168.1.8'],
    }]);

    net.setCommandExecutorForTesting(async (script: string) => {
      if (script.includes('Get-NetRoute')) {
        return { stdout: routeResponse, stderr: '' };
      }
      if (script.includes('Get-DnsClientServerAddress')) {
        if (phase === 'reconcile') reconcileScripts.push(script);
        else inspectScripts.push(script);
        return { stdout: dnsResponse, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    try {
      phase = 'reconcile';
      await net.reconcileAdapters(dnsServer.port);

      phase = 'inspect';
      await net.inspectCurrentEnforcement();

      // Both must use -InterfaceIndex [int]6 (not the old -contains filter)
      const reconcileDnsScript = reconcileScripts[0] || '';
      const inspectDnsScript = inspectScripts[0] || '';

      assert.ok(reconcileScripts.length > 0, 'reconcileAdapters must have captured a DNS script');
      assert.ok(inspectScripts.length > 0, 'inspectCurrentEnforcement must have captured a DNS script');

      assert.ok(
        reconcileDnsScript.includes('[int]6') || reconcileDnsScript.includes('-InterfaceIndex'),
        'reconcileAdapters DNS script must use explicit -InterfaceIndex query'
      );
      assert.ok(
        inspectDnsScript.includes('[int]6') || inspectDnsScript.includes('-InterfaceIndex'),
        'inspectCurrentEnforcement DNS script must use explicit -InterfaceIndex query'
      );

      // Verify array-safe result handling to prevent scalar .Count collapse
      assert.ok(
        reconcileDnsScript.includes('@($results).Count') || reconcileDnsScript.includes('$results = @('),
        'reconcileAdapters DNS script must use array-safe Count handling'
      );
      assert.ok(
        inspectDnsScript.includes('@($results).Count') || inspectDnsScript.includes('$results = @('),
        'inspectCurrentEnforcement DNS script must use array-safe Count handling'
      );
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      await dnsServer.close();
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
  });


  it('41. queryDnsStateForAdapters: null ServerAddresses from PS normalises to [] (not null/undefined)', async () => {
    const backupPath = path.join(os.tmpdir(), 'sb-test-query-41-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    net.setCommandExecutorForTesting(async (_script: string) => ({
      stdout: JSON.stringify([{
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        ServerAddresses: null,   // PowerShell can emit null for empty collections in some PS versions
        CleanNonLoopback: null,
        IsEnforced: false,
        DhcpEnabled: true,
        QueryStatus: 'OK',
      }]),
      stderr: '',
    }));

    const targets: TargetAdapterInfo[] = [
      { InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Description: 'Wi-Fi', Gateway: '192.168.1.1', IpAddresses: ['192.168.1.8'] },
    ];

    try {
      const result = await net.queryDnsStateForAdapters(targets);
      assert.strictEqual(result.length, 1);
      assert.ok(Array.isArray(result[0].ServerAddresses), 'ServerAddresses must always be an array');
      assert.deepStrictEqual(result[0].ServerAddresses, []);
      assert.ok(Array.isArray(result[0].CleanNonLoopback), 'CleanNonLoopback must always be an array');
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
  });

  it('42. reconcileAdapters: ONE of multiple active adapters fails DNS query -> overall result is ERROR, never IN_SYNC', async () => {
    // When one adapter's DNS query succeeds and is enforced, but another active adapter's
    // DNS query fails, overall system protection cannot be verified. Must return ERROR, not IN_SYNC.
    const dnsServer = await createMockDnsServer();
    const backupPath = path.join(os.tmpdir(), 'sb-test-reconcile-42-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    const executedCommands: string[] = [];
    net.setCommandExecutorForTesting(async (script: string) => {
      executedCommands.push(script);
      if (script.includes('Get-NetRoute')) {
        return {
          stdout: JSON.stringify([
            { InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Description: 'Intel Wi-Fi', Gateway: '192.168.1.1', IPv4Addresses: ['192.168.1.8'] },
            { InterfaceIndex: 14, InterfaceAlias: 'Ethernet', Description: 'Realtek PCIe', Gateway: '10.0.0.1', IPv4Addresses: ['10.0.0.15'] },
          ]),
          stderr: '',
        };
      }
      if (script.includes('Get-DnsClientServerAddress')) {
        // Wi-Fi (6) succeeds with 127.0.0.1; Ethernet (14) fails query
        return {
          stdout: JSON.stringify([
            { InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', ServerAddresses: ['127.0.0.1'], CleanNonLoopback: [], IsEnforced: true, DhcpEnabled: true, QueryStatus: 'OK' },
            { InterfaceIndex: 14, InterfaceAlias: 'Ethernet', ServerAddresses: [], CleanNonLoopback: [], IsEnforced: false, DhcpEnabled: true, QueryStatus: 'QUERY_FAILED' },
          ]),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    try {
      const result = await net.reconcileAdapters(dnsServer.port);
      // Overall status must be ERROR because Ethernet could not be verified
      assert.strictEqual(result.status, 'ERROR', 'Partial query failure must return ERROR, never IN_SYNC');
      assert.deepStrictEqual(result.enforcedIndexes, [6]);
      assert.deepStrictEqual(result.unenforcedIndexes, [14]);
      assert.ok(result.message.includes('DNS state query failed'));

      // No blind rewrite of the failed adapter
      const setDnsCalls = executedCommands.filter((c) => c.includes('Set-DnsClientServerAddress'));
      assert.strictEqual(setDnsCalls.length, 0, 'No Set-DnsClientServerAddress calls on query failure');
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      await dnsServer.close();
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
  });

  it('43. inspectCurrentEnforcement: QUERY_FAILED adapter sets isProtected=false and surfaces [DNS_QUERY_FAILED]', async () => {
    const backupPath = path.join(os.tmpdir(), 'sb-test-inspect-43-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    net.setCommandExecutorForTesting(async (script: string) => {
      if (script.includes('Get-NetRoute')) {
        return {
          stdout: JSON.stringify([{
            InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Description: 'Intel Wi-Fi',
            Gateway: '192.168.1.1', IPv4Addresses: ['192.168.1.8'],
          }]),
          stderr: '',
        };
      }
      if (script.includes('Get-DnsClientServerAddress')) {
        return {
          stdout: JSON.stringify([{
            InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi',
            ServerAddresses: [], CleanNonLoopback: [],
            IsEnforced: false, DhcpEnabled: true,
            QueryStatus: 'QUERY_FAILED',
          }]),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    try {
      const inspection = await net.inspectCurrentEnforcement();
      assert.strictEqual(inspection.isProtected, false, 'QUERY_FAILED must not report Protected');
      assert.strictEqual(inspection.summary, 'DNS not redirected');
      assert.strictEqual(inspection.activeAdapters.length, 1);
      assert.strictEqual(inspection.activeAdapters[0].isEnforced, false);
      // queryStatus is set to QUERY_FAILED, and dnsServers remains clean [] (DNS IP addresses only)
      assert.strictEqual(inspection.activeAdapters[0].queryStatus, 'QUERY_FAILED');
      assert.deepStrictEqual(inspection.activeAdapters[0].dnsServers, []);
      assert.strictEqual(inspection.activeAdapters[0].interfaceAlias, 'Wi-Fi');
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
  });

  it('44. reconcileAdapters: stable protected network produces zero DNS writes and skips redundant firewall initialization', async () => {
    const dnsServer = await createMockDnsServer();
    const backupPath = path.join(os.tmpdir(), 'sb-test-reconcile-44-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    const executedCommands: string[] = [];
    net.setCommandExecutorForTesting(async (script: string) => {
      executedCommands.push(script);
      if (script.includes('Get-NetRoute')) {
        return {
          stdout: JSON.stringify([{
            InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Description: 'Intel Wi-Fi',
            Gateway: '192.168.1.1', IPv4Addresses: ['192.168.1.8'],
          }]),
          stderr: '',
        };
      }
      if (script.includes('Get-DnsClientServerAddress')) {
        return {
          stdout: JSON.stringify([{
            InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi',
            ServerAddresses: ['127.0.0.1'], CleanNonLoopback: [],
            IsEnforced: true, DhcpEnabled: true,
            QueryStatus: 'OK',
          }]),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    try {
      // Tick 1
      const r1 = await net.reconcileAdapters(dnsServer.port);
      assert.strictEqual(r1.status, 'IN_SYNC');
      assert.deepStrictEqual(r1.enforcedIndexes, [6]);

      // Tick 2
      const r2 = await net.reconcileAdapters(dnsServer.port);
      assert.strictEqual(r2.status, 'IN_SYNC');
      assert.deepStrictEqual(r2.enforcedIndexes, [6]);

      // Across both ticks, zero Set-DnsClientServerAddress calls
      const setDnsCalls = executedCommands.filter((c) => c.includes('Set-DnsClientServerAddress'));
      assert.strictEqual(setDnsCalls.length, 0, 'Zero DNS writes on stable protected network');
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      await dnsServer.close();
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
  });

  it('45. proven root cause: single-adapter scalar PSCustomObject from ConvertTo-Json parses into 1-element array with normalized DNS', async () => {
    // When PowerShell 5.1 converts a single PSCustomObject (not an array), ConvertTo-Json emits a raw
    // JSON object: {"InterfaceIndex":6,"InterfaceAlias":"Wi-Fi","ServerAddresses":"127.0.0.1",...}
    // queryDnsStateForAdapters must handle this scalar object correctly and normalize ServerAddresses to ["127.0.0.1"].
    const backupPath = path.join(os.tmpdir(), 'sb-test-scalar-45-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    net.setCommandExecutorForTesting(async (_script: string) => ({
      // Real PowerShell 5.1 output on DIC Windows laptop: single object, scalar ServerAddresses string
      stdout: JSON.stringify({
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        ServerAddresses: '127.0.0.1',
        CleanNonLoopback: [],
        IsEnforced: true,
        DhcpEnabled: true,
        QueryStatus: 'OK',
      }),
      stderr: '',
    }));

    const targets: TargetAdapterInfo[] = [
      { InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Description: 'Wi-Fi', Gateway: '192.168.1.1', IpAddresses: ['192.168.1.8'] },
    ];

    try {
      const results = await net.queryDnsStateForAdapters(targets);
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].InterfaceIndex, 6);
      assert.deepStrictEqual(results[0].ServerAddresses, ['127.0.0.1']);
      assert.strictEqual(results[0].IsEnforced, true);
      assert.strictEqual(results[0].queryStatus, 'OK');
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
  });

  it('46. generated PowerShell scripts audit: array assignment @(...) and @().Count prevents scalar .Count collapse', async () => {
    // Audit that queryDnsStateForAdapters script syntax guards against the proven PS 5.1 foreach scalar collapse
    const backupPath = path.join(os.tmpdir(), 'sb-test-audit-46-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('win32');

    let capturedScript = '';
    net.setCommandExecutorForTesting(async (script: string) => {
      capturedScript = script;
      return {
        stdout: JSON.stringify([{
          InterfaceIndex: 6,
          InterfaceAlias: 'Wi-Fi',
          ServerAddresses: ['127.0.0.1'],
          CleanNonLoopback: [],
          IsEnforced: true,
          DhcpEnabled: true,
          QueryStatus: 'OK',
        }]),
        stderr: '',
      };
    });

    const targets: TargetAdapterInfo[] = [
      { InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Description: 'Wi-Fi', Gateway: '192.168.1.1', IpAddresses: ['192.168.1.8'] },
    ];

    try {
      await net.queryDnsStateForAdapters(targets);
      // Must use @(foreach ...) assignment and @($results).Count check
      assert.ok(
        capturedScript.includes('$results = @('),
        'PowerShell script must use $results = @( to avoid scalar .Count collapse'
      );
      assert.ok(
        capturedScript.includes('@($results).Count -gt 0'),
        'PowerShell script must use @($results).Count -gt 0'
      );
    } finally {
      net.setPlatformForTesting(null);
      net.setCommandExecutorForTesting(null);
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
  });

  it('47. concurrent reconcile: active execution causes concurrent call to return SKIPPED (never IN_SYNC)', async () => {
    const backupPath = path.join(os.tmpdir(), 'sb-test-concurrent-47-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('linux');

    try {
      // Simulate isReconciling lock held by an in-flight operation
      (net as any).isReconciling = true;
      const res = await net.reconcileAdapters(53);
      assert.strictEqual(res.status, 'SKIPPED');
      assert.notStrictEqual(res.status, 'IN_SYNC', 'Concurrent reconcile must never return IN_SYNC');
      assert.ok(res.message.includes('skipped'));
    } finally {
      (net as any).isReconciling = false;
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
  });

  it('48. reconciliation loop: slow reconciliation overlapping with timer ticks does NOT emit onStateChange for skipped ticks', async () => {
    const backupPath = path.join(os.tmpdir(), 'sb-test-loop-48-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('linux');

    const callbacks: Array<{ success: boolean; reason?: string }> = [];
    try {
      // Hold isReconciling lock while startReconciliationLoop is running
      (net as any).isReconciling = true;
      net.startReconciliationLoop(53, 20, (success, reason) => {
        callbacks.push({ success, reason });
      });

      // Allow several timer ticks to fire while isReconciling is held
      await new Promise((resolve) => setTimeout(resolve, 80));

      // Must be ZERO callbacks emitted because all overlapping ticks are skipped
      assert.strictEqual(callbacks.length, 0, 'Skipped/busy ticks must emit zero state change callbacks');
    } finally {
      net.stopReconciliationLoop();
      (net as any).isReconciling = false;
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
  });

  it('49. NO_NETWORK_ROUTE invariant: slow reconciliation with no route emits NO_NETWORK_ROUTE, while overlapping ticks emit zero false success callbacks', async () => {
    const backupPath = path.join(os.tmpdir(), 'sb-test-no-route-49-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('linux');
    net.setMockAdaptersForTesting([]); // No active internet-facing route

    const callbacks: Array<{ success: boolean; reason?: string }> = [];
    try {
      net.startReconciliationLoop(53, 25, (success, reason) => {
        callbacks.push({ success, reason });
      });

      // Wait for multiple ticks
      await new Promise((resolve) => setTimeout(resolve, 100));

      // All emitted callbacks must be false / NO_NETWORK_ROUTE
      assert.ok(callbacks.length > 0, 'Should have received at least one callback');
      for (const cb of callbacks) {
        assert.strictEqual(cb.success, false, 'No callback must report success during no-network');
        assert.strictEqual(cb.reason, 'NO_NETWORK_ROUTE');
      }
    } finally {
      net.stopReconciliationLoop();
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
  });

  it('50. no-network engine status stability: policy changes while NO_NETWORK_ROUTE is held keep engine DEGRADED_NO_NETWORK', () => {
    // Verifies the state invariant: policy changes (POLICY_LIVE <-> POLICY_CACHED) do not
    // override DEGRADED_NO_NETWORK because network connectivity is not verified.
    const sLive = computeEngineStatus(false, 'NO_NETWORK_ROUTE', 'POLICY_LIVE');
    assert.strictEqual(sLive, 'DEGRADED_NO_NETWORK');

    const sCached = computeEngineStatus(false, 'NO_NETWORK_ROUTE', 'POLICY_CACHED');
    assert.strictEqual(sCached, 'DEGRADED_NO_NETWORK');

    const sUnavail = computeEngineStatus(false, 'NO_NETWORK_ROUTE', 'POLICY_UNAVAILABLE');
    assert.strictEqual(sUnavail, 'DEGRADED_NO_NETWORK');
  });

  it('51. network reconnect: returns RE_ENFORCED on external DNS, subsequent tick returns IN_SYNC', async () => {
    const dnsServer = await createMockDnsServer();
    const backupPath = path.join(os.tmpdir(), 'sb-test-reconnect-51-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);
    net.setPlatformForTesting('linux');

    const adapters = [{
      InterfaceIndex: 6,
      InterfaceAlias: 'Wi-Fi',
      Status: 'Up' as const,
      IpAddresses: ['192.168.1.50'],
      Gateway: '192.168.1.1',
      ServerAddresses: ['192.168.1.1'],
      DhcpEnabled: true,
    }];
    net.setMockAdaptersForTesting(adapters);

    try {
      // Reconnect tick: external DNS -> RE_ENFORCED
      const r1 = await net.reconcileAdapters(dnsServer.port);
      assert.strictEqual(r1.status, 'RE_ENFORCED');
      assert.deepStrictEqual(adapters[0].ServerAddresses, ['127.0.0.1']);

      // Subsequent tick: already at 127.0.0.1 -> IN_SYNC
      const r2 = await net.reconcileAdapters(dnsServer.port);
      assert.strictEqual(r2.status, 'IN_SYNC');
    } finally {
      net.setPlatformForTesting(null);
      await dnsServer.close();
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
  });

  it('52. timer lifecycle safety: duplicate start clears previous timer, stopReconciliationLoop leaves no open handles', () => {
    const backupPath = path.join(os.tmpdir(), 'sb-test-timer-52-' + Date.now() + '.json');
    const net = new WindowsNetworkManager(backupPath);

    try {
      net.startReconciliationLoop(53, 5000);
      const timer1 = net.getReconcileTimerForTesting();
      assert.ok(timer1 !== null, 'Timer must be active');

      // Duplicate start must replace timer without leaking
      net.startReconciliationLoop(53, 5000);
      const timer2 = net.getReconcileTimerForTesting();
      assert.ok(timer2 !== null, 'Timer must be active after duplicate start');
      assert.notStrictEqual(timer1, timer2, 'New timer instance must replace previous');

      // Clean stop
      net.stopReconciliationLoop();
      assert.strictEqual(net.getReconcileTimerForTesting(), null, 'Timer must be cleared after stop');
    } finally {
      net.stopReconciliationLoop();
      try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
  });
});
