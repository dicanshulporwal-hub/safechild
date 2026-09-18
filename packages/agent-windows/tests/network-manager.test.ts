import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as dgram from 'dgram';
import { WindowsNetworkManager } from '../src/network-manager';

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
  const testTmpFile = path.join(os.tmpdir(), 'sb-test-network-backup-' + Date.now() + '.json');
  const netManager = new WindowsNetworkManager(testTmpFile);

  after(() => {
    try {
      if (fs.existsSync(testTmpFile)) {
        fs.unlinkSync(testTmpFile);
      }
    } catch {}
  });

  it('1. should create DNS backup on call', async () => {
    const backup = await netManager.backupCurrentDnsConfig();
    assert.ok(Array.isArray(backup));
    assert.strictEqual(fs.existsSync(testTmpFile), true);
    const saved = JSON.parse(fs.readFileSync(testTmpFile, 'utf8'));
    assert.ok(Array.isArray(saved));
  });

  it('2. should fail probe when DNS proxy is not listening on given port', async () => {
    // Port 54321 is unused in test
    const isResponding = await netManager.verifyDnsProxyResponding(54321, 300);
    assert.strictEqual(isResponding, false);
  });

  it('3. should abort fail-safe DNS activation if proxy is not responding', async () => {
    // Use an unassigned port with a short timeout to guarantee probe failure
    const result = await netManager.activateFailSafeDns(54322);
    assert.strictEqual(result.success, false);
    assert.match(result.message, /failed health probe/);
  });

  it('4. should run restoreOriginalDns cleanly without throwing on non-Windows platform', async () => {
    await assert.doesNotReject(async () => {
      await netManager.restoreOriginalDns();
    });
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
      const backup = await net.backupCurrentDnsConfig();
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
    const failingExecutor = async () => {
      throw new Error('PowerShell Set-DnsClientServerAddress access denied');
    };
    netManager.setPlatformForTesting('win32');
    netManager.setCommandExecutorForTesting(failingExecutor);

    try {
      await assert.rejects(
        async () => {
          await netManager.restoreOriginalDns();
        },
        /PowerShell Set-DnsClientServerAddress access denied/
      );
    } finally {
      netManager.setPlatformForTesting(null);
      netManager.setCommandExecutorForTesting(null);
    }
  });
});
