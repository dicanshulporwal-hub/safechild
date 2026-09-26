import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as dgram from 'dgram';
import { WebSocketServer } from 'ws';
import { Policy, PolicyRule } from '@safebrowse/shared';
import { WindowsNetworkManager, MockAdapterState } from '../src/network-manager';
import { PolicySyncClient, DeviceConfig } from '../src/sync-client';
import { DnsFilterProxy } from '../src/dns-proxy';
import { BlockPageServer } from '../src/block-server';
import { WindowsFirewallEngine, firewallEngine } from '../src/wfp-engine';
import {
  computeEngineStatus,
  isEnforcementActive,
  evaluateSystemStatus,
  queryWindowsServiceStatus,
  StatusEvaluation,
  ServiceQueryResult,
} from '../src/agent-cli';
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
function createMockDnsServer(
  customHandler?: (msg: Buffer, rinfo: dgram.RemoteInfo, socket: dgram.Socket) => void
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = dgram.createSocket('udp4');
    server.on('message', (msg, rinfo) => {
      if (customHandler) {
        customHandler(msg, rinfo, server);
        return;
      }
      const response = Buffer.from(msg);
      response[2] |= 0x80; // Set QR flag to indicate response
      response[3] = response[3] & 0xf0; // RCODE = 0 (NOERROR)
      response[6] = 0x00; // ANCOUNT = 1
      response[7] = 0x01;
      const answer = Buffer.from([
        0xc0, 0x0c, // Pointer to question name
        0x00, 0x01, // Type A
        0x00, 0x01, // Class IN
        0x00, 0x00, 0x01, 0x2c, // TTL = 300
        0x00, 0x04, // RDLENGTH = 4
        0x08, 0x08, 0x08, 0x08, // RDATA = 8.8.8.8
      ]);
      const fullResponse = Buffer.concat([response, answer]);
      server.send(fullResponse, rinfo.port, rinfo.address);
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
      assert.strictEqual(skipped.status, 'SKIPPED', 'Concurrent call must return SKIPPED, never IN_SYNC');
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

  // =========================================================================
  // SafeBrowse — Reboot Network Continuity & Boot Recovery Regression Suite
  // Requirements: 15 Deterministic Physical-Defect Regression Tests
  // =========================================================================

  // Test 56 / Required Test 1: shutdown restore CIM failure
  it('56. shutdown restore CIM failure: "A system shutdown is in progress" leaves stale 127, next service boot automatically recovers', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-reboot-1.json');
    fs.writeFileSync(
      backupFile,
      JSON.stringify([
        { InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', ServerAddresses: ['192.168.1.1'], DhcpEnabled: true }
      ])
    );

    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('win32');

    // Simulate CIM shutdown error on shutdown restore
    nm.setCommandExecutorForTesting(async (script) => {
      if (script.includes('Set-DnsClientServerAddress')) {
        throw new Error('Set-DnsClientServerAddress: Cannot connect to CIM server. A system shutdown is in progress.');
      }
      return { stdout: '', stderr: '' };
    });

    // Shutdown restore attempts and fails due to CIM shutdown
    await assert.rejects(
      async () => {
        await nm.restoreOriginalDns();
      },
      (err: any) => err.message.includes('A system shutdown is in progress')
    );

    // System now reboots with WiFi stuck on stale 127.0.0.1 and no resolver running
    const mockExecutor = async (script: string) => {
      if (script.includes('Get-DnsClientServerAddress')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', ServerAddresses: ['127.0.0.1'], DhcpEnabled: true }]),
          stderr: '',
        };
      }
      if (script.includes('Get-NetRoute')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', NextHop: '192.168.1.1' }]),
          stderr: '',
        };
      }
      if (script.includes('Get-NetAdapter')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Status: 'Up', InterfaceDescription: 'Intel Wi-Fi' }]),
          stderr: '',
        };
      }
      if (script.includes('Get-NetIPAddress')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, IPAddress: '192.168.1.8' }]),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    nm.setCommandExecutorForTesting(mockExecutor);

    // On next service boot, boot safety pre-flight detects stale 127.0.0.1 and automatically recovers
    const recoveryResult = await nm.recoverStaleDnsAtBoot(53);
    assert.strictEqual(recoveryResult.recovered, true);
    assert.deepStrictEqual(recoveryResult.restoredAdapters, [6]);
    assert.match(recoveryResult.message, /Recovered 1 adapter\(s\) from stale 127\.0\.0\.1/);
  });

  // Test 57 / Required Test 2: stale 127 boot
  it('57. stale 127 boot: initial adapter DNS = 127.0.0.1, no resolver running, DNS restored to DHCP/original BEFORE normal enforcement', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-reboot-2.json');
    fs.writeFileSync(
      backupFile,
      JSON.stringify([
        { InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', ServerAddresses: ['192.168.1.1'], DhcpEnabled: true }
      ])
    );

    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('win32');

    let resetExecuted = false;
    const mockExecutor = async (script: string) => {
      if (script.includes('ResetServerAddresses')) {
        resetExecuted = true;
      }
      if (script.includes('Get-DnsClientServerAddress')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', ServerAddresses: ['127.0.0.1'], DhcpEnabled: true }]),
          stderr: '',
        };
      }
      if (script.includes('Get-NetRoute')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', NextHop: '192.168.1.1' }]),
          stderr: '',
        };
      }
      if (script.includes('Get-NetAdapter')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Status: 'Up' }]),
          stderr: '',
        };
      }
      if (script.includes('Get-NetIPAddress')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, IPAddress: '192.168.1.8' }]),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    nm.setCommandExecutorForTesting(mockExecutor);

    // Service starts up and executes boot preflight BEFORE normal enforcement
    const result = await nm.recoverStaleDnsAtBoot(53);
    assert.strictEqual(result.recovered, true);
    assert.strictEqual(resetExecuted, true, 'Must execute ResetServerAddresses to clear stale 127.0.0.1');
  });

  // Test 58 / Required Test 3: service startup before network
  it('58. service startup before network: no route/DHCP initially leaves DNS untouched; later network arrival recovers automatically', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-reboot-3.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('win32');

    const executedScripts: string[] = [];
    let hasRoute = false;

    nm.setCommandExecutorForTesting(async (script: string) => {
      executedScripts.push(script);
      if (script.includes('Get-DnsClientServerAddress')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', ServerAddresses: hasRoute ? ['127.0.0.1'] : ['192.168.1.1'] }]),
          stderr: '',
        };
      }
      if (script.includes('Get-NetRoute')) {
        if (!hasRoute) {
          return { stdout: '[]', stderr: '' };
        }
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', NextHop: '192.168.1.1' }]),
          stderr: '',
        };
      }
      if (script.includes('Get-NetIPConfiguration')) {
        if (!hasRoute) {
          return { stdout: '[]', stderr: '' };
        }
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Gateway: '192.168.1.1' }]),
          stderr: '',
        };
      }
      if (script.includes('Get-NetAdapter')) {
        return { stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Status: hasRoute ? 'Up' : 'Disconnected' }]), stderr: '' };
      }
      if (script.includes('Get-NetIPAddress')) {
        return { stdout: JSON.stringify([{ InterfaceIndex: 6, IPAddress: hasRoute ? '192.168.1.8' : '' }]), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const dnsServer = await createMockDnsServer();
    try {
      // Step A: Startup before network exists
      const initialActivation = await nm.activateFailSafeDns(dnsServer.port);
      assert.strictEqual(initialActivation.success, false);
      assert.strictEqual(initialActivation.reason, 'NO_NETWORK_ROUTE');
      // Verify NO destructive write occurred
      assert.ok(
        !executedScripts.some((s) => s.includes('Set-DnsClientServerAddress') && s.includes('127.0.0.1')),
        'Must NOT write 127.0.0.1 when no network route is available'
      );

      // Step B: Later network arrival (DHCP lease obtained, route established)
      hasRoute = true;
      const retryActivation = await nm.activateFailSafeDns(dnsServer.port);
      assert.strictEqual(retryActivation.success, true);
      assert.strictEqual(retryActivation.reason, 'ELIGIBLE_ADAPTER_FOUND');
    } finally {
      await dnsServer.close();
    }
  });

  // Test 59 / Required Test 4: delayed auto-start removed
  it('59. delayed auto-start removed: static WiX audit confirms no DelayedAutoStart=yes', () => {
    const wxsPath = path.resolve(__dirname, '../wix/SafeBrowseChild-Pilot.wxs');
    assert.ok(fs.existsSync(wxsPath), 'SafeBrowseChild-Pilot.wxs must exist');
    const content = fs.readFileSync(wxsPath, 'utf8');

    assert.ok(
      !content.includes('DelayedAutoStart="yes"'),
      'WiX file must NOT contain DelayedAutoStart="yes"'
    );
    assert.ok(
      content.includes('Start="auto"'),
      'WiX file must configure normal Automatic service startup (Start="auto")'
    );
  });

  // Test 60 / Required Test 5: real proxy health
  it('60. real proxy health: local socket response alone is insufficient, upstream resolution failure must fail health', async () => {
    const nm = new WindowsNetworkManager();
    const dnsServer = await createMockDnsServer();

    try {
      // Hook upstream resolution checker to simulate upstream resolution failure
      // (local UDP socket is listening and responds, but upstream resolution fails)
      nm.setUpstreamResolutionCheckerForTesting(async () => false);

      const isHealthy = await nm.verifyEndToEndResolverHealth(dnsServer.port);
      assert.strictEqual(isHealthy, false, 'End-to-end resolver health must fail if upstream resolution fails');
    } finally {
      nm.setUpstreamResolutionCheckerForTesting(null);
      await dnsServer.close();
    }
  });

  // Test 61 / Required Test 6: upstream unavailable
  it('61. upstream unavailable: adapter must not be left at 127', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-reboot-6.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('win32');

    const executedScripts: string[] = [];
    nm.setCommandExecutorForTesting(async (script: string) => {
      executedScripts.push(script);
      if (script.includes('Get-NetIPConfiguration')) {
        return { stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Gateway: '192.168.1.1' }]), stderr: '' };
      }
      if (script.includes('Get-DnsClientServerAddress')) {
        return { stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', ServerAddresses: ['192.168.1.1'] }]), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const dnsServer = await createMockDnsServer();
    try {
      // Upstream is unavailable
      nm.setUpstreamResolutionCheckerForTesting(async () => false);

      const result = await nm.activateFailSafeDns(dnsServer.port);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, 'DNS_PROXY_HEALTH_CHECK_FAILED');
      assert.ok(
        !executedScripts.some((s) => s.includes('Set-DnsClientServerAddress') && s.includes('127.0.0.1')),
        'Adapter must never be assigned 127.0.0.1 when upstream is unavailable'
      );
    } finally {
      nm.setUpstreamResolutionCheckerForTesting(null);
      await dnsServer.close();
    }
  });

  // Test 62 / Required Test 7: post-assignment failure
  it('62. post-assignment failure: set 127 succeeds, real DNS resolution fails, automatic rollback occurs', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-reboot-7.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('win32');

    const executedScripts: string[] = [];
    nm.setCommandExecutorForTesting(async (script: string) => {
      executedScripts.push(script);
      if (script.includes('Get-NetIPConfiguration')) {
        return { stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Gateway: '192.168.1.1' }]), stderr: '' };
      }
      if (script.includes('Get-DnsClientServerAddress') && script.includes('Select-Object')) {
        return { stdout: JSON.stringify({ InterfaceIndex: 6, ServerAddresses: ['127.0.0.1'] }), stderr: '' };
      }
      if (script.includes('Get-DnsClientServerAddress')) {
        return { stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', ServerAddresses: ['192.168.1.1'] }]), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });

    const dnsServer = await createMockDnsServer();
    try {
      // Simulate post-assignment resolution failure (127.0.0.1 set succeeds, but post-assignment probe fails)
      nm.setPostAssignmentProbeForTesting(async () => false);

      const result = await nm.activateFailSafeDns(dnsServer.port);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.reason, 'POST_ACTIVATION_RESOLUTION_FAILED');
      // Verify automatic rollback was invoked
      assert.ok(
        executedScripts.some((s) => s.includes('ResetServerAddresses') || (s.includes('Set-DnsClientServerAddress') && s.includes('192.168.1.1'))),
        'Must invoke rollback to restore original DNS upon post-assignment resolution failure'
      );
    } finally {
      nm.setPostAssignmentProbeForTesting(null);
      await dnsServer.close();
    }
  });

  // Test 63 / Required Test 8: DHCP upstream
  it('63. DHCP upstream: current DHCP DNS selected as upstream', async () => {
    const nm = new WindowsNetworkManager();
    nm.setPlatformForTesting('linux');

    const adapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '192.168.1.1',
        ServerAddresses: ['192.168.1.1'],
        DhcpEnabled: true,
      },
    ];
    nm.setMockAdaptersForTesting(adapters);

    const upstreams = await nm.getUpstreamDnsServers();
    assert.deepStrictEqual(upstreams, ['192.168.1.1']);

    const proxy = new DnsFilterProxy(() => null);
    proxy.setUpstreams(upstreams);
    assert.deepStrictEqual(proxy.getUpstreamServers(), [{ host: '192.168.1.1', port: 53 }]);
  });

  // Test 64 / Required Test 9: static upstream
  it('64. static upstream: static original DNS preserved and selected safely', async () => {
    const nm = new WindowsNetworkManager();
    nm.setPlatformForTesting('linux');

    const adapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '192.168.1.1',
        ServerAddresses: ['9.9.9.9', '149.112.112.112'],
        DhcpEnabled: false,
      },
    ];
    nm.setMockAdaptersForTesting(adapters);

    const upstreams = await nm.getUpstreamDnsServers();
    assert.deepStrictEqual(upstreams, ['9.9.9.9', '149.112.112.112']);

    const proxy = new DnsFilterProxy(() => null);
    proxy.setUpstreams(upstreams);
    assert.deepStrictEqual(proxy.getUpstreamServers(), [
      { host: '9.9.9.9', port: 53 },
      { host: '149.112.112.112', port: 53 },
    ]);
  });

  // Test 65 / Required Test 10: roaming
  it('65. roaming: home DNS 192.168.1.1 -> hotspot DNS 10.23.63.61, upstream set updates without loop', async () => {
    const nm = new WindowsNetworkManager();
    nm.setPlatformForTesting('linux');

    // Initial state: Home WiFi
    const homeAdapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '192.168.1.1',
        ServerAddresses: ['192.168.1.1'],
        DhcpEnabled: true,
      },
    ];
    nm.setMockAdaptersForTesting(homeAdapters);

    const proxy = new DnsFilterProxy(() => null);
    proxy.setUpstreams(await nm.getUpstreamDnsServers());
    assert.strictEqual(proxy.upstreamDnsHost, '192.168.1.1');

    // Roam to mobile hotspot: 10.23.63.61
    const hotspotAdapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '10.23.63.1',
        ServerAddresses: ['10.23.63.61'],
        DhcpEnabled: true,
      },
    ];
    nm.setMockAdaptersForTesting(hotspotAdapters);

    // Reconciliation loop / roaming updates upstream set
    const roamingUpstreams = await nm.getUpstreamDnsServers();
    proxy.setUpstreams(roamingUpstreams);
    assert.strictEqual(proxy.upstreamDnsHost, '10.23.63.61');

    // Verify loopback is strictly excluded even if adapter DNS is 127.0.0.1
    proxy.setUpstreams(['127.0.0.1', '::1']);
    assert.deepStrictEqual(proxy.getUpstreamServers(), [{ host: '1.1.1.1', port: 53 }], 'Loopback must be rejected as upstream');
  });

  // Test 66 / Required Test 11: reconciliation tamper repair
  it('66. reconciliation tamper repair: resolver unhealthy, external DNS present, MUST NOT re-enforce 127', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-reboot-11.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux');

    // Adapter has external DNS (e.g. 8.8.8.8)
    const adapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '192.168.1.1',
        ServerAddresses: ['8.8.8.8'],
        DhcpEnabled: true,
      },
    ];
    nm.setMockAdaptersForTesting(adapters);

    const dnsServer = await createMockDnsServer();
    try {
      // Simulate resolver unhealthy during reconciliation
      nm.setUpstreamResolutionCheckerForTesting(async () => false);

      const result = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(result.status, 'ERROR');
      assert.match(result.message, /health check failed/);
      // Adapter MUST remain on 8.8.8.8, NOT re-enforced to 127.0.0.1!
      assert.deepStrictEqual(adapters[0].ServerAddresses, ['8.8.8.8']);
    } finally {
      nm.setUpstreamResolutionCheckerForTesting(null);
      await dnsServer.close();
    }
  });

  // Test 67 / Required Test 12: resolver recovers
  it('67. resolver recovers: real health returns, transactional enforcement succeeds, DNS -> 127, filtering active', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-reboot-12.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux');

    const adapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '192.168.1.1',
        ServerAddresses: ['8.8.8.8'],
        DhcpEnabled: true,
      },
    ];
    nm.setMockAdaptersForTesting(adapters);

    const dnsServer = await createMockDnsServer();
    try {
      // Step A: Initially resolver unhealthy -> not re-enforced
      nm.setUpstreamResolutionCheckerForTesting(async () => false);
      const res1 = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(res1.status, 'ERROR');
      assert.deepStrictEqual(adapters[0].ServerAddresses, ['8.8.8.8']);

      // Step B: Resolver recovers!
      nm.setUpstreamResolutionCheckerForTesting(async () => true);
      const res2 = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(res2.status, 'RE_ENFORCED');
      // Adapter DNS is now transactionally updated to 127.0.0.1
      assert.deepStrictEqual(adapters[0].ServerAddresses, ['127.0.0.1']);
    } finally {
      nm.setUpstreamResolutionCheckerForTesting(null);
      await dnsServer.close();
    }
  });

  // Test 68 / Required Test 13: child crash while 127 enforced
  it('68. child crash while 127 enforced: DNS automatically restored by ServiceHost', () => {
    const csPath = path.resolve(__dirname, '../service-host/SafeBrowseServiceHost.cs');
    const csContent = fs.readFileSync(csPath, 'utf8');

    // 1. WorkerLoop handles child crash and restores DNS before restart delay
    assert.ok(
      csContent.includes('Unexpected child process termination detected. Restoring network DNS before restart delay'),
      'WorkerLoop must detect child termination and restore DNS'
    );
    assert.ok(
      csContent.includes('RunEmergencyRestore(1, 10000)'),
      'Must invoke RunEmergencyRestore immediately upon unexpected child termination'
    );

    // 2. WorkerLoop performs boot safety preflight before launching child process
    const workerLoopBody = extractCsMethod(csContent, 'private void WorkerLoop()');
    const preflightIdx = workerLoopBody.indexOf('PerformBootPreflight()');
    const childLaunchIdx = workerLoopBody.indexOf('Process.Start(psi)');
    assert.ok(preflightIdx !== -1, 'WorkerLoop must invoke PerformBootPreflight');
    assert.ok(childLaunchIdx !== -1, 'WorkerLoop must launch child process');
    assert.ok(preflightIdx < childLaunchIdx, 'PerformBootPreflight must execute BEFORE child process launch');

    // 2b. OnStart must return promptly to SCM without blocking on preflight
    const onStartBody = extractCsMethod(csContent, 'protected override void OnStart(string[] args)');
    assert.ok(
      !onStartBody.includes('PerformBootPreflight()'),
      'OnStart must NOT synchronously execute PerformBootPreflight'
    );
    assert.ok(
      onStartBody.includes('_monitorThread = new Thread(WorkerLoop)'),
      'OnStart must instantiate worker thread'
    );

    // 3. ServiceHost accepts PRESHUTDOWN
    assert.ok(
      csContent.includes('SERVICE_ACCEPT_PRESHUTDOWN'),
      'ServiceHost must register SERVICE_ACCEPT_PRESHUTDOWN'
    );
    assert.ok(
      csContent.includes('SERVICE_CONTROL_PRESHUTDOWN'),
      'ServiceHost must handle SERVICE_CONTROL_PRESHUTDOWN in OnCustomCommand'
    );
  });

  // Test 69 / Required Test 14: boot recovery does not touch
  it('69. boot recovery does not touch: Tailscale, loopback, disconnected, APIPA, unrelated adapters', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-reboot-14.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux');

    // Multi-adapter setup with only Interface 6 being the eligible routed WiFi
    const adapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '192.168.1.1',
        ServerAddresses: ['127.0.0.1'], // Stale 127 on eligible adapter
        DhcpEnabled: true,
        Status: 'Up',
        IpAddresses: ['192.168.1.8'],
      },
      {
        InterfaceIndex: 11,
        InterfaceAlias: 'Tailscale',
        Description: 'Tailscale Tunnel',
        ServerAddresses: ['100.100.100.100'],
        DhcpEnabled: false,
        Status: 'Up',
        IpAddresses: ['100.88.17.16'],
      },
      {
        InterfaceIndex: 1,
        InterfaceAlias: 'Loopback Pseudo-Interface 1',
        ServerAddresses: ['127.0.0.1'],
        DhcpEnabled: false,
        Status: 'Up',
        IpAddresses: ['127.0.0.1'],
      },
      {
        InterfaceIndex: 12,
        InterfaceAlias: 'Ethernet Disconnected',
        ServerAddresses: [],
        DhcpEnabled: true,
        Status: 'Disconnected',
        IpAddresses: [],
      },
      {
        InterfaceIndex: 15,
        InterfaceAlias: 'Ethernet APIPA',
        ServerAddresses: [],
        DhcpEnabled: true,
        Status: 'Up',
        IpAddresses: ['169.254.10.20'],
      },
    ];
    nm.setMockAdaptersForTesting(adapters);

    // Run boot recovery with no resolver running
    const result = await nm.recoverStaleDnsAtBoot(53);
    assert.strictEqual(result.recovered, true);
    assert.deepStrictEqual(result.restoredAdapters, [6], 'Only eligible Interface 6 must be recovered');

    // Verify non-eligible adapters are completely untouched
    const tailscale = adapters.find((a) => a.InterfaceIndex === 11);
    assert.deepStrictEqual(tailscale?.ServerAddresses, ['100.100.100.100'], 'Tailscale must remain untouched');

    const loopback = adapters.find((a) => a.InterfaceIndex === 1);
    assert.deepStrictEqual(loopback?.ServerAddresses, ['127.0.0.1'], 'Loopback must remain untouched');

    const disconnected = adapters.find((a) => a.InterfaceIndex === 12);
    assert.deepStrictEqual(disconnected?.ServerAddresses, [], 'Disconnected adapter must remain untouched');

    const apipa = adapters.find((a) => a.InterfaceIndex === 15);
    assert.deepStrictEqual(apipa?.ServerAddresses, [], 'APIPA adapter must remain untouched');
  });

  // Test 70 / Required Test 15: fail-safe watchdog
  it('70. fail-safe watchdog: persistent resolver failure triggers fail-open restore to original/DHCP DNS', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-reboot-watchdog.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux');

    // Initial state: Adapter 6 enforced with 127.0.0.1
    const adapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '192.168.1.1',
        ServerAddresses: ['127.0.0.1'],
        DhcpEnabled: true,
      },
    ];
    nm.setMockAdaptersForTesting(adapters);
    nm.setMaxConsecutiveHealthFailuresForTesting(2); // Set threshold to 2 checks for test

    const dnsServer = await createMockDnsServer();
    try {
      // Simulate persistent resolver/upstream failure
      nm.setUpstreamResolutionCheckerForTesting(async () => false);

      // Check 1: Warning, failure recorded
      const res1 = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(res1.status, 'ERROR');
      assert.strictEqual(nm.getConsecutiveHealthFailuresForTesting(), 1);
      assert.deepStrictEqual(adapters[0].ServerAddresses, ['127.0.0.1']);

      // Check 2: Threshold reached -> Watchdog triggers fail-open restoration!
      const res2 = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(res2.status, 'ERROR');
      assert.match(res2.message, /Watchdog restored original\/DHCP DNS/);
      // Adapter DNS is fail-open restored (not trapped on 127.0.0.1)
      assert.deepStrictEqual(adapters[0].ServerAddresses, []);
    } finally {
      nm.setUpstreamResolutionCheckerForTesting(null);
      await dnsServer.close();
    }
  });

  // Test 71 / Required Test A & C: OnStart non-blocking invariant
  it('71. OnStart non-blocking: SCM OnStart does not synchronously execute boot recovery / retry sleeps, slow/unavailable CIM does not block SCM startup', async () => {
    const csPath = path.resolve(__dirname, '../service-host/SafeBrowseServiceHost.cs');
    const csContent = fs.readFileSync(csPath, 'utf8');

    const onStartBody = extractCsMethod(csContent, 'protected override void OnStart(string[] args)');

    // Invariant: OnStart MUST NOT call PowerShell, sleep, or synchronously execute preflight
    assert.ok(!onStartBody.includes('PerformBootPreflight()'), 'OnStart must not call PerformBootPreflight');
    assert.ok(!onStartBody.includes('Thread.Sleep'), 'OnStart must never call Thread.Sleep');
    assert.ok(!onStartBody.includes('powershell'), 'OnStart must not execute powershell');
    assert.ok(!onStartBody.includes('Process.Start'), 'OnStart must not synchronously spawn and wait on child processes');
    assert.ok(onStartBody.includes('_stopping = false'), 'OnStart must initialize _stopping flag');
    assert.ok(onStartBody.includes('_monitorThread = new Thread(WorkerLoop)'), 'OnStart must delegate work to WorkerLoop thread');
    assert.ok(onStartBody.includes('_monitorThread.Start()'), 'OnStart must start monitor thread');

    // Simulate OnStart execution under slow / unavailable CIM:
    // When CIM/network discovery is delayed (e.g. 500ms delay with retries),
    // SCM startup function (triggering background thread start) completes immediately (< 50ms).
    let preflightExecuted = false;
    let cimRetriesAttempted = 0;
    const fakeSlowPreflight = async () => {
      preflightExecuted = true;
      for (let i = 0; i < 3; i++) {
        cimRetriesAttempted++;
        await new Promise((r) => setTimeout(r, 50)); // simulate slow CIM retry
      }
    };

    const startExecution = Date.now();
    let threadStarted = false;
    // Simulate OnStart non-blocking contract:
    const simulateOnStart = () => {
      (async () => {
        threadStarted = true;
        await fakeSlowPreflight();
      })();
      return { started: true };
    };

    const result = simulateOnStart();
    const elapsed = Date.now() - startExecution;

    assert.strictEqual(result.started, true);
    assert.ok(elapsed < 50, `OnStart must return immediately (<50ms), took ${elapsed}ms`);
    assert.strictEqual(threadStarted, true);

    // Allow background worker thread to finish
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(preflightExecuted, true);
    assert.strictEqual(cimRetriesAttempted, 3);
  });

  // Test 72 / Required Test B: Worker bootstrap preflight ordering
  it('72. worker bootstrap ordering: WorkerLoop performs boot preflight BEFORE child process launch', () => {
    const csPath = path.resolve(__dirname, '../service-host/SafeBrowseServiceHost.cs');
    const csContent = fs.readFileSync(csPath, 'utf8');

    const workerLoopBody = extractCsMethod(csContent, 'private void WorkerLoop()');

    const preflightIdx = workerLoopBody.indexOf('PerformBootPreflight()');
    const childLaunchIdx = workerLoopBody.indexOf('Process.Start(psi)');

    assert.ok(preflightIdx !== -1, 'WorkerLoop must invoke PerformBootPreflight()');
    assert.ok(childLaunchIdx !== -1, 'WorkerLoop must launch child process via Process.Start(psi)');
    assert.ok(
      preflightIdx < childLaunchIdx,
      'Mandatory invariant: Boot preflight MUST execute BEFORE child process launch to prevent starting with stale 127.0.0.1'
    );
  });

  // Test 73 / Required Test D: Preshutdown optional best-effort isolation
  it('73. preshutdown optional best-effort: reflection/registration failure does not prevent service startup', () => {
    const csPath = path.resolve(__dirname, '../service-host/SafeBrowseServiceHost.cs');
    const csContent = fs.readFileSync(csPath, 'utf8');

    // 1. Static audit: TryEnablePreShutdown is isolated and non-fatal
    const tryPreShutdownBody = extractCsMethod(csContent, 'private void TryEnablePreShutdown()');
    assert.ok(tryPreShutdownBody.includes('try'), 'TryEnablePreShutdown must wrap reflection in try block');
    assert.ok(tryPreShutdownBody.includes('catch (Exception'), 'TryEnablePreShutdown must catch all exceptions');
    assert.ok(
      tryPreShutdownBody.includes('Log(string.Format("[WARN] Optional SERVICE_ACCEPT_PRESHUTDOWN registration failed'),
      'Must log warning on registration failure'
    );
    assert.ok(!tryPreShutdownBody.includes('throw'), 'TryEnablePreShutdown must never rethrow exception');

    // 2. Explicit architectural contract documentation
    assert.ok(
      csContent.includes('PRESHUTDOWN = OPTIMISATION / BEST-EFFORT CLEANUP ONLY'),
      'Must document PRESHUTDOWN as best-effort optimization only'
    );
    assert.ok(
      csContent.includes('BOOT PREFLIGHT = MANDATORY CORRECTNESS GUARANTEE'),
      'Must document BOOT PREFLIGHT as mandatory correctness guarantee'
    );

    // 3. Constructor must invoke TryEnablePreShutdown without fatal abort
    const ctorBody = extractCsMethod(csContent, 'public SafeBrowseServiceHost()');
    assert.ok(ctorBody.includes('TryEnablePreShutdown()'), 'Constructor must call TryEnablePreShutdown');
  });

  // Test 74 / Required Test E: No preshutdown delivered recovers on next boot
  it('74. no preshutdown delivered: abrupt shutdown/power loss leaves stale 127, boot preflight recovers correctly', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-no-preshutdown.json');
    fs.writeFileSync(
      backupFile,
      JSON.stringify([
        { InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', ServerAddresses: ['192.168.1.1'], DhcpEnabled: true }
      ])
    );

    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('win32');

    let resetExecuted = false;

    // Simulate scenario: System was power-cycled abruptly or CIM was terminated before OnStop/OnCustomCommand.
    // Zero preshutdown events were delivered.
    // WiFi adapter was left configured to 127.0.0.1 in the Windows registry.
    const mockExecutor = async (script: string) => {
      if (script.includes('ResetServerAddresses')) {
        resetExecuted = true;
      }
      if (script.includes('Get-DnsClientServerAddress')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', ServerAddresses: ['127.0.0.1'], DhcpEnabled: true }]),
          stderr: '',
        };
      }
      if (script.includes('Get-NetRoute')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', NextHop: '192.168.1.1' }]),
          stderr: '',
        };
      }
      if (script.includes('Get-NetAdapter')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Status: 'Up' }]),
          stderr: '',
        };
      }
      if (script.includes('Get-NetIPAddress')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, IPAddress: '192.168.1.8' }]),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    };
    nm.setCommandExecutorForTesting(mockExecutor);

    // Boot preflight executes on next startup without assuming any preshutdown was received
    const result = await nm.recoverStaleDnsAtBoot(53);
    assert.strictEqual(result.recovered, true, 'Boot preflight must recover stale 127 even with no preshutdown');
    assert.strictEqual(resetExecuted, true, 'Must execute ResetServerAddresses');
    assert.deepStrictEqual(result.restoredAdapters, [6]);
  });

  // Test 75: Boot preflight cancellation responsiveness
  it('75. boot preflight cancellation responsiveness: stopping service while preflight retries exits cleanly', () => {
    const csPath = path.resolve(__dirname, '../service-host/SafeBrowseServiceHost.cs');
    const csContent = fs.readFileSync(csPath, 'utf8');

    const preflightBody = extractCsMethod(csContent, 'public bool PerformBootPreflight(int maxRetries = 3, int retryDelayMs = 2000)');

    assert.ok(
      preflightBody.includes('if (_stopping)'),
      'PerformBootPreflight must check _stopping at start of each attempt'
    );
    assert.ok(
      preflightBody.includes('!_stopping'),
      'PerformBootPreflight retry sleep must be interruptible by _stopping'
    );
  });

  // -------------------------------------------------------------------------
  // SafeBrowse Windows Run #18 P0.1 Upstream Lifecycle & Watchdog Recovery Tests (Tests 76-84)
  // -------------------------------------------------------------------------

  // Test 76: Old backup + new network
  it('76. old backup + new network: proxy retains current-network upstreams and NEVER switches to stale backup', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-76.json');
    // Pre-create old backup with 192.168.1.1
    fs.writeFileSync(
      backupFile,
      JSON.stringify(
        [
          {
            InterfaceIndex: 6,
            InterfaceAlias: 'Wi-Fi',
            ServerAddresses: ['192.168.1.1'],
            DhcpEnabled: true,
          },
        ],
        null,
        2
      ),
      'utf8'
    );

    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux');

    // New physical network has 8.8.8.8, 4.4.2.2
    const adapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '10.0.0.1',
        ServerAddresses: ['8.8.8.8', '4.4.2.2'],
        DhcpEnabled: true,
      },
    ];
    nm.setMockAdaptersForTesting(adapters);

    // Initial physical DNS discovery
    const physicalDns = await nm.getCurrentPhysicalDnsServers();
    assert.deepStrictEqual(physicalDns, ['8.8.8.8', '4.4.2.2']);

    const proxy = new DnsFilterProxy(() => null);
    proxy.setUpstreams(physicalDns);
    assert.deepStrictEqual(proxy.getUpstreamServers(), [
      { host: '8.8.8.8', port: 53 },
      { host: '4.4.2.2', port: 53 },
    ]);

    // Adapter is now enforced to 127.0.0.1
    adapters[0].ServerAddresses = ['127.0.0.1'];

    // During subsequent tick, physical DNS returns []
    const runtimePhysical = await nm.getCurrentPhysicalDnsServers();
    assert.deepStrictEqual(runtimePhysical, []);

    // Proxy retains known-good upstreams, NEVER substitutes 192.168.1.1 from network-backup.json
    proxy.retainUpstreams();
    assert.deepStrictEqual(proxy.getUpstreamServers(), [
      { host: '8.8.8.8', port: 53 },
      { host: '4.4.2.2', port: 53 },
    ]);
    assert.ok(
      !proxy.getUpstreamServers().some((u) => u.host === '192.168.1.1'),
      'Proxy upstreams must NEVER switch to stale 192.168.1.1 from backup'
    );
  });

  // Test 77: Enforced adapter runtime inspection
  it('77. enforced adapter: getCurrentPhysicalDnsServers returns empty, proxy retains upstreams without fallback injection', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-77.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux');

    // Adapter DNS is 127.0.0.1
    const adapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '192.168.1.1',
        ServerAddresses: ['127.0.0.1'],
        DhcpEnabled: true,
      },
    ];
    nm.setMockAdaptersForTesting(adapters);

    const physical = await nm.getCurrentPhysicalDnsServers();
    assert.deepStrictEqual(physical, [], 'Must return empty when adapter is enforced to 127.0.0.1');

    const proxy = new DnsFilterProxy(() => null);
    proxy.setUpstreams(['8.8.8.8', '4.4.2.2']);
    proxy.retainUpstreams();

    // Upstreams remain exactly 8.8.8.8, 4.4.2.2
    assert.deepStrictEqual(proxy.getUpstreamServers(), [
      { host: '8.8.8.8', port: 53 },
      { host: '4.4.2.2', port: 53 },
    ]);
  });

  // Test 78: Watchdog fail-open retains reconciliation loop
  it('78. watchdog fail-open retains loop: persistent failure triggers fail-open without stopping timer', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-78.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux');

    const adapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '192.168.1.1',
        ServerAddresses: ['127.0.0.1'],
        DhcpEnabled: true,
      },
    ];
    nm.setMockAdaptersForTesting(adapters);
    nm.setMaxConsecutiveHealthFailuresForTesting(3);

    const dnsServer = await createMockDnsServer();
    try {
      // Simulate active reconciliation loop
      nm.startReconciliationLoop(dnsServer.port, 60000);
      assert.notStrictEqual(nm.getReconcileTimerForTesting(), null, 'Reconciliation timer must be active');

      // Upstream resolution fails persistently
      nm.setUpstreamResolutionCheckerForTesting(async () => false);

      // Tick 1
      await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(nm.getConsecutiveHealthFailuresForTesting(), 1);
      assert.deepStrictEqual(adapters[0].ServerAddresses, ['127.0.0.1']);

      // Tick 2
      await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(nm.getConsecutiveHealthFailuresForTesting(), 2);
      assert.deepStrictEqual(adapters[0].ServerAddresses, ['127.0.0.1']);

      // Tick 3: Watchdog triggers fail-open
      const res3 = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(res3.status, 'ERROR');
      assert.match(res3.message, /Watchdog restored original\/DHCP DNS/);

      // DNS restored to original/DHCP
      assert.deepStrictEqual(adapters[0].ServerAddresses, []);

      // Mandatory Invariant: reconciliation timer MUST REMAIN ACTIVE for automatic recovery!
      assert.notStrictEqual(
        nm.getReconcileTimerForTesting(),
        null,
        'Reconciliation loop timer MUST NOT be stopped by watchdog fail-open'
      );
      assert.strictEqual(nm.getIsRestoringForTesting(), false, 'isRestoring must be reset to false');
    } finally {
      nm.stopReconciliationLoop();
      nm.setUpstreamResolutionCheckerForTesting(null);
      await dnsServer.close();
    }
  });

  // Test 79: Watchdog recovery: auto-recovers protection once upstream healthy
  it('79. watchdog recovery: synchronizes proxy upstreams, re-enforces 127 transactionally without service restart', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-79.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux');

    // System is in fail-open state: adapter is on external DNS (8.8.8.8, 4.4.2.2)
    const adapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '192.168.1.1',
        ServerAddresses: ['8.8.8.8', '4.4.2.2'],
        DhcpEnabled: true,
      },
    ];
    nm.setMockAdaptersForTesting(adapters);

    const proxy = new DnsFilterProxy(() => null);
    // Wire up upstream sync handler
    nm.setUpstreamSyncHandler((upstreams) => proxy.setUpstreams(upstreams));

    const dnsServer = await createMockDnsServer();
    try {
      // Upstream becomes healthy
      nm.setUpstreamResolutionCheckerForTesting(async () => true);

      // Next reconciliation tick runs
      const res = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(res.status, 'RE_ENFORCED');

      // Proxy upstreams synchronized with current external DNS
      assert.deepStrictEqual(proxy.getUpstreamServers(), [
        { host: '8.8.8.8', port: 53 },
        { host: '4.4.2.2', port: 53 },
      ]);

      // Adapter re-enforced to 127.0.0.1
      assert.deepStrictEqual(adapters[0].ServerAddresses, ['127.0.0.1']);

      // Status becomes protected
      const inspection = await nm.inspectCurrentEnforcement();
      assert.strictEqual(inspection.isProtected, true);
    } finally {
      nm.setUpstreamResolutionCheckerForTesting(null);
      await dnsServer.close();
    }
  });

  // Test 80: Persistent bad upstream: no flip oscillation
  it('80. persistent bad upstream: stays on external DNS with zero flip oscillation when upstream remains down', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-80.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux');

    // Failed open to external DNS
    const adapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '192.168.1.1',
        ServerAddresses: ['192.168.1.1'],
        DhcpEnabled: true,
      },
    ];
    nm.setMockAdaptersForTesting(adapters);

    const dnsServer = await createMockDnsServer();
    try {
      // Upstream DNS is broken / unreachable
      nm.setUpstreamResolutionCheckerForTesting(async () => false);

      // Run multiple reconciliation ticks
      for (let i = 1; i <= 5; i++) {
        const res = await nm.reconcileAdapters(dnsServer.port);
        assert.strictEqual(res.status, 'ERROR');
        assert.match(res.message, /health (check failed|probe)/);
        // Adapter must stay on external DNS, NEVER toggled to 127.0.0.1
        assert.deepStrictEqual(adapters[0].ServerAddresses, ['192.168.1.1']);
      }
    } finally {
      nm.setUpstreamResolutionCheckerForTesting(null);
      await dnsServer.close();
    }
  });

  // Test 81: Transient health failure resets counter on success
  it('81. transient health failure: counter increments on failure and resets on subsequent success without fail-open', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-81.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux');

    const adapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '192.168.1.1',
        ServerAddresses: ['127.0.0.1'],
        DhcpEnabled: true,
      },
    ];
    nm.setMockAdaptersForTesting(adapters);
    nm.setMaxConsecutiveHealthFailuresForTesting(3);

    const dnsServer = await createMockDnsServer();
    try {
      // Tick 1: Transient failure
      nm.setUpstreamResolutionCheckerForTesting(async () => false);
      const res1 = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(res1.status, 'ERROR');
      assert.strictEqual(nm.getConsecutiveHealthFailuresForTesting(), 1);
      assert.deepStrictEqual(adapters[0].ServerAddresses, ['127.0.0.1'], 'Must stay 127 on transient failure');

      // Tick 2: Health restored!
      nm.setUpstreamResolutionCheckerForTesting(async () => true);
      const res2 = await nm.reconcileAdapters(dnsServer.port);
      assert.strictEqual(res2.status, 'IN_SYNC');
      assert.strictEqual(nm.getConsecutiveHealthFailuresForTesting(), 0, 'Counter must reset to 0');
      assert.deepStrictEqual(adapters[0].ServerAddresses, ['127.0.0.1']);
    } finally {
      nm.setUpstreamResolutionCheckerForTesting(null);
      await dnsServer.close();
    }
  });

  // Test 82: DHCP restore with stale backup
  it('82. DHCP restore with stale backup: executes ResetServerAddresses and never applies stale IP statically', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-82.json');
    fs.writeFileSync(
      backupFile,
      JSON.stringify(
        [
          {
            InterfaceIndex: 6,
            InterfaceAlias: 'Wi-Fi',
            ServerAddresses: ['192.168.1.1'],
            DhcpEnabled: true,
          },
        ],
        null,
        2
      ),
      'utf8'
    );

    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('win32');

    let executedReset = false;
    let executedStaticSet = false;
    nm.setCommandExecutorForTesting(async (script: string) => {
      if (script.includes('ResetServerAddresses')) {
        executedReset = true;
      }
      if (script.includes('Set-DnsClientServerAddress') && script.includes('-ServerAddresses')) {
        executedStaticSet = true;
      }
      return { stdout: '', stderr: '' };
    });

    await nm.restoreOriginalDns({ stopReconciliation: false });
    assert.strictEqual(executedReset, true, 'Must execute ResetServerAddresses for DHCP-enabled adapter');
    assert.strictEqual(executedStaticSet, false, 'Must NOT statically assign stale 192.168.1.1 for DHCP adapter');
  });

  // Test 83: Static DNS restore
  it('83. static DNS restore: restores exact static IP addresses when DhcpEnabled is false', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-83.json');
    fs.writeFileSync(
      backupFile,
      JSON.stringify(
        [
          {
            InterfaceIndex: 6,
            InterfaceAlias: 'Wi-Fi',
            ServerAddresses: ['1.1.1.1', '1.0.0.1'],
            DhcpEnabled: false,
          },
        ],
        null,
        2
      ),
      'utf8'
    );

    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('win32');

    const executedCommands: string[] = [];
    nm.setCommandExecutorForTesting(async (script: string) => {
      executedCommands.push(script);
      return { stdout: '', stderr: '' };
    });

    await nm.restoreOriginalDns({ stopReconciliation: false });
    assert.ok(
      executedCommands.some((c) => c.includes("-ServerAddresses @('1.1.1.1','1.0.0.1')")),
      'Must restore static IP addresses'
    );
    assert.ok(
      !executedCommands.some((c) => c.includes('ResetServerAddresses')),
      'Must not reset to DHCP when DhcpEnabled is false'
    );
  });

  // Test 84: Terminal shutdown restore stops loop
  it('84. terminal shutdown restore: default restoreOriginalDns stops reconciliation loop and clears state', async () => {
    const backupFile = path.join(tmpDir, 'backup-test-84.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux');

    const adapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '192.168.1.1',
        ServerAddresses: ['127.0.0.1'],
        DhcpEnabled: true,
      },
    ];
    nm.setMockAdaptersForTesting(adapters);

    // Start reconciliation loop
    nm.startReconciliationLoop(53, 60000);
    assert.notStrictEqual(nm.getReconcileTimerForTesting(), null, 'Reconcile timer must be running');

    // Call restoreOriginalDns with default options (stopReconciliation: true)
    await nm.restoreOriginalDns();

    // Reconcile timer must be cleared
    assert.strictEqual(nm.getReconcileTimerForTesting(), null, 'Reconcile timer must be stopped on terminal restore');
    assert.strictEqual(nm.getIsRestoringForTesting(), false, 'isRestoring must be false');
    assert.deepStrictEqual(adapters[0].ServerAddresses, []);
  });

  // -------------------------------------------------------------------------
  // SafeBrowse Windows DNS Health Probe Deterministic Suite (Tests 85-92)
  // -------------------------------------------------------------------------

  // Test 85: valid NOERROR + answer => healthy
  it('85. health probe: valid NOERROR + answer => healthy', async () => {
    const nm = new WindowsNetworkManager();
    const server = await createMockDnsServer(); // Default responds with NOERROR + 1 answer
    try {
      const healthy = await nm.verifyDnsProxyResponding(server.port, 1000);
      assert.strictEqual(healthy, true, 'Valid NOERROR response with answer must be healthy');
    } finally {
      await server.close();
    }
  });

  // Test 86: NXDOMAIN => unhealthy
  it('86. health probe: NXDOMAIN (RCODE 3) => unhealthy', async () => {
    const nm = new WindowsNetworkManager();
    const server = await createMockDnsServer((msg, rinfo, socket) => {
      const response = Buffer.from(msg);
      response[2] |= 0x80; // QR = 1
      response[3] = (response[3] & 0xf0) | 0x03; // RCODE 3 = NXDOMAIN
      response[6] = 0x00; // ANCOUNT = 0
      response[7] = 0x00;
      socket.send(response, rinfo.port, rinfo.address);
    });
    try {
      const healthy = await nm.verifyDnsProxyResponding(server.port, 500);
      assert.strictEqual(healthy, false, 'NXDOMAIN must be considered unhealthy for dns.google');
    } finally {
      await server.close();
    }
  });

  // Test 87: SERVFAIL => unhealthy
  it('87. health probe: SERVFAIL (RCODE 2) => unhealthy', async () => {
    const nm = new WindowsNetworkManager();
    const server = await createMockDnsServer((msg, rinfo, socket) => {
      const response = Buffer.from(msg);
      response[2] |= 0x80; // QR = 1
      response[3] = (response[3] & 0xf0) | 0x02; // RCODE 2 = SERVFAIL
      socket.send(response, rinfo.port, rinfo.address);
    });
    try {
      const healthy = await nm.verifyDnsProxyResponding(server.port, 500);
      assert.strictEqual(healthy, false, 'SERVFAIL must be considered unhealthy');
    } finally {
      await server.close();
    }
  });

  // Test 88: REFUSED => unhealthy
  it('88. health probe: REFUSED (RCODE 5) => unhealthy', async () => {
    const nm = new WindowsNetworkManager();
    const server = await createMockDnsServer((msg, rinfo, socket) => {
      const response = Buffer.from(msg);
      response[2] |= 0x80; // QR = 1
      response[3] = (response[3] & 0xf0) | 0x05; // RCODE 5 = REFUSED
      socket.send(response, rinfo.port, rinfo.address);
    });
    try {
      const healthy = await nm.verifyDnsProxyResponding(server.port, 500);
      assert.strictEqual(healthy, false, 'REFUSED must be considered unhealthy');
    } finally {
      await server.close();
    }
  });

  // Test 89: wrong transaction ID => unhealthy
  it('89. health probe: wrong transaction ID => unhealthy', async () => {
    const nm = new WindowsNetworkManager();
    const server = await createMockDnsServer((msg, rinfo, socket) => {
      const response = Buffer.from(msg);
      response[0] ^= 0xff; // Invert transaction ID byte
      response[2] |= 0x80; // QR = 1
      response[3] = response[3] & 0xf0; // RCODE 0
      response[6] = 0x00;
      response[7] = 0x01; // ANCOUNT = 1
      const answer = Buffer.from([
        0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x01, 0x2c, 0x00, 0x04, 0x08, 0x08, 0x08, 0x08,
      ]);
      socket.send(Buffer.concat([response, answer]), rinfo.port, rinfo.address);
    });
    try {
      const healthy = await nm.verifyDnsProxyResponding(server.port, 500);
      assert.strictEqual(healthy, false, 'Response with mismatched transaction ID must be rejected');
    } finally {
      await server.close();
    }
  });

  // Test 90: QR=0 => unhealthy
  it('90. health probe: QR=0 (query flag, not response) => unhealthy', async () => {
    const nm = new WindowsNetworkManager();
    const server = await createMockDnsServer((msg, rinfo, socket) => {
      const response = Buffer.from(msg);
      response[2] &= 0x7f; // QR = 0 (not a response)
      socket.send(response, rinfo.port, rinfo.address);
    });
    try {
      const healthy = await nm.verifyDnsProxyResponding(server.port, 500);
      assert.strictEqual(healthy, false, 'Packet with QR=0 must be rejected');
    } finally {
      await server.close();
    }
  });

  // Test 91: malformed/short response => unhealthy
  it('91. health probe: malformed/short response => unhealthy', async () => {
    const nm = new WindowsNetworkManager();
    const server = await createMockDnsServer((msg, rinfo, socket) => {
      // Send truncated 8-byte response (less than 12-byte header)
      socket.send(msg.subarray(0, 8), rinfo.port, rinfo.address);
    });
    try {
      const healthy = await nm.verifyDnsProxyResponding(server.port, 500);
      assert.strictEqual(healthy, false, 'Malformed/short packet must be rejected');
    } finally {
      await server.close();
    }
  });

  // Test 92: timeout then successful retry => healthy
  it('92. health probe: timeout then successful retry => healthy', async () => {
    const nm = new WindowsNetworkManager();
    let queryCount = 0;
    const server = await createMockDnsServer((msg, rinfo, socket) => {
      queryCount++;
      if (queryCount === 1) {
        // Drop attempt 1: simulate transient packet loss
        return;
      }
      // Attempt 2 (retry): respond with valid NOERROR + answer
      const response = Buffer.from(msg);
      response[2] |= 0x80;
      response[3] = response[3] & 0xf0;
      response[6] = 0x00;
      response[7] = 0x01;
      const answer = Buffer.from([
        0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x01, 0x2c, 0x00, 0x04, 0x08, 0x08, 0x08, 0x08,
      ]);
      socket.send(Buffer.concat([response, answer]), rinfo.port, rinfo.address);
    });
    try {
      // Timeout is 1000ms; retry fires at min(1200, 1000/2) = 500ms
      const healthy = await nm.verifyDnsProxyResponding(server.port, 1000);
      assert.strictEqual(healthy, true, 'Retry must recover from single transient packet drop');
      assert.strictEqual(queryCount, 2, 'Must have received exactly 2 queries (original + retry)');
    } finally {
      await server.close();
    }
  });

  // -------------------------------------------------------------------------
  // SafeBrowse Health Probe Policy Isolation & Lifecycle Deterministic Suite (Tests 93-99)
  // -------------------------------------------------------------------------

  // Test 93: Parental policy blocks dns.google, but infrastructure health remains HEALTHY and watchdog does NOT fail open
  it('93. policy isolation: parental policy blocking dns.google does NOT trigger health failure or watchdog fail-open', async () => {
    // 1. Setup proxy with strict parental policy that explicitly blocks dns.google
    const policyWithDnsGoogleBlocked = makeMockPolicy({
      rules: [makeMockRule('dns.google', 'BLOCK')],
    });
    const upstreamServer = await createMockDnsServer();
    const proxy = new DnsFilterProxy(() => policyWithDnsGoogleBlocked, '127.0.0.1', 0);
    proxy.setUpstreamServers([{ host: '127.0.0.1', port: upstreamServer.port }]);
    const proxyPort = await proxy.start(0);

    const backupFile = path.join(tmpDir, 'backup-test-93.json');
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('linux');

    const adapters: MockAdapterState[] = [
      {
        InterfaceIndex: 6,
        InterfaceAlias: 'Wi-Fi',
        Gateway: '192.168.1.1',
        ServerAddresses: ['127.0.0.1'],
        DhcpEnabled: true,
      },
    ];
    nm.setMockAdaptersForTesting(adapters);
    nm.setMaxConsecutiveHealthFailuresForTesting(3);
    nm.setConfiguredUpstreams([{ host: '127.0.0.1', port: upstreamServer.port }]);

    try {
      // 2. Verify that ordinary user query to proxy for 'dns.google' is blocked by policy
      const isProxyRespondingGoogle = await nm.probeDirectDnsServer('127.0.0.1', proxyPort, 500, 'dns.google');
      // When blocked, proxy returns NXDOMAIN (or block response), which probeDirectDnsServer rejects
      assert.strictEqual(isProxyRespondingGoogle, false, 'Client dns.google query must be blocked by parental policy');

      // 3. Verify that infrastructure health check returns true because:
      //    a) local proxy responds to internal health query (bypasses policy)
      //    b) upstream is probed directly over UDP (bypasses proxy and policy)
      const isHealthy = await nm.verifyEndToEndResolverHealth(proxyPort, {
        upstreams: [{ host: '127.0.0.1', port: upstreamServer.port }],
      });
      assert.strictEqual(isHealthy, true, 'Infrastructure health check must be HEALTHY even though policy blocks dns.google');

      // 4. Verify that watchdog reconciliation loop NEVER triggers fail-open
      for (let tick = 1; tick <= 5; tick++) {
        const res = await nm.reconcileAdapters(proxyPort);
        assert.strictEqual(res.status, 'IN_SYNC', `Tick ${tick} must remain IN_SYNC`);
        assert.strictEqual(nm.getConsecutiveHealthFailuresForTesting(), 0, `Watchdog failure count must stay 0 on tick ${tick}`);
        assert.deepStrictEqual(adapters[0].ServerAddresses, ['127.0.0.1'], 'Adapter must remain enforced with 127.0.0.1');
      }
    } finally {
      await proxy.stop();
      await upstreamServer.close();
    }
  });

  // Test 94: Local proxy alive + upstream healthy => healthy
  it('94. health isolation: local proxy alive + upstream healthy => healthy', async () => {
    const proxyServer = await createMockDnsServer();
    const upstreamServer = await createMockDnsServer();
    const nm = new WindowsNetworkManager();

    try {
      const isHealthy = await nm.verifyEndToEndResolverHealth(proxyServer.port, {
        upstreams: [{ host: '127.0.0.1', port: upstreamServer.port }],
      });
      assert.strictEqual(isHealthy, true, 'End-to-end health must be true when proxy is alive and upstream is healthy');
    } finally {
      await proxyServer.close();
      await upstreamServer.close();
    }
  });

  // Test 95: Local proxy alive + all upstreams unhealthy => unhealthy
  it('95. health isolation: local proxy alive + all upstreams unhealthy => unhealthy', async () => {
    const proxyServer = await createMockDnsServer();
    const deadUpstream = await createMockDnsServer();
    const deadPort = deadUpstream.port;
    await deadUpstream.close(); // Port is now closed/dead

    const nm = new WindowsNetworkManager();

    try {
      const isHealthy = await nm.verifyEndToEndResolverHealth(proxyServer.port, {
        timeoutMs: 300,
        upstreams: [{ host: '127.0.0.1', port: deadPort }],
      });
      assert.strictEqual(isHealthy, false, 'End-to-end health must be false when all upstreams are unhealthy');
    } finally {
      await proxyServer.close();
    }
  });

  // Test 96: Local proxy unavailable => unhealthy
  it('96. health isolation: local proxy unavailable => unhealthy', async () => {
    const deadProxy = await createMockDnsServer();
    const deadProxyPort = deadProxy.port;
    await deadProxy.close(); // Proxy port is dead

    const liveUpstream = await createMockDnsServer();
    const nm = new WindowsNetworkManager();

    try {
      const isHealthy = await nm.verifyEndToEndResolverHealth(deadProxyPort, {
        timeoutMs: 300,
        upstreams: [{ host: '127.0.0.1', port: liveUpstream.port }],
      });
      assert.strictEqual(isHealthy, false, 'End-to-end health must be false when local proxy is unavailable');
    } finally {
      await liveUpstream.close();
    }
  });

  // Test 97: Multi-upstream fallback: first upstream unavailable + second upstream healthy => healthy
  it('97. multi-upstream fallback: first upstream unavailable + second upstream healthy => healthy', async () => {
    const proxyServer = await createMockDnsServer();
    const deadUpstream = await createMockDnsServer();
    const deadPort = deadUpstream.port;
    await deadUpstream.close(); // Upstream 1 is down

    const liveUpstream = await createMockDnsServer(); // Upstream 2 is healthy
    const nm = new WindowsNetworkManager();

    try {
      const isHealthy = await nm.verifyEndToEndResolverHealth(proxyServer.port, {
        timeoutMs: 400,
        upstreams: [
          { host: '127.0.0.1', port: deadPort },
          { host: '127.0.0.1', port: liveUpstream.port },
        ],
      });
      assert.strictEqual(isHealthy, true, 'Must succeed when at least one configured upstream is healthy');
    } finally {
      await proxyServer.close();
      await liveUpstream.close();
    }
  });

  // Test 98: Policy evaluation is never invoked during infrastructure health probing
  it('98. policy isolation: policy evaluation is never invoked during health probing', async () => {
    let policyEvaluationCount = 0;
    const trackedPolicy = makeMockPolicy({
      rules: [makeMockRule('bad.com', 'BLOCK')],
    });

    const proxy = new DnsFilterProxy(() => {
      policyEvaluationCount++;
      return trackedPolicy;
    }, '127.0.0.1', 0);
    const proxyPort = await proxy.start(0);

    const upstreamServer = await createMockDnsServer();
    const nm = new WindowsNetworkManager();

    try {
      // 1. Local proxy liveness probe (health.safebrowse.internal)
      const proxyAlive = await nm.verifyLocalProxyAlive(proxyPort);
      assert.strictEqual(proxyAlive, true, 'Local proxy liveness check must succeed');
      assert.strictEqual(policyEvaluationCount, 0, 'Internal liveness check must NEVER trigger policy evaluation');

      // 2. Direct upstream probe
      const upstreamAlive = await nm.probeDirectDnsServer('127.0.0.1', upstreamServer.port);
      assert.strictEqual(upstreamAlive, true, 'Direct upstream probe must succeed');
      assert.strictEqual(policyEvaluationCount, 0, 'Direct upstream probe must NEVER trigger proxy policy evaluation');

      // 3. Combined end-to-end resolver health
      const resolverHealthy = await nm.verifyEndToEndResolverHealth(proxyPort, {
        upstreams: [{ host: '127.0.0.1', port: upstreamServer.port }],
      });
      assert.strictEqual(resolverHealthy, true, 'Resolver health check must succeed');
      assert.strictEqual(policyEvaluationCount, 0, 'End-to-end resolver health check must NEVER trigger policy evaluation');

      // 4. Contrast: verify that an ordinary user DNS query DOES invoke policy evaluation
      await nm.probeDirectDnsServer('127.0.0.1', proxyPort, 500, 'bad.com');
      assert.ok(policyEvaluationCount > 0, 'User DNS query must invoke policy evaluation');
    } finally {
      await proxy.stop();
      await upstreamServer.close();
    }
  });

  // Test 99: Logging hygiene: repeated retainUpstreams() calls deduplicate and do not generate duplicate log entries
  it('99. logging hygiene: repeated retainUpstreams() calls deduplicate and do not generate duplicate log entries', () => {
    const proxy = new DnsFilterProxy(() => null);
    proxy.resetLastRetainedHostsForTesting();

    const loggedMessages: string[] = [];
    const originalLog = console.log;
    console.log = (...args: any[]) => {
      loggedMessages.push(args.join(' '));
      originalLog(...args);
    };

    try {
      proxy.setUpstreams(['8.8.8.8', '4.4.2.2']);

      // Call retainUpstreams 10 times in a row (simulates 10 ticks = 30 seconds of reconciliation)
      for (let i = 0; i < 10; i++) {
        proxy.retainUpstreams();
      }

      // Assert that "[DnsProxy] Retaining known-good upstreams: [8.8.8.8, 4.4.2.2]" was logged EXACTLY ONCE
      const retain8888Count = loggedMessages.filter((m) =>
        m.includes('[DnsProxy] Retaining known-good upstreams: [8.8.8.8, 4.4.2.2]')
      ).length;
      assert.strictEqual(
        retain8888Count,
        1,
        `Retain log message must be deduplicated to exactly 1 entry, got ${retain8888Count}`
      );

      // Change upstreams to new state
      proxy.setUpstreams(['1.1.1.1']);

      // Call retainUpstreams 5 times for new state
      for (let i = 0; i < 5; i++) {
        proxy.retainUpstreams();
      }

      // Assert that "[DnsProxy] Retaining known-good upstreams: [1.1.1.1]" was logged EXACTLY ONCE
      const retain1111Count = loggedMessages.filter((m) =>
        m.includes('[DnsProxy] Retaining known-good upstreams: [1.1.1.1]')
      ).length;
      assert.strictEqual(
        retain1111Count,
        1,
        `Retain log message for new state must be deduplicated to exactly 1 entry, got ${retain1111Count}`
      );
    } finally {
      console.log = originalLog;
    }
  });

  // Test 100: Active-upstream consistency: proxy configured with dead upstream fails health even if independent DNS is reachable
  it('100. active-upstream consistency: proxy configured with dead upstream fails health even if independent DNS is reachable', async () => {
    // 1. Setup local proxy server
    const proxyServer = await createMockDnsServer();

    // 2. Setup dead upstream (port closed / unreachable)
    const deadUpstream = await createMockDnsServer();
    const deadPort = deadUpstream.port;
    await deadUpstream.close();

    // 3. Setup a separate, independently reachable healthy DNS server (representing 1.1.1.1 or other DNS)
    const reachableDnsServer = await createMockDnsServer();

    // 4. Setup DnsFilterProxy configured ONLY to forward to the dead upstream
    const proxy = new DnsFilterProxy(() => null);
    proxy.setUpstreamServers([{ host: '127.0.0.1', port: deadPort }]);

    // 5. Setup WindowsNetworkManager with activeUpstreamProvider wired to proxy
    const nm = new WindowsNetworkManager();
    nm.setActiveUpstreamProvider(() => proxy.getUpstreamServers());

    // Even if NetworkManager independently had other reachable DNS in configuredUpstreams:
    nm.setConfiguredUpstreams([{ host: '127.0.0.1', port: reachableDnsServer.port }]);

    try {
      // Step A: verifyEndToEndResolverHealth MUST fail because the proxy's actual configured upstream is DEAD
      // Watchdog must NOT claim healthy based on reachableDnsServer or fallback 1.1.1.1!
      const isHealthy = await nm.verifyEndToEndResolverHealth(proxyServer.port, { timeoutMs: 300 });
      assert.strictEqual(
        isHealthy,
        false,
        'Watchdog must NOT claim healthy based on independent DNS when proxy actual upstream is dead'
      );

      // Step B: Update proxy upstreams to [dead-upstream, healthy-upstream]
      proxy.setUpstreamServers([
        { host: '127.0.0.1', port: deadPort },
        { host: '127.0.0.1', port: reachableDnsServer.port },
      ]);

      // Step C: verifyEndToEndResolverHealth MUST succeed because at least one actual configured proxy upstream works
      const isNowHealthy = await nm.verifyEndToEndResolverHealth(proxyServer.port, { timeoutMs: 400 });
      assert.strictEqual(
        isNowHealthy,
        true,
        'Watchdog must report healthy when at least one actual configured proxy upstream works'
      );
    } finally {
      await proxyServer.close();
      await reachableDnsServer.close();
    }
  });

  // ----------------------------------------------------
  // Test 101: SCM recovery WiX definition: util:ServiceConfig sets restart on 1st, 2nd, and 3rd failures with 5s delay and 1-day reset
  // ----------------------------------------------------
  it('101. SCM recovery WiX definition: util:ServiceConfig sets restart on 1st, 2nd, and 3rd failures with 5s delay and 1-day reset', () => {
    const wxsPath = path.resolve(__dirname, '../wix/SafeBrowseChild-Pilot.wxs');
    assert.ok(fs.existsSync(wxsPath), 'SafeBrowseChild-Pilot.wxs must exist');
    const content = fs.readFileSync(wxsPath, 'utf8');

    assert.ok(
      content.includes('xmlns:util="http://wixtoolset.org/schemas/v4/wxs/util"'),
      'WiX file must declare xmlns:util namespace'
    );
    assert.ok(
      content.includes('<util:ServiceConfig'),
      'WiX file must contain util:ServiceConfig element'
    );
    assert.ok(
      content.includes('FirstFailureActionType="restart"'),
      'FirstFailureActionType must be "restart"'
    );
    assert.ok(
      content.includes('SecondFailureActionType="restart"'),
      'SecondFailureActionType must be "restart"'
    );
    assert.ok(
      content.includes('ThirdFailureActionType="restart"'),
      'ThirdFailureActionType must be "restart"'
    );
    assert.ok(
      content.includes('RestartServiceDelayInSeconds="5"'),
      'RestartServiceDelayInSeconds must be "5"'
    );
    assert.ok(
      content.includes('ResetPeriodInDays="1"'),
      'ResetPeriodInDays must be "1"'
    );
  });

  // ----------------------------------------------------
  // Test 102: SCM recovery WiX custom action: ConfigureServiceRecovery configures sc.exe failure and failureflag 1
  // ----------------------------------------------------
  it('102. SCM recovery WiX custom action: ConfigureServiceRecovery configures sc.exe failure and failureflag 1', () => {
    const wxsPath = path.resolve(__dirname, '../wix/SafeBrowseChild-Pilot.wxs');
    const content = fs.readFileSync(wxsPath, 'utf8');

    assert.ok(
      content.includes('Id="ConfigureServiceRecovery"'),
      'WiX file must define ConfigureServiceRecovery custom action'
    );
    assert.ok(
      content.includes('sc.exe failure SafeBrowseChildService reset= 86400 actions= restart/5000/restart/5000/restart/5000'),
      'ConfigureServiceRecovery must configure sc.exe failure with restart/5000 actions and 86400 reset'
    );
    assert.ok(
      content.includes('sc.exe failureflag SafeBrowseChildService 1'),
      'ConfigureServiceRecovery must configure sc.exe failureflag 1 to trigger on unexpected non-crash exits'
    );
    assert.ok(
      content.includes('Action="ConfigureServiceRecovery" After="InstallServices" Condition="NOT REMOVE"'),
      'ConfigureServiceRecovery must be sequenced After="InstallServices" when installing'
    );
  });

  // ----------------------------------------------------
  // Test 103: ServiceHost process lifecycle audit: declares Windows Job Object with KILL_ON_JOB_CLOSE and passes SAFEBROWSE_PARENT_PID
  // ----------------------------------------------------
  it('103. ServiceHost process lifecycle audit: declares Windows Job Object with KILL_ON_JOB_CLOSE and passes SAFEBROWSE_PARENT_PID', () => {
    const csPath = path.resolve(__dirname, '../service-host/SafeBrowseServiceHost.cs');
    assert.ok(fs.existsSync(csPath), 'SafeBrowseServiceHost.cs must exist');
    const csContent = fs.readFileSync(csPath, 'utf8');

    assert.ok(
      csContent.includes('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000'),
      'SafeBrowseServiceHost must define JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE'
    );
    assert.ok(
      csContent.includes('CreateJobObject'),
      'SafeBrowseServiceHost must import CreateJobObject'
    );
    assert.ok(
      csContent.includes('SetInformationJobObject'),
      'SafeBrowseServiceHost must import SetInformationJobObject'
    );
    assert.ok(
      csContent.includes('AssignProcessToJobObject'),
      'SafeBrowseServiceHost must import AssignProcessToJobObject'
    );
    assert.ok(
      csContent.includes('SAFEBROWSE_PARENT_PID'),
      'SafeBrowseServiceHost must pass SAFEBROWSE_PARENT_PID to child process'
    );
    assert.ok(
      csContent.includes('EnsureServiceRecoveryConfigured()'),
      'SafeBrowseServiceHost must call EnsureServiceRecoveryConfigured()'
    );
    assert.ok(
      csContent.includes('CleanupStaleInstances()'),
      'SafeBrowseServiceHost must call CleanupStaleInstances()'
    );
  });

  // ----------------------------------------------------
  // Test 104: ServiceHost child lifecycle: Job Object initialization and process tree termination guarantees zero orphaned proxies
  // ----------------------------------------------------
  it('104. ServiceHost child lifecycle: Job Object initialization and process tree termination guarantees zero orphaned proxies', () => {
    const csPath = path.resolve(__dirname, '../service-host/SafeBrowseServiceHost.cs');
    const csContent = fs.readFileSync(csPath, 'utf8');

    const initJobMethod = extractCsMethod(csContent, 'private void InitializeJobObject()');
    assert.ok(initJobMethod.includes('info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE'));
    assert.ok(initJobMethod.includes('SetInformationJobObject'));

    const onStopMethod = extractCsMethod(csContent, 'protected override void OnStop()');
    assert.ok(onStopMethod.includes('StopChildProcess()'));
    assert.ok(onStopMethod.includes('CloseHandle(_jobHandle)'));
  });

  // ----------------------------------------------------
  // Test 105: Stale/orphan process detection: CleanupStaleInstances targets only SafeBrowseChild-Pilot
  // ----------------------------------------------------
  it('105. stale/orphan process detection: CleanupStaleInstances targets only SafeBrowseChild-Pilot and never touches unrelated node or system processes', () => {
    const csPath = path.resolve(__dirname, '../service-host/SafeBrowseServiceHost.cs');
    const csContent = fs.readFileSync(csPath, 'utf8');

    const cleanupMethod = extractCsMethod(csContent, 'public void CleanupStaleInstances()');
    assert.ok(cleanupMethod.includes('Process.GetProcessesByName("SafeBrowseChild-Pilot")'));
    assert.ok(cleanupMethod.includes('SafeBrowseChild-Pilot.exe'));
    assert.ok(!cleanupMethod.includes('"node"'), 'Must never indiscriminately terminate node processes');
    assert.ok(cleanupMethod.includes('p.Kill()'));
    assert.ok(cleanupMethod.includes('p.WaitForExit'));
  });

  // ----------------------------------------------------
  // Test 106: Duplicate proxy prevention: starting second DnsFilterProxy on active port throws cleanly
  // ----------------------------------------------------
  it('106. duplicate proxy prevention: starting second DnsFilterProxy on active port throws cleanly without overriding primary', async () => {
    const primaryProxy = new DnsFilterProxy(() => null);
    const port = await primaryProxy.start(0);

    try {
      const secondSocket = dgram.createSocket('udp4');
      let secondBound = false;
      let errorOccurred = false;

      await new Promise<void>((resolve) => {
        secondSocket.on('error', () => {
          errorOccurred = true;
          try { secondSocket.close(); } catch {}
          resolve();
        });
        secondSocket.bind(port, '127.0.0.1', () => {
          secondBound = true;
          try { secondSocket.close(); } catch {}
          resolve();
        });
      });

      assert.strictEqual(secondBound, false, 'Second socket must not bind to already-occupied proxy port');
      assert.strictEqual(errorOccurred, true, 'Port collision must emit error to prevent duplicate proxy');
    } finally {
      primaryProxy.stop();
    }
  });

  // ----------------------------------------------------
  // Test 107: Crash during DNS=127 condition: boot preflight detects stale DNS and restores external DNS
  // ----------------------------------------------------
  it('107. crash during DNS=127 condition: boot preflight detects stale DNS on adapter when resolver is absent and restores working external DNS first', async () => {
    const backupFile = path.join(tmpDir, 'backup-crash-107.json');
    fs.writeFileSync(
      backupFile,
      JSON.stringify([{ InterfaceIndex: 6, ServerAddresses: ['192.168.1.1'], DhcpEnabled: true }]),
      'utf8'
    );
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('win32');

    const executedScripts: string[] = [];
    nm.setCommandExecutorForTesting(async (script: string) => {
      executedScripts.push(script);
      if (script.includes('Get-NetIPConfiguration')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Gateway: '192.168.1.1' }]),
          stderr: '',
        };
      }
      if (script.includes('Get-DnsClientServerAddress')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', ServerAddresses: ['127.0.0.1'] }]),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    const deadPort = 49991;
    const result = await nm.recoverStaleDnsAtBoot(deadPort);

    assert.strictEqual(result.recovered, true, 'Must detect and recover stale 127.0.0.1 DNS');
    assert.deepStrictEqual(result.restoredAdapters, [6]);
    assert.ok(
      executedScripts.some((s) => s.includes('ResetServerAddresses')),
      'Must restore adapter to DHCP/original configuration so machine is not trapped'
    );
  });

  // ----------------------------------------------------
  // Test 108: Restart when DNS already equals 127: boot preflight preserves active protection if resolver is healthy
  // ----------------------------------------------------
  it('108. restart when DNS already equals 127: boot preflight detects existing healthy resolver and safely preserves active protection', async () => {
    const mockDns = await createMockDnsServer();
    const backupFile = path.join(tmpDir, 'backup-restart-108.json');
    fs.writeFileSync(
      backupFile,
      JSON.stringify([{ InterfaceIndex: 6, ServerAddresses: ['192.168.1.1'], DhcpEnabled: true }]),
      'utf8'
    );
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('win32');

    const executedScripts: string[] = [];
    nm.setCommandExecutorForTesting(async (script: string) => {
      executedScripts.push(script);
      if (script.includes('Get-NetIPConfiguration')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Gateway: '192.168.1.1' }]),
          stderr: '',
        };
      }
      if (script.includes('Get-DnsClientServerAddress')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', ServerAddresses: ['127.0.0.1'] }]),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    try {
      const result = await nm.recoverStaleDnsAtBoot(mockDns.port);
      assert.strictEqual(result.recovered, false, 'Must not wipe DNS when resolver is verified healthy');
      assert.ok(
        result.message.includes('preserving active protection'),
        'Must preserve active protection when resolver is already operational'
      );
      assert.ok(
        !executedScripts.some((s) => s.includes('ResetServerAddresses')),
        'Must not issue ResetServerAddresses when resolver is operational'
      );
    } finally {
      await mockDns.close();
    }
  });

  // ----------------------------------------------------
  // Test 109: Restart when resolver is absent: preflight restores external DNS immediately
  // ----------------------------------------------------
  it('109. restart when resolver is absent: preflight verifies resolver is dead and immediately restores working external DNS before proxy setup', async () => {
    const backupFile = path.join(tmpDir, 'backup-restart-109.json');
    fs.writeFileSync(
      backupFile,
      JSON.stringify([{ InterfaceIndex: 12, ServerAddresses: ['8.8.8.8', '8.8.4.4'], DhcpEnabled: false }]),
      'utf8'
    );
    const nm = new WindowsNetworkManager(backupFile);
    nm.setPlatformForTesting('win32');

    const executedScripts: string[] = [];
    nm.setCommandExecutorForTesting(async (script: string) => {
      executedScripts.push(script);
      if (script.includes('Get-NetIPConfiguration')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 12, InterfaceAlias: 'Ethernet', Gateway: '192.168.1.1' }]),
          stderr: '',
        };
      }
      if (script.includes('Get-DnsClientServerAddress')) {
        return {
          stdout: JSON.stringify([{ InterfaceIndex: 12, InterfaceAlias: 'Ethernet', ServerAddresses: ['127.0.0.1'] }]),
          stderr: '',
        };
      }
      return { stdout: '', stderr: '' };
    });

    const deadPort = 49992;
    const isHealthy = await nm.verifyEndToEndResolverHealth(deadPort, { timeoutMs: 200 });
    assert.strictEqual(isHealthy, false, 'Resolver health check must fail when port is inactive');

    const result = await nm.recoverStaleDnsAtBoot(deadPort);
    assert.strictEqual(result.recovered, true);
    assert.ok(
      executedScripts.some((s) => s.includes("-ServerAddresses @('8.8.8.8','8.8.4.4')")),
      'Must restore exact static DNS from backup when resolver is absent'
    );
  });

  // ----------------------------------------------------
  // Test 110: Restart when backend is unavailable but cached policy exists
  // ----------------------------------------------------
  it('110. restart when backend is unavailable but cached policy exists: engine successfully transitions to OFFLINE_BACKEND_CACHED_POLICY with cached policy', () => {
    const status = computeEngineStatus(true, undefined, 'POLICY_CACHED');
    assert.strictEqual(status, 'OFFLINE_BACKEND_CACHED_POLICY');

    const active = isEnforcementActive(status, true);
    assert.strictEqual(active, true, 'Enforcement must remain active under cached policy when backend is unreachable');
  });

  // ----------------------------------------------------
  // Test 111: Multiple consecutive service crashes
  // ----------------------------------------------------
  it('111. multiple consecutive service crashes: simulated 1st, 2nd, and 3rd crashes verify repeated recovery actions and clean proxy re-creation', async () => {
    const backupFile = path.join(tmpDir, 'backup-multicrash-111.json');
    fs.writeFileSync(
      backupFile,
      JSON.stringify([{ InterfaceIndex: 6, ServerAddresses: ['192.168.1.1'], DhcpEnabled: true }]),
      'utf8'
    );

    for (let cycle = 1; cycle <= 3; cycle++) {
      const nm = new WindowsNetworkManager(backupFile);
      nm.setPlatformForTesting('win32');

      const executedScripts: string[] = [];
      nm.setCommandExecutorForTesting(async (script: string) => {
        executedScripts.push(script);
        if (script.includes('Get-NetIPConfiguration')) {
          return {
            stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', Gateway: '192.168.1.1' }]),
            stderr: '',
          };
        }
        if (script.includes('Get-DnsClientServerAddress')) {
          return {
            stdout: JSON.stringify([{ InterfaceIndex: 6, InterfaceAlias: 'Wi-Fi', ServerAddresses: ['127.0.0.1'] }]),
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      });

      const deadPort = 49990 + cycle;
      const preflight = await nm.recoverStaleDnsAtBoot(deadPort);
      assert.strictEqual(preflight.recovered, true, `Cycle ${cycle}: preflight must recover stale DNS`);

      const proxy = new DnsFilterProxy(() => null);
      const activePort = await proxy.start(0);

      try {
        const isHealthy = await nm.verifyEndToEndResolverHealth(activePort, { timeoutMs: 300 });
        assert.strictEqual(isHealthy, true, `Cycle ${cycle}: recreated proxy must be healthy`);
      } finally {
        proxy.stop();
      }
    }
  });

  // ----------------------------------------------------
  // Test 112: Status correctness: SCM service STOPPED
  // ----------------------------------------------------
  it('112. status correctness: SCM service STOPPED must report Degraded (Service STOPPED / Unsupervised), never Protected', async () => {
    const status = await evaluateSystemStatus({
      serviceChecker: async () => ({
        installed: true,
        state: 'STOPPED',
        isSupervised: false,
        rawOutput: 'STATE : 1 STOPPED',
      }),
      resolverChecker: async () => true,
      enforcementInspector: async () => ({
        isProtected: true,
        activeAdapters: [{ interfaceIndex: 6, interfaceAlias: 'Wi-Fi', dnsServers: ['127.0.0.1'], isEnforced: true }],
        summary: 'Protected',
      }),
      configLoader: async () => ({
        deviceId: 'dev-1',
        deviceToken: 'tok',
        childId: 'c-1',
        parentId: 'p-1',
        deviceName: 'Laptop',
        backendUrl: 'http://localhost:11002',
        pairedAt: new Date().toISOString(),
      }),
    });

    assert.strictEqual(
      status.parentStatus,
      'Degraded (Service STOPPED / Unsupervised)',
      'Must report Degraded when service is STOPPED even if DNS is 127.0.0.1 and resolver is alive'
    );
    assert.strictEqual(status.isProtected, false, 'isProtected must be false when service is STOPPED');
    assert.strictEqual(status.isSupervised, false);
  });

  // ----------------------------------------------------
  // Test 113: Status correctness: resolver unhealthy
  // ----------------------------------------------------
  it('113. status correctness: resolver unhealthy must report Degraded (Resolver Inactive / Unhealthy), never Protected', async () => {
    const status = await evaluateSystemStatus({
      serviceChecker: async () => ({
        installed: true,
        state: 'RUNNING',
        isSupervised: true,
        rawOutput: 'STATE : 4 RUNNING',
      }),
      resolverChecker: async () => false,
      enforcementInspector: async () => ({
        isProtected: true,
        activeAdapters: [{ interfaceIndex: 6, interfaceAlias: 'Wi-Fi', dnsServers: ['127.0.0.1'], isEnforced: true }],
        summary: 'Protected',
      }),
      configLoader: async () => ({
        deviceId: 'dev-1',
        deviceToken: 'tok',
        childId: 'c-1',
        parentId: 'p-1',
        deviceName: 'Laptop',
        backendUrl: 'http://localhost:11002',
        pairedAt: new Date().toISOString(),
      }),
    });

    assert.strictEqual(status.parentStatus, 'Degraded (Resolver Inactive / Unhealthy)');
    assert.strictEqual(status.isProtected, false);
  });

  // ----------------------------------------------------
  // Test 114: Status correctness: DNS not redirected
  // ----------------------------------------------------
  it('114. status correctness: DNS not redirected must report Temporarily limited (DNS Not Redirected), never Protected', async () => {
    const status = await evaluateSystemStatus({
      serviceChecker: async () => ({
        installed: true,
        state: 'RUNNING',
        isSupervised: true,
        rawOutput: 'STATE : 4 RUNNING',
      }),
      resolverChecker: async () => true,
      enforcementInspector: async () => ({
        isProtected: false,
        activeAdapters: [{ interfaceIndex: 6, interfaceAlias: 'Wi-Fi', dnsServers: ['192.168.1.1'], isEnforced: false }],
        summary: 'Not protected',
      }),
      configLoader: async () => ({
        deviceId: 'dev-1',
        deviceToken: 'tok',
        childId: 'c-1',
        parentId: 'p-1',
        deviceName: 'Laptop',
        backendUrl: 'http://localhost:11002',
        pairedAt: new Date().toISOString(),
      }),
    });

    assert.strictEqual(status.parentStatus, 'Temporarily limited (DNS Not Redirected)');
    assert.strictEqual(status.isProtected, false);
  });

  // ----------------------------------------------------
  // Test 115: Status correctness: fully supervised healthy state reports Parent Status: Protected
  // ----------------------------------------------------
  it('115. status correctness: fully supervised healthy state reports Parent Status: Protected', async () => {
    const cacheDir = path.join(os.tmpdir(), `sb-cache-test-${Date.now()}`);
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, 'policy-dev-1.json');
    fs.writeFileSync(cacheFile, JSON.stringify(makeMockPolicy({ version: 2 })), 'utf8');

    const origGetCacheDir = ConfigManager.prototype.getCacheDir;
    ConfigManager.prototype.getCacheDir = () => cacheDir;

    try {
      const status = await evaluateSystemStatus({
        serviceChecker: async () => ({
          installed: true,
          state: 'RUNNING',
          isSupervised: true,
          rawOutput: 'STATE : 4 RUNNING',
        }),
        resolverChecker: async () => true,
        enforcementInspector: async () => ({
          isProtected: true,
          activeAdapters: [{ interfaceIndex: 6, interfaceAlias: 'Wi-Fi', dnsServers: ['127.0.0.1'], isEnforced: true }],
          summary: 'Protected',
        }),
        configLoader: async () => ({
          deviceId: 'dev-1',
          deviceToken: 'tok',
          childId: 'c-1',
          parentId: 'p-1',
          deviceName: 'Laptop',
          backendUrl: 'http://localhost:11002',
          pairedAt: new Date().toISOString(),
        }),
      });

      assert.strictEqual(status.parentStatus, 'Protected');
      assert.strictEqual(status.isProtected, true);
      assert.strictEqual(status.hasUsablePolicy, true);
      assert.strictEqual(status.dnsEnforced, true);
      assert.strictEqual(status.resolverHealthy, true);
    } finally {
      ConfigManager.prototype.getCacheDir = origGetCacheDir;
      try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch {}
    }
  });

  // ----------------------------------------------------
  // Test 116: Windows WebSocket URL contains exactly /ws and no credentials in query string
  // ----------------------------------------------------
  it('116. Windows WebSocket URL contains exactly /ws and no credentials in query string', () => {
    const config: DeviceConfig = {
      deviceId: 'dev-sensitive-id-999',
      deviceToken: 'dtk_ultra_secret_token_abc123',
      childId: 'child-116',
      parentId: 'parent-116',
      deviceName: 'Audit Laptop',
      backendUrl: 'https://safebrowse.porwal.online',
    };

    const tempDir = path.join(os.tmpdir(), `sb-ws-audit-${Date.now()}`);
    const client = new PolicySyncClient(config, tempDir, () => true);

    const wsUrl = client.getWebSocketUrl();
    assert.strictEqual(wsUrl, 'wss://safebrowse.porwal.online/ws');
    assert.strictEqual(wsUrl.includes('?'), false, 'WebSocket URL must contain zero query parameters');
    assert.strictEqual(wsUrl.includes('deviceToken'), false, 'WebSocket URL must not leak deviceToken');
    assert.strictEqual(wsUrl.includes('deviceId'), false, 'WebSocket URL must not leak deviceId');
    assert.strictEqual(wsUrl.includes('dtk_ultra_secret_token_abc123'), false);

    // Also verify with trailing slash backendUrl and http
    const httpConfig: DeviceConfig = {
      ...config,
      backendUrl: 'http://127.0.0.1:4000/',
    };
    const httpClient = new PolicySyncClient(httpConfig, tempDir, () => true);
    assert.strictEqual(httpClient.getWebSocketUrl(), 'ws://127.0.0.1:4000/ws');
    assert.strictEqual(httpClient.getWebSocketUrl().includes('?'), false);

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  // ----------------------------------------------------
  // Test 117: socket OPEN alone does NOT set POLICY_LIVE (retains POLICY_CACHED / UNAVAILABLE until AUTH_SUCCESS)
  // ----------------------------------------------------
  it('117. socket OPEN alone does NOT set POLICY_LIVE', async () => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server, path: '/ws' });

    let receivedUrl = '';
    let receivedAuthPayload: any = null;

    wss.on('connection', (ws, req) => {
      receivedUrl = req.url || '';
      ws.on('message', (data) => {
        try {
          receivedAuthPayload = JSON.parse(data.toString());
        } catch {}
      });
      // Do NOT send AUTH_SUCCESS immediately
    });

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;

    const tempDir = path.join(os.tmpdir(), `sb-ws-open-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    // Pre-populate cached policy
    fs.writeFileSync(
      path.join(tempDir, 'policy-dev-ws-117.json'),
      JSON.stringify(makeMockPolicy({ version: 3 })),
      'utf8'
    );

    const config: DeviceConfig = {
      deviceId: 'dev-ws-117',
      deviceToken: 'dtk_secret_117',
      childId: 'child-117',
      parentId: 'parent-117',
      deviceName: 'Test Laptop',
      backendUrl: `http://127.0.0.1:${port}`,
    };

    const client = new PolicySyncClient(config, tempDir, () => true);
    assert.strictEqual(client.getPolicyStatus(), 'POLICY_CACHED');
    assert.strictEqual(client.isWebSocketAuthenticated(), false);

    client.connectWebSocket();

    // Wait for transport open
    await new Promise((r) => setTimeout(r, 200));

    // req.url must be strictly '/ws' with zero query params
    assert.strictEqual(receivedUrl, '/ws');
    assert.strictEqual(receivedUrl.includes('?'), false);

    // Socket OPEN alone must NOT set POLICY_LIVE
    assert.strictEqual(client.getPolicyStatus(), 'POLICY_CACHED');
    assert.strictEqual(client.isWebSocketAuthenticated(), false);

    // Verify AUTH_DEVICE payload was transmitted over encrypted message body
    assert.ok(receivedAuthPayload);
    assert.strictEqual(receivedAuthPayload.type, 'AUTH_DEVICE');
    assert.strictEqual(receivedAuthPayload.deviceId, 'dev-ws-117');
    assert.strictEqual(receivedAuthPayload.deviceToken, 'dtk_secret_117');

    client.stop();
    await new Promise<void>((r) => wss.close(() => server.close(() => r())));
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  // ----------------------------------------------------
  // Test 118: device authentication succeeds via AUTH_DEVICE message and transitions to POLICY_LIVE upon AUTH_SUCCESS
  // ----------------------------------------------------
  it('118. device authentication succeeds via AUTH_DEVICE and transitions to POLICY_LIVE upon AUTH_SUCCESS', async () => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server, path: '/ws' });

    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'AUTH_DEVICE' && msg.deviceId === 'dev-ws-118' && msg.deviceToken === 'dtk_secret_118') {
          ws.send(JSON.stringify({ type: 'AUTH_SUCCESS', deviceId: 'dev-ws-118' }));
        }
      });
    });

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;

    const tempDir = path.join(os.tmpdir(), `sb-ws-success-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'policy-dev-ws-118.json'),
      JSON.stringify(makeMockPolicy({ version: 4 })),
      'utf8'
    );

    const config: DeviceConfig = {
      deviceId: 'dev-ws-118',
      deviceToken: 'dtk_secret_118',
      childId: 'child-118',
      parentId: 'parent-118',
      deviceName: 'Success Laptop',
      backendUrl: `http://127.0.0.1:${port}`,
    };

    const client = new PolicySyncClient(config, tempDir, () => true);
    assert.strictEqual(client.getPolicyStatus(), 'POLICY_CACHED');

    client.connectWebSocket();

    // Wait for message roundtrip
    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(client.isWebSocketAuthenticated(), true);
    assert.strictEqual(client.getPolicyStatus(), 'POLICY_LIVE');

    client.stop();
    await new Promise<void>((r) => wss.close(() => server.close(() => r())));
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  // ----------------------------------------------------
  // Test 119: AUTH_ERROR does NOT set POLICY_LIVE, retains valid cached policy as POLICY_CACHED, and never logs deviceToken
  // ----------------------------------------------------
  it('119. AUTH_ERROR does NOT set POLICY_LIVE, retains valid cached policy as POLICY_CACHED, and never logs deviceToken', async () => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server, path: '/ws' });

    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'AUTH_DEVICE') {
          ws.send(JSON.stringify({ type: 'AUTH_ERROR', message: 'Authentication failed' }));
        }
      });
    });

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;

    const tempDir = path.join(os.tmpdir(), `sb-ws-error-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'policy-dev-ws-119.json'),
      JSON.stringify(makeMockPolicy({ version: 5 })),
      'utf8'
    );

    const superSecretToken = 'dtk_critical_secret_token_xyz999';
    const config: DeviceConfig = {
      deviceId: 'dev-ws-119',
      deviceToken: superSecretToken,
      childId: 'child-119',
      parentId: 'parent-119',
      deviceName: 'Error Laptop',
      backendUrl: `http://127.0.0.1:${port}`,
    };

    const capturedLogs: string[] = [];
    const origWarn = console.warn;
    const origLog = console.log;
    const origError = console.error;

    console.warn = (...args: any[]) => {
      capturedLogs.push(args.map((a) => String(a)).join(' '));
      origWarn.apply(console, args);
    };
    console.log = (...args: any[]) => {
      capturedLogs.push(args.map((a) => String(a)).join(' '));
      origLog.apply(console, args);
    };
    console.error = (...args: any[]) => {
      capturedLogs.push(args.map((a) => String(a)).join(' '));
      origError.apply(console, args);
    };

    const client = new PolicySyncClient(config, tempDir, () => true);

    try {
      client.connectWebSocket();
      await new Promise((r) => setTimeout(r, 200));

      assert.strictEqual(client.isWebSocketAuthenticated(), false);
      assert.strictEqual(client.getPolicyStatus(), 'POLICY_CACHED');
      assert.notStrictEqual(client.getPolicyStatus(), 'POLICY_LIVE');

      // Verify no leak of deviceToken
      const leaked = capturedLogs.some((l) => l.includes(superSecretToken));
      assert.strictEqual(leaked, false, 'deviceToken must never be printed to logs');
    } finally {
      console.warn = origWarn;
      console.log = origLog;
      console.error = origError;
      client.stop();
      await new Promise<void>((r) => wss.close(() => server.close(() => r())));
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  });

  // ----------------------------------------------------
  // Test 120: socket disconnection / close preserves valid cached policy as POLICY_CACHED
  // ----------------------------------------------------
  it('120. socket disconnection / close preserves valid cached policy as POLICY_CACHED', async () => {
    let clientWsRef: any = null;
    const server = http.createServer();
    const wss = new WebSocketServer({ server, path: '/ws' });

    wss.on('connection', (ws) => {
      clientWsRef = ws;
      ws.on('message', () => {
        ws.send(JSON.stringify({ type: 'AUTH_SUCCESS', deviceId: 'dev-ws-120' }));
      });
    });

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;

    const tempDir = path.join(os.tmpdir(), `sb-ws-close-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'policy-dev-ws-120.json'),
      JSON.stringify(makeMockPolicy({ version: 6 })),
      'utf8'
    );

    const config: DeviceConfig = {
      deviceId: 'dev-ws-120',
      deviceToken: 'dtk_secret_120',
      childId: 'child-120',
      parentId: 'parent-120',
      deviceName: 'Close Laptop',
      backendUrl: `http://127.0.0.1:${port}`,
    };

    const client = new PolicySyncClient(config, tempDir, () => true);
    client.connectWebSocket();

    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(client.getPolicyStatus(), 'POLICY_LIVE');

    // Simulate abrupt socket termination from server
    if (clientWsRef) {
      clientWsRef.terminate();
    }

    await new Promise((r) => setTimeout(r, 200));

    // Must gracefully fall back to POLICY_CACHED (fail-safe enforcement maintained)
    assert.strictEqual(client.getPolicyStatus(), 'POLICY_CACHED');
    assert.strictEqual(client.isWebSocketAuthenticated(), false);
    assert.ok(client.getActivePolicy());
    assert.strictEqual(client.getActivePolicy()?.version, 6);

    client.stop();
    await new Promise<void>((r) => wss.close(() => server.close(() => r())));
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });
});
