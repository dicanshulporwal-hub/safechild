import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  normalizeDomain,
  domainMatches,
  evaluatePolicy,
  Policy,
} from '@safebrowse/shared';
import { authService } from '../src/services/auth.service';
import { childService } from '../src/services/child.service';
import { deviceService } from '../src/services/device.service';
import { requestService } from '../src/services/request.service';
import { familyService } from '../src/services/family.service';
import { prisma } from '../src/db/prisma';
import { nanoid } from 'nanoid';

describe('SafeBrowse Security, Edge Cases & Threat Model Test Suite', () => {
  describe('1. Domain Normalization & Internationalized Domain Names (IDN/Punycode)', () => {
    it('should strip scheme, path, ports, and whitespace from raw URLs', () => {
      assert.strictEqual(normalizeDomain('https://example.com/some/path?arg=val#hash'), 'example.com');
      assert.strictEqual(normalizeDomain('HTTP://WWW.EXAMPLE.COM:8080/'), 'example.com');
      assert.strictEqual(normalizeDomain('   m.youtube.com   '), 'm.youtube.com');
    });

    it('should correctly match wildcard subdomains', () => {
      assert.strictEqual(domainMatches('sub.example.com', 'example.com'), true);
      assert.strictEqual(domainMatches('deep.nested.sub.example.com', 'example.com'), true);
      assert.strictEqual(domainMatches('other-example.com', 'example.com'), false);
      assert.strictEqual(domainMatches('notexample.com', 'example.com'), false);
    });

    it('should handle IPv4 and loopback addresses safely', () => {
      assert.strictEqual(normalizeDomain('192.168.1.1:3000'), '192.168.1.1');
      assert.strictEqual(domainMatches('192.168.1.1', '192.168.1.1'), true);
    });

    it('should safely normalize and match punycode/IDN domains (Homoglyph attack defense)', () => {
      const punyDomain = 'xn--e1afmkfd.xn--p1ai';
      assert.strictEqual(normalizeDomain(punyDomain), punyDomain);
      assert.strictEqual(domainMatches(punyDomain, punyDomain), true);
      assert.strictEqual(domainMatches('sub.' + punyDomain, punyDomain), true);
    });
  });

  describe('2. Authentication & Bcrypt Password Hashing', () => {
    it('should securely hash passwords and verify with bcrypt', async () => {
      const testEmail = `user-${nanoid(6)}@safebrowse.io`;
      const plainPassword = 'MySecretPassword123!';
      const reg = await authService.register(testEmail, plainPassword, 'Test Parent');
      await authService.activateAccount(reg.activationToken!);

      assert.notStrictEqual(reg.user.passwordHash, plainPassword);
      assert.ok(reg.user.passwordHash.startsWith('$2a$') || reg.user.passwordHash.startsWith('$2b$'));

      const loginRes = await authService.login(testEmail, plainPassword);
      assert.ok(loginRes.token);
    });

    it('should reject invalid passwords during login', async () => {
      const testEmail = `user-${nanoid(6)}@safebrowse.io`;
      const reg = await authService.register(testEmail, 'CorrectPassphrase2026!', 'Parent');
      await authService.activateAccount(reg.activationToken!);

      await assert.rejects(async () => {
        await authService.login(testEmail, 'WrongPassword2026!');
      }, /Invalid email or password/);
    });

    it('should fail token verification on tampered or forged JWT tokens', async () => {
      const reg = await authService.register(
        `sec-token-${nanoid(6)}@safebrowse.io`,
        'SecTestPassphrase2026!',
        'Sec Parent'
      );
      await authService.activateAccount(reg.activationToken!);
      const { token } = await authService.login(reg.user.email, 'SecTestPassphrase2026!');
      const tamperedToken = token!.slice(0, -5) + 'xxxxx';

      await assert.rejects(async () => {
        await authService.verifyToken(tamperedToken);
      }, /Invalid or expired token/);
    });
  });

  describe('3. Cross-Family Authorization & Negative Tenancy Tests', () => {
    it('should prevent Parent A from deleting Parent B devices', async () => {
      const uA = nanoid(6);
      const uB = nanoid(6);

      const famA = await authService.register(`famA-${uA}@test.io`, 'StrongPassA2026!Secure', 'Parent A');
      const famB = await authService.register(`famB-${uB}@test.io`, 'StrongPassB2026!Secure', 'Parent B');
      const familyB = await familyService.getOrCreateUserFamily(famB.user.id);

      const { child: childB } = await childService.createChild(famB.user.id, 'Child B', 12, undefined, familyB.id);
      const codeB = await deviceService.generatePairingCode(famB.user.id, childB.id);
      const { device: devB } = await deviceService.pairDevice(codeB.code, 'Phone B', 'android');

      // Parent A attempts to delete Parent B's device -> MUST FAIL with Forbidden
      await assert.rejects(async () => {
        await deviceService.removeDevice(devB.id, famA.user.id);
      }, /Forbidden/);
    });

    it('should prevent Parent A from resolving Parent B access requests', async () => {
      const uA = nanoid(6);
      const uB = nanoid(6);

      const famA = await authService.register(`famA-${uA}@test.io`, 'StrongPassA2026!Secure', 'Parent A');
      const famB = await authService.register(`famB-${uB}@test.io`, 'StrongPassB2026!Secure', 'Parent B');
      const familyB = await familyService.getOrCreateUserFamily(famB.user.id);

      const { child: childB } = await childService.createChild(famB.user.id, 'Child B', 12, undefined, familyB.id);
      const codeB = await deviceService.generatePairingCode(famB.user.id, childB.id);
      const { device: devB } = await deviceService.pairDevice(codeB.code, 'Phone B', 'android');

      // Child B creates access request
      const reqB = await requestService.createRequest(childB.id, devB.id, 'roblox.com', 'Need game access');

      // Parent A attempts to resolve Child B's request -> MUST FAIL with Forbidden
      await assert.rejects(async () => {
        await requestService.resolveRequest(reqB.id, famA.user.id, 'APPROVE', '15m');
      }, /Forbidden/);

      // Parent B resolving their own child's request -> SUCCEEDS
      const approved = await requestService.resolveRequest(reqB.id, famB.user.id, 'APPROVE', '15m');
      assert.strictEqual(approved.request.status, 'APPROVED');
    });
  });

  describe('4. Cryptographic Pairing Code Entropy & Replay Protection', () => {
    it('should generate high-entropy pairing codes and issue distinct device credentials', async () => {
      const reg = await authService.register(
        `sec-pair-${nanoid(6)}@safebrowse.io`,
        'SecTestPassphrase2026!',
        'Pair Parent'
      );
      await authService.activateAccount(reg.activationToken!);
      const familyReg = await familyService.getOrCreateUserFamily(reg.user.id);
      const { child } = await childService.createChild(reg.user.id, 'Pair Child', 10, undefined, familyReg.id);
      const pairing = await deviceService.generatePairingCode(reg.user.id, child.id);

      assert.match(pairing.code, /^SB-[2-9A-Z]{4}-[2-9A-Z]{4}$/);

      const { device } = await deviceService.pairDevice(pairing.code, 'New Phone', 'android');
      assert.ok(device.deviceToken.startsWith('dtk_'));
      assert.ok(device.deviceToken.length > 40);

      // Code immediately invalidated upon claim
      await assert.rejects(async () => {
        await deviceService.pairDevice(pairing.code, 'Replay Phone', 'android');
      }, /Invalid or expired pairing code/);
    });

    it('should reject expired pairing codes', async () => {
      const reg = await authService.register(
        `sec-exp-${nanoid(6)}@safebrowse.io`,
        'SecTestPassphrase2026!',
        'Exp Parent'
      );
      await authService.activateAccount(reg.activationToken!);
      const familyReg = await familyService.getOrCreateUserFamily(reg.user.id);
      const { child } = await childService.createChild(reg.user.id, 'Exp Child', 10, undefined, familyReg.id);
      const pairing = await deviceService.generatePairingCode(reg.user.id, child.id);

      // Expire code in database
      await prisma.pairingCode.update({
        where: { code: pairing.code },
        data: { expiresAt: new Date(Date.now() - 60000) },
      });

      await assert.rejects(async () => {
        await deviceService.pairDevice(pairing.code, 'Expired Token Phone', 'android');
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

      const duringGrant = evaluatePolicy(policy, 'youtube.com', new Date('2026-08-29T12:05:00Z'));
      assert.strictEqual(duringGrant.action, 'ALLOW');
      assert.strictEqual(duringGrant.reason, 'TEMPORARY_ALLOW');

      const afterExpiry = evaluatePolicy(policy, 'youtube.com', new Date('2026-08-29T12:16:00Z'));
      assert.strictEqual(afterExpiry.action, 'BLOCK');
      assert.strictEqual(afterExpiry.reason, 'EXPLICIT_BLOCK');
    });
  });
});
