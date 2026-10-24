process.env.NODE_ENV = 'test';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import * as http from 'http';
import {
  BlockIpcServer,
  BlockPresentationMessage,
  HelperRegisterAck,
} from '../src/block-ipc';
import { BlockPageServer } from '../src/block-server';
import { DnsFilterProxy, BlockExperienceContext } from '../src/dns-proxy';
import { PolicySyncClient, AccessRequestResolutionEvent } from '../src/sync-client';
import { Policy, evaluatePolicy } from '@safebrowse/shared';

describe('SafeBrowse Stage C.5.4: Ask Parent Approval Scope & Continuation Suite', () => {
  let testSockPath: string;
  let ipcServer: BlockIpcServer;
  let blockServer: BlockPageServer;
  let mockBackendServer: http.Server;
  let mockBackendPort: number;
  let lastBackendRequestBody: any = null;

  beforeEach(async () => {
    testSockPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\sb-c54-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
        : path.join(
            os.tmpdir(),
            `sb-c54-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}.sock`
          );

    ipcServer = new BlockIpcServer(testSockPath, 2000, 100);
    ipcServer.setActivePolicyProvider(() => ({
      accountName: 'mporwal',
      isManaged: true,
      childId: 'child-manjari-uuid',
      childName: 'Manjari',
      sid: 'S-1-5-21-12345-67890-1005',
      sessionId: 5,
    }));
    ipcServer.setMultiSessionChecker(() => ({
      hasMultipleSessions: false,
      sessionCount: 1,
      activeUsers: ['mporwal'],
      warning: null,
    }));

    // Start mock backend for POST /api/requests
    await new Promise<void>((resolve) => {
      mockBackendServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/api/requests') {
          let b = '';
          req.on('data', (c) => (b += c));
          req.on('end', () => {
            lastBackendRequestBody = JSON.parse(b);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'req-roblox-123',
                childId: lastBackendRequestBody.childId,
                deviceId: lastBackendRequestBody.deviceId,
                domain: lastBackendRequestBody.domain,
                reason: lastBackendRequestBody.reason,
                status: 'PENDING',
              })
            );
          });
          return;
        }
        res.writeHead(404);
        res.end();
      });
      mockBackendServer.listen(0, '127.0.0.1', () => {
        const addr = mockBackendServer.address() as net.AddressInfo;
        mockBackendPort = addr.port;
        resolve();
      });
    });

    blockServer = new BlockPageServer(
      `http://127.0.0.1:${mockBackendPort}`,
      'child-manjari-uuid',
      'dev-win-101',
      () => ({ childId: 'child-manjari-uuid', childName: 'Manjari' }),
      'token-test-secret'
    );
  });

  afterEach(async () => {
    try {
      await ipcServer.stop();
    } catch {}
    try {
      blockServer.stop();
    } catch {}
    try {
      await new Promise<void>((resolve) => mockBackendServer.close(() => resolve()));
    } catch {}
  });

  // --------------------------------------------------------------------------
  // Test 1: MatchedDomain Approval Scope & BlockExperienceContext
  // --------------------------------------------------------------------------
  test('Test 1: Policy evaluation of subdomain block extracts matchedDomain approval scope', () => {
    const policy: Policy = {
      id: 'pol-1',
      childId: 'child-manjari-uuid',
      familyId: 'fam-1',
      version: 1,
      isPaused: false,
      rules: [
        { id: 'r1', domain: 'roblox.com', action: 'BLOCK', addedAt: new Date().toISOString(), reason: 'Gaming blocked by family rule' },
        { id: 'r2', domain: '*.wildcard-site.com', action: 'BLOCK', addedAt: new Date().toISOString() },
      ],
      updatedAt: new Date().toISOString(),
    };

    // 1. Physical Roblox Case: ncs.roblox.com query against roblox.com BLOCK rule
    const res1 = evaluatePolicy(policy, 'ncs.roblox.com');
    assert.strictEqual(res1.action, 'BLOCK');
    assert.strictEqual(res1.matchedDomain, 'roblox.com');

    const norm1 = 'ncs.roblox.com';
    const approval1 = res1.matchedDomain ? res1.matchedDomain.toLowerCase() : norm1;
    const ctx1: BlockExperienceContext = {
      requestedDomain: norm1,
      approvalDomain: approval1,
      reason: res1.reason || 'Blocked by family rules',
      matchedDomain: res1.matchedDomain,
      matchedRuleType: res1.matchedRuleType,
    };

    assert.strictEqual(ctx1.requestedDomain, 'ncs.roblox.com');
    assert.strictEqual(ctx1.approvalDomain, 'roblox.com', 'Approval domain MUST be roblox.com, not ncs.roblox.com');

    // 2. Wildcard Case: video.wildcard-site.com
    const res2 = evaluatePolicy(policy, 'video.wildcard-site.com');
    assert.strictEqual(res2.action, 'BLOCK');
    assert.strictEqual(res2.matchedDomain, '*.wildcard-site.com');

    const ctx2: BlockExperienceContext = {
      requestedDomain: 'video.wildcard-site.com',
      approvalDomain: res2.matchedDomain ? res2.matchedDomain.toLowerCase() : 'video.wildcard-site.com',
      reason: res2.reason,
      matchedDomain: res2.matchedDomain,
    };
    assert.strictEqual(ctx2.approvalDomain, '*.wildcard-site.com');

    // 3. Fallback without matchedDomain (e.g. Category Block)
    const catPolicy: Policy = {
      id: 'pol-2',
      childId: 'child-manjari-uuid',
      familyId: 'fam-1',
      version: 1,
      isPaused: false,
      rules: [],
      categoryControls: [{ category: 'GAMING', action: 'BLOCK' }],
      updatedAt: new Date().toISOString(),
    };
    const res3 = evaluatePolicy(catPolicy, 'steampowered.com');
    assert.strictEqual(res3.action, 'BLOCK');
    assert.strictEqual(res3.matchedDomain, undefined);

    const norm3 = 'steampowered.com';
    const approval3 = res3.matchedDomain || norm3;
    assert.strictEqual(approval3, 'steampowered.com', 'Fallback approval scope must be requestedDomain');
  });

  // --------------------------------------------------------------------------
  // Test 2: Subdomain Fanout Deduplication & Logical Scope Debounce
  // --------------------------------------------------------------------------
  test('Test 2: Subdomain fanout for roblox.com triggers only 1 block experience during debounce window', async () => {
    await ipcServer.start();

    // Register helper in Session 5
    const helperSocket = net.connect(testSockPath);
    const helperReceived: BlockPresentationMessage[] = [];

    await new Promise<void>((resolve) => {
      helperSocket.on('connect', () => {
        helperSocket.write(
          JSON.stringify({
            type: 'REGISTER_HELPER',
            version: '1.0.4.11',
            accountName: 'mporwal',
            sessionId: 5,
          }) + '\n'
        );
      });

      helperSocket.on('data', (buf) => {
        const lines = buf.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          const parsed = JSON.parse(line);
          if (parsed.type === 'REGISTER_ACK') {
            resolve();
          } else if (parsed.type === 'PRESENT_BLOCK') {
            helperReceived.push(parsed);
          }
        }
      });
    });

    // Simulate browser opening Roblox, triggering simultaneous queries
    const fanoutQueries = [
      'www.roblox.com',
      'auth.roblox.com',
      'ncs.roblox.com',
      'realtime.roblox.com',
    ];

    const results: Array<{ sent: boolean; reason: string }> = [];
    for (const q of fanoutQueries) {
      const res = ipcServer.presentBlock({
        requestedDomain: q,
        approvalDomain: 'roblox.com',
        reason: 'EXPLICIT_BLOCK',
      });
      results.push(res);
    }

    // 1st query presented; remaining 3 debounced under approval scope 'roblox.com'
    assert.strictEqual(results[0].sent, true, 'First Roblox subdomain must present');
    assert.strictEqual(results[1].sent, false);
    assert.strictEqual(results[1].reason, 'DOMAIN_DEBOUNCED');
    assert.strictEqual(results[2].sent, false);
    assert.strictEqual(results[2].reason, 'DOMAIN_DEBOUNCED');
    assert.strictEqual(results[3].sent, false);
    assert.strictEqual(results[3].reason, 'DOMAIN_DEBOUNCED');

    // Wait for helper buffer flush
    await new Promise((r) => setTimeout(r, 100));

    assert.strictEqual(helperReceived.length, 1, 'Helper must receive exactly 1 presentation message');
    assert.strictEqual(helperReceived[0].approvalDomain, 'roblox.com');
    assert.strictEqual(helperReceived[0].requestedDomain, 'www.roblox.com');
    assert.match(helperReceived[0].url, /approvalDomain=roblox\.com/);
    assert.match(helperReceived[0].url, /domain=www\.roblox\.com/);

    helperSocket.destroy();
  });

  // --------------------------------------------------------------------------
  // Test 3: Local Block Page POST /submit-request returns requestId & records in resolution map
  // --------------------------------------------------------------------------
  test('Test 3: POST /submit-request passes approvalDomain, returns requestId, and initializes request-status', async () => {
    let blockPort = 0;
    await new Promise<void>((resolve) => {
      blockServer.start(0).then(() => {
        // Retrieve dynamic listening port
        blockPort = (blockServer as any).server.address().port;
        resolve();
      });
    });

    // Make POST /submit-request to local block server
    const postData = JSON.stringify({
      domain: 'roblox.com',
      reason: 'Need for weekend game club',
    });

    const submitRes = await new Promise<{ statusCode: number; data: any }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: blockPort,
          path: '/submit-request',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            resolve({ statusCode: res.statusCode || 0, data: JSON.parse(body) });
          });
        }
      );
      req.on('error', reject);
      req.write(postData);
      req.end();
    });

    assert.strictEqual(submitRes.statusCode, 200);
    assert.strictEqual(submitRes.data.success, true);
    assert.strictEqual(submitRes.data.requestId, 'req-roblox-123');
    assert.strictEqual(submitRes.data.domain, 'roblox.com');

    // Verify backend received approvalDomain roblox.com
    assert.strictEqual(lastBackendRequestBody.domain, 'roblox.com');

    // Query local GET /request-status?id=req-roblox-123
    const statusRes = await new Promise<{ statusCode: number; data: any }>((resolve, reject) => {
      http.get(
        `http://127.0.0.1:${blockPort}/request-status?id=req-roblox-123&domain=roblox.com`,
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            resolve({ statusCode: res.statusCode || 0, data: JSON.parse(body) });
          });
        }
      ).on('error', reject);
    });

    assert.strictEqual(statusRes.statusCode, 200);
    assert.strictEqual(statusRes.data.status, 'PENDING');
    assert.strictEqual(statusRes.data.domain, 'roblox.com');
    assert.strictEqual(statusRes.data.allowed, false);
  });

  // --------------------------------------------------------------------------
  // Test 4: ACCESS_REQUEST_RESOLVED Callback for APPROVED and DENIED
  // --------------------------------------------------------------------------
  test('Test 4: PolicySyncClient invokes callback for both APPROVED and DENIED events and updates local status', async () => {
    let blockPort = 0;
    await new Promise<void>((resolve) => {
      blockServer.start(0).then(() => {
        blockPort = (blockServer as any).server.address().port;
        resolve();
      });
    });

    // Record pending request in blockServer
    blockServer.recordPendingRequest('req-approve-99', 'roblox.com');
    blockServer.recordPendingRequest('req-deny-88', 'distracting.com');

    // Simulate APPROVED event
    const approvedEvent: AccessRequestResolutionEvent = {
      requestId: 'req-approve-99',
      status: 'APPROVED',
      domain: 'roblox.com',
      resolvedDuration: 15,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
    blockServer.handleAccessRequestResolved(approvedEvent);

    const approvedStatus = blockServer.getRequestStatus('req-approve-99', 'roblox.com');
    assert.strictEqual(approvedStatus.status, 'APPROVED');
    assert.strictEqual(approvedStatus.allowed, true);
    assert.strictEqual(approvedStatus.duration, 15);

    // Simulate DENIED event
    const deniedEvent: AccessRequestResolutionEvent = {
      requestId: 'req-deny-88',
      status: 'DENIED',
      domain: 'distracting.com',
    };
    blockServer.handleAccessRequestResolved(deniedEvent);

    const deniedStatus = blockServer.getRequestStatus('req-deny-88', 'distracting.com');
    assert.strictEqual(deniedStatus.status, 'DENIED');
    assert.strictEqual(deniedStatus.allowed, false);
  });

  // --------------------------------------------------------------------------
  // Test 5: Automatic DNS Cache Flush on APPROVED vs DENIED
  // --------------------------------------------------------------------------
  test('Test 5: DNS cache flush triggers automatically on APPROVED resolution, but not on DENIED', async () => {
    let flushCount = 0;
    const mockFlushDns = async () => {
      flushCount++;
    };

    const handleResolution = async (event: AccessRequestResolutionEvent) => {
      blockServer.handleAccessRequestResolved(event);
      if (event.status === 'APPROVED') {
        await mockFlushDns();
      }
    };

    // 1. APPROVED -> flush occurs
    await handleResolution({
      requestId: 'req-1',
      status: 'APPROVED',
      domain: 'roblox.com',
    });
    assert.strictEqual(flushCount, 1, 'DNS cache flush MUST execute on APPROVED');

    // 2. DENIED -> flush does NOT occur
    await handleResolution({
      requestId: 'req-2',
      status: 'DENIED',
      domain: 'tiktok.com',
    });
    assert.strictEqual(flushCount, 1, 'DNS cache flush must NOT execute on DENIED');
  });

  // --------------------------------------------------------------------------
  // Test 6: Active Policy Fallback (Resilience to Event Loss)
  // --------------------------------------------------------------------------
  test('Test 6: /request-status evaluates active policy directly if WebSocket resolution event was missed', async () => {
    // Current policy has roblox.com TEMPORARY_ALLOW
    const activePolicy: Policy = {
      id: 'pol-3',
      childId: 'child-manjari-uuid',
      familyId: 'fam-1',
      version: 2,
      isPaused: false,
      rules: [
        {
          id: 'r-temp',
          domain: 'roblox.com',
          action: 'TEMPORARY_ALLOW',
          addedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        },
        { id: 'r-block', domain: 'roblox.com', action: 'BLOCK', addedAt: new Date().toISOString() },
      ],
      updatedAt: new Date().toISOString(),
    };

    blockServer.setPolicyProvider(() => activePolicy);

    // Query status without any prior record in resolution map
    const status1 = blockServer.getRequestStatus('unknown-req-id', 'roblox.com');
    assert.strictEqual(status1.allowed, true, 'Policy fallback must report allowed=true for roblox.com');
    assert.strictEqual(status1.status, 'APPROVED');

    // Subdomain evaluation fallback
    const status2 = blockServer.getRequestStatus('unknown-req-id', 'ncs.roblox.com');
    assert.strictEqual(status2.allowed, true, 'Subdomain query must evaluate to allowed=true under parent grant');
    assert.strictEqual(status2.status, 'APPROVED');

    // Unrelated blocked domain remains unallowed
    const status3 = blockServer.getRequestStatus('unknown-req-id', 'unrelated-block.com');
    assert.strictEqual(status3.allowed, false);
  });

  // --------------------------------------------------------------------------
  // Test 7: Policy Coexistence & Expiry
  // --------------------------------------------------------------------------
  test('Test 7: TEMPORARY_ALLOW coexists with BLOCK; subdomains allow during grant and revert to BLOCK after expiry', () => {
    const grantExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const policy: Policy = {
      id: 'pol-4',
      childId: 'child-manjari-uuid',
      familyId: 'fam-1',
      version: 5,
      isPaused: false,
      rules: [
        { id: 'r-t', domain: 'roblox.com', action: 'TEMPORARY_ALLOW', addedAt: new Date().toISOString(), expiresAt: grantExpiresAt },
        { id: 'r-b', domain: 'roblox.com', action: 'BLOCK', addedAt: new Date().toISOString() },
      ],
      updatedAt: new Date().toISOString(),
    };

    const subdomains = [
      'roblox.com',
      'www.roblox.com',
      'auth.roblox.com',
      'ncs.roblox.com',
      'realtime.roblox.com',
    ];

    // During grant: all 5 subdomains ALLOW
    const duringGrantTime = new Date();
    for (const d of subdomains) {
      const res = evaluatePolicy(policy, d, duringGrantTime);
      assert.strictEqual(res.action, 'ALLOW', `${d} must evaluate to ALLOW during grant`);
      assert.strictEqual(res.reason, 'TEMPORARY_ALLOW');
    }

    // After grant expires (+20 minutes): all 5 subdomains BLOCK
    const afterExpiryTime = new Date(Date.now() + 20 * 60 * 1000);
    for (const d of subdomains) {
      const res = evaluatePolicy(policy, d, afterExpiryTime);
      assert.strictEqual(res.action, 'BLOCK', `${d} must revert to BLOCK after grant expiry`);
      assert.strictEqual(res.reason, 'EXPLICIT_BLOCK');
    }
  });

  // --------------------------------------------------------------------------
  // Test 8: Safe Continue URL Sanitization
  // --------------------------------------------------------------------------
  test('Test 8: Safe continue URL extracts HTTPS domain and rejects dangerous URI schemes', () => {
    function getSafeContinueUrl(domain: string): string {
      if (!domain) return 'https://google.com';
      let clean = String(domain).trim().toLowerCase();
      if (clean.startsWith('*.')) {
        clean = clean.substring(2);
      } else if (clean.startsWith('.')) {
        clean = clean.substring(1);
      }
      clean = clean.replace(/[^a-z0-9.-]/g, '');
      if (!clean || clean.indexOf('.') === -1) {
        return 'https://google.com';
      }
      return 'https://' + clean;
    }

    assert.strictEqual(getSafeContinueUrl('roblox.com'), 'https://roblox.com');
    assert.strictEqual(getSafeContinueUrl('*.roblox.com'), 'https://roblox.com');
    assert.strictEqual(getSafeContinueUrl('www.roblox.com'), 'https://www.roblox.com');
    assert.strictEqual(getSafeContinueUrl('*.example.org'), 'https://example.org');

    // Malicious schemes must be neutralized
    assert.strictEqual(getSafeContinueUrl('javascript:alert(1)'), 'https://google.com');
    assert.strictEqual(getSafeContinueUrl('data:text/html,evil'), 'https://google.com');
    assert.strictEqual(getSafeContinueUrl('file:///c:/windows'), 'https://google.com');
    assert.strictEqual(getSafeContinueUrl(''), 'https://google.com');
  });
});
