import { describe, it } from 'node:test';
import assert from 'node:assert';
import { authService } from '../src/services/auth.service';
import { mailService } from '../src/services/mail.service';
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

  function getActivationToken(email: string): string {
    const mail = mailService.getOutbox().filter((m) => m.to.toLowerCase() === email.toLowerCase().trim()).pop();
    if (!mail || !mail.token) throw new Error(`Activation token not found for ${email}`);
    return mail.token;
  }

  it('should register and authenticate test parent user', async () => {
    const email = `test_parent_main_${Date.now()}@porwal.io`;
    const reg = await authService.register(email, 'StrongTestPassphrase2026!', 'Test Parent');
    await authService.activateAccount(getActivationToken(email));
    const { user, token } = await authService.login(email, 'StrongTestPassphrase2026!');
    assert.ok(user);
    assert.ok(token);
    assert.strictEqual(user.email, email);
    parentId = user.id;
    const fam = await familyService.getOrCreateUserFamily(user.id);

    const { child } = await childService.createChild(parentId, 'Rahul', 10, '🧒', fam.id);
    assert.ok(child);
    childId = child.id;
  });

  it('should list children and manage child profile', async () => {
    const children = await childService.getChildrenForParent(parentId);
    assert.ok(children.length >= 1);
    const rahul = children.find((c) => c.name === 'Rahul');
    assert.ok(rahul);
    assert.strictEqual(rahul.id, childId);
  });

  it('should generate pairing code and claim device', async () => {
    const pairing = await deviceService.generatePairingCode(parentId, childId);
    assert.ok(pairing.code);

    const { device, policy } = await deviceService.pairDevice(
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

  it('should handle device heartbeat', async () => {
    const devices = await deviceService.getDevicesForChild(childId);
    const dev = devices.find((d) => d.id === deviceId);
    assert.ok(dev);

    const hbRes = await deviceService.processHeartbeat({
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

  it('should add rules and increment policy version', async () => {
    const currentPolicy = await policyService.getPolicyForChild(childId);
    const initialVersion = currentPolicy.version;

    const updated = await policyService.addRule(childId, 'https://www.tiktok.com', 'BLOCK', 'No TikTok');
    assert.strictEqual(updated.version, initialVersion + 1);
    const rule = updated.rules.find((r: PolicyRule) => r.domain === 'tiktok.com');
    assert.ok(rule);
    assert.strictEqual(rule.action, 'BLOCK');
  });

  it('should process Ask Parent flow end-to-end', async () => {
    // 1. Child creates request for youtube.com
    const req = await requestService.createRequest(
      childId,
      deviceId,
      'youtube.com',
      'Need a maths tutorial for school'
    );
    assert.ok(req);
    assert.strictEqual(req.status, 'PENDING');
    assert.strictEqual(req.domain, 'youtube.com');

    // 2. Parent approves for 15 minutes
    const { request: resolvedReq, policy: updatedPolicy } = await requestService.resolveRequest(
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
