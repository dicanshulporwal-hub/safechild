import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { WebSocket } from 'ws';
import { app, bootstrap } from '../src/server';
import { prisma } from '../src/db/prisma';
import { nanoid } from 'nanoid';
import {
  validateTestDatabaseUrl,
  assertLiveTestDatabaseMarker,
} from '../src/utils/test-db-guard';
import { authService } from '../src/services/auth.service';
import { mailService } from '../src/services/mail.service';
import { familyService } from '../src/services/family.service';
import { childService } from '../src/services/child.service';
import { deviceService } from '../src/services/device.service';
import { resolveAllowedOrigins, createCorsOptions } from '../src/middleware/cors';
import { configureTrustProxy } from '../src/middleware/proxy';
import { ensureDemoAccounts } from '../src/services/seed.service';

describe('SafeBrowse Backend Hardening: CORS, Trust Proxy & Device Authentication Suite', () => {
  let server: http.Server;
  let baseUrl: string;
  let port: number;

  function getActivationToken(email: string): string {
    const mail = mailService.getOutbox().filter((m) => m.to.toLowerCase() === email.toLowerCase().trim()).pop();
    if (!mail || !mail.token) {
      throw new Error(`No activation token found in outbox for ${email}`);
    }
    return mail.token;
  }

  const testPassword = 'HardenedPassword2026!';
  let parentEmail: string;
  let parentUserId: string;
  let parentToken: string;
  let familyId: string;
  let childId: string;
  let deviceId: string;
  let deviceToken: string;

  before(async () => {
    const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://safebrowse:safebrowse_dev_password@127.0.0.1:5432/safebrowse_test';
    const dbConfig = validateTestDatabaseUrl(testDbUrl);
    await assertLiveTestDatabaseMarker(prisma, dbConfig.database);

    // Clean test tables
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "UserSession", "MfaChallenge", "AccessRequest", "ChildUsageRecord",
      "ActivityEvent", "Policy", "PairingCode", "Device", "Child", "FamilyInvitation",
      "FamilyAuditLog", "FamilyMember", "Family", "User" CASCADE;
    `);

    // Bootstrap Express server
    const rawServer = http.createServer(app);
    server = await bootstrap(app, rawServer, { port: 0, skipListen: false });
    const address = server.address() as any;
    port = address.port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Setup Parent, Family, Child, Device
    parentEmail = `parent-cors-${nanoid(6).toLowerCase()}@safebrowse.io`;
    const reg = await authService.register(parentEmail, testPassword, 'Hardening Parent');
    parentUserId = reg.user.id;
    await authService.activateAccount(getActivationToken(parentEmail));
    const login = await authService.login(parentEmail, testPassword);
    parentToken = login.token!;

    const family = await familyService.getOrCreateUserFamily(parentUserId);
    familyId = family.id;

    const childRes = await childService.createChild(parentUserId, 'Leo', 11, '👦', familyId);
    childId = childRes.child.id;

    const pairing = await deviceService.generatePairingCode(parentUserId, childId);
    const pairResult = await deviceService.pairDevice(
      pairing.code,
      "Leo's Windows Hardened Laptop",
      'windows',
      '1.1.0'
    );
    deviceId = pairResult.device.id;
    deviceToken = pairResult.device.deviceToken;
  });

  after(async () => {
    if (server && server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe('1. CORS Unit & Environment Resolution Tests', () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origCorsOrigins = process.env.CORS_ALLOWED_ORIGINS;
    const origAllowedOrigins = process.env.ALLOWED_ORIGINS;

    after(() => {
      process.env.NODE_ENV = origNodeEnv;
      if (origCorsOrigins !== undefined) process.env.CORS_ALLOWED_ORIGINS = origCorsOrigins;
      else delete process.env.CORS_ALLOWED_ORIGINS;
      if (origAllowedOrigins !== undefined) process.env.ALLOWED_ORIGINS = origAllowedOrigins;
      else delete process.env.ALLOWED_ORIGINS;
    });

    it('should default strictly to https://safebrowse.porwal.online in production mode', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.CORS_ALLOWED_ORIGINS;
      delete process.env.ALLOWED_ORIGINS;

      const origins = resolveAllowedOrigins();
      assert.deepStrictEqual(origins, ['https://safebrowse.porwal.online']);
    });

    it('should parse comma-separated CORS_ALLOWED_ORIGINS and strip trailing slashes', () => {
      process.env.CORS_ALLOWED_ORIGINS = 'https://safebrowse.porwal.online/, https://beta.safebrowse.io ';
      const origins = resolveAllowedOrigins();
      assert.deepStrictEqual(origins, ['https://safebrowse.porwal.online', 'https://beta.safebrowse.io']);
    });

    it('should fall back to ALLOWED_ORIGINS if CORS_ALLOWED_ORIGINS is absent', () => {
      delete process.env.CORS_ALLOWED_ORIGINS;
      process.env.ALLOWED_ORIGINS = 'https://legacy.safebrowse.io';
      const origins = resolveAllowedOrigins();
      assert.deepStrictEqual(origins, ['https://legacy.safebrowse.io']);
    });

    it('should include controlled localhost origins in development mode', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.CORS_ALLOWED_ORIGINS;
      delete process.env.ALLOWED_ORIGINS;

      const origins = resolveAllowedOrigins();
      assert.ok(origins.includes('https://safebrowse.porwal.online'));
      assert.ok(origins.includes('http://localhost:1001'));
      assert.ok(origins.includes('http://localhost:3000'));
      assert.ok(!origins.includes('*'), 'Must never contain wildcard in resolved origins');
    });

    it('createCorsOptions origin callback should allow undefined origin (non-browser clients)', (t, done) => {
      const options = createCorsOptions();
      const originFn = options.origin as Function;
      originFn(undefined, (err: any, allow: boolean) => {
        assert.strictEqual(err, null);
        assert.strictEqual(allow, true);
        done();
      });
    });

    it('createCorsOptions origin callback should reject unauthorized browser origin', (t, done) => {
      process.env.CORS_ALLOWED_ORIGINS = 'https://safebrowse.porwal.online';
      const options = createCorsOptions();
      const originFn = options.origin as Function;
      originFn('https://malicious-website.xyz', (err: any, allow: boolean) => {
        assert.strictEqual(err, null);
        assert.strictEqual(allow, false);
        done();
      });
    });

    it('createCorsOptions origin callback should accept authorized browser origin', (t, done) => {
      process.env.CORS_ALLOWED_ORIGINS = 'https://safebrowse.porwal.online';
      const options = createCorsOptions();
      const originFn = options.origin as Function;
      originFn('https://safebrowse.porwal.online', (err: any, allow: boolean) => {
        assert.strictEqual(err, null);
        assert.strictEqual(allow, true);
        done();
      });
    });
  });

  describe('2. HTTP Integration: Browser CORS Enforcement', () => {
    it('should return CORS allow headers for production origin https://safebrowse.porwal.online on GET /health', async () => {
      const res = await fetch(`${baseUrl}/health`, {
        headers: {
          Origin: 'https://safebrowse.porwal.online',
        },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://safebrowse.porwal.online');
      assert.strictEqual(res.headers.get('access-control-allow-credentials'), 'true');
    });

    it('should NOT return CORS allow headers for unauthorized origin https://evil-attacker.com on GET /health', async () => {
      const res = await fetch(`${baseUrl}/health`, {
        headers: {
          Origin: 'https://evil-attacker.com',
        },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('access-control-allow-origin'), null);
    });

    it('should respond to OPTIONS preflight for allowed origin with 204 and correct CORS headers', async () => {
      const res = await fetch(`${baseUrl}/api/devices/claim`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://safebrowse.porwal.online',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type, x-device-id, x-device-token',
        },
      });

      assert.strictEqual(res.status, 204);
      assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://safebrowse.porwal.online');
      assert.strictEqual(res.headers.get('access-control-allow-credentials'), 'true');
      assert.ok(res.headers.get('access-control-allow-methods')?.includes('POST'));
    });

    it('should NOT return CORS headers on OPTIONS preflight for unauthorized origin', async () => {
      const res = await fetch(`${baseUrl}/api/devices/claim`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://unauthorized-domain.com',
          'Access-Control-Request-Method': 'POST',
        },
      });

      assert.strictEqual(res.headers.get('access-control-allow-origin'), null);
    });

    it('should succeed without error on requests with NO Origin header (curl / desktop / mobile)', async () => {
      const res = await fetch(`${baseUrl}/health`);
      assert.strictEqual(res.status, 200);
      const json = await res.json();
      assert.strictEqual(json.status, 'healthy');
      assert.strictEqual(res.headers.get('access-control-allow-origin'), null);
    });
  });

  describe('3. Non-Browser Device API Compatibility (No Origin Header)', () => {
    it('should allow device claim with no Origin header', async () => {
      const res = await fetch(`${baseUrl}/api/devices/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'SB-NONEXIST-CODE', platform: 'windows' }),
      });
      // 400 is expected because code is invalid, proving endpoint is reached and not blocked by CORS
      assert.strictEqual(res.status, 400);
      const json = await res.json();
      assert.ok(json.error);
    });

    it('should reject unauthenticated heartbeat with 401 and succeed with valid credentials', async () => {
      // 1. Unauthenticated -> 401
      const failRes = await fetch(`${baseUrl}/api/devices/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activePolicyVersion: 1 }),
      });
      assert.strictEqual(failRes.status, 401);

      // 2. Authenticated -> 200
      const okRes = await fetch(`${baseUrl}/api/devices/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-device-id': deviceId,
          'x-device-token': deviceToken,
        },
        body: JSON.stringify({
          activePolicyVersion: 1,
          enforcementActive: true,
          platform: 'windows',
          agentVersion: '1.1.0',
        }),
      });
      assert.strictEqual(okRes.status, 200);
      const data = await okRes.json();
      assert.strictEqual(data.status, 'ok');
      assert.strictEqual(data.policyChanged, false);
    });

    it('should enforce device auth on policy sync GET /api/policies/device/:deviceId', async () => {
      // 1. Missing credentials -> 401
      const failRes = await fetch(`${baseUrl}/api/policies/device/${deviceId}`);
      assert.strictEqual(failRes.status, 401);

      // 2. Valid credentials -> 200
      const okRes = await fetch(`${baseUrl}/api/policies/device/${deviceId}`, {
        headers: {
          'x-device-id': deviceId,
          'x-device-token': deviceToken,
        },
      });
      assert.strictEqual(okRes.status, 200);
      const data = await okRes.json();
      assert.ok(data.policy);
    });

    it('should enforce device auth on POST /api/usage/session', async () => {
      // 1. Missing credentials -> 401
      const failRes = await fetch(`${baseUrl}/api/usage/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appName: 'chrome.exe', durationSeconds: 60 }),
      });
      assert.strictEqual(failRes.status, 401);

      // 2. Valid credentials -> 200
      const okRes = await fetch(`${baseUrl}/api/usage/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-device-id': deviceId,
          'x-device-token': deviceToken,
        },
        body: JSON.stringify({
          appName: 'chrome.exe',
          durationSeconds: 120,
        }),
      });
      assert.strictEqual(okRes.status, 200);
      const data = await okRes.json();
      assert.ok(data.consumedSeconds !== undefined);
    });

    it('should enforce device auth on POST /api/requests (Ask Parent)', async () => {
      // 1. Missing credentials -> 401
      const failRes = await fetch(`${baseUrl}/api/requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'gaming.com', reason: 'Play with friends' }),
      });
      assert.strictEqual(failRes.status, 401);

      // 2. Valid credentials -> 200
      const okRes = await fetch(`${baseUrl}/api/requests`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-device-id': deviceId,
          'x-device-token': deviceToken,
        },
        body: JSON.stringify({
          domain: 'roblox.com',
          reason: 'Weekend game time',
        }),
      });
      assert.strictEqual(okRes.status, 200);
      const req = await okRes.json();
      assert.strictEqual(req.domain, 'roblox.com');
      assert.strictEqual(req.deviceId, deviceId);
    });
  });

  describe('4. Express Trust Proxy Configuration & Anti-Spoofing', () => {
    it('should configure trust proxy safely based on environment', () => {
      const mockApp = {
        settings: {} as Record<string, any>,
        set(key: string, val: any) {
          this.settings[key] = val;
        },
      } as any;

      // 1. Default in production: 'loopback, uniquelocal'
      const origEnv = process.env.NODE_ENV;
      const origTrust = process.env.TRUST_PROXY;
      try {
        process.env.NODE_ENV = 'production';
        delete process.env.TRUST_PROXY;
        configureTrustProxy(mockApp);
        assert.strictEqual(mockApp.settings['trust proxy'], 'loopback, uniquelocal');

        // 2. Explicit hop count
        process.env.TRUST_PROXY = '2';
        configureTrustProxy(mockApp);
        assert.strictEqual(mockApp.settings['trust proxy'], 2);

        // 3. Explicit disabled
        process.env.TRUST_PROXY = 'false';
        configureTrustProxy(mockApp);
        assert.strictEqual(mockApp.settings['trust proxy'], false);

        // 4. Default in development: false
        process.env.NODE_ENV = 'development';
        delete process.env.TRUST_PROXY;
        configureTrustProxy(mockApp);
        assert.strictEqual(mockApp.settings['trust proxy'], false);
      } finally {
        process.env.NODE_ENV = origEnv;
        if (origTrust !== undefined) process.env.TRUST_PROXY = origTrust;
        else delete process.env.TRUST_PROXY;
      }
    });

    it('should correctly peel trusted VM1 and VM2 proxy hops and reject spoofed headers', async () => {
      // Create a test app with trust proxy set to 'loopback, uniquelocal'
      const express = require('express');
      const testApp = express();
      testApp.set('trust proxy', 'loopback, uniquelocal');
      testApp.get('/ip-audit', (req: any, res: any) => {
        res.json({
          ip: req.ip,
          ips: req.ips,
          protocol: req.protocol,
          secure: req.secure,
        });
      });

      const srv = testApp.listen(0);
      const testPort = srv.address().port;

      try {
        // Case A: Real client 203.0.113.88 routed through VM1 (192.168.1.4) and VM2 (127.0.0.1)
        const resA = await fetch(`http://127.0.0.1:${testPort}/ip-audit`, {
          headers: {
            'x-forwarded-for': '203.0.113.88, 192.168.1.4',
            'x-forwarded-proto': 'https',
          },
        });
        const dataA = await resA.json();
        assert.strictEqual(dataA.ip, '203.0.113.88');
        assert.strictEqual(dataA.protocol, 'https');
        assert.strictEqual(dataA.secure, true);

        // Case B: Attacker attempts to spoof 10.0.0.1 or 8.8.8.8 ahead of real client 203.0.113.88
        const resB = await fetch(`http://127.0.0.1:${testPort}/ip-audit`, {
          headers: {
            'x-forwarded-for': '8.8.8.8, 203.0.113.88, 192.168.1.4',
            'x-forwarded-proto': 'https',
          },
        });
        const dataB = await resB.json();
        // Since 203.0.113.88 is not in loopback or uniquelocal, proxy peeling stops at 203.0.113.88
        // and does NOT trust 8.8.8.8!
        assert.strictEqual(dataB.ip, '203.0.113.88');
      } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
      }
    });
  });

  describe('5. WebSocket Device & Parent Authentication Compatibility', () => {
    it('should authenticate device connection via WebSocket query parameters', async () => {
      const wsUrl = `ws://127.0.0.1:${port}/ws?deviceId=${encodeURIComponent(deviceId)}&deviceToken=${encodeURIComponent(deviceToken)}`;
      const ws = new WebSocket(wsUrl);

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          ws.close();
          resolve();
        });
        ws.on('error', reject);
      });
    });

    it('should authenticate parent connection via WebSocket query token', async () => {
      const wsUrl = `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(parentToken)}`;
      const ws = new WebSocket(wsUrl);

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          ws.close();
          resolve();
        });
        ws.on('error', reject);
      });
    });
  });

  describe('6. Production Demo Account Seeding Suppression', () => {
    it('should not seed demo accounts when ENABLE_DEMO_DATA=false or NODE_ENV=production', async () => {
      const origDemo = process.env.ENABLE_DEMO_DATA;
      const origEnv = process.env.NODE_ENV;

      try {
        process.env.ENABLE_DEMO_DATA = 'false';
        process.env.NODE_ENV = 'production';

        await ensureDemoAccounts();

        // Check that demo parent was NOT created by this call
        const demoParent = await prisma.user.findUnique({
          where: { email: 'parent@safebrowse.io' },
        });
        assert.strictEqual(demoParent, null, 'Demo parent must not be seeded when ENABLE_DEMO_DATA=false');
      } finally {
        if (origDemo !== undefined) process.env.ENABLE_DEMO_DATA = origDemo;
        else delete process.env.ENABLE_DEMO_DATA;
        process.env.NODE_ENV = origEnv;
      }
    });
  });
});
