import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as dgram from 'dgram';
import { Policy, PolicyRule } from '@safebrowse/shared';
import { WindowsNetworkManager } from '../src/network-manager';
import { PolicySyncClient, DeviceConfig } from '../src/sync-client';
import { DnsFilterProxy } from '../src/dns-proxy';
import { BlockPageServer } from '../src/block-server';
import { WindowsFirewallEngine } from '../src/wfp-engine';
import { computeEngineStatus, isEnforcementActive } from '../src/agent-cli';

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

    // OnStop must call RunEmergencyRestore before StopChildProcess
    const onStopIdx = csContent.indexOf('protected override void OnStop()');
    assert.ok(onStopIdx !== -1, 'OnStop method must be present');
    const onStopBody = csContent.substring(onStopIdx, onStopIdx + 600);

    const restoreIdx = onStopBody.indexOf('RunEmergencyRestore');
    const stopChildIdx = onStopBody.indexOf('StopChildProcess');
    assert.ok(restoreIdx !== -1, 'RunEmergencyRestore must be invoked in OnStop');
    assert.ok(stopChildIdx !== -1, 'StopChildProcess must be invoked in OnStop');
    assert.ok(restoreIdx < stopChildIdx, 'RunEmergencyRestore must precede StopChildProcess');
  });

  // ----------------------------------------------------
  // Test 2: Service shutdown requests restoration
  // ----------------------------------------------------
  it('2. service shutdown requests restoration', () => {
    const csPath = path.resolve(__dirname, '../service-host/SafeBrowseServiceHost.cs');
    const csContent = fs.readFileSync(csPath, 'utf8');

    const onShutdownIdx = csContent.indexOf('protected override void OnShutdown()');
    assert.ok(onShutdownIdx !== -1, 'OnShutdown method must be present');
    const onShutdownBody = csContent.substring(onShutdownIdx, onShutdownIdx + 250);

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
    assert.ok(caIndex !== -1);
    const caBlock = wxsContent.substring(caIndex, caIndex + 400);

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
});
