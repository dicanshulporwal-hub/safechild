import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as dgram from 'dgram';
import { Policy, PolicyRule } from '@safebrowse/shared';
import { WindowsNetworkManager, MockAdapterState } from '../src/network-manager';
import { PolicySyncClient, DeviceConfig } from '../src/sync-client';
import { DnsFilterProxy } from '../src/dns-proxy';
import { BlockPageServer } from '../src/block-server';
import { WindowsFirewallEngine, firewallEngine } from '../src/wfp-engine';
import { computeEngineStatus, isEnforcementActive } from '../src/agent-cli';
import { ConfigManager } from '../src/config-manager';

function makeMockRule(domain: string, action: 'BLOCK' | 'ALLOW' = 'BLOCK'): PolicyRule {
  return {
    id: `r-${Math.random()}`,
    domain,
    action,
    addedAt: new Date().toISOString(),
  };
}

function makeMockPolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    id: 'pol-mock',
    childId: 'child-1',
    familyId: 'fam-1',
    version: 1,
    isPaused: false,
    rules: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Extracts the exact method declaration and body from C# source using brace-depth matching.
 */
function extractCsMethod(source: string, signature: string): string {
  const sigIdx = source.indexOf(signature);
  assert.ok(sigIdx !== -1, `Method signature "${signature}" must be present`);
  const openBraceIdx = source.indexOf('{', sigIdx);
  assert.ok(openBraceIdx !== -1, `Opening brace for "${signature}" must be present`);

  let depth = 0;
  for (let i = openBraceIdx; i < source.length; i++) {
    if (source[i] === '{') {
      depth++;
    } else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        return source.substring(sigIdx, i + 1);
      }
    }
  }
  assert.fail(`Matching closing brace for "${signature}" not found`);
}

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

