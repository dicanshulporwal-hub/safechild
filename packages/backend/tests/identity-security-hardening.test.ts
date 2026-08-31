import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { authService, getJwtSecret } from '../src/services/auth.service';
import { profileService } from '../src/services/profile.service';
import { deviceService } from '../src/services/device.service';
import { childService } from '../src/services/child.service';
import { db } from '../src/db/store';
import {
  decryptMfaSecret,
  encryptMfaSecret,
  verifyTotpToken,
  generateBase32Secret,
  hashToken,
  generateCurrentTotp,
  generateTotpAtStep,
  getCurrentTotpTimeStep,
} from '../src/utils/security';
import {
  ProductionMailAdapter,
  DevelopmentMailAdapter,
  MockMailAdapter,
  MailDeliveryError,
  mailService,
} from '../src/services/mail.service';
import { app } from '../src/server';
import http from 'http';

let testServer: http.Server;
let testPort: number = 0;

function makeRequest(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: any
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: testPort,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        let respBody = '';
        res.on('data', (chunk) => {
          respBody += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = respBody ? JSON.parse(respBody) : {};
            resolve({ status: res.statusCode || 500, body: parsed });
          } catch {
            resolve({ status: res.statusCode || 500, body: respBody });
          }
        });
      }
    );
    req.on('error', reject);
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

