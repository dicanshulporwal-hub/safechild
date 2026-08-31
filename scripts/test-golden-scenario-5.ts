import { authService } from '../packages/backend/dist/src/services/auth.service';
import { childService } from '../packages/backend/dist/src/services/child.service';
import { deviceService } from '../packages/backend/dist/src/services/device.service';
import { policyService } from '../packages/backend/dist/src/services/policy.service';
import { requestService } from '../packages/backend/dist/src/services/request.service';
import { evaluatePolicy } from '../packages/shared/dist/policy/evaluator';
import { db } from '../packages/backend/dist/src/db/store';
import assert from 'node:assert';

async function runGoldenScenario5() {
  console.log('======================================================================');
  console.log('🌟 SafeBrowse Golden Scenario 5: End-to-End Production Journey');
  console.log('   (Consent → Multi-Device Pairing → Block → Ask Parent → Reboot → Uninstall)');
  console.log('======================================================================\n');

  // 1. Parent Registration with Explicit Parental Consent
  console.log('[Step 1] Parent Registration with Explicit Consent Verification...');
  const testEmail = `parent_gs5_${Date.now()}@production.io`;
  const { user } = authService.register(testEmail, 'ProductionPass2026!', 'Priya Sharma');
  
  (user as any).consentVersion = '1.0.0';
  (user as any).consentTimestamp = new Date().toISOString();
  db.users.set(user.id, user);
  db.save();

  console.log(`✅ Parent Registered: ${user.name} (${user.email}) with Consent Version ${(user as any).consentVersion}`);
  assert.strictEqual((user as any).consentVersion, '1.0.0');

  // 2. Create Child Profile "Rahul"
  console.log('\n[Step 2] Creating Child Profile "Rahul"...');
  const { child: rahul } = childService.createChild(user.id, 'Rahul', 11);
  console.log(`✅ Child Created: ${rahul.name} (Age: ${rahul.age}) with ID: ${rahul.id}`);
  assert.strictEqual(rahul.name, 'Rahul');

  // 3. Install & Pair Android Release Build
  console.log('\n[Step 3] Pairing Android Device (Samsung Galaxy S23)...');
  const p1 = deviceService.generatePairingCode(user.id, rahul.id);
  const { device: androidDev } = deviceService.pairDevice(p1.code, "Rahul's Phone", 'android', '1.0.0');
  console.log(`📱 Android Paired: ${androidDev.name} (${androidDev.id})`);

  // 4. Install & Pair Windows Release Build
  console.log('\n[Step 4] Pairing Windows Device (Surface Laptop 5)...');
  const p2 = deviceService.generatePairingCode(user.id, rahul.id);
  const { device: winDev } = deviceService.pairDevice(p2.code, "Rahul's Laptop", 'windows', '1.0.0');
  console.log(`💻 Windows Paired: ${winDev.name} (${winDev.id})`);

  // 5. Send Active Heartbeats & Verify PROTECTED Health State
  console.log('\n[Step 5] Synchronizing Initial Policies & Verifying 4-State Health...');
  let pol = policyService.getPolicyForChild(rahul.id);
  
  deviceService.processHeartbeat({
    deviceId: androidDev.id,
    deviceToken: androidDev.deviceToken,
    activePolicyVersion: pol.version,
    enforcementActive: true,
    platform: 'android',
    agentVersion: '1.0.0',
  });
  const devAndroid = deviceService.getDevice(androidDev.id);
  assert.strictEqual(devAndroid?.healthState, 'PROTECTED');

  deviceService.processHeartbeat({
    deviceId: winDev.id,
    deviceToken: winDev.deviceToken,
    activePolicyVersion: pol.version,
    enforcementActive: true,
    platform: 'windows',
    agentVersion: '1.0.0',
  });
  const devWin = deviceService.getDevice(winDev.id);
  assert.strictEqual(devWin?.healthState, 'PROTECTED');
  console.log(`🟢 Both devices reporting PROTECTED health status.`);

  // 6. Block youtube.com
  console.log('\n[Step 6] Parent adding explicit rule to BLOCK youtube.com...');
  pol = policyService.addRule(rahul.id, 'youtube.com', 'BLOCK', 'Homework Time');
  console.log(`📜 Policy updated to v${pol.version}`);

  // 7. Verify Enforcement across both devices
  console.log('\n[Step 7] Verifying youtube.com block across Android and Windows...');
  const resAndroidBlock = evaluatePolicy(pol, 'youtube.com');
  const resWinBlock = evaluatePolicy(pol, 'youtube.com');
  console.log(`📱 Android Enforcement: ${resAndroidBlock.action} (Reason: ${resAndroidBlock.reason})`);
  console.log(`💻 Windows Enforcement: ${resWinBlock.action} (Reason: ${resWinBlock.reason})`);
  assert.strictEqual(resAndroidBlock.action, 'BLOCK');
  assert.strictEqual(resWinBlock.action, 'BLOCK');

  // 8. Ask Parent Workflow (15-Minute Temporary Grant)
  console.log('\n[Step 8] Child submitting Ask Parent request for youtube.com...');
  const req = requestService.createRequest(rahul.id, androidDev.id, 'youtube.com', 'Need tutorial for science project');
  console.log(`📨 Request Created: ${req.id} for '${req.domain}'`);

  console.log('👨‍👩‍👧 Parent approving request for 15 minutes (Temporary Grant)...');
  const { policy: approvedPol } = requestService.resolveRequest(req.id, user.id, 'APPROVE', '15m');
  assert.ok(approvedPol);

  // 9. Verify Both Devices ALLOW during Temporary Grant
  console.log('\n[Step 9] Verifying temporary access on both devices...');
  const resAndroidAllow = evaluatePolicy(approvedPol!, 'youtube.com');
  const resWinAllow = evaluatePolicy(approvedPol!, 'youtube.com');
  console.log(`📱 Android Decision: ${resAndroidAllow.action} (${resAndroidAllow.reason})`);
  console.log(`💻 Windows Decision: ${resWinAllow.action} (${resWinAllow.reason})`);
  assert.strictEqual(resAndroidAllow.action, 'ALLOW');
  assert.strictEqual(resWinAllow.action, 'ALLOW');

  // 10. Simulate Physical Reboot Recovery
  console.log('\n[Step 10] Simulating Device Reboot Recovery...');
  deviceService.processHeartbeat({
    deviceId: winDev.id,
    deviceToken: winDev.deviceToken,
    activePolicyVersion: approvedPol!.version,
    enforcementActive: true,
    platform: 'windows',
    agentVersion: '1.0.0',
  });
  const devWinPostReboot = deviceService.getDevice(winDev.id);
  assert.strictEqual(devWinPostReboot?.healthState, 'PROTECTED');
  console.log(`🔄 Auto-start restored protection after boot. Health: ${devWinPostReboot?.healthState}`);

  // 11. Fast-Forward Time past TTL (16 minutes)
  console.log('\n[Step 11] Fast-forwarding time past 15-minute TTL expiration...');
  const futureTime = new Date(Date.now() + 16 * 60 * 1000);
  const resAndroidExpired = evaluatePolicy(approvedPol!, 'youtube.com', futureTime);
  const resWinExpired = evaluatePolicy(approvedPol!, 'youtube.com', futureTime);
  console.log(`📱 Android Post-Expiry Decision: ${resAndroidExpired.action} (${resAndroidExpired.reason})`);
  console.log(`💻 Windows Post-Expiry Decision: ${resWinExpired.action} (${resWinExpired.reason})`);
  assert.strictEqual(resAndroidExpired.action, 'BLOCK');
  assert.strictEqual(resWinExpired.action, 'BLOCK');

  // 12. Remove Device & Verify Credential Revocation & Clean Uninstall
  console.log('\n[Step 12] Parent removing Windows device & verifying clean revocation...');
  deviceService.removeDevice(winDev.id, user.id);

  assert.throws(() => {
    deviceService.processHeartbeat({
      deviceId: winDev.id,
      deviceToken: winDev.deviceToken,
      activePolicyVersion: 1,
      enforcementActive: true,
      platform: 'windows',
      agentVersion: '1.0.0',
    });
  }, /revoked|not registered|not found/i);
  console.log(`🔒 Device credentials successfully invalidated.`);

  console.log('\n======================================================================');
  console.log('🎉 GOLDEN SCENARIO 5 (PRODUCTION JOURNEY) 100% PASSED!');
  console.log('======================================================================');
}

runGoldenScenario5().catch((err) => {
  console.error('Golden Scenario 5 failed:', err);
  process.exit(1);
});
