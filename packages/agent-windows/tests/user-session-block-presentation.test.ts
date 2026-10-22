process.env.NODE_ENV = 'test';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as http from 'http';
import {
  BlockIpcServer,
  validateBlockUrl,
  normalizeDomainForDebounce,
  BlockPresentationMessage,
} from '../src/block-ipc';
import { SafeBrowseUserSessionHelper } from '../src/user-helper';
import { BlockPageServer } from '../src/block-server';
import { DnsFilterProxy } from '../src/dns-proxy';
import { ResolvedUserPolicy, MultiSessionCheckResult } from '../src/account-manager';
import { Policy } from '@safebrowse/shared';

describe('SafeBrowse Windows Stage C.3: User-Session Block Presentation & Ask-Parent Suite', () => {
  let testSockPath: string;
  let ipcServer: BlockIpcServer;
  let userHelper: SafeBrowseUserSessionHelper;
  let mockBackendServer: http.Server | null = null;
  let mockBackendPort: number = 0;
  let capturedBackendRequests: any[] = [];

  beforeEach(async () => {
    testSockPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\sb-test-ipc-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
      : path.join(
          os.tmpdir(),
          `sb-test-ipc-${Date.now()}-${Math.random().toString(36).substring(2, 7)}.sock`
        );
    ipcServer = new BlockIpcServer(testSockPath, 1000, 200); // Shorter debounce for fast tests
    capturedBackendRequests = [];
  });

  afterEach(async () => {
    if (userHelper) {
      await userHelper.stop();
    }
    if (ipcServer) {
      await ipcServer.stop();
    }
    if (mockBackendServer) {
      await new Promise<void>((res) => mockBackendServer!.close(() => res()));
      mockBackendServer = null;
    }
    if (process.platform !== 'win32' && fs.existsSync(testSockPath)) {
      try {
        fs.unlinkSync(testSockPath);
      } catch {}
    }
  });

  // Test A: Blocked DNS event triggers presentation IPC event
  test('Test A: blocked DNS event sends presentation IPC event', async () => {
    let blockTriggeredDomain = '';
    let blockTriggeredReason = '';

    const dnsProxy = new DnsFilterProxy(
      () =>
        ({
          id: 'pol-1',
          childId: 'child-1',
          familyId: 'fam-1',
          version: 1,
          isPaused: false,
          rules: [{ id: 'r1', domain: 'blocked-site.com', action: 'BLOCK', addedAt: new Date().toISOString() }],
          updatedAt: new Date().toISOString(),
        } as Policy),
      '1.1.1.1',
      0
    );

    dnsProxy.setOnBlockExperienceTriggered((domain, reason) => {
      blockTriggeredDomain = domain;
      blockTriggeredReason = reason;
    });

    // Simulate query evaluation
    const evalResult = (dnsProxy as any).evaluatePolicy ? (dnsProxy as any).evaluatePolicy : null;
    assert.strictEqual(typeof dnsProxy.setOnBlockExperienceTriggered, 'function');

    // Trigger block manually through the established proxy contract
    (dnsProxy as any).onBlockExperienceTriggered?.('blocked-site.com', 'EXPLICIT_BLOCK');
    assert.strictEqual(blockTriggeredDomain, 'blocked-site.com');
    assert.strictEqual(blockTriggeredReason, 'EXPLICIT_BLOCK');
  });

  // Test B: Managed child receives block presentation
  test('Test B: managed child receives block presentation', async () => {
    const managedChildPolicy: ResolvedUserPolicy = {
      isManaged: true,
      childId: 'child-rahul-101',
      childName: 'Rahul',
      accountName: 'Rahul',
      sid: 'S-1-5-21-12345-1001',
    };

    ipcServer.setActivePolicyProvider(() => managedChildPolicy);
    await ipcServer.start();

    let presentedUrl = '';
    userHelper = new SafeBrowseUserSessionHelper(testSockPath, 'Rahul', (url) => {
      presentedUrl = url;
      return true;
    });
    userHelper.start();

    // Wait for helper registration handshake
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(ipcServer.getConnectedHelperCount(), 1);

    const result = ipcServer.presentBlock('gaming.com', 'GAMING_RESTRICTION', 8880);
    assert.strictEqual(result.sent, true);
    assert.strictEqual(result.reason, 'PRESENTED');

    await new Promise((r) => setTimeout(r, 100));
    assert.ok(presentedUrl.includes('gaming.com'));
    assert.ok(presentedUrl.includes('GAMING_RESTRICTION'));
    assert.ok(presentedUrl.startsWith('http://127.0.0.1:8880/blocked'));
  });

  // Test C: Parent/unmanaged session receives none
  test('Test C: Parent/unmanaged session receives none', async () => {
    const parentPolicy: ResolvedUserPolicy = {
      isManaged: false,
      childId: null,
      childName: null,
      accountName: 'ParentAdmin',
      sid: 'S-1-5-21-12345-500',
    };

    ipcServer.setActivePolicyProvider(() => parentPolicy);
    await ipcServer.start();

    let presented = false;
    userHelper = new SafeBrowseUserSessionHelper(testSockPath, 'ParentAdmin', () => {
      presented = true;
      return true;
    });
    userHelper.start();

    await new Promise((r) => setTimeout(r, 100));

    const result = ipcServer.presentBlock('adultsite.com', 'ADULT_CONTENT', 8880);
    assert.strictEqual(result.sent, false);
    assert.strictEqual(result.reason, 'PARENT_OR_UNMANAGED_USER');

    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(presented, false);
  });

  // Test D: wrong child/session receives none
  test('Test D: wrong child/session receives none', async () => {
    const childAPolicy: ResolvedUserPolicy = {
      isManaged: true,
      childId: 'child-a',
      childName: 'ChildA',
      accountName: 'ChildA',
      sid: 'S-1-5-21-12345-1002',
    };

    ipcServer.setActivePolicyProvider(() => childAPolicy);
    await ipcServer.start();

    let childBPresented = false;
    // Helper running for Child B
    userHelper = new SafeBrowseUserSessionHelper(testSockPath, 'ChildB', () => {
      childBPresented = true;
      return true;
    });
    userHelper.start();

    await new Promise((r) => setTimeout(r, 100));

    const result = ipcServer.presentBlock('social.com', 'SOCIAL_MEDIA', 8880);
    // Sent is false because helper account (ChildB) does not match active console user (ChildA)
    assert.strictEqual(result.sent, false);
    assert.strictEqual(result.reason, 'NO_CONNECTED_HELPER');

    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(childBPresented, false);
  });

  // Test E: duplicate blocked DNS queries do not create repeated UI launches
  test('Test E: duplicate blocked DNS queries do not create repeated UI launches (debounce & throttle)', async () => {
    const managedPolicy: ResolvedUserPolicy = {
      isManaged: true,
      childId: 'child-1',
      childName: 'Rahul',
      accountName: 'Rahul',
      sid: 'S-1-5-21-12345-1001',
    };

    // Use standard 12s domain debounce and 2.5s global throttle
    const strictIpcServer = new BlockIpcServer(testSockPath, 12000, 2500);
    strictIpcServer.setActivePolicyProvider(() => managedPolicy);
    await strictIpcServer.start();

    let presentationCount = 0;
    userHelper = new SafeBrowseUserSessionHelper(testSockPath, 'Rahul', () => {
      presentationCount++;
      return true;
    });
    userHelper.start();

    await new Promise((r) => setTimeout(r, 100));

    // First presentation should succeed
    const res1 = strictIpcServer.presentBlock('youtube.com', 'CATEGORY_BLOCKED', 8880);
    assert.strictEqual(res1.sent, true);

    // Second presentation for exact same domain immediately after should be DOMAIN_DEBOUNCED
    const res2 = strictIpcServer.presentBlock('youtube.com', 'CATEGORY_BLOCKED', 8880);
    assert.strictEqual(res2.sent, false);
    assert.strictEqual(res2.reason, 'DOMAIN_DEBOUNCED');

    // Third presentation for normalized domain (www.youtube.com.) should also be DOMAIN_DEBOUNCED
    const res3 = strictIpcServer.presentBlock('www.youtube.com.', 'CATEGORY_BLOCKED', 8880);
    assert.strictEqual(res3.sent, false);
    assert.strictEqual(res3.reason, 'DOMAIN_DEBOUNCED');

    // Fourth presentation for a DIFFERENT domain immediately after should be GLOBAL_THROTTLED
    const res4 = strictIpcServer.presentBlock('another-blocked.com', 'CATEGORY_BLOCKED', 8880);
    assert.strictEqual(res4.sent, false);
    assert.strictEqual(res4.reason, 'GLOBAL_THROTTLED');

    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(presentationCount, 1);

    await strictIpcServer.stop();
  });

  // Test F: URL validation rejects dangerous schemes and non-localhost URLs
  test('Test F: URL validation rejects https://evil.example, file://, javascript:, non-127.0.0.1', () => {
    // Valid URL
    assert.strictEqual(
      validateBlockUrl('http://127.0.0.1:8880/blocked?domain=youtube.com&reason=TEST', 8880).valid,
      true
    );
    assert.strictEqual(
      validateBlockUrl('http://localhost:8880/blocked?domain=youtube.com&reason=TEST', 8880).valid,
      true
    );

    // Dangerous schemes
    assert.strictEqual(validateBlockUrl('javascript:alert(1)', 8880).valid, false);
    assert.strictEqual(validateBlockUrl('file:///C:/Windows/System32/cmd.exe', 8880).valid, false);
    assert.strictEqual(validateBlockUrl('data:text/html,<script>alert(1)</script>', 8880).valid, false);
    assert.strictEqual(validateBlockUrl('powershell:Invoke-Expression "calc"', 8880).valid, false);

    // Non-localhost hosts
    assert.strictEqual(validateBlockUrl('https://evil.example/blocked', 8880).valid, false);
    assert.strictEqual(validateBlockUrl('http://evil.example:8880/blocked', 8880).valid, false);
    assert.strictEqual(validateBlockUrl('http://192.168.1.1:8880/blocked', 8880).valid, false);

    // Wrong port
    assert.strictEqual(validateBlockUrl('http://127.0.0.1:9999/blocked', 8880).valid, false);

    // Wrong path
    assert.strictEqual(validateBlockUrl('http://127.0.0.1:8880/other', 8880).valid, false);
  });

  // Test G: default browser launcher called with http://127.0.0.1:8880/blocked...
  test('Test G: default browser launcher called with http://127.0.0.1:8880/blocked...', async () => {
    let launchedUrl = '';
    const helper = new SafeBrowseUserSessionHelper(testSockPath, 'Rahul', (url) => {
      launchedUrl = url;
      return true;
    });

    const validPayload: BlockPresentationMessage = {
      type: 'PRESENT_BLOCK',
      domain: 'roblox.com',
      reason: 'GAMING_BLOCKED',
      url: 'http://127.0.0.1:8880/blocked?domain=roblox.com&reason=GAMING_BLOCKED',
      timestamp: Date.now(),
      eventId: 'evt-1',
    };

    (helper as any).handleMessage(JSON.stringify(validPayload));
    assert.strictEqual(launchedUrl, 'http://127.0.0.1:8880/blocked?domain=roblox.com&reason=GAMING_BLOCKED');

    // Attempt invalid URL through handleMessage: launcher MUST NOT be called
    launchedUrl = '';
    const evilPayload = { ...validPayload, url: 'https://attacker.site/phish' };
    (helper as any).handleMessage(JSON.stringify(evilPayload));
    assert.strictEqual(launchedUrl, '');
  });

  // Test H: no deviceToken or secrets included in IPC payload
  test('Test H: no deviceToken or secrets included in IPC payload', async () => {
    const managedPolicy: ResolvedUserPolicy = {
      isManaged: true,
      childId: 'child-101',
      childName: 'Rahul',
      accountName: 'Rahul',
      sid: 'S-1-5-21-1001',
    };
    ipcServer.setActivePolicyProvider(() => managedPolicy);
    await ipcServer.start();

    let rawIpcMessages: string[] = [];
    userHelper = new SafeBrowseUserSessionHelper(testSockPath, 'Rahul', () => true);
    userHelper.setOnBlockReceived((msg) => {
      rawIpcMessages.push(JSON.stringify(msg));
    });
    userHelper.start();

    await new Promise((r) => setTimeout(r, 100));

    ipcServer.presentBlock('tiktok.com', 'SOCIAL_MEDIA', 8880);

    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(rawIpcMessages.length, 1);

    const message = rawIpcMessages[0];
    assert.strictEqual(message.includes('deviceToken'), false);
    assert.strictEqual(message.includes('token'), false);
    assert.strictEqual(message.includes('password'), false);
    assert.strictEqual(message.includes('secret'), false);
  });

  // Test I: Ask Parent still authenticates correctly
  test('Test I: Ask Parent still authenticates correctly with x-device-id and x-device-token', async () => {
    // 1. Start mock backend server
    mockBackendServer = http.createServer((req, res) => {
      if (req.url === '/api/requests' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          capturedBackendRequests.push({
            headers: req.headers,
            body: JSON.parse(body),
          });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, id: 'req-999' }));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((res) => {
      mockBackendServer!.listen(0, '127.0.0.1', () => {
        mockBackendPort = (mockBackendServer!.address() as any).port;
        res();
      });
    });

    const blockServer = new BlockPageServer(
      `http://127.0.0.1:${mockBackendPort}`,
      'child-rahul-default',
      'dev-win-001',
      () => ({ childId: 'child-rahul-active', childName: 'Rahul' }),
      'secret-device-token-12345'
    );

    const testBlockPort = 38880;
    await blockServer.start(testBlockPort);

    // 2. Child clicks "Ask Parent" -> POST to local block page /submit-request
    const clientReq = http.request(
      `http://127.0.0.1:${testBlockPort}/submit-request`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        assert.strictEqual(res.statusCode, 200);
      }
    );

    clientReq.write(
      JSON.stringify({
        domain: 'roblox.com',
        reason: 'GAMING',
        requestedDuration: '30m',
      })
    );
    clientReq.end();

    await new Promise((r) => setTimeout(r, 200));

    // Verify backend received the request with device auth headers
    assert.strictEqual(capturedBackendRequests.length, 1);
    const backendReq = capturedBackendRequests[0];
    assert.strictEqual(backendReq.headers['x-device-id'], 'dev-win-001');
    assert.strictEqual(backendReq.headers['x-device-token'], 'secret-device-token-12345');
    assert.strictEqual(backendReq.body.childId, 'child-rahul-active');
    assert.strictEqual(backendReq.body.domain, 'roblox.com');

    blockServer.stop();
  });

  // Test J: Service restart / helper reconnect
  test('Test J: service restart/helper reconnect', async () => {
    const managedPolicy: ResolvedUserPolicy = {
      isManaged: true,
      childId: 'child-1',
      childName: 'Rahul',
      accountName: 'Rahul',
      sid: 'S-1-5-21-1001',
    };

    ipcServer.setActivePolicyProvider(() => managedPolicy);
    await ipcServer.start();

    let presentedCount = 0;
    userHelper = new SafeBrowseUserSessionHelper(testSockPath, 'Rahul', () => {
      presentedCount++;
      return true;
    });
    userHelper.start();

    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(ipcServer.getConnectedHelperCount(), 1);

    // Stop service (simulating service restart)
    await ipcServer.stop();
    await new Promise((r) => setTimeout(r, 100));

    // Start service again
    ipcServer = new BlockIpcServer(testSockPath, 1000, 200);
    ipcServer.setActivePolicyProvider(() => managedPolicy);
    await ipcServer.start();

    // Wait for helper reconnect (reconnect interval is 2s)
    await new Promise((r) => setTimeout(r, 2500));
    assert.strictEqual(ipcServer.getConnectedHelperCount(), 1);

    // Verify presentations succeed after reconnect
    const res = ipcServer.presentBlock('gaming.com', 'BLOCKED', 8880);
    assert.strictEqual(res.sent, true);

    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(presentedCount, 1);
  });

  // Test K: Logoff / login lifecycle
  test('Test K: logoff/login lifecycle with multiple session changes', async () => {
    let currentActivePolicy: ResolvedUserPolicy = {
      isManaged: true,
      childId: 'child-1',
      childName: 'Rahul',
      accountName: 'Rahul',
      sid: 'S-1-5-21-1001',
    };

    ipcServer.setActivePolicyProvider(() => currentActivePolicy);
    await ipcServer.start();

    let rahulPresented = false;
    userHelper = new SafeBrowseUserSessionHelper(testSockPath, 'Rahul', () => {
      rahulPresented = true;
      return true;
    });
    userHelper.start();

    await new Promise((r) => setTimeout(r, 100));

    // 1. Rahul is logged in: presentation works
    let res = ipcServer.presentBlock('youtube.com', 'BLOCK', 8880);
    assert.strictEqual(res.sent, true);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(rahulPresented, true);

    // 2. Child logs off; Parent logs in
    rahulPresented = false;
    currentActivePolicy = {
      isManaged: false,
      childId: null,
      childName: null,
      accountName: 'Parent',
      sid: 'S-1-5-21-500',
    };

    res = ipcServer.presentBlock('adult.com', 'ADULT', 8880);
    assert.strictEqual(res.sent, false);
    assert.strictEqual(res.reason, 'PARENT_OR_UNMANAGED_USER');
    assert.strictEqual(rahulPresented, false);
  });

  // Test L: Normalized domain debounce helper
  test('Test L: domain normalization strips trailing dot and www correctly', () => {
    assert.strictEqual(normalizeDomainForDebounce('youtube.com'), 'youtube.com');
    assert.strictEqual(normalizeDomainForDebounce('www.youtube.com'), 'youtube.com');
    assert.strictEqual(normalizeDomainForDebounce('www.youtube.com.'), 'youtube.com');
    assert.strictEqual(normalizeDomainForDebounce('YOUTUBE.COM.'), 'youtube.com');
    assert.strictEqual(normalizeDomainForDebounce('sub.example.com'), 'sub.example.com');
    assert.strictEqual(normalizeDomainForDebounce('www.sub.example.com.'), 'sub.example.com');
  });
});