describe('SafeBrowse Stage 11 Step 2: Authentication, Sessions & MFA Hardening Suite', () => {
  let testEmail: string;
  let testPass: string;
  let userId: string;
  let accessToken: string;
  let refreshToken: string;
  let sessionId: string;
  let testChildId: string;
  let testDeviceId: string;
  let testDeviceToken: string;

  before(async () => {
    // Start ephemeral test HTTP server
    await new Promise<void>((resolve) => {
      testServer = http.createServer(app);
      testServer.listen(0, '127.0.0.1', () => {
        testPort = (testServer.address() as any).port;
        resolve();
      });
    });

    testEmail = `parent-${nanoid(8)}@safebrowse.io`;
    testPass = 'StrongPassphrase2026!IdentitySuite';
    const reg = authService.register(testEmail, testPass, 'Test Parent');
    userId = reg.user.id;
    accessToken = reg.accessToken;
    refreshToken = reg.refreshToken;
    const decoded = authService.verifyToken(accessToken);
    sessionId = decoded.sessionId!;

    // Create child and paired device for device auth tests
    const { child } = childService.createChild(userId, 'Leo', 8, '🧒');
    testChildId = child.id;

    const pairing = deviceService.generatePairingCode(userId, testChildId);
    const { device } = deviceService.pairDevice(pairing.code, 'Leo Windows', 'windows', '1.0.0');
    testDeviceId = device.id;
    testDeviceToken = device.deviceToken;
  });

  after(() => {
    if (testServer) {
      testServer.close();
    }
  });

  describe('A. JWT & Mandatory Session Claims Validation', () => {
    it('1. should reject signed JWT forged with legacy fallback secrets', () => {
      const legacySecret = 'safebrowse-secret-key-2026';
      const forgedToken = jwt.sign(
        { userId, sessionId, tokenVersion: 1, jti: `at_${nanoid(16)}` },
        legacySecret,
        { algorithm: 'HS256', issuer: 'safebrowse-auth', audience: 'safebrowse-client', subject: userId }
      );

      assert.throws(() => {
        authService.verifyToken(forgedToken);
      }, /invalid signature|Invalid or expired token/);
    });

    it('2. should reject validly signed JWT without an active session in store', () => {
      const ghostSessionId = `sess_${nanoid(16)}`;
      const tokenWithoutSession = jwt.sign(
        { userId, sessionId: ghostSessionId, tokenVersion: 1, jti: `at_${nanoid(16)}` },
        getJwtSecret(),
        { algorithm: 'HS256', issuer: 'safebrowse-auth', audience: 'safebrowse-client', subject: userId }
      );

      assert.throws(() => {
        authService.verifyToken(tokenWithoutSession);
      }, /Session does not exist/);
    });

    it('2a. should reject validly signed JWT with omitted sessionId', () => {
      const sessionlessToken = jwt.sign(
        { userId, tokenVersion: 1, jti: `at_${nanoid(16)}` },
        getJwtSecret(),
        { algorithm: 'HS256', issuer: 'safebrowse-auth', audience: 'safebrowse-client', subject: userId }
      );

      assert.throws(() => {
        authService.verifyToken(sessionlessToken);
      }, /sessionId missing or empty/);
    });

    it('2b. should reject validly signed JWT with empty string sessionId', () => {
      const emptySessionToken = jwt.sign(
        { userId, sessionId: '   ', tokenVersion: 1, jti: `at_${nanoid(16)}` },
        getJwtSecret(),
        { algorithm: 'HS256', issuer: 'safebrowse-auth', audience: 'safebrowse-client', subject: userId }
      );

      assert.throws(() => {
        authService.verifyToken(emptySessionToken);
      }, /sessionId missing or empty/);
    });

    it('2c. should reject validly signed JWT with omitted tokenVersion claim', () => {
      const noVersionToken = jwt.sign(
        { userId, sessionId, jti: `at_${nanoid(16)}` },
        getJwtSecret(),
        { algorithm: 'HS256', issuer: 'safebrowse-auth', audience: 'safebrowse-client', subject: userId }
      );

      assert.throws(() => {
        authService.verifyToken(noVersionToken);
      }, /tokenVersion missing/);
    });

    it('2d. should reject validly signed JWT with missing or blank sub claim', () => {
      const missingSubToken = jwt.sign(
        { userId, sessionId, tokenVersion: 1, jti: `at_${nanoid(16)}` },
        getJwtSecret(),
        { algorithm: 'HS256', issuer: 'safebrowse-auth', audience: 'safebrowse-client' }
      );

      assert.throws(() => {
        authService.verifyToken(missingSubToken);
      }, /sub missing or empty/);

      const blankSubToken = jwt.sign(
        { userId, sessionId, tokenVersion: 1, jti: `at_${nanoid(16)}`, sub: '   ' },
        getJwtSecret(),
        { algorithm: 'HS256', issuer: 'safebrowse-auth', audience: 'safebrowse-client' }
      );

      assert.throws(() => {
        authService.verifyToken(blankSubToken);
      }, /sub missing or empty/);
    });

    it('2e. should reject validly signed JWT with mismatched subject (sub !== userId)', () => {
      const otherUserId = `usr_${nanoid(10)}`;
      const mismatchToken = jwt.sign(
        { userId, sessionId, tokenVersion: 1, jti: `at_${nanoid(16)}` },
        getJwtSecret(),
        { algorithm: 'HS256', issuer: 'safebrowse-auth', audience: 'safebrowse-client', subject: otherUserId }
      );

      assert.throws(() => {
        authService.verifyToken(mismatchToken);
      }, /subject mismatch/);
    });

    it('2f. should reject validly signed JWT with missing or blank jti claim', () => {
      const missingJtiToken = jwt.sign(
        { userId, sessionId, tokenVersion: 1 },
        getJwtSecret(),
        { algorithm: 'HS256', issuer: 'safebrowse-auth', audience: 'safebrowse-client', subject: userId }
      );

      assert.throws(() => {
        authService.verifyToken(missingJtiToken);
      }, /jti missing or empty/);

      const blankJtiToken = jwt.sign(
        { userId, sessionId, tokenVersion: 1, jti: '  ' },
        getJwtSecret(),
        { algorithm: 'HS256', issuer: 'safebrowse-auth', audience: 'safebrowse-client', subject: userId }
      );

      assert.throws(() => {
        authService.verifyToken(blankJtiToken);
      }, /jti missing or empty/);
    });

    it('2g. should reject validly signed JWT pointing to a session belonging to another user', () => {
      const otherReg = authService.register(`other-${nanoid(8)}@test.io`, testPass, 'Other Parent');
      const otherSessionId = authService.verifyToken(otherReg.accessToken).sessionId;

      const spoofToken = jwt.sign(
        { userId, sessionId: otherSessionId, tokenVersion: 1, jti: `at_${nanoid(16)}` },
        getJwtSecret(),
        { algorithm: 'HS256', issuer: 'safebrowse-auth', audience: 'safebrowse-client', subject: userId }
      );

      assert.throws(() => {
        authService.verifyToken(spoofToken);
      }, /Session ownership mismatch/);
    });

    it('3. should reject validly signed JWT when session is revoked or expired', () => {
      const dummySession = db.userSessions.get(sessionId)!;
      dummySession.isRevoked = true;
      db.userSessions.set(sessionId, dummySession);

      assert.throws(() => {
        authService.verifyToken(accessToken);
      }, /Session has been revoked/);

      // Restore session
      dummySession.isRevoked = false;
      db.userSessions.set(sessionId, dummySession);
    });

    it('4. should rotate refresh tokens atomically on valid refresh call', () => {
      const oldHash = hashToken(refreshToken);
      const res = authService.refreshSession(refreshToken, 'Firefox / Windows', '127.0.0.1');

      assert.ok(res.accessToken);
      assert.ok(res.refreshToken);
      assert.notStrictEqual(res.refreshToken, refreshToken);

      const session = db.userSessions.get(sessionId)!;
      assert.strictEqual(session.refreshTokenHash, hashToken(res.refreshToken));
      assert.notStrictEqual(session.refreshTokenHash, oldHash);

      refreshToken = res.refreshToken;
      accessToken = res.accessToken;
    });

    it('5. should detect refresh token replay, reject request, and revoke token family', () => {
      const s1 = authService.createSession(userId, 'Device 1');
      const token1 = s1.refreshToken;

      const rot = authService.refreshSession(token1, 'Device 1');
      const token2 = rot.refreshToken;
      assert.notStrictEqual(token1, token2);

      const s2 = authService.createSession(userId, 'Device 2', undefined, s1.session.sessionFamilyId);
      assert.strictEqual(s2.session.isRevoked, false);

      assert.throws(() => {
        authService.refreshSession(token1);
      }, /Invalid, expired or revoked refresh token/);

      const siblingSession = db.userSessions.get(s2.session.id)!;
      assert.strictEqual(siblingSession.isRevoked, true);
    });

    it('6. should ensure session list API never returns tokens, hashes, or MFA secrets', () => {
      const sessions = profileService.getSessions(userId, sessionId);
      assert.ok(sessions.length > 0);

      for (const s of sessions) {
        assert.strictEqual((s as any).accessToken, undefined);
        assert.strictEqual((s as any).refreshToken, undefined);
        assert.strictEqual((s as any).refreshTokenHash, undefined);
        assert.strictEqual((s as any).token, undefined);
        assert.strictEqual((s as any).mfaSecret, undefined);
        assert.strictEqual((s as any).mfaRecoveryCodes, undefined);
        assert.ok(s.id);
        assert.ok(s.deviceInfo);
      }
    });
  });

  describe('B. MFA Enrollment, TOTP Verification & Anti-Replay', () => {
    let mfaSecretBase32: string;

    it('7. should generate 160-bit Base32 secret and local QR data URI during setup', async () => {
      const setup = await profileService.setupMfa(userId);
      assert.ok(setup.secret);
      assert.ok(setup.otpAuthUrl.startsWith('otpauth://totp/'));
      assert.ok(setup.qrDataUrl.startsWith('data:image/png;base64,'));
      mfaSecretBase32 = setup.secret;

      const user = db.users.get(userId)!;
      assert.strictEqual(user.mfaEnabled, false);
      assert.ok(user.pendingMfaSecret);
      assert.strictEqual(user.mfaSecret, undefined);
    });

    it('8. should strictly reject invalid codes during MFA activation', () => {
      assert.throws(() => {
        profileService.verifyAndEnableMfa(userId, '000000');
      }, /Invalid MFA verification code/);
    });

    it('9. should verify valid current TOTP, enable MFA, and generate 8 recovery codes', () => {
      const currentTotp = generateCurrentTotp(mfaSecretBase32);
      const result = profileService.verifyAndEnableMfa(userId, currentTotp);

      assert.ok(result.recoveryCodes);
      assert.strictEqual(result.recoveryCodes.length, 8);
      for (const code of result.recoveryCodes) {
        assert.match(code, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
      }

      const user = db.users.get(userId)!;
      assert.strictEqual(user.mfaEnabled, true);
      assert.strictEqual(user.pendingMfaSecret, undefined);
      assert.ok(user.mfaSecret);
    });

    it('10. should accurately verify TOTP timestep with tolerance window and return acceptedTimeStep', () => {
      const secret = generateBase32Secret();
      const baseTime = 1700000000; // Controlled fake timestamp
      const baseStep = getCurrentTotpTimeStep(baseTime);

      const codeStep0 = generateTotpAtStep(secret, baseStep);
      const codeStepMinus1 = generateTotpAtStep(secret, baseStep - 1);
      const codeStepPlus1 = generateTotpAtStep(secret, baseStep + 1);
      const codeStepFarAway = generateTotpAtStep(secret, baseStep + 5);

      // Current step
      const r0 = verifyTotpToken(secret, codeStep0, baseTime);
      assert.strictEqual(r0.valid, true);
      assert.strictEqual(r0.acceptedTimeStep, baseStep);

      // -1 tolerance window
      const rMinus1 = verifyTotpToken(secret, codeStepMinus1, baseTime);
      assert.strictEqual(rMinus1.valid, true);
      assert.strictEqual(rMinus1.acceptedTimeStep, baseStep - 1);

      // +1 tolerance window
      const rPlus1 = verifyTotpToken(secret, codeStepPlus1, baseTime);
      assert.strictEqual(rPlus1.valid, true);
      assert.strictEqual(rPlus1.acceptedTimeStep, baseStep + 1);

      // Outside tolerance window
      const rFar = verifyTotpToken(secret, codeStepFarAway, baseTime);
      assert.strictEqual(rFar.valid, false);
      assert.strictEqual(rFar.acceptedTimeStep, undefined);
    });

    it('11. should verify 30-second boundary transitions using controlled timestamps without waiting', () => {
      const secret = generateBase32Secret();
      // Test across exact 30s boundary: step K = 50000000 -> boundary at 50000000 * 30 = 1500000000
      const boundaryTime = 1500000000;
      const tBefore = boundaryTime - 1; // 1499999999 (step 49999999)
      const tAfter = boundaryTime;      // 1500000000 (step 50000000)
      const stepBefore = getCurrentTotpTimeStep(tBefore);
      const stepAfter = getCurrentTotpTimeStep(tAfter);

      assert.strictEqual(stepAfter, stepBefore + 1);

      const codeBefore = generateTotpAtStep(secret, stepBefore);
      const codeAfter = generateTotpAtStep(secret, stepAfter);

      // Code generated before boundary is valid at tAfter via -1 tolerance
      const resOldAtNewTime = verifyTotpToken(secret, codeBefore, tAfter);
      assert.strictEqual(resOldAtNewTime.valid, true);
      assert.strictEqual(resOldAtNewTime.acceptedTimeStep, stepBefore);

      // Code for new step is valid at tAfter
      const resNewAtNewTime = verifyTotpToken(secret, codeAfter, tAfter);
      assert.strictEqual(resNewAtNewTime.valid, true);
      assert.strictEqual(resNewAtNewTime.acceptedTimeStep, stepAfter);
    });
  });

  describe('C. MFA Login Challenge & Recovery Codes Flow', () => {
    let mfaTicket: string;

    it('12. should return MFA challenge ticket and withhold access tokens on login', () => {
      const res = authService.login(testEmail, testPass);
      assert.strictEqual(res.mfaRequired, true);
      assert.ok(res.mfaTicket);
      assert.strictEqual(res.accessToken, undefined);
      mfaTicket = res.mfaTicket!;
    });

    it('13. should reject MFA ticket missing jti claim', () => {
      const forgedTicketNoJti = jwt.sign(
        { userId, purpose: 'mfa_challenge', ticketId: `tkt_${nanoid(16)}` },
        getJwtSecret(),
        { algorithm: 'HS256', issuer: 'safebrowse-auth', audience: 'safebrowse-mfa' }
      );

      assert.throws(() => {
        authService.verifyMfaLogin(forgedTicketNoJti, '123456');
      }, /missing jti/);
    });

    it('14. should complete login with valid TOTP code and return authenticated tokens', () => {
      const user = db.users.get(userId)!;
      const decryptedSecret = decryptMfaSecret(user.mfaSecret!);
      const validTotp = generateCurrentTotp(decryptedSecret);

      const res = authService.verifyMfaLogin(mfaTicket, validTotp);
      assert.ok(res.accessToken);
      assert.ok(res.refreshToken);
      assert.ok(res.user);
      assert.strictEqual(res.user.id, userId);
    });

    it('15. should reject reuse of single-use challenge ticket', () => {
      const user = db.users.get(userId)!;
      const decryptedSecret = decryptMfaSecret(user.mfaSecret!);
      const validTotp = generateCurrentTotp(decryptedSecret);

      assert.throws(() => {
        authService.verifyMfaLogin(mfaTicket, validTotp);
      }, /ticket has already been used/);
    });

    it('16. should reject immediate TOTP timestep replay for same purpose (mfa_login)', () => {
      const login2 = authService.login(testEmail, testPass);
      const user = db.users.get(userId)!;
      const decryptedSecret = decryptMfaSecret(user.mfaSecret!);
      const validTotp = generateCurrentTotp(decryptedSecret);

      assert.throws(() => {
        authService.verifyMfaLogin(login2.mfaTicket!, validTotp);
      }, /This TOTP code has already been used/);
    });

    it('17. should support emergency single-use recovery code and atomically consume it', () => {
      const userBefore = db.users.get(userId)!;
      const initialCodeCount = userBefore.mfaRecoveryCodes!.length;
      assert.ok(initialCodeCount > 0);

      // Generate a known recovery code
      const rawRecoveryCode = 'AAAA-BBBB';
      userBefore.mfaRecoveryCodes!.push(bcrypt.hashSync(rawRecoveryCode, 12));
      db.users.set(userId, userBefore);

      const login = authService.login(testEmail, testPass);
      const res = authService.verifyMfaLogin(login.mfaTicket!, rawRecoveryCode);
      assert.ok(res.accessToken);

      // Verify code was consumed
      const userAfter = db.users.get(userId)!;
      assert.strictEqual(userAfter.mfaRecoveryCodes!.length, initialCodeCount);

      // Attempt reuse of consumed recovery code
      const loginRetry = authService.login(testEmail, testPass);
      assert.throws(() => {
        authService.verifyMfaLogin(loginRetry.mfaTicket!, rawRecoveryCode);
      }, /Invalid MFA verification code or recovery code/);
    });
  });

  describe('D. Step-Up Authentication & Mandatory Parameter Enforcement', () => {
    it('18. should strictly fail recovery-code regeneration when password or OTP is missing', () => {
      assert.throws(() => {
        profileService.regenerateRecoveryCodes(userId, '');
      }, /Current password is required/);

      assert.throws(() => {
        profileService.regenerateRecoveryCodes(userId, testPass, '');
      }, /MFA verification code is required/);

      assert.throws(() => {
        profileService.regenerateRecoveryCodes(userId, 'WrongPass', '123456');
      }, /Incorrect password/);
    });

    it('19. should require step-up authentication (password + OTP) to disable MFA', () => {
      assert.throws(() => {
        profileService.disableMfa(userId, 'WrongPass', '123456');
      }, /Incorrect password/);

      const user = db.users.get(userId)!;
      const decryptedSecret = decryptMfaSecret(user.mfaSecret!);
      // Generate TOTP at an advance timestep to prevent timestep replay conflict
      const futureTime = Math.floor(Date.now() / 1000) + 120;
      const futureTotp = generateCurrentTotp(decryptedSecret, futureTime);

      profileService.disableMfa(userId, testPass, futureTotp, futureTime);

      const userDisabled = db.users.get(userId)!;
      assert.strictEqual(userDisabled.mfaEnabled, false);
      assert.strictEqual(userDisabled.mfaSecret, undefined);
    });
  });

  describe('E. Separate Parent & Device Route Authentication', () => {
    let unverifiedToken: string;
    let verifiedToken: string;

    before(() => {
      const u1 = authService.register(`unver-${nanoid(6)}@safebrowse.io`, testPass, 'Unverified');
      unverifiedToken = u1.accessToken;

      const u2 = authService.register(`ver-${nanoid(6)}@safebrowse.io`, testPass, 'Verified');
      authService.verifyEmail(u2.emailVerificationToken);
      verifiedToken = u2.accessToken;
    });

    it('20. should block unverified parent from accessing parent operations (403 EMAIL_VERIFICATION_REQUIRED)', async () => {
      const res = await makeRequest('GET', '/api/children', {
        Authorization: `Bearer ${unverifiedToken}`,
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.code, 'EMAIL_VERIFICATION_REQUIRED');
    });

    it('21. should allow verified parent to access owned parent resources (200 OK)', async () => {
      const res = await makeRequest('GET', '/api/children', {
        Authorization: `Bearer ${verifiedToken}`,
      });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });

    it('22. should reject device endpoint when no device token is provided (401)', async () => {
      const res = await makeRequest('POST', '/api/activity', {}, {
        deviceId: testDeviceId,
        domain: 'wikipedia.org',
        action: 'ALLOW',
      });
      assert.strictEqual(res.status, 401);
      assert.match(res.body.error, /deviceToken is required/i);
    });

    it('23. should reject device endpoint when wrong device token is provided (401)', async () => {
      const res = await makeRequest(
        'POST',
        '/api/activity',
        { 'x-device-id': testDeviceId, 'x-device-token': 'dtk_wrong_invalid_token' },
        { domain: 'wikipedia.org', action: 'ALLOW' }
      );
      assert.strictEqual(res.status, 401);
      assert.match(res.body.error, /Invalid device token/i);
    });

    it('24. should reject parent JWT token when supplied to device endpoint (401)', async () => {
      const res = await makeRequest(
        'POST',
        '/api/activity',
        {
          Authorization: `Bearer ${verifiedToken}`,
          'x-device-id': testDeviceId,
        },
        { domain: 'wikipedia.org', action: 'ALLOW' }
      );
      assert.strictEqual(res.status, 401);
      assert.match(res.body.error, /Parent tokens are not accepted/i);
    });

    it('25. should allow valid paired device to submit activity and usage sync', async () => {
      const actRes = await makeRequest(
        'POST',
        '/api/activity',
        {
          'x-device-id': testDeviceId,
          'x-device-token': testDeviceToken,
        },
        { domain: 'khanacademy.org', action: 'ALLOW' }
      );
      assert.strictEqual(actRes.status, 200);
      assert.strictEqual(actRes.body.domain, 'khanacademy.org');

      const usageRes = await makeRequest(
        'POST',
        '/api/usage/sync',
        {
          'x-device-id': testDeviceId,
          'x-device-token': testDeviceToken,
        },
        {
          target: 'khanacademy.org',
          targetType: 'DOMAIN',
          secondsIncrement: 60,
        }
      );
      assert.strictEqual(usageRes.status, 200);
      assert.strictEqual(usageRes.body.consumedSeconds, 60);
    });

    it('26. should reject device submitting for another child profile (403)', async () => {
      const otherChildId = `ch_${nanoid(10)}`;
      const res = await makeRequest(
        'POST',
        '/api/activity',
        {
          'x-device-id': testDeviceId,
          'x-device-token': testDeviceToken,
        },
        {
          childId: otherChildId,
          domain: 'khanacademy.org',
          action: 'ALLOW',
        }
      );
      assert.strictEqual(res.status, 403);
      assert.match(res.body.error, /not associated with the requested child profile/i);
    });
  });

  describe('F. Mail Delivery Modes & Startup Configuration Safety', () => {
    it('27. should block production startup with PRODUCTION_MAIL_PROVIDER_NOT_CONFIGURED', () => {
      const prodMail = new ProductionMailAdapter();
      assert.throws(() => {
        prodMail.validateConfiguration();
      }, /PRODUCTION_MAIL_PROVIDER_NOT_CONFIGURED/);
    });

    it('28. should capture messages in DevelopmentMailAdapter labeled DEVELOPMENT_CAPTURED', async () => {
      const devMail = new DevelopmentMailAdapter();
      devMail.clearOutbox();

      await devMail.sendVerificationEmail('test@safebrowse.io', 'ev_token123');
      const outbox = devMail.getOutbox();
      assert.strictEqual(outbox.length, 1);
      assert.strictEqual(outbox[0].status, 'DEVELOPMENT_CAPTURED');
      assert.strictEqual(outbox[0].token, 'ev_token123');
    });
  });
});
