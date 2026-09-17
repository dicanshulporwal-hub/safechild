import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WindowsNetworkManager } from '../src/network-manager';

describe('SafeBrowse Windows NetworkManager & Fail-Safe Activation Tests', () => {
  const testTmpFile = path.join(os.tmpdir(), 'sb-test-network-backup-' + Date.now() + '.json');
  const netManager = new WindowsNetworkManager(testTmpFile);

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

  it('4. should run restoreOriginalDns cleanly without throwing', async () => {
    await assert.doesNotReject(async () => {
      await netManager.restoreOriginalDns();
    });
  });
});
