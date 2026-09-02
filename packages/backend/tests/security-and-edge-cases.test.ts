import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  normalizeDomain,
  domainMatches,
  evaluatePolicy,
  Policy,
  calculateExpirationDate,
} from '@safebrowse/shared';
import { authService } from '../src/services/auth.service';
import { familyService } from '../src/services/family.service';
import { childService } from '../src/services/child.service';
import { deviceService } from '../src/services/device.service';
import { policyService } from '../src/services/policy.service';
import { requestService } from '../src/services/request.service';
import { db } from '../src/db/store';
import { nanoid } from 'nanoid';

describe('SafeBrowse Stage 3 Security, Edge-Case & Bypass Audit Tests', () => {

  describe('1. Domain Normalization & Pattern Matching Edge Cases', () => {
    it('should strip complex protocols, credentials, and ports', () => {
      assert.strictEqual(normalizeDomain('https://user:pass@www.youtube.com:8443/watch?v=1#t=10'), 'youtube.com');
      assert.strictEqual(normalizeDomain('ftp://ftp.is.co.za/'), 'ftp.is.co.za');
      assert.strictEqual(normalizeDomain('HTTP://WWW.REDDIT.COM/'), 'reddit.com');
      assert.strictEqual(normalizeDomain('//m.youtube.com/path'), 'm.youtube.com');
    });

    it('should handle trailing DNS root dots properly', () => {
      assert.strictEqual(normalizeDomain('wikipedia.org.'), 'wikipedia.org');
      assert.strictEqual(normalizeDomain('www.wikipedia.org.'), 'wikipedia.org');
    });

    it('should correctly prevent false-positive domain suffix collisions', () => {
      assert.strictEqual(domainMatches('notyoutube.com', 'youtube.com'), false);
      assert.strictEqual(domainMatches('myoutube.com', 'youtube.com'), false);
      assert.strictEqual(domainMatches('youtube.com.attacker.com', 'youtube.com'), false);
      assert.strictEqual(domainMatches('fake-youtube.com', 'youtube.com'), false);
    });

    it('should match deep nested subdomains', () => {
      assert.strictEqual(domainMatches('a.b.c.video.youtube.com', 'youtube.com'), true);
      assert.strictEqual(domainMatches('m.youtube.com', 'youtube.com'), true);
      assert.strictEqual(domainMatches('mail.google.com', '*.google.com'), true);
      assert.strictEqual(domainMatches('drive.google.com', '*.google.com'), true);
    });

    it('should handle punycode/IDN internationalized domains', () => {
      const punyDomain = 'xn--d1abbgf6aiiy.xn--p1ai';
      assert.strictEqual(normalizeDomain(punyDomain), punyDomain);
      assert.strictEqual(domainMatches(punyDomain, punyDomain), true);
      assert.strictEqual(domainMatches('sub.' + punyDomain, punyDomain), true);
    });
  });

  describe('2. Authentication & Bcrypt Password Hashing', () => {
    it('should securely hash passwords and verify with bcrypt', () => {
      const testEmail = `user-${nanoid(6)}@safebrowse.io`;
      const plainPassword = 'MySecretPassword123!';
      const { user } = authService.register(testEmail, plainPassword, 'Test Parent');

      // Assert password is NOT stored as plaintext
      assert.notStrictEqual(user.passwordHash, plainPassword);
      assert.ok(user.passwordHash.startsWith('$2a$') || user.passwordHash.startsWith('$2b$'));

      // Assert login verifies bcrypt hash correctly
      const loginRes = authService.login(testEmail, plainPassword);
      assert.ok(loginRes.token);
    });

    it('should reject invalid passwords during login', () => {
      const testEmail = `user-${nanoid(6)}@safebrowse.io`;
      authService.register(testEmail, 'CorrectPassphrase2026!', 'Parent');

      assert.throws(() => {
        authService.login(testEmail, 'WrongPassword2026!');
      }, /Invalid email or password/);
    });

    it('should fail token verification on tampered or forged JWT tokens', () => {
      const reg = authService.register(`sec-token-${nanoid(6)}@safebrowse.io`, 'SecTestPassphrase2026!', 'Sec Parent');
      authService.verifyEmail(reg.emailVerificationToken);
      const { token } = authService.login(reg.user.email, 'SecTestPassphrase2026!');
      const tamperedToken = token!.slice(0, -5) + 'xxxxx';

      assert.throws(() => {
        authService.verifyToken(tamperedToken);
      }, /Invalid or expired token/);
    });
  });

  describe('3. Cross-Family Authorization & Negative Tenancy Tests', () => {
    it('should prevent Parent A from deleting Parent B devices', () => {
      const uA = nanoid(6);
      const uB = nanoid(6);

      const famA = authService.register(`famA-${uA}@test.io`, 'StrongPassA2026!Secure', 'Parent A');
      const famB = authService.register(`famB-${uB}@test.io`, 'StrongPassB2026!Secure', 'Parent B');
      const familyB = familyService.getOrCreateUserFamily(famB.user.id);

      const { child: childB } = childService.createChild(famB.user.id, 'Child B', 12, undefined, familyB.id);
      const codeB = deviceService.generatePairingCode(famB.user.id, childB.id);
      const { device: devB } = deviceService.pairDevice(codeB.code, 'Phone B', 'android');

      // Parent A attempts to delete Parent B's device -> MUST FAIL with Forbidden
      assert.throws(() => {
        deviceService.removeDevice(devB.id, famA.user.id);
      }, /Forbidden/);
    });

    it('should prevent Parent A from resolving Parent B access requests', () => {
      const uA = nanoid(6);
      const uB = nanoid(6);

      const famA = authService.register(`famA-${uA}@test.io`, 'StrongPassA2026!Secure', 'Parent A');
      const famB = authService.register(`famB-${uB}@test.io`, 'StrongPassB2026!Secure', 'Parent B');
      const familyB = familyService.getOrCreateUserFamily(famB.user.id);

      const { child: childB } = childService.createChild(famB.user.id, 'Child B', 12, undefined, familyB.id);
      const codeB = deviceService.generatePairingCode(famB.user.id, childB.id);
      const { device: devB } = deviceService.pairDevice(codeB.code, 'Phone B', 'android');

      // Child B creates access request
      const reqB = requestService.createRequest(childB.id, devB.id, 'roblox.com', 'Need game access');

      // Parent A attempts to resolve Child B's request -> MUST FAIL with Forbidden
      assert.throws(() => {
        requestService.resolveRequest(reqB.id, famA.user.id, 'APPROVE', '15m');
      }, /Forbidden/);

      // Parent B resolving their own child's request -> SUCCEEDS
      const approved = requestService.resolveRequest(reqB.id, famB.user.id, 'APPROVE', '15m');
      assert.strictEqual(approved.request.status, 'APPROVED');
    });
  });

  describe('4. Cryptographic Pairing Code Entropy & Replay Protection', () => {
    it('should generate high-entropy pairing codes and issue distinct device credentials', () => {
      const reg = authService.register(`sec-pair-${nanoid(6)}@safebrowse.io`, 'SecTestPassphrase2026!', 'Pair Parent');
      authService.verifyEmail(reg.emailVerificationToken);
      const familyReg = familyService.getOrCreateUserFamily(reg.user.id);
      const { child } = childService.createChild(reg.user.id, 'Pair Child', 10, undefined, familyReg.id);
      const pairing = deviceService.generatePairingCode(reg.user.id, child.id);

      // High entropy format: SB-XXXX-XXXX
      assert.match(pairing.code, /^SB-[2-9A-Z]{4}-[2-9A-Z]{4}$/);

      const { device } = deviceService.pairDevice(pairing.code, 'New Phone', 'android');
      assert.ok(device.deviceToken.startsWith('dtk_'));
      assert.ok(device.deviceToken.length > 40);

      // Code immediately invalidated upon claim
      assert.throws(() => {
        deviceService.pairDevice(pairing.code, 'Replay Phone', 'android');
      }, /Invalid or expired pairing code/);
    });

    it('should reject expired pairing codes', () => {
      const reg = authService.register(`sec-exp-${nanoid(6)}@safebrowse.io`, 'SecTestPassphrase2026!', 'Exp Parent');
      authService.verifyEmail(reg.emailVerificationToken);
      const familyReg = familyService.getOrCreateUserFamily(reg.user.id);
      const { child } = childService.createChild(reg.user.id, 'Exp Child', 10, undefined, familyReg.id);
      const pairing = deviceService.generatePairingCode(reg.user.id, child.id);

      // Expire code
      pairing.expiresAt = new Date(Date.now() - 60000).toISOString();
      db.pairingCodes.set(pairing.code, pairing);

      assert.throws(() => {
        deviceService.pairDevice(pairing.code, 'Expired Token Phone', 'android');
      }, /Pairing code has expired/);
    });
  });

  describe('5. Temporary Approval TTL Expiration & Reversion', () => {
    it('should evaluate temporary grant as ALLOW before expiry and strictly BLOCK after expiry', () => {
      const baseTime = new Date('2026-08-29T12:00:00Z');
      const expiresAt = new Date('2026-08-29T12:15:00Z').toISOString();

      const policy: Policy = {
        id: 'pol-ttl',
        childId: 'c1',
        familyId: 'fam-test',
        version: 3,
        isPaused: false,
        rules: [
          {
            id: 'r-temp',
            domain: 'youtube.com',
            action: 'TEMPORARY_ALLOW',
            addedAt: baseTime.toISOString(),
            expiresAt,
          },
          {
            id: 'r-base',
            domain: 'youtube.com',
            action: 'BLOCK',
            addedAt: '2026-08-29T10:00:00Z',
          },
        ],
        updatedAt: baseTime.toISOString(),
      };

      // T = 12:05 (Before expiry -> ALLOW)
      const duringGrant = evaluatePolicy(policy, 'youtube.com', new Date('2026-08-29T12:05:00Z'));
      assert.strictEqual(duringGrant.action, 'ALLOW');
      assert.strictEqual(duringGrant.reason, 'TEMPORARY_ALLOW');

      // T = 12:16 (After expiry -> reverts to BLOCK without human intervention)
      const afterExpiry = evaluatePolicy(policy, 'youtube.com', new Date('2026-08-29T12:16:00Z'));
      assert.strictEqual(afterExpiry.action, 'BLOCK');
      assert.strictEqual(afterExpiry.reason, 'EXPLICIT_BLOCK');
    });
  });
});
