import { describe, it } from 'node:test';
import assert from 'node:assert';
import { authService } from '../src/services/auth.service';
import { childService } from '../src/services/child.service';
import { familyService } from '../src/services/family.service';
import { deviceService } from '../src/services/device.service';
import { policyService } from '../src/services/policy.service';
import { requestService } from '../src/services/request.service';
import { PolicyRule } from '@safebrowse/shared';

describe('SafeBrowse Backend Service Integration Tests', () => {
  let parentId: string;
  let childId: string;
  let deviceId: string;

  it('should register and authenticate test parent user', () => {
    const reg = authService.register('test_parent_main@porwal.io', 'StrongTestPassphrase2026!', 'Test Parent');
    authService.verifyEmail(reg.emailVerificationToken);
    const { user, token } = authService.login('test_parent_main@porwal.io', 'StrongTestPassphrase2026!');
    assert.ok(user);
    assert.ok(token);
    assert.strictEqual(user.email, 'test_parent_main@porwal.io');
    parentId = user.id;
    const fam = familyService.getOrCreateUserFamily(user.id);

    const { child } = childService.createChild(parentId, 'Rahul', 10, '🧒', fam.id);
    assert.ok(child);
    childId = child.id;
  });

  it('should list children and manage child profile', () => {
    const children = childService.getChildrenForParent(parentId);
    assert.ok(children.length >= 1);
    const rahul = children.find((c) => c.name === 'Rahul');
    assert.ok(rahul);
    assert.strictEqual(rahul.id, childId);
  });

  it('should generate pairing code and claim device', () => {
    const pairing = deviceService.generatePairingCode(parentId, childId);
    assert.ok(pairing.code);

    const { device, policy } = deviceService.pairDevice(
      pairing.code,
      "Rahul's Windows Laptop",
      'windows',
      '1.0.0'
    );

    assert.ok(device);
    assert.strictEqual(device.name, "Rahul's Windows Laptop");
    assert.strictEqual(device.platform, 'windows');
    assert.strictEqual(device.childId, childId);
    assert.ok(policy);
    deviceId = device.id;
  });

  it('should handle device heartbeat', () => {
    const dev = deviceService.getDevicesForChild(childId).find((d) => d.id === deviceId);
    assert.ok(dev);

    const hbRes = deviceService.processHeartbeat({
      deviceId: dev.id,
      deviceToken: dev.deviceToken,
      activePolicyVersion: dev.activePolicyVersion,
      enforcementActive: true,
      platform: 'windows',
      agentVersion: '1.0.0',
    });

    assert.strictEqual(hbRes.status, 'ok');
    assert.strictEqual(hbRes.policyChanged, false);
  });

  it('should add rules and increment policy version', () => {
    const currentPolicy = policyService.getPolicyForChild(childId);
    const initialVersion = currentPolicy.version;

    const updated = policyService.addRule(childId, 'https://www.tiktok.com', 'BLOCK', 'No TikTok');
    assert.strictEqual(updated.version, initialVersion + 1);
    const rule = updated.rules.find((r: PolicyRule) => r.domain === 'tiktok.com');
    assert.ok(rule);
    assert.strictEqual(rule.action, 'BLOCK');
  });

  it('should process Ask Parent flow end-to-end', () => {
    // 1. Child creates request for youtube.com
    const req = requestService.createRequest(
      childId,
      deviceId,
      'youtube.com',
      'Need a maths tutorial for school'
    );
    assert.ok(req);
    assert.strictEqual(req.status, 'PENDING');
    assert.strictEqual(req.domain, 'youtube.com');

    // 2. Parent approves for 15 minutes
    const { request: resolvedReq, policy: updatedPolicy } = requestService.resolveRequest(
      req.id,
      parentId,
      'APPROVE',
      '15m'
    );

    assert.strictEqual(resolvedReq.status, 'APPROVED');
    assert.strictEqual(resolvedReq.resolvedDuration, '15m');
    assert.ok(resolvedReq.expiresAt);

    // Verify policy now has active TEMPORARY_ALLOW rule for youtube.com
    const tempRule = updatedPolicy.rules.find((r: PolicyRule) => r.domain === 'youtube.com');
    assert.ok(tempRule);
    assert.strictEqual(tempRule.action, 'TEMPORARY_ALLOW');
    assert.ok(tempRule.expiresAt);
  });
});