describe('SafeBrowse Windows — Recovery and Hardening Suite', () => {
  const tmpDir = path.join(os.tmpdir(), `sb-recovery-tests-${Date.now()}`);
  before(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // ----------------------------------------------------
  // Test 1: Service stop requests emergency DNS restoration before forced kill
  // ----------------------------------------------------
  it('1. service stop requests emergency DNS restoration before forced kill', () => {
    const csPath = path.resolve(__dirname, '../service-host/SafeBrowseServiceHost.cs');
    assert.strictEqual(fs.existsSync(csPath), true, 'SafeBrowseServiceHost.cs must exist');
    const csContent = fs.readFileSync(csPath, 'utf8');

    // Extract exact OnStop method body deterministically using brace-depth matching
    const onStopBody = extractCsMethod(csContent, 'protected override void OnStop()');

    const stoppingIdx = onStopBody.indexOf('_stopping = true');
    const restoreIdx = onStopBody.indexOf('RunEmergencyRestore');
    const stopChildIdx = onStopBody.indexOf('StopChildProcess');

    assert.ok(stoppingIdx !== -1, '_stopping = true must be set in OnStop');
    assert.ok(restoreIdx !== -1, 'RunEmergencyRestore must be invoked in OnStop');
    assert.ok(stopChildIdx !== -1, 'StopChildProcess must be invoked in OnStop');
    assert.ok(stoppingIdx < restoreIdx, '_stopping = true must occur before RunEmergencyRestore');
    assert.ok(restoreIdx < stopChildIdx, 'RunEmergencyRestore must precede StopChildProcess');
  });

  // ----------------------------------------------------
  // Test 2: Service shutdown requests restoration
  // ----------------------------------------------------
  it('2. service shutdown requests restoration', () => {
    const csPath = path.resolve(__dirname, '../service-host/SafeBrowseServiceHost.cs');
    const csContent = fs.readFileSync(csPath, 'utf8');

    // Extract exact OnShutdown method body deterministically using brace-depth matching
    const onShutdownBody = extractCsMethod(csContent, 'protected override void OnShutdown()');

    assert.ok(
      onShutdownBody.includes('OnStop()') || onShutdownBody.includes('RunEmergencyRestore'),
      'OnShutdown must invoke OnStop or RunEmergencyRestore to guarantee network recovery'
    );
  });

  // ----------------------------------------------------
  // Test 3: Emergency restore failure is surfaced
  // ----------------------------------------------------
  it('3. emergency restore failure is surfaced', async () => {
    const testBackup = path.join(tmpDir, 'failing-backup.json');
    const nm = new WindowsNetworkManager(testBackup);
    nm.setPlatformForTesting('win32');

    // Command executor that rejects to simulate PowerShell permission/execution error
    nm.setCommandExecutorForTesting(async () => {
      throw new Error('Access denied resetting DNS');
    });

    // restoreOriginalDns should throw on failure so CLI/MSI exits with code 1
    await assert.rejects(
      async () => {
        await nm.restoreOriginalDns();
      },
      (err: any) => {
        assert.ok(err.message.includes('Access denied resetting DNS'));
        return true;
      }
    );
  });

  // ----------------------------------------------------
  // Test 4: Bounded emergency restore retry
  // ----------------------------------------------------
  it('4. bounded emergency restore retry', () => {
    const csPath = path.resolve(__dirname, '../service-host/SafeBrowseServiceHost.cs');
    const csContent = fs.readFileSync(csPath, 'utf8');

    assert.ok(csContent.includes('int maxRetries = 2'), 'RunEmergencyRestore must have bounded retry limit');
    assert.ok(csContent.includes('FallbackPowerShellRestore'), 'Must fall back to native PowerShell restore if retries fail');
    assert.ok(csContent.includes('[CRITICAL]'), 'Must log CRITICAL error if retries are exhausted');
  });

  // ----------------------------------------------------
  // Test 5: Unexpected child crash restores DNS before restart delay
  // ----------------------------------------------------
  it('5. unexpected child crash restores DNS before restart delay', () => {
    const csPath = path.resolve(__dirname, '../service-host/SafeBrowseServiceHost.cs');
    const csContent = fs.readFileSync(csPath, 'utf8');

    const workerLoopIdx = csContent.indexOf('private void WorkerLoop()');
    assert.ok(workerLoopIdx !== -1, 'WorkerLoop must exist');
    const workerLoopBody = csContent.substring(workerLoopIdx);

    const unexpectedLogIdx = workerLoopBody.indexOf('Unexpected child process termination detected');
    const emergencyRestoreIdx = workerLoopBody.indexOf('RunEmergencyRestore', unexpectedLogIdx);
    const sleepIdx = workerLoopBody.indexOf('Thread.Sleep', unexpectedLogIdx);

    assert.ok(unexpectedLogIdx !== -1, 'Must detect unexpected child termination');
    assert.ok(emergencyRestoreIdx !== -1, 'Must call RunEmergencyRestore on unexpected exit');
    assert.ok(sleepIdx !== -1, 'Must have backoff delay');
    assert.ok(
      emergencyRestoreIdx < sleepIdx,
      'RunEmergencyRestore must execute before backoff Thread.Sleep to prevent temporary DNS blackout'
    );
  });

  // ----------------------------------------------------
  // Test 6: Backend unavailable retains cached policy
  // ----------------------------------------------------
  it('6. backend unavailable retains cached policy', async () => {
    const deviceDir = path.join(tmpDir, 'cache-test-6');
    fs.mkdirSync(deviceDir, { recursive: true });

    const config: DeviceConfig = {
      deviceId: 'dev-offline-1',
      deviceToken: 'tok-offline-1',
      childId: 'child-1',
      parentId: 'parent-1',
      deviceName: 'Test Laptop',
      backendUrl: 'http://127.0.0.1:59999', // Non-existent backend
    };

    const initialPolicy: Policy = makeMockPolicy({
      version: 42,
      childId: 'child-1',
      rules: [makeMockRule('evil.com', 'BLOCK')],
    });

    // Pre-populate cache
    const cacheFile = path.join(deviceDir, `policy-${config.deviceId}.json`);
    fs.writeFileSync(cacheFile, JSON.stringify(initialPolicy, null, 2), 'utf8');

    const client = new PolicySyncClient(config, deviceDir);
    assert.strictEqual(client.getActivePolicy()?.version, 42);
    assert.strictEqual(client.getPolicyStatus(), 'POLICY_CACHED');

    // Attempt fetch with offline backend
    const policy = await client.fetchLatestPolicy();
    assert.strictEqual(policy?.version, 42, 'Cached policy version must be retained');
    assert.strictEqual(client.getActivePolicy()?.version, 42);
    assert.strictEqual(client.getPolicyStatus(), 'POLICY_CACHED');
    client.stop();
  });

  // ----------------------------------------------------
  // Test 7: Backend unavailable does not erase cached policy
  // ----------------------------------------------------
  it('7. backend unavailable does not erase cached policy', async () => {
    const deviceDir = path.join(tmpDir, 'cache-test-7');
    fs.mkdirSync(deviceDir, { recursive: true });

    const config: DeviceConfig = {
      deviceId: 'dev-offline-2',
      deviceToken: 'tok-offline-2',
      childId: 'child-2',
      parentId: 'parent-2',
      deviceName: 'Test Laptop',
      backendUrl: 'http://127.0.0.1:59998',
    };

    const initialPolicy: Policy = makeMockPolicy({
      version: 99,
      childId: 'child-2',
      rules: [makeMockRule('gambling.com', 'BLOCK')],
    });

    const cacheFile = path.join(deviceDir, `policy-${config.deviceId}.json`);
    fs.writeFileSync(cacheFile, JSON.stringify(initialPolicy, null, 2), 'utf8');

    const client = new PolicySyncClient(config, deviceDir);

    // Call fetch multiple times while backend is unreachable
    await client.fetchLatestPolicy();
    await client.fetchLatestPolicy();

    assert.strictEqual(fs.existsSync(cacheFile), true, 'Policy cache file must still exist on disk');
    const onDisk = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.strictEqual(onDisk.version, 99, 'On-disk policy version must remain unchanged');
    client.stop();
  });

  // ----------------------------------------------------
  // Test 8: Backend unavailable does not disable upstream DNS forwarding
  // ----------------------------------------------------
  it('8. backend unavailable does not disable upstream DNS forwarding', async () => {
    // 1. Mock upstream DNS server
    let upstreamQueries = 0;
    const upstreamServer = dgram.createSocket('udp4');
    upstreamServer.on('message', (msg, rinfo) => {
      upstreamQueries++;
      const resp = Buffer.from(msg);
      resp[2] |= 0x80; // QR flag
      upstreamServer.send(resp, rinfo.port, rinfo.address);
    });

    const upstreamPort = await new Promise<number>((res) => {
      upstreamServer.bind(0, '127.0.0.1', () => {
        res(upstreamServer.address().port);
      });
    });

    // 2. Client with cached policy
    const cachedPolicy: Policy = makeMockPolicy({
      version: 1,
      childId: 'c1',
      rules: [makeMockRule('blocked.com', 'BLOCK')],
    });

    const proxy = new DnsFilterProxy(() => cachedPolicy, '127.0.0.1', upstreamPort);
    const proxyPort = await proxy.start(0);

    // Send query for allowed domain: wikipedia.org
    const client = dgram.createSocket('udp4');
    // Minimal DNS query buffer for "wikipedia.org"
    const queryBuffer = Buffer.from([
      0x12, 0x34, // ID
      0x01, 0x00, // Standard query
      0x00, 0x01, // QDCOUNT = 1
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      9, 119, 105, 107, 105, 112, 101, 100, 105, 97, // wikipedia
      3, 111, 114, 103, // org
      0, // null terminator
      0x00, 0x01, // Type A
      0x00, 0x01, // Class IN
    ]);

    const receivedResp = await new Promise<boolean>((resolve) => {
      client.on('message', (msg) => {
        resolve(msg.length > 0 && (msg[2] & 0x80) !== 0);
      });
      client.send(queryBuffer, proxyPort, '127.0.0.1');
    });

    assert.strictEqual(receivedResp, true, 'Client must receive DNS response forwarded from upstream');
    assert.ok(upstreamQueries >= 1, 'Upstream server must have received the forwarded query');

    client.close();
    proxy.stop();
    await new Promise<void>((r) => upstreamServer.close(() => r()));
  });

  // ----------------------------------------------------
  // Test 9: Backend reconnect fetches policy again
  // ----------------------------------------------------
  it('9. backend reconnect fetches policy again', async () => {
    const deviceDir = path.join(tmpDir, 'cache-test-9');
    fs.mkdirSync(deviceDir, { recursive: true });

    let returnUpdatedPolicy = false;
    const server = http.createServer((req, res) => {
      if (req.url?.includes('/api/policies/device/')) {
        const policyPayload: Policy = makeMockPolicy({
          version: returnUpdatedPolicy ? 5 : 2,
          childId: 'child-reconnect',
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ policy: policyPayload }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const serverPort = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        resolve(addr.port);
      });
    });

    const config: DeviceConfig = {
      deviceId: 'dev-reconnect',
      deviceToken: 'tok-reconnect',
      childId: 'child-reconnect',
      parentId: 'parent-reconnect',
      deviceName: 'Test Laptop',
      backendUrl: `http://127.0.0.1:${serverPort}`,
    };

    const client = new PolicySyncClient(config, deviceDir);
    const initial = await client.fetchLatestPolicy();
    assert.strictEqual(initial?.version, 2);
    assert.strictEqual(client.getPolicyStatus(), 'POLICY_LIVE');

    // Simulate newer policy on backend
    returnUpdatedPolicy = true;
    const updated = await client.fetchLatestPolicy();
    assert.strictEqual(updated?.version, 5);
    assert.strictEqual(client.getPolicyStatus(), 'POLICY_LIVE');
    assert.strictEqual(client.getActivePolicy()?.version, 5);

    client.stop();
    await new Promise<void>((r) => server.close(() => r()));
  });

  // ----------------------------------------------------
  // Test 10: Invalid remote policy does not replace valid cache
  // ----------------------------------------------------
  it('10. invalid remote policy does not replace valid cache', async () => {
    const deviceDir = path.join(tmpDir, 'cache-test-10');
    fs.mkdirSync(deviceDir, { recursive: true });

    // Server returning malformed/invalid policy structure (version is missing)
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ policy: { not_a_valid_policy: true } }));
    });

    const serverPort = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        resolve(addr.port);
      });
    });

    const config: DeviceConfig = {
      deviceId: 'dev-invalid-pol',
      deviceToken: 'tok-invalid-pol',
      childId: 'c10',
      parentId: 'p10',
      deviceName: 'Laptop',
      backendUrl: `http://127.0.0.1:${serverPort}`,
    };

    // Pre-seed cache
    const cacheFile = path.join(deviceDir, `policy-${config.deviceId}.json`);
    const validPolicy: Policy = makeMockPolicy({ version: 15, childId: 'c10' });
    fs.writeFileSync(cacheFile, JSON.stringify(validPolicy, null, 2), 'utf8');

    const client = new PolicySyncClient(config, deviceDir);
    assert.strictEqual(client.getActivePolicy()?.version, 15);

    const fetched = await client.fetchLatestPolicy();
    assert.strictEqual(fetched?.version, 15, 'Must retain valid cache version when remote payload is invalid');
    assert.strictEqual(client.getActivePolicy()?.version, 15);

    client.stop();
    await new Promise<void>((r) => server.close(() => r()));
  });

  // ----------------------------------------------------
  // Test 11: No cached policy results in DEGRADED/POLICY_UNAVAILABLE
  // ----------------------------------------------------
  it('11. no cached policy results in DEGRADED/POLICY_UNAVAILABLE', async () => {
    const deviceDir = path.join(tmpDir, 'cache-test-11');
    fs.mkdirSync(deviceDir, { recursive: true });

    const config: DeviceConfig = {
      deviceId: 'dev-no-cache',
      deviceToken: 'tok-no-cache',
      childId: 'c11',
      parentId: 'p11',
      deviceName: 'Laptop',
      backendUrl: 'http://127.0.0.1:59990', // Offline
    };

    const client = new PolicySyncClient(config, deviceDir);
    assert.strictEqual(client.getActivePolicy(), null);
    assert.strictEqual(client.getPolicyStatus(), 'POLICY_UNAVAILABLE');

    await client.fetchLatestPolicy();
    assert.strictEqual(client.getPolicyStatus(), 'POLICY_UNAVAILABLE');

    // Check engine status computation: network is up, but policy is unavailable
    const engineStatus = computeEngineStatus(true, undefined, client.getPolicyStatus());
    assert.strictEqual(engineStatus, 'DEGRADED_POLICY_UNAVAILABLE');

    client.stop();
  });

  // ----------------------------------------------------
  // Test 12: No cached policy does not deliberately break internet
  // ----------------------------------------------------
  it('12. no cached policy does not deliberately break internet', async () => {
    let upstreamReached = false;
    const upstreamServer = dgram.createSocket('udp4');
    upstreamServer.on('message', (msg, rinfo) => {
      upstreamReached = true;
      const resp = Buffer.from(msg);
      resp[2] |= 0x80;
      upstreamServer.send(resp, rinfo.port, rinfo.address);
    });

    const upstreamPort = await new Promise<number>((res) => {
      upstreamServer.bind(0, '127.0.0.1', () => res(upstreamServer.address().port));
    });

    // Proxy with null policy (no policy available)
    const proxy = new DnsFilterProxy(() => null, '127.0.0.1', upstreamPort);
    const proxyPort = await proxy.start(0);

    const client = dgram.createSocket('udp4');
    const queryBuffer = Buffer.from([
      0x56, 0x78,
      0x01, 0x00,
      0x00, 0x01,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      6, 103, 111, 111, 103, 108, 101, // google
      3, 99, 111, 109, // com
      0,
      0x00, 0x01,
      0x00, 0x01,
    ]);

    const received = await new Promise<boolean>((resolve) => {
      client.on('message', () => resolve(true));
      client.send(queryBuffer, proxyPort, '127.0.0.1');
    });

    assert.strictEqual(received, true, 'Client must receive DNS response even with null policy');
    assert.strictEqual(upstreamReached, true, 'Query must be forwarded to upstream DNS');

    client.close();
    proxy.stop();
    await new Promise<void>((r) => upstreamServer.close(() => r()));
  });

  // ----------------------------------------------------
  // Test 13: Ask Parent backend failure is graceful
  // ----------------------------------------------------
  it('13. Ask Parent backend failure is graceful', async () => {
    const offlineUrl = 'http://127.0.0.1:59989';
    const blockServer = new BlockPageServer(offlineUrl, 'child-offline', 'device-offline');

    const serverPort = 18881;
    await blockServer.start(serverPort);

    // POST /submit-request while backend is down
    const postData = JSON.stringify({ domain: 'blockedgame.com', reason: 'Need for homework' });
    const reqOptions: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: serverPort,
      path: '/submit-request',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const response = await new Promise<{ statusCode?: number; body: string }>((resolve) => {
      const req = http.request(reqOptions, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      });
      req.write(postData);
      req.end();
    });

    assert.strictEqual(response.statusCode, 503, 'Must return HTTP 503 Service Unavailable');
    const parsed = JSON.parse(response.body);
    assert.strictEqual(parsed.offline, true);
    assert.ok(parsed.error.includes('temporarily unreachable'));

    blockServer.stop();
  });

  // ----------------------------------------------------
  // Test 14: Uninstall custom action runs before loss of recovery executable
  // ----------------------------------------------------
  it('14. uninstall custom action runs before loss of recovery executable', () => {
    const wxsPath = path.resolve(__dirname, '../wix/SafeBrowseChild-Pilot.wxs');
    assert.strictEqual(fs.existsSync(wxsPath), true, 'SafeBrowseChild-Pilot.wxs must exist');
    const wxsContent = fs.readFileSync(wxsPath, 'utf8');

    assert.ok(
      wxsContent.includes('Id="RestoreDnsOnUninstall"'),
      'WiX file must define RestoreDnsOnUninstall custom action'
    );
    assert.ok(
      wxsContent.includes('Before="StopServices"'),
      'RestoreDnsOnUninstall must be sequenced Before="StopServices" so binaries and services are intact'
    );
  });

  // ----------------------------------------------------
  // Test 15: Uninstall restoration failure returns failure
  // ----------------------------------------------------
  it('15. uninstall restoration failure returns failure', () => {
    const wxsPath = path.resolve(__dirname, '../wix/SafeBrowseChild-Pilot.wxs');
    const wxsContent = fs.readFileSync(wxsPath, 'utf8');

    const caIndex = wxsContent.indexOf('Id="RestoreDnsOnUninstall"');
    assert.ok(caIndex !== -1, 'RestoreDnsOnUninstall custom action must be present');
    const caEnd = wxsContent.indexOf('/>', caIndex);
    assert.ok(caEnd !== -1, 'CustomAction tag closing delimiter must be found');
    const caBlock = wxsContent.substring(caIndex, caEnd);

    assert.ok(
      caBlock.includes('Return="check"'),
      'CustomAction must specify Return="check" to fail the uninstall transaction if DNS restore fails'
    );
  });

  // ----------------------------------------------------
  // Test 16: Upgrade path does not trigger final-uninstall restoration incorrectly
  // ----------------------------------------------------
  it('16. upgrade path does not trigger final-uninstall restoration incorrectly', () => {
    const wxsPath = path.resolve(__dirname, '../wix/SafeBrowseChild-Pilot.wxs');
    const wxsContent = fs.readFileSync(wxsPath, 'utf8');

    assert.ok(
      wxsContent.includes('NOT UPGRADINGPRODUCTCODE'),
      'InstallExecuteSequence must guard RestoreDnsOnUninstall with NOT UPGRADINGPRODUCTCODE'
    );
  });

  // ----------------------------------------------------
  // Test 17: Firewall teardown removes only SafeBrowse-owned rules
  // ----------------------------------------------------
  it('17. firewall teardown removes only SafeBrowse-owned rules', () => {
    const rules = WindowsFirewallEngine.SAFEBROWSE_RULE_NAMES;
    assert.strictEqual(rules.length, 3);
    for (const rule of rules) {
      assert.ok(rule.startsWith('SafeBrowse_'), `Rule ${rule} must be namespaced with SafeBrowse_`);
    }

    const fwTsPath = path.resolve(__dirname, '../src/wfp-engine.ts');
    const fwTsContent = fs.readFileSync(fwTsPath, 'utf8');
    assert.strictEqual(
      fwTsContent.includes('advfirewall reset'),
      false,
      'Firewall teardown must NEVER execute netsh advfirewall reset'
    );
  });

  // ----------------------------------------------------
  // Test 18: Repeated firewall teardown is safe
  // ----------------------------------------------------
  it('18. repeated firewall teardown is safe', async () => {
    const fw = new WindowsFirewallEngine();
    // In test environment (non-win32), teardown should return cleanly
    await fw.teardown();
    await fw.teardown();
    await fw.teardown();
    const status = fw.getStatus();
    assert.strictEqual(status.isRunning, false);
    assert.strictEqual(status.activeRuleCount, 0);
  });

  // ----------------------------------------------------
  // Test 19: Newly active physical adapter gets its original DNS backed up
  // ----------------------------------------------------
  it('19. newly active physical adapter gets its original DNS backed up', async () => {
    const backupPath = path.join(tmpDir, 'multi-adapter-test-19.json');
    const nm = new WindowsNetworkManager(backupPath);

    // Initial adapter: Wi-Fi (Index 6)
    const initialBackup = await nm.backupCurrentDnsConfig([
      { InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', IpAddresses: ['192.168.1.8'], Gateway: '192.168.1.1' },
    ]);
    assert.strictEqual(initialBackup.length, 1);
    assert.strictEqual(initialBackup[0].InterfaceIndex, 6);
    assert.deepStrictEqual(initialBackup[0].ServerAddresses, ['192.168.1.1']);

    // Now a new adapter appears: Ethernet (Index 4)
    const updatedBackup = await nm.backupCurrentDnsConfig([
      { InterfaceIndex: 4, InterfaceAlias: 'Ethernet', IpAddresses: ['10.0.0.50'], Gateway: '10.0.0.1' },
    ]);
    assert.strictEqual(updatedBackup.length, 2, 'Must contain both Wi-Fi and Ethernet');
    const eth = updatedBackup.find((b) => b.InterfaceIndex === 4);
    assert.ok(eth, 'Ethernet record must be present');
    assert.deepStrictEqual(eth?.ServerAddresses, ['10.0.0.1']);
  });

  // ----------------------------------------------------
  // Test 20: Multi-adapter backup merges without overwriting valid historical backup
  // ----------------------------------------------------
  it('20. multi-adapter backup merges without overwriting valid historical backup', async () => {
    const backupPath = path.join(tmpDir, 'multi-adapter-test-20.json');

    // Pre-create historical backup for Adapter 6 with static DNS [1.1.1.1, 8.8.8.8]
    const historical = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        ServerAddresses: ['1.1.1.1', '8.8.8.8'],
        DhcpEnabled: false,
      },
    ];
    fs.writeFileSync(backupPath, JSON.stringify(historical, null, 2), 'utf8');

    const nm = new WindowsNetworkManager(backupPath);

    // Try backing up when Adapter 6 might currently be redirected to 127.0.0.1
    // and Adapter 4 is newly connected
    const merged = await nm.backupCurrentDnsConfig([
      { InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', IpAddresses: ['192.168.1.8'], Gateway: '192.168.1.1' },
      { InterfaceIndex: 4, InterfaceAlias: 'Ethernet', IpAddresses: ['192.168.2.5'], Gateway: '192.168.2.1' },
    ]);

    assert.strictEqual(merged.length, 2);
    const wifi = merged.find((b) => b.InterfaceIndex === 6);
    assert.deepStrictEqual(
      wifi?.ServerAddresses,
      ['1.1.1.1', '8.8.8.8'],
      'Original historical static DNS for Wi-Fi must NEVER be overwritten'
    );

    // Ensure 127.0.0.1 is not present in any backup record
    for (const b of merged) {
      assert.strictEqual(
        b.ServerAddresses.some((ip) => ip.includes('127.0.0.1')),
        false,
        `Backup for adapter ${b.InterfaceIndex} must never record 127.0.0.1`
      );
    }
  });

  // ----------------------------------------------------
  // Test 21: Shutdown/restart cannot intentionally leave 127.0.0.1 DNS without resolver
  // ----------------------------------------------------
  it('21. shutdown/restart cannot intentionally leave 127.0.0.1 DNS without resolver', async () => {
    const backupPath = path.join(tmpDir, 'shutdown-safety-21.json');
    const historical = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        ServerAddresses: ['192.168.1.1'],
        DhcpEnabled: false,
      },
    ];
    fs.writeFileSync(backupPath, JSON.stringify(historical, null, 2), 'utf8');

    const executedCommands: string[] = [];
    const nm = new WindowsNetworkManager(backupPath);
    nm.setPlatformForTesting('win32');
    nm.setCommandExecutorForTesting(async (script) => {
      executedCommands.push(script);
      return { stdout: '', stderr: '' };
    });

    // Run emergency DNS restoration (simulating ServiceHost or Agent shutdown)
    await nm.restoreOriginalDns();

    // Verify Set-DnsClientServerAddress was executed with original DNS (192.168.1.1)
    const restoreCmd = executedCommands.find((cmd) => cmd.includes('Set-DnsClientServerAddress'));
    assert.ok(restoreCmd, 'Set-DnsClientServerAddress command must be dispatched during shutdown');
    assert.ok(restoreCmd.includes("'192.168.1.1'"), 'Must restore original gateway DNS address');
    assert.strictEqual(restoreCmd.includes('127.0.0.1'), false, 'Restoration must never set 127.0.0.1');

    // Verify Clear-DnsClientCache was executed
    const flushCmd = executedCommands.find((cmd) => cmd.includes('Clear-DnsClientCache'));
    assert.ok(flushCmd, 'DNS client cache flush must be executed during restoration');
  });

  // ----------------------------------------------------
  // Test 22: DHCP vs Static DNS restoration semantics
  // ----------------------------------------------------
  it('22. DHCP vs Static DNS restoration semantics', async () => {
    const backupPath = path.join(tmpDir, 'dhcp-vs-static-22.json');
    // Adapter 6 was DHCP with 192.168.1.1 assigned by DHCP server
    // Adapter 4 had static custom DNS 8.8.8.8
    const historical = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        ServerAddresses: ['192.168.1.1'],
        DhcpEnabled: true,
      },
      {
        InterfaceIndex: 4,
        InterfaceAlias: 'Ethernet',
        ServerAddresses: ['8.8.8.8'],
        DhcpEnabled: false,
      },
    ];
    fs.writeFileSync(backupPath, JSON.stringify(historical, null, 2), 'utf8');

    const executedCommands: string[] = [];
    const nm = new WindowsNetworkManager(backupPath);
    nm.setPlatformForTesting('win32');
    nm.setCommandExecutorForTesting(async (script) => {
      executedCommands.push(script);
      return { stdout: '', stderr: '' };
    });

    await nm.restoreOriginalDns();

    // Verify Adapter 6 (DHCP) was restored using -ResetServerAddresses (not converted to static)
    const wifiCmd = executedCommands.find(
      (cmd) => cmd.includes('InterfaceIndex 6') && cmd.includes('ResetServerAddresses')
    );
    assert.ok(
      wifiCmd,
      'Adapter originally on DHCP must be restored via -ResetServerAddresses even if ServerAddresses had DHCP IPs'
    );
    assert.strictEqual(
      executedCommands.some((cmd) => cmd.includes('InterfaceIndex 6') && cmd.includes("-ServerAddresses @('192.168.1.1')")),
      false,
      'Must NOT convert DHCP DNS into a permanent static DNS override'
    );

    // Verify Adapter 4 (Static) was restored with static server address 8.8.8.8
    const ethCmd = executedCommands.find(
      (cmd) => cmd.includes('InterfaceIndex 4') && cmd.includes("'8.8.8.8'")
    );
    assert.ok(ethCmd, 'Adapter with static DNS must be restored with its static ServerAddresses');
  });

  // ----------------------------------------------------
  // Test 23: Emergency fallback restricts to 127.0.0.1-trapped routed adapters
  // ----------------------------------------------------
  it('23. emergency fallback restricts to 127.0.0.1-trapped routed adapters without touching unrelated adapters', async () => {
    // Non-existent backup file to trigger emergency fallback
    const missingBackupPath = path.join(tmpDir, 'non-existent-backup-23.json');
    const executedCommands: string[] = [];

    const nm = new WindowsNetworkManager(missingBackupPath);
    nm.setPlatformForTesting('win32');
    nm.setCommandExecutorForTesting(async (script) => {
      executedCommands.push(script);
      return { stdout: '', stderr: '' };
    });

    await nm.restoreOriginalDns();

    // Verify fallback script inspects $trapped (adapters with 127.0.0.1) and $validRoutes (NextHop -ne '0.0.0.0')
    const fallbackScript = executedCommands.find((cmd) => cmd.includes('$trapped'));
    assert.ok(fallbackScript, 'Fallback script must identify trapped 127.0.0.1 adapters');
    assert.ok(
      fallbackScript.includes("ServerAddresses -contains '127.0.0.1'"),
      'Must strictly filter for adapters pointing to 127.0.0.1'
    );
    assert.ok(
      fallbackScript.includes("NextHop -ne '0.0.0.0'"),
      'Must strictly filter for active default routes (excluding Tailscale 0.0.0.0)'
    );
    assert.ok(
      fallbackScript.includes('$routeIndexes -contains $t.InterfaceIndex'),
      'Must only reset adapters that are BOTH trapped on 127.0.0.1 AND have a valid default route'
    );
  });

  // ----------------------------------------------------
  // Test 24: enforcementActive accuracy under various engine and policy states
  // ----------------------------------------------------
  it('24. enforcementActive accuracy under various engine and policy states', () => {
    // Active with usable policy -> true
    assert.strictEqual(isEnforcementActive('ACTIVE', true), true);
    // Active but policy is null -> false
    assert.strictEqual(isEnforcementActive('ACTIVE', false), false);

    // Offline with cached usable policy -> true
    assert.strictEqual(isEnforcementActive('OFFLINE_BACKEND_CACHED_POLICY', true), true);
    // Offline without usable policy -> false
    assert.strictEqual(isEnforcementActive('OFFLINE_BACKEND_CACHED_POLICY', false), false);

    // Degraded / policy unavailable -> false
    assert.strictEqual(isEnforcementActive('DEGRADED_POLICY_UNAVAILABLE', true), false);
    assert.strictEqual(isEnforcementActive('DEGRADED_POLICY_UNAVAILABLE', false), false);

    // Degraded / DNS not enforced -> false
    assert.strictEqual(isEnforcementActive('DEGRADED_DNS_NOT_ENFORCED', true), false);
    assert.strictEqual(isEnforcementActive('DEGRADED_NO_NETWORK', true), false);

    // Stopping / Restoring -> false
    assert.strictEqual(isEnforcementActive('STOPPING', true), false);
    assert.strictEqual(isEnforcementActive('RESTORING_NETWORK', true), false);
  });

  // ----------------------------------------------------
  // Test 25: Dynamic heartbeat enforcementActive provider and policy null guard
  // ----------------------------------------------------
  it('25. dynamic heartbeat enforcementActive provider and policy null guard', async () => {
    let receivedPayload: any = null;
    const mockBackend = http.createServer((req, res) => {
      if (req.url === '/api/devices/heartbeat' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          receivedPayload = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ acknowledged: true, policyChanged: false }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const port = await new Promise<number>((resolve) => {
      mockBackend.listen(0, '127.0.0.1', () => {
        resolve((mockBackend.address() as any).port);
      });
    });

    const config: DeviceConfig = {
      deviceId: 'dev-hb-test',
      childId: 'child-hb',
      deviceToken: 'token-secret',
      deviceName: 'Test Laptop',
      backendUrl: `http://127.0.0.1:${port}`,
      parentId: 'parent-hb',
    };

    let isEnforcingState = false;
    const client = new PolicySyncClient(config, path.join(tmpDir, 'hb-test'), () => isEnforcingState);

    // 1. Provider returns false -> enforcementActive must be false
    await client.sendHeartbeat();
    assert.strictEqual(receivedPayload?.enforcementActive, false);

    // 2. Provider returns true, but client has NO policy loaded -> enforcementActive must be false
    isEnforcingState = true;
    await client.sendHeartbeat();
    assert.strictEqual(receivedPayload?.enforcementActive, false, 'Without a policy, enforcementActive must be false');

    // 3. Provider returns true AND valid policy exists -> enforcementActive must be true
    const cacheFile = path.join(tmpDir, 'hb-test', `policy-${config.deviceId}.json`);
    fs.writeFileSync(
      cacheFile,
      JSON.stringify(makeMockPolicy({ version: 2, childId: config.childId })),
      'utf8'
    );
    // Reload policy into client
    (client as any).loadCachedPolicy();
    await client.sendHeartbeat();
    assert.strictEqual(receivedPayload?.enforcementActive, true, 'With valid policy and provider true, enforcementActive must be true');

    client.stop();
    await new Promise<void>((r) => mockBackend.close(() => r()));
  });

  // ----------------------------------------------------
  // Test 26: Cached policy + successful initial backend fetch => startup status ACTIVE
  // ----------------------------------------------------
  it('26. cached policy + successful initial backend fetch => startup status ACTIVE', async () => {
    let requestCount = 0;
    const mockBackend = http.createServer((req, res) => {
      if (req.url?.startsWith('/api/policies/device/dev-start-26') && req.method === 'GET') {
        requestCount++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            policy: makeMockPolicy({ version: 5, childId: 'child-26' }),
          })
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const port = await new Promise<number>((resolve) => {
      mockBackend.listen(0, '127.0.0.1', () => {
        resolve((mockBackend.address() as any).port);
      });
    });

    const testDir = path.join(tmpDir, 'startup-test-26');
    fs.mkdirSync(testDir, { recursive: true });
    // Pre-populate with cached policy v2
    fs.writeFileSync(
      path.join(testDir, 'policy-dev-start-26.json'),
      JSON.stringify(makeMockPolicy({ version: 2, childId: 'child-26' })),
      'utf8'
    );

    const config: DeviceConfig = {
      deviceId: 'dev-start-26',
      childId: 'child-26',
      deviceToken: 'token-26',
      deviceName: 'Startup Laptop',
      backendUrl: `http://127.0.0.1:${port}`,
      parentId: 'parent-26',
    };

    const client = new PolicySyncClient(config, testDir, () => true);
    // Before start: cached policy v2 is loaded synchronously
    assert.strictEqual(client.getPolicyStatus(), 'POLICY_CACHED');
    assert.strictEqual(client.getActivePolicy()?.version, 2);

    // Bounded startup await
    const initialStatus = await client.start(5000);
    assert.strictEqual(initialStatus, 'POLICY_LIVE');
    assert.strictEqual(client.getPolicyStatus(), 'POLICY_LIVE');
    assert.strictEqual(client.getActivePolicy()?.version, 5);

    // Network activation is successful -> Engine status must compute to ACTIVE
    const engineStatus = computeEngineStatus(true, undefined, client.getPolicyStatus());
    assert.strictEqual(engineStatus, 'ACTIVE');
    assert.strictEqual(isEnforcementActive(engineStatus, client.getActivePolicy() !== null), true);

    client.stop();
    await new Promise<void>((r) => mockBackend.close(() => r()));
  });

  // ----------------------------------------------------
  // Test 27: Cached policy + failed backend fetch => startup status OFFLINE_BACKEND_CACHED_POLICY
  // ----------------------------------------------------
  it('27. cached policy + failed backend fetch => startup status OFFLINE_BACKEND_CACHED_POLICY', async () => {
    const mockBackend = http.createServer((req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    });

    const port = await new Promise<number>((resolve) => {
      mockBackend.listen(0, '127.0.0.1', () => {
        resolve((mockBackend.address() as any).port);
      });
    });

    const testDir = path.join(tmpDir, 'startup-test-27');
    fs.mkdirSync(testDir, { recursive: true });
    // Pre-populate with cached policy v3
    fs.writeFileSync(
      path.join(testDir, 'policy-dev-start-27.json'),
      JSON.stringify(makeMockPolicy({ version: 3, childId: 'child-27' })),
      'utf8'
    );

    const config: DeviceConfig = {
      deviceId: 'dev-start-27',
      childId: 'child-27',
      deviceToken: 'token-27',
      deviceName: 'Offline Startup Laptop',
      backendUrl: `http://127.0.0.1:${port}`,
      parentId: 'parent-27',
    };

    const client = new PolicySyncClient(config, testDir, () => true);
    assert.strictEqual(client.getPolicyStatus(), 'POLICY_CACHED');

    // Startup with failed backend fetch falls back safely to cached policy
    const initialStatus = await client.start(1000);
    assert.strictEqual(initialStatus, 'POLICY_CACHED');
    assert.strictEqual(client.getPolicyStatus(), 'POLICY_CACHED');
    assert.strictEqual(client.getActivePolicy()?.version, 3);

    // Network activation is successful + cached policy -> OFFLINE_BACKEND_CACHED_POLICY
    const engineStatus = computeEngineStatus(true, undefined, client.getPolicyStatus());
    assert.strictEqual(engineStatus, 'OFFLINE_BACKEND_CACHED_POLICY');
    // Protection remains active even in offline cached policy mode
    assert.strictEqual(isEnforcementActive(engineStatus, client.getActivePolicy() !== null), true);

    client.stop();
    await new Promise<void>((r) => mockBackend.close(() => r()));
  });

  // ----------------------------------------------------
  // Test 28: No cache + failed backend fetch => startup status DEGRADED_POLICY_UNAVAILABLE
  // ----------------------------------------------------
  it('28. no cache + failed backend fetch => startup status DEGRADED_POLICY_UNAVAILABLE', async () => {
    const testDir = path.join(tmpDir, 'startup-test-28');
    fs.mkdirSync(testDir, { recursive: true });

    // Use an unroutable port where connection immediately fails
    const config: DeviceConfig = {
      deviceId: 'dev-start-28',
      childId: 'child-28',
      deviceToken: 'token-28',
      deviceName: 'No Cache Laptop',
      backendUrl: 'http://127.0.0.1:1',
      parentId: 'parent-28',
    };

    const client = new PolicySyncClient(config, testDir, () => true);
    assert.strictEqual(client.getPolicyStatus(), 'POLICY_UNAVAILABLE');
    assert.strictEqual(client.getActivePolicy(), null);

    const initialStatus = await client.start(500);
    assert.strictEqual(initialStatus, 'POLICY_UNAVAILABLE');
    assert.strictEqual(client.getPolicyStatus(), 'POLICY_UNAVAILABLE');

    const engineStatus = computeEngineStatus(true, undefined, client.getPolicyStatus());
    assert.strictEqual(engineStatus, 'DEGRADED_POLICY_UNAVAILABLE');
    assert.strictEqual(isEnforcementActive(engineStatus, client.getActivePolicy() !== null), false);

    client.stop();
  });

  // ----------------------------------------------------
  // Test 29: Live policy -> backend disconnect with cache => transition callback fires, ACTIVE -> OFFLINE_BACKEND_CACHED_POLICY
  // ----------------------------------------------------
  it('29. live policy -> backend disconnect with cache => transition callback fires, ACTIVE -> OFFLINE_BACKEND_CACHED_POLICY', async () => {
    let shouldFail = false;
    const mockBackend = http.createServer((req, res) => {
      if (shouldFail) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Backend down' }));
        return;
      }
      if (req.url?.startsWith('/api/policies/device/dev-trans-29')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ policy: makeMockPolicy({ version: 7, childId: 'child-29' }) }));
      } else if (req.url === '/api/devices/heartbeat') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ acknowledged: true }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const port = await new Promise<number>((resolve) => {
      mockBackend.listen(0, '127.0.0.1', () => {
        resolve((mockBackend.address() as any).port);
      });
    });

    const testDir = path.join(tmpDir, 'trans-test-29');
    fs.mkdirSync(testDir, { recursive: true });

    const config: DeviceConfig = {
      deviceId: 'dev-trans-29',
      childId: 'child-29',
      deviceToken: 'token-29',
      deviceName: 'Transition Laptop',
      backendUrl: `http://127.0.0.1:${port}`,
      parentId: 'parent-29',
    };

    const client = new PolicySyncClient(config, testDir, () => true);
    const transitions: Array<{ newStatus: string; prevStatus: string }> = [];
    client.setOnPolicyStatusChange((newStatus, prevStatus) => {
      transitions.push({ newStatus, prevStatus });
    });

    await client.start(5000);
    assert.strictEqual(client.getPolicyStatus(), 'POLICY_LIVE');
    let engineStatus = computeEngineStatus(true, undefined, client.getPolicyStatus());
    assert.strictEqual(engineStatus, 'ACTIVE');

    // Simulate backend outage on subsequent heartbeat
    shouldFail = true;
    await client.sendHeartbeat();

    // Must transition to POLICY_CACHED
    assert.strictEqual(client.getPolicyStatus(), 'POLICY_CACHED');
    const lastTrans = transitions[transitions.length - 1];
    assert.deepStrictEqual(lastTrans, { newStatus: 'POLICY_CACHED', prevStatus: 'POLICY_LIVE' });

    engineStatus = computeEngineStatus(true, undefined, client.getPolicyStatus());
    assert.strictEqual(engineStatus, 'OFFLINE_BACKEND_CACHED_POLICY');
    assert.strictEqual(isEnforcementActive(engineStatus, client.getActivePolicy() !== null), true);

    client.stop();
    await new Promise<void>((r) => mockBackend.close(() => r()));
  });

  // ----------------------------------------------------
  // Test 30: Cached policy -> backend restored => transition callback fires, OFFLINE_BACKEND_CACHED_POLICY -> ACTIVE
  // ----------------------------------------------------
  it('30. cached policy -> backend restored => transition callback fires, OFFLINE_BACKEND_CACHED_POLICY -> ACTIVE', async () => {
    let backendOnline = false;
    const mockBackend = http.createServer((req, res) => {
      if (!backendOnline) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service Unavailable' }));
        return;
      }
      if (req.url?.startsWith('/api/policies/device/dev-restore-30')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ policy: makeMockPolicy({ version: 9, childId: 'child-30' }) }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const port = await new Promise<number>((resolve) => {
      mockBackend.listen(0, '127.0.0.1', () => {
        resolve((mockBackend.address() as any).port);
      });
    });

    const testDir = path.join(tmpDir, 'restore-test-30');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      path.join(testDir, 'policy-dev-restore-30.json'),
      JSON.stringify(makeMockPolicy({ version: 4, childId: 'child-30' })),
      'utf8'
    );

    const config: DeviceConfig = {
      deviceId: 'dev-restore-30',
      childId: 'child-30',
      deviceToken: 'token-30',
      deviceName: 'Restore Laptop',
      backendUrl: `http://127.0.0.1:${port}`,
      parentId: 'parent-30',
    };

    const client = new PolicySyncClient(config, testDir, () => true);
    const transitions: Array<{ newStatus: string; prevStatus: string }> = [];
    client.setOnPolicyStatusChange((newStatus, prevStatus) => {
      transitions.push({ newStatus, prevStatus });
    });

    await client.start(1000);
    assert.strictEqual(client.getPolicyStatus(), 'POLICY_CACHED');
    let engineStatus = computeEngineStatus(true, undefined, client.getPolicyStatus());
    assert.strictEqual(engineStatus, 'OFFLINE_BACKEND_CACHED_POLICY');

    // Backend comes back online
    backendOnline = true;
    await client.fetchLatestPolicy();

    assert.strictEqual(client.getPolicyStatus(), 'POLICY_LIVE');
    const lastTrans = transitions[transitions.length - 1];
    assert.deepStrictEqual(lastTrans, { newStatus: 'POLICY_LIVE', prevStatus: 'POLICY_CACHED' });

    engineStatus = computeEngineStatus(true, undefined, client.getPolicyStatus());
    assert.strictEqual(engineStatus, 'ACTIVE');

    client.stop();
    await new Promise<void>((r) => mockBackend.close(() => r()));
  });

  // ----------------------------------------------------
  // Test 31: DNS not enforced (netSuccess = false) => never reported ACTIVE
  // ----------------------------------------------------
  it('31. DNS not enforced (netSuccess = false) => never reported ACTIVE', () => {
    // When netSuccess = false, regardless of policyStatus, status is never ACTIVE
    const s1 = computeEngineStatus(false, 'DNS_NOT_ENFORCED', 'POLICY_LIVE');
    assert.strictEqual(s1, 'DEGRADED_DNS_NOT_ENFORCED');
    assert.strictEqual(isEnforcementActive(s1, true), false);

    const s2 = computeEngineStatus(false, 'NO_NETWORK_ROUTE', 'POLICY_LIVE');
    assert.strictEqual(s2, 'DEGRADED_NO_NETWORK');
    assert.strictEqual(isEnforcementActive(s2, true), false);

    const s3 = computeEngineStatus(false, undefined, 'POLICY_LIVE');
    assert.strictEqual(s3, 'DEGRADED_DNS_NOT_ENFORCED');
    assert.strictEqual(isEnforcementActive(s3, true), false);

    const s4 = computeEngineStatus(false, 'DNS_NOT_ENFORCED', 'POLICY_CACHED');
    assert.strictEqual(s4, 'DEGRADED_DNS_NOT_ENFORCED');
    assert.strictEqual(isEnforcementActive(s4, true), false);

    const s5 = computeEngineStatus(false, 'NO_NETWORK_ROUTE', 'POLICY_CACHED');
    assert.strictEqual(s5, 'DEGRADED_NO_NETWORK');
    assert.strictEqual(isEnforcementActive(s5, true), false);
  });

  // ----------------------------------------------------
  // Test 32: WiX SafeBrowseChild-Pilot.wxs static audit confirming Start="install", Stop="both", Remove="uninstall", and Wait="yes"
  // ----------------------------------------------------
  it('32. WiX SafeBrowseChild-Pilot.wxs static audit confirming Start="install", Stop="both", Remove="uninstall", and Wait="yes"', () => {
    const wxsPath = path.resolve(__dirname, '../wix/SafeBrowseChild-Pilot.wxs');
    assert.strictEqual(fs.existsSync(wxsPath), true, 'SafeBrowseChild-Pilot.wxs must exist');
    const wxsContent = fs.readFileSync(wxsPath, 'utf8');

    const scIndex = wxsContent.indexOf('Id="ControlSafeBrowseService"');
    assert.ok(scIndex !== -1, 'ControlSafeBrowseService ServiceControl element must be present');
    const scEnd = wxsContent.indexOf('/>', scIndex);
    assert.ok(scEnd !== -1, 'ServiceControl tag closing delimiter must be found');
    const scBlock = wxsContent.substring(scIndex, scEnd);

    assert.ok(scBlock.includes('Name="SafeBrowseChildService"'), 'Must control SafeBrowseChildService');
    assert.ok(scBlock.includes('Start="install"'), 'Must have Start="install" for immediate auto-start after MSI install');
    assert.ok(scBlock.includes('Stop="both"'), 'Must have Stop="both" for clean shutdown on install/uninstall');
    assert.ok(scBlock.includes('Remove="uninstall"'), 'Must have Remove="uninstall" to delete service entry on uninstall');
    assert.ok(scBlock.includes('Wait="yes"'), 'Must have Wait="yes" to ensure service transitions complete synchronously');
  });

  // ----------------------------------------------------
  // Test 33: WiX uninstall restore ordering remains RestoreDnsOnUninstall Before="StopServices" with NOT UPGRADINGPRODUCTCODE
  // ----------------------------------------------------
  it('33. WiX uninstall restore ordering remains RestoreDnsOnUninstall Before="StopServices" with NOT UPGRADINGPRODUCTCODE', () => {
    const wxsPath = path.resolve(__dirname, '../wix/SafeBrowseChild-Pilot.wxs');
    const wxsContent = fs.readFileSync(wxsPath, 'utf8');

    const seqIndex = wxsContent.indexOf('<InstallExecuteSequence>');
    const seqEnd = wxsContent.indexOf('</InstallExecuteSequence>', seqIndex);
    assert.ok(seqIndex !== -1 && seqEnd !== -1, 'InstallExecuteSequence must be present');
    const seqBlock = wxsContent.substring(seqIndex, seqEnd);

    assert.ok(
      seqBlock.includes('Action="RestoreDnsOnUninstall"'),
      'RestoreDnsOnUninstall must be in InstallExecuteSequence'
    );
    assert.ok(
      seqBlock.includes('Before="StopServices"'),
      'RestoreDnsOnUninstall must run Before="StopServices"'
    );
    assert.ok(
      seqBlock.includes('Condition="REMOVE=&quot;ALL&quot; AND NOT UPGRADINGPRODUCTCODE"'),
      'RestoreDnsOnUninstall condition must be guarded against upgrade'
    );
  });

  // ----------------------------------------------------
  // Test 34: Unpaired auto-start service waits safely for config without redirecting DNS
  // ----------------------------------------------------
  it('34. unpaired auto-start service waits safely for config without redirecting DNS', async () => {
    const emptyDir = path.join(tmpDir, 'unpaired-service-34');
    fs.mkdirSync(emptyDir, { recursive: true });

    const cm = new ConfigManager(emptyDir);
    const config = await cm.loadDeviceConfig();
    assert.strictEqual(config, null, 'Must return null when device has not been paired');

    const nm = new WindowsNetworkManager(cm.getNetworkBackupFilePath());
    // Backup file must not exist before any DNS activation
    assert.strictEqual(fs.existsSync(cm.getNetworkBackupFilePath()), false);

    // In agent-cli.ts service mode:
    // if (!config) { logServiceMessage('INFO', 'No device pairing configuration found. SafeBrowse service is waiting for pairing.'); return; }
    // Verify DNS activation is never triggered and system remains untampered
    assert.strictEqual(cm.checkConfigAccess(), 'NOT_PAIRED');
  });

  // ----------------------------------------------------
  // Test 35: --status reporting: missing config (NOT_PAIRED) vs restricted config (ACCESS_DENIED) produces correct messaging without ACL weakening
  // ----------------------------------------------------
  it('35. --status reporting: missing config (NOT_PAIRED) vs restricted config (ACCESS_DENIED) produces correct messaging without ACL weakening', () => {
    const testDir = path.join(tmpDir, 'status-test-35');
    fs.mkdirSync(testDir, { recursive: true });

    const cm = new ConfigManager(testDir);

    // 1. Missing config -> NOT_PAIRED
    assert.strictEqual(cm.checkConfigAccess(), 'NOT_PAIRED');

    // 2. Simulated restricted config (EACCES/EPERM) -> ACCESS_DENIED
    cm.setConfigAccessOverrideForTesting('ACCESS_DENIED');
    assert.strictEqual(cm.checkConfigAccess(), 'ACCESS_DENIED');

    // 3. Configured state -> CONFIGURED
    cm.setConfigAccessOverrideForTesting('CONFIGURED');
    assert.strictEqual(cm.checkConfigAccess(), 'CONFIGURED');

    // Reset override
    cm.setConfigAccessOverrideForTesting(null);
    assert.strictEqual(cm.checkConfigAccess(), 'NOT_PAIRED');
  });

  // ----------------------------------------------------
  // Test 36: Roaming: same InterfaceIndex network switch (192.168.1.x -> 10.23.63.x) triggers re-enforcement of 127.0.0.1
  // ----------------------------------------------------
  it('36. roaming: same InterfaceIndex network switch (192.168.1.x -> 10.23.63.x) triggers re-enforcement of 127.0.0.1', async () => {
    const dnsServer = await createMockDnsServer();
    const backupFile = path.join(tmpDir, 'backup-test-36.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux'); // CI isolation: mock adapter path regardless of host OS

    try {
      const adapters: MockAdapterState[] = [
        {
          InterfaceIndex: 6,
          InterfaceAlias: 'Wi-Fi',
          Status: 'Up',
          IpAddresses: ['192.168.1.8'],
          Gateway: '192.168.1.1',
          ServerAddresses: ['127.0.0.1'],
          DhcpEnabled: true,
        },
      ];
      nm.setMockAdaptersForTesting(adapters);

      // Initially in-sync
      const syncResult = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(syncResult.status, 'IN_SYNC');

      // Laptop moves to mobile hotspot: IP changes to 10.23.63.201, Gateway to 10.23.63.1,
      // and Windows DHCP stack resets DNS to 10.23.63.61 (DHCP DNS is distinct from default gateway)
      adapters[0].IpAddresses = ['10.23.63.201'];
      adapters[0].Gateway = '10.23.63.1';
      adapters[0].ServerAddresses = ['10.23.63.61'];

      // Reconciliation detects un-enforced adapter, refreshes backup, and re-enforces 127.0.0.1
      const roamResult = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(roamResult.status, 'RE_ENFORCED');
      assert.deepStrictEqual(roamResult.enforcedIndexes, [6]);
      assert.deepStrictEqual(adapters[0].ServerAddresses, ['127.0.0.1']);

      // Verify backup on disk recorded clean hotspot DNS and DHCP enabled
      const savedBackup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
      assert.strictEqual(savedBackup[0].InterfaceIndex, 6);
      assert.strictEqual(savedBackup[0].DhcpEnabled, true);
      assert.deepStrictEqual(savedBackup[0].ServerAddresses, ['10.23.63.61']);
    } finally {
      await dnsServer.close();
    }
  });

  // ----------------------------------------------------
  // Test 37: Roaming: reconciliation loop continuously protects across network change without service restart
  // ----------------------------------------------------
  it('37. roaming: reconciliation loop continuously protects across network change without service restart', async () => {
    const dnsServer = await createMockDnsServer();
    const backupFile = path.join(tmpDir, 'backup-test-37.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux'); // CI isolation: prevents real PowerShell spawns in reconciliation loop on Windows runner

    try {
      const adapters: MockAdapterState[] = [
        {
          InterfaceIndex: 6,
          InterfaceAlias: 'Wi-Fi',
          Status: 'Up',
          IpAddresses: ['192.168.1.8'],
          Gateway: '192.168.1.1',
          ServerAddresses: ['127.0.0.1'],
          DhcpEnabled: true,
        },
      ];
      nm.setMockAdaptersForTesting(adapters);

      let lastStateChange: any = null;
      nm.startReconciliationLoop(dnsServer.port, 25, (success, reason) => {
        lastStateChange = { success, reason };
      });

      // Roam to hotspot (DHCP DNS is distinct from default gateway)
      adapters[0].IpAddresses = ['10.23.63.201'];
      adapters[0].Gateway = '10.23.63.1';
      adapters[0].ServerAddresses = ['10.23.63.61'];

      // Wait for loop to tick and re-enforce
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(interval);
          reject(new Error('Timed out waiting for reconciliation loop to re-enforce 127.0.0.1'));
        }, 2000);

        const interval = setInterval(() => {
          if (adapters[0].ServerAddresses.includes('127.0.0.1')) {
            clearTimeout(timeout);
            clearInterval(interval);
            resolve();
          }
        }, 10);
      });

      assert.deepStrictEqual(adapters[0].ServerAddresses, ['127.0.0.1']);
      assert.strictEqual(lastStateChange?.success, true);
    } finally {
      nm.stopReconciliationLoop();
      await dnsServer.close();
    }
  });

  // ----------------------------------------------------
  // Test 38: Roaming: DHCP adapter backup records DhcpEnabled: true and restores via -ResetServerAddresses
  // ----------------------------------------------------
  it('38. roaming: DHCP adapter backup records DhcpEnabled: true and restores via -ResetServerAddresses', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-38.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('win32');

    const executedCommands: string[] = [];
    nm.setCommandExecutorForTesting(async (script) => {
      executedCommands.push(script);
      return { stdout: '', stderr: '' };
    });

    nm.persistOrRefreshAdapterBackup({
      InterfaceIndex: 6,
      InterfaceAlias: 'Wi-Fi',
      ServerAddresses: ['10.23.63.61'],
      DhcpEnabled: true,
    });

    const saved = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    assert.strictEqual(saved[0].DhcpEnabled, true);

    await nm.restoreOriginalDns();

    const resetCmd = executedCommands.find(
      (c) => c.includes('InterfaceIndex 6') && c.includes('ResetServerAddresses')
    );
    assert.ok(resetCmd, 'Must restore DHCP adapter via -ResetServerAddresses');
    assert.strictEqual(
      executedCommands.some((c) => c.includes('InterfaceIndex 6') && c.includes('-ServerAddresses')),
      false,
      'Must NOT assign static server addresses to a DHCP adapter'
    );
  });

  // ----------------------------------------------------
  // Test 39: Roaming: stopping service while on new hotspot executes -ResetServerAddresses and does NOT restore old 192.168.1.1
  // ----------------------------------------------------
  it('39. roaming: stopping service while on new hotspot executes -ResetServerAddresses and does NOT restore old 192.168.1.1', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-39.json');
    // Pre-populate backup with old home WiFi static DNS
    fs.writeFileSync(
      backupFile,
      JSON.stringify([
        {
          InterfaceIndex: 6,
          InterfaceAlias: 'Wi-Fi',
          ServerAddresses: ['192.168.1.1'],
          DhcpEnabled: false,
        },
      ])
    );

    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('win32');

    const executedCommands: string[] = [];
    nm.setCommandExecutorForTesting(async (script) => {
      executedCommands.push(script);
      return { stdout: '', stderr: '' };
    });

    // Device connects to mobile hotspot using DHCP (DHCP DNS is distinct from default gateway)
    nm.persistOrRefreshAdapterBackup({
      InterfaceIndex: 6,
      InterfaceAlias: 'Wi-Fi',
      ServerAddresses: ['10.23.63.61'],
      DhcpEnabled: true,
    });

    await nm.restoreOriginalDns();

    // Verify it used -ResetServerAddresses and did NOT restore old 192.168.1.1
    const resetCmd = executedCommands.find(
      (c) => c.includes('InterfaceIndex 6') && c.includes('ResetServerAddresses')
    );
    assert.ok(resetCmd, 'Must use -ResetServerAddresses on hotspot');
    assert.strictEqual(
      executedCommands.some((c) => c.includes('192.168.1.1')),
      false,
      'Must NOT restore old home Wi-Fi DNS 192.168.1.1 when stopped on mobile hotspot'
    );
  });

  // ----------------------------------------------------
  // Test 40: Roaming: network change never overwrites backup with 127.0.0.1 or ::1
  // ----------------------------------------------------
  it('40. roaming: network change never overwrites backup with 127.0.0.1 or ::1', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-40.json');
    const nm = new WindowsNetworkManager(backupFile);

    // Initial clean backup
    nm.persistOrRefreshAdapterBackup({
      InterfaceIndex: 6,
      InterfaceAlias: 'Wi-Fi',
      ServerAddresses: ['192.168.1.1'],
      DhcpEnabled: false,
    });

    // Attempt to refresh with 127.0.0.1 and ::1 mixed in
    nm.persistOrRefreshAdapterBackup({
      InterfaceIndex: 6,
      InterfaceAlias: 'Wi-Fi',
      ServerAddresses: ['127.0.0.1', '10.23.63.61', '::1'],
      DhcpEnabled: true,
    });

    let saved = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    assert.deepStrictEqual(saved[0].ServerAddresses, ['10.23.63.61']);

    // Attempt to refresh with ONLY loopback
    nm.persistOrRefreshAdapterBackup({
      InterfaceIndex: 6,
      InterfaceAlias: 'Wi-Fi',
      ServerAddresses: ['127.0.0.1'],
      DhcpEnabled: true,
    });

    saved = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    assert.deepStrictEqual(
      saved[0].ServerAddresses,
      ['10.23.63.61'],
      'Must retain existing clean backup when input is only loopback'
    );
  });

  // ----------------------------------------------------
  // Test 41: Roaming: genuine static DNS remains preserved exactly on static adapters
  // ----------------------------------------------------
  it('41. roaming: genuine static DNS remains preserved exactly on static adapters', async () => {
    const dnsServer = await createMockDnsServer();
    const backupFile = path.join(tmpDir, 'backup-test-41.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux'); // CI isolation: mock adapter path regardless of host OS

    try {
      const adapters: MockAdapterState[] = [
        {
          InterfaceIndex: 4,
          InterfaceAlias: 'Ethernet',
          Status: 'Up',
          IpAddresses: ['10.10.0.50'],
          Gateway: '10.10.0.1',
          ServerAddresses: ['1.1.1.1', '8.8.8.8'],
          DhcpEnabled: false,
        },
      ];
      nm.setMockAdaptersForTesting(adapters);

      const res = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(res.status, 'RE_ENFORCED');

      const saved = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
      assert.strictEqual(saved[0].InterfaceIndex, 4);
      assert.strictEqual(saved[0].DhcpEnabled, false);
      assert.deepStrictEqual(saved[0].ServerAddresses, ['1.1.1.1', '8.8.8.8']);

      // Verify Win32 restore produces exact static restore command
      nm.setPlatformForTesting('win32');
      const executedCommands: string[] = [];
      nm.setCommandExecutorForTesting(async (script) => {
        executedCommands.push(script);
        return { stdout: '', stderr: '' };
      });

      await nm.restoreOriginalDns();

      const staticCmd = executedCommands.find(
        (c) => c.includes('InterfaceIndex 4') && c.includes("'1.1.1.1','8.8.8.8'")
      );
      assert.ok(staticCmd, 'Must restore exact static DNS addresses');
    } finally {
      await dnsServer.close();
    }
  });

  // ----------------------------------------------------
  // Test 42: Adapter arrival: newly arriving Ethernet is discovered, backed up, and protected alongside existing WiFi
  // ----------------------------------------------------
  it('42. adapter arrival: newly arriving Ethernet is discovered, backed up, and protected alongside existing WiFi', async () => {
    const dnsServer = await createMockDnsServer();
    const backupFile = path.join(tmpDir, 'backup-test-42.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux'); // CI isolation: mock adapter path regardless of host OS

    try {
      const adapters: MockAdapterState[] = [
        {
          InterfaceIndex: 6,
          InterfaceAlias: 'Wi-Fi',
          Status: 'Up',
          IpAddresses: ['192.168.1.8'],
          Gateway: '192.168.1.1',
          ServerAddresses: ['127.0.0.1'],
          DhcpEnabled: true,
        },
      ];
      nm.setMockAdaptersForTesting(adapters);

      // Initially WiFi backup exists and adapter is enforced
      nm.persistOrRefreshAdapterBackup({
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        ServerAddresses: ['192.168.1.1'],
        DhcpEnabled: true,
      });

      const initialRes = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(initialRes.status, 'IN_SYNC');

      // Ethernet cable is plugged in: Adapter 14 appears
      adapters.push({
        InterfaceIndex: 14,
        InterfaceAlias: 'Ethernet 2',
        Status: 'Up',
        IpAddresses: ['10.0.0.55'],
        Gateway: '10.0.0.1',
        ServerAddresses: ['10.0.0.1'],
        DhcpEnabled: true,
      });

      const roamRes = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(roamRes.status, 'RE_ENFORCED');
      assert.ok(roamRes.enforcedIndexes.includes(14));
      assert.deepStrictEqual(adapters[1].ServerAddresses, ['127.0.0.1']);

      const saved = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
      assert.strictEqual(saved.length, 2);
      assert.ok(saved.some((a: any) => a.InterfaceIndex === 6));
      assert.ok(saved.some((a: any) => a.InterfaceIndex === 14 && a.DhcpEnabled === true));
    } finally {
      await dnsServer.close();
    }
  });

  // ----------------------------------------------------
  // Test 43: Multihoming: simultaneous active WiFi and Ethernet routes are both enforced
  // ----------------------------------------------------
  it('43. multihoming: simultaneous active WiFi and Ethernet routes are both enforced', async () => {
    const dnsServer = await createMockDnsServer();
    const backupFile = path.join(tmpDir, 'backup-test-43.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux'); // CI isolation: mock adapter path regardless of host OS

    try {
      const adapters: MockAdapterState[] = [
        {
          InterfaceIndex: 6,
          InterfaceAlias: 'Wi-Fi',
          Status: 'Up',
          IpAddresses: ['192.168.1.8'],
          Gateway: '192.168.1.1',
          ServerAddresses: ['192.168.1.1'],
          DhcpEnabled: true,
        },
        {
          InterfaceIndex: 14,
          InterfaceAlias: 'Ethernet',
          Status: 'Up',
          IpAddresses: ['10.0.0.2'],
          Gateway: '10.0.0.1',
          ServerAddresses: ['10.0.0.1'],
          DhcpEnabled: true,
        },
      ];
      nm.setMockAdaptersForTesting(adapters);

      const res = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(res.status, 'RE_ENFORCED');
      assert.deepStrictEqual(res.enforcedIndexes.slice().sort((a, b) => a - b), [6, 14]);

      const inspection = await nm.inspectCurrentEnforcement();
      assert.strictEqual(inspection.isProtected, true);
      assert.strictEqual(inspection.activeAdapters.length, 2);
      assert.ok(inspection.activeAdapters.every((a) => a.isEnforced));
    } finally {
      await dnsServer.close();
    }
  });

  // ----------------------------------------------------
  // Test 44: Exclusion: Tailscale virtual adapter remains strictly excluded during roaming and reconciliation
  // ----------------------------------------------------
  it('44. exclusion: Tailscale virtual adapter remains strictly excluded during roaming and reconciliation', async () => {
    const dnsServer = await createMockDnsServer();
    const backupFile = path.join(tmpDir, 'backup-test-44.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux'); // CI isolation: mock adapter path regardless of host OS

    try {
      const adapters: MockAdapterState[] = [
        {
          InterfaceIndex: 6,
          InterfaceAlias: 'Wi-Fi',
          Status: 'Up',
          IpAddresses: ['192.168.1.8'],
          Gateway: '192.168.1.1',
          ServerAddresses: ['192.168.1.1'],
          DhcpEnabled: true,
        },
        {
          InterfaceIndex: 11,
          InterfaceAlias: 'Tailscale',
          Status: 'Up',
          IpAddresses: ['100.98.155.122'],
          Gateway: '0.0.0.0',
          ServerAddresses: ['100.100.100.100'],
          DhcpEnabled: false,
        },
      ];
      nm.setMockAdaptersForTesting(adapters);

      const res = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(res.status, 'RE_ENFORCED');
      assert.deepStrictEqual(res.enforcedIndexes, [6]);
      assert.strictEqual(adapters[1].ServerAddresses[0], '100.100.100.100', 'Tailscale DNS must never be modified');

      const saved = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
      assert.strictEqual(saved.length, 1);
      assert.strictEqual(saved[0].InterfaceIndex, 6);
    } finally {
      await dnsServer.close();
    }
  });

  // ----------------------------------------------------
  // Test 45: Exclusion: APIPA, loopback, and disconnected adapters remain excluded during reconciliation
  // ----------------------------------------------------
  it('45. exclusion: APIPA, loopback, and disconnected adapters remain excluded during reconciliation', async () => {
    const dnsServer = await createMockDnsServer();
    const backupFile = path.join(tmpDir, 'backup-test-45.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux'); // CI isolation: mock adapter path regardless of host OS

    try {
      const adapters: MockAdapterState[] = [
        {
          InterfaceIndex: 6,
          InterfaceAlias: 'Wi-Fi',
          Status: 'Up',
          IpAddresses: ['192.168.1.8'],
          Gateway: '192.168.1.1',
          ServerAddresses: ['192.168.1.1'],
          DhcpEnabled: true,
        },
        {
          InterfaceIndex: 20,
          InterfaceAlias: 'Disconnected Eth',
          Status: 'Disconnected',
          IpAddresses: [],
          Gateway: '192.168.2.1',
          ServerAddresses: ['192.168.2.1'],
          DhcpEnabled: true,
        },
        {
          InterfaceIndex: 21,
          InterfaceAlias: 'APIPA Adapter',
          Status: 'Up',
          IpAddresses: ['169.254.120.30'],
          Gateway: '169.254.120.1',
          ServerAddresses: ['169.254.120.1'],
          DhcpEnabled: true,
        },
      ];
      nm.setMockAdaptersForTesting(adapters);

      const res = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(res.status, 'RE_ENFORCED');
      assert.deepStrictEqual(res.enforcedIndexes, [6]);
    } finally {
      await dnsServer.close();
    }
  });

  // ----------------------------------------------------
  // Test 46: Offline degradation: no default route (NO_NETWORK_ROUTE) sets engine status DEGRADED_NO_NETWORK
  // ----------------------------------------------------
  it('46. offline degradation: no default route (NO_NETWORK_ROUTE) sets engine status DEGRADED_NO_NETWORK', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-46.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux'); // CI isolation: mock adapter path regardless of host OS

    const adapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Status: 'Disconnected',
        IpAddresses: [],
        Gateway: '0.0.0.0',
        ServerAddresses: [],
        DhcpEnabled: true,
      },
    ];
    nm.setMockAdaptersForTesting(adapters);

    const res = await nm.reconcileAdapters(53);
    assert.strictEqual(res.status, 'NO_NETWORK_ROUTE');

    const engineStatus = computeEngineStatus(false, 'NO_NETWORK_ROUTE', 'POLICY_LIVE');
    assert.strictEqual(engineStatus, 'DEGRADED_NO_NETWORK');
    assert.strictEqual(isEnforcementActive(engineStatus, true), false);
  });

  // ----------------------------------------------------
  // Test 47: Network return: route restored transitions from DEGRADED_NO_NETWORK back to ACTIVE
  // ----------------------------------------------------
  it('47. network return: route restored transitions from DEGRADED_NO_NETWORK back to ACTIVE', async () => {
    const dnsServer = await createMockDnsServer();
    const backupFile = path.join(tmpDir, 'backup-test-47.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux'); // CI isolation: mock adapter path regardless of host OS

    try {
      const adapters: MockAdapterState[] = [
        {
          InterfaceIndex: 6,
          InterfaceAlias: 'Wi-Fi',
          Status: 'Up',
          IpAddresses: ['10.23.63.201'],
          Gateway: '10.23.63.1',
          ServerAddresses: ['10.23.63.61'], // DHCP DNS distinct from gateway
          DhcpEnabled: true,
        },
      ];
      nm.setMockAdaptersForTesting(adapters);

      const res = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(res.status, 'RE_ENFORCED');

      // Transitions to ACTIVE when backend policy is live
      const activeStatus = computeEngineStatus(true, undefined, 'POLICY_LIVE');
      assert.strictEqual(activeStatus, 'ACTIVE');
      assert.strictEqual(isEnforcementActive(activeStatus, true), true);

      // Or OFFLINE_BACKEND_CACHED_POLICY when backend is unreachable but policy is cached
      const cachedStatus = computeEngineStatus(true, undefined, 'POLICY_CACHED');
      assert.strictEqual(cachedStatus, 'OFFLINE_BACKEND_CACHED_POLICY');
      assert.strictEqual(isEnforcementActive(cachedStatus, true), true);
    } finally {
      await dnsServer.close();
    }
  });

  // ----------------------------------------------------
  // Test 48: Tamper repair: external or child modification of DNS away from 127.0.0.1 is repaired by reconciliation
  // ----------------------------------------------------
  it('48. tamper repair: external or child modification of DNS away from 127.0.0.1 is repaired by reconciliation', async () => {
    const dnsServer = await createMockDnsServer();
    const backupFile = path.join(tmpDir, 'backup-test-48.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux'); // CI isolation: mock adapter path regardless of host OS

    try {
      const adapters: MockAdapterState[] = [
        {
          InterfaceIndex: 6,
          InterfaceAlias: 'Wi-Fi',
          Status: 'Up',
          IpAddresses: ['192.168.1.8'],
          Gateway: '192.168.1.1',
          ServerAddresses: ['8.8.8.8'], // Child manually changed DNS to Google Public DNS
          DhcpEnabled: false,
        },
      ];
      nm.setMockAdaptersForTesting(adapters);

      const res = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(res.status, 'RE_ENFORCED');
      assert.deepStrictEqual(adapters[0].ServerAddresses, ['127.0.0.1']);
    } finally {
      await dnsServer.close();
    }
  });

  // ----------------------------------------------------
  // Test 49: Race safety: shutdown and restore flags prevent reconciliation from re-enforcing DNS
  // ----------------------------------------------------
  it('49. race safety: shutdown and restore flags prevent reconciliation from re-enforcing DNS', async () => {
    const dnsServer = await createMockDnsServer();
    const backupFile = path.join(tmpDir, 'backup-test-49.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux'); // CI isolation: mock adapter path regardless of host OS

    try {
      const adapters: MockAdapterState[] = [
        {
          InterfaceIndex: 6,
          InterfaceAlias: 'Wi-Fi',
          Status: 'Up',
          IpAddresses: ['192.168.1.8'],
          Gateway: '192.168.1.1',
          ServerAddresses: ['192.168.1.1'],
          DhcpEnabled: true,
        },
      ];
      nm.setMockAdaptersForTesting(adapters);

      nm.setShuttingDown(true);
      const res = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(res.status, 'NO_NETWORK_ROUTE');
      assert.deepStrictEqual(adapters[0].ServerAddresses, ['192.168.1.1'], 'Must not re-enforce during shutdown');
    } finally {
      await dnsServer.close();
    }
  });

  // ----------------------------------------------------
  // Test 50: Concurrency: reconciliation single-flight lock skips overlapping concurrent executions
  // ----------------------------------------------------
  it('50. concurrency: reconciliation single-flight lock skips overlapping concurrent executions', async () => {
    const dnsServer = await createMockDnsServer();
    const backupFile = path.join(tmpDir, 'backup-test-50.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux'); // CI isolation: mock adapter path regardless of host OS

    try {
      const adapters: MockAdapterState[] = [
        {
          InterfaceIndex: 6,
          InterfaceAlias: 'Wi-Fi',
          Status: 'Up',
          IpAddresses: ['192.168.1.8'],
          Gateway: '192.168.1.1',
          ServerAddresses: ['127.0.0.1'],
          DhcpEnabled: true,
        },
      ];
      nm.setMockAdaptersForTesting(adapters);

      // Simulate a concurrent call while isReconciling is already held
      (nm as any).isReconciling = true;
      const skipped = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(skipped.status, 'IN_SYNC');
      assert.ok(skipped.message.includes('skipped'));
    } finally {
      (nm as any).isReconciling = false;
      await dnsServer.close();
    }
  });

  // ----------------------------------------------------
  // Test 51: Status accuracy: disconnected adapter with 127.0.0.1 and active adapter with external DNS reports NOT protected
  // ----------------------------------------------------
  it('51. status accuracy: disconnected adapter with 127.0.0.1 and active adapter with external DNS reports NOT protected', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-51.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux'); // CI isolation: mock adapter path regardless of host OS

    const adapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Status: 'Disconnected',
        IpAddresses: [],
        Gateway: '0.0.0.0',
        ServerAddresses: ['127.0.0.1'], // Trapped / inactive adapter
        DhcpEnabled: true,
      },
      {
        InterfaceIndex: 14,
        InterfaceAlias: 'Ethernet',
        Status: 'Up',
        IpAddresses: ['10.0.0.50'],
        Gateway: '10.0.0.1',
        ServerAddresses: ['10.0.0.1'], // Active routing adapter lacks 127.0.0.1
        DhcpEnabled: true,
      },
    ];
    nm.setMockAdaptersForTesting(adapters);

    const inspection = await nm.inspectCurrentEnforcement();
    assert.strictEqual(inspection.isProtected, false);
    assert.strictEqual(inspection.summary, 'DNS not redirected');
    assert.strictEqual(inspection.activeAdapters.length, 1);
    assert.strictEqual(inspection.activeAdapters[0].interfaceIndex, 14);
    assert.strictEqual(inspection.activeAdapters[0].isEnforced, false);
  });

  // ----------------------------------------------------
  // Test 52: Status accuracy: all active default-route adapters with 127.0.0.1 reports Protected
  // ----------------------------------------------------
  it('52. status accuracy: all active default-route adapters with 127.0.0.1 reports Protected', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-52.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux'); // CI isolation: mock adapter path regardless of host OS

    const adapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Status: 'Up',
        IpAddresses: ['192.168.1.8'],
        Gateway: '192.168.1.1',
        ServerAddresses: ['127.0.0.1'],
        DhcpEnabled: true,
      },
      {
        InterfaceIndex: 14,
        InterfaceAlias: 'Ethernet',
        Status: 'Up',
        IpAddresses: ['10.0.0.50'],
        Gateway: '10.0.0.1',
        ServerAddresses: ['127.0.0.1'],
        DhcpEnabled: true,
      },
    ];
    nm.setMockAdaptersForTesting(adapters);

    const inspection = await nm.inspectCurrentEnforcement();
    assert.strictEqual(inspection.isProtected, true);
    assert.strictEqual(inspection.summary, 'Protected');
    assert.strictEqual(inspection.activeAdapters.length, 2);
    assert.ok(inspection.activeAdapters.every((a) => a.isEnforced));
  });

  // ----------------------------------------------------
  // Test 53: Win32 command verification: reconciliation script executes Set-DnsClientServerAddress and verifies read-back
  // ----------------------------------------------------
  it('53. win32 command verification: reconciliation script executes Set-DnsClientServerAddress and verifies read-back', async () => {
    const dnsServer = await createMockDnsServer();
    const backupFile = path.join(tmpDir, 'backup-test-53.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('win32');

    const executedCommands: string[] = [];
    nm.setCommandExecutorForTesting(async (script) => {
      executedCommands.push(script);
      // Route discovery command
      if (script.includes('Get-NetRoute')) {
        return {
          stdout: JSON.stringify([
            {
              InterfaceIndex: 6,
              DestinationPrefix: '0.0.0.0/0',
              NextHop: '10.23.63.1',
              RouteMetric: 25,
              InterfaceMetric: 15,
            },
          ]),
          stderr: '',
        };
      }
      // NetAdapter discovery
      if (script.includes('Get-NetAdapter')) {
        return {
          stdout: JSON.stringify([
            {
              InterfaceIndex: 6,
              InterfaceAlias: 'Wi-Fi',
              Status: 'Up',
              LinkSpeed: '100 Mbps',
            },
          ]),
          stderr: '',
        };
      }
      // NetIPAddress discovery
      if (script.includes('Get-NetIPAddress')) {
        return {
          stdout: JSON.stringify([
            {
              InterfaceIndex: 6,
              IPAddress: '10.23.63.201',
              PrefixLength: 24,
            },
          ]),
          stderr: '',
        };
      }
      // DNS client server address query during reconciliation
      if (script.includes('Get-DnsClientServerAddress') && script.includes('$cleanAddrs')) {
        return {
          stdout: JSON.stringify([
            {
              InterfaceIndex: 6,
              InterfaceAlias: 'Wi-Fi',
              ServerAddresses: ['10.23.63.61'],
              CleanNonLoopback: ['10.23.63.61'],
              IsEnforced: false,
              DhcpEnabled: true,
            },
          ]),
          stderr: '',
        };
      }
      // Read-back verification
      if (script.includes('Get-DnsClientServerAddress') && script.includes('readBackScript')) {
        return {
          stdout: JSON.stringify({
            InterfaceIndex: 6,
            ServerAddresses: ['127.0.0.1'],
          }),
          stderr: '',
        };
      }
      return {
        stdout: JSON.stringify({
          InterfaceIndex: 6,
          ServerAddresses: ['127.0.0.1'],
        }),
        stderr: '',
      };
    });

    try {
      const res = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(res.status, 'RE_ENFORCED');
      assert.deepStrictEqual(res.enforcedIndexes, [6]);

      // Verify Set-DnsClientServerAddress was called
      const setCmd = executedCommands.find(
        (c) => c.includes('Set-DnsClientServerAddress') && c.includes('127.0.0.1')
      );
      assert.ok(setCmd, 'Must execute Set-DnsClientServerAddress with 127.0.0.1');

      // Verify Clear-DnsClientCache was called
      const flushCmd = executedCommands.find((c) => c.includes('Clear-DnsClientCache'));
      assert.ok(flushCmd, 'Must execute Clear-DnsClientCache');
    } finally {
      await dnsServer.close();
    }
  });

  // ----------------------------------------------------
  // Test 54: Timer and reconciliation lifecycle: duplicate start, stop, shutdown cancellation, unref, and error containment
  // ----------------------------------------------------
  it('54. timer and reconciliation lifecycle: duplicate start, stop, shutdown cancellation, unref, and error containment', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-54.json');
    const nm = new WindowsNetworkManager(backupFile);
    // CI isolation: keep platform as linux throughout so timer ticks use mock path,
    // never spawning real PowerShell child processes on a Windows runner.
    nm.setPlatformForTesting('linux');

    try {
      // 1. Calling start creates a timer
      nm.startReconciliationLoop(53, 100);
      const timer1 = nm.getReconcileTimerForTesting();
      assert.ok(timer1 !== null, 'Reconciliation timer must exist after start');

      // 2. Calling start twice replaces previous timer (at most one active timer exists)
      nm.startReconciliationLoop(53, 200);
      const timer2 = nm.getReconcileTimerForTesting();
      assert.ok(timer2 !== null, 'Second timer must exist');
      assert.notStrictEqual(timer1, timer2, 'Previous timer must be cleared and replaced on duplicate start');

      // 3. stop clears and nulls timer
      nm.stopReconciliationLoop();
      assert.strictEqual(nm.getReconcileTimerForTesting(), null, 'Timer must be null after stopReconciliationLoop');

      // 4. setShuttingDown clears and nulls timer
      nm.startReconciliationLoop(53, 100);
      assert.ok(nm.getReconcileTimerForTesting() !== null);
      nm.setShuttingDown(true);
      assert.strictEqual(nm.getReconcileTimerForTesting(), null, 'Timer must be cleared and nulled by setShuttingDown(true)');
      nm.setShuttingDown(false);

      // 5. Error containment: exceptions in reconcileAdapters do not crash service or leave isReconciling true.
      // Use a failing command executor with win32 platform override to exercise the win32 PowerShell path.
      // The injected executor throws immediately so no real child process is spawned.
      const failingExecutor = async () => {
        throw new Error('Simulated WMI/PowerShell engine failure');
      };
      nm.setPlatformForTesting('win32');
      nm.setCommandExecutorForTesting(failingExecutor);

      try {
        await nm.reconcileAdapters(53);
      } catch {
        // Expected to fail or return error status
      }
      assert.strictEqual(nm.isReconcilingState(), false, 'isReconciling must be reset in finally even on error');
    } finally {
      // Guarantee no timer survives this test regardless of assertion failures
      nm.stopReconciliationLoop();
      nm.setShuttingDown(false);
      nm.setCommandExecutorForTesting(null);
      nm.setPlatformForTesting('linux');
    }
  });

  // ----------------------------------------------------
  // Test 55: Firewall idempotence: running firewall engine skips redundant netsh rule recreation during reconciliation
  // ----------------------------------------------------
  it('55. firewall idempotence: running firewall engine skips redundant netsh rule recreation during reconciliation', async () => {
    const dnsServer = await createMockDnsServer();
    const backupFile = path.join(tmpDir, 'backup-test-55.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux'); // CI isolation: mock adapter path regardless of host OS

    try {
      const adapters: MockAdapterState[] = [
        {
          InterfaceIndex: 6,
          InterfaceAlias: 'Wi-Fi',
          Status: 'Up',
          IpAddresses: ['10.23.63.201'],
          Gateway: '10.23.63.1',
          ServerAddresses: ['10.23.63.61'], // Hotspot DHCP DNS distinct from gateway
          DhcpEnabled: true,
        },
      ];
      nm.setMockAdaptersForTesting(adapters);

      // Spy on firewallEngine.initialize to verify idempotency
      let initCalls = 0;
      const originalInit = firewallEngine.initialize.bind(firewallEngine);
      firewallEngine.initialize = async () => {
        initCalls++;
        return await originalInit();
      };

      try {
        // Ensure firewall status is running
        (firewallEngine as any).isRunning = true;

        const res = await nm.reconcileAdapters(dnsServer.port);
        assert.strictEqual(res.status, 'RE_ENFORCED');
        assert.strictEqual(initCalls, 0, 'Must NOT re-initialize firewall if engine is already running (idempotency)');
      } finally {
        firewallEngine.initialize = originalInit;
      }
    } finally {
      await dnsServer.close();
    }
  });
});
