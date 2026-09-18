import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WindowsNetworkManager } from '../src/network-manager';

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
    const isResponding = await netManager.verifyDnsProxyResponding(54321, 500);
    assert.strictEqual(isResponding, false);
  });

  it('3. should abort fail-safe DNS activation if proxy is not responding', async () => {
    // Use an unassigned port to guarantee probe failure
    const result = await netManager.activateFailSafeDns(54322);
    assert.strictEqual(result.success, false);
    assert.match(result.message, /failed health probe/);
  });

  it('4. should run restoreOriginalDns cleanly without throwing on non-Windows platform', async () => {
    await assert.doesNotReject(async () => {
      await netManager.restoreOriginalDns();
    });
  });

  it('5. should execute restoration commands on Windows platform and succeed', async () => {
    const executedCommands: string[] = [];
    const mockExecutor = async (cmd: string) => {
      executedCommands.push(cmd);
      return { stdout: '', stderr: '' };
    };
    netManager.setPlatformForTesting('win32');
    netManager.setCommandExecutorForTesting(mockExecutor);

    try {
      await netManager.restoreOriginalDns();
      assert.ok(executedCommands.length > 0);
      assert.ok(executedCommands.some((c) => c.includes('Set-DnsClientServerAddress') || c.includes('Clear-DnsClientCache')));
    } finally {
      netManager.setPlatformForTesting(null);
      netManager.setCommandExecutorForTesting(null);
    }
  });

  it('6. should reject and throw when Windows DNS restoration fails', async () => {
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

  it('7. should fall back to DHCP reset when backup file contains empty addresses', async () => {
    const emptyBackupFile = path.join(os.tmpdir(), 'sb-test-empty-backup-' + Date.now() + '.json');
    fs.writeFileSync(emptyBackupFile, JSON.stringify([{ InterfaceIndex: 2, ServerAddresses: [] }]), 'utf8');
    const emptyNetManager = new WindowsNetworkManager(emptyBackupFile);

    const executedCommands: string[] = [];
    const mockExecutor = async (cmd: string) => {
      executedCommands.push(cmd);
      return { stdout: '', stderr: '' };
    };
    emptyNetManager.setPlatformForTesting('win32');
    emptyNetManager.setCommandExecutorForTesting(mockExecutor);

    try {
      await emptyNetManager.restoreOriginalDns();
      assert.ok(executedCommands.some((c) => c.includes('-ResetServerAddresses')));
    } finally {
      emptyNetManager.setPlatformForTesting(null);
      emptyNetManager.setCommandExecutorForTesting(null);
      try {
        if (fs.existsSync(emptyBackupFile)) {
          fs.unlinkSync(emptyBackupFile);
        }
      } catch {}
    }
  });
});
