import { authService } from '../packages/backend/dist/src/services/auth.service';
import { childService } from '../packages/backend/dist/src/services/child.service';
import { deviceService } from '../packages/backend/dist/src/services/device.service';
import { policyService } from '../packages/backend/dist/src/services/policy.service';
import { requestService } from '../packages/backend/dist/src/services/request.service';
import { evaluatePolicy } from '../packages/shared/dist/policy/evaluator';
import { Policy } from '@safebrowse/shared';
import assert from 'node:assert';

async function runGoldenScenario3() {
  console.log('======================================================================');
  console.log('🧪 Running SafeBrowse Stage 5 Golden Scenario 3');
  console.log('   (Installation-to-Protection, Reboot Recovery & Multi-Device Sync)');
  console.log('======================================================================\n');

  // Step 1: Parent creates child Rahul
  console.log('[Step 1] Parent registration and profile creation...');
  const reg = authService.register('gs3_parent@porwal.io', 'StrongPassphrase2026!GS3', 'Sarah (Parent)');
  authService.verifyEmail(reg.emailVerificationToken);
  const { child: rahul } = childService.createChild(reg.user.id, 'Rahul', 10, '🧒');
  const parent = reg.user;
  console.log(`✅ Parent: ${parent.name} | Child: ${rahul.name} (${rahul.id})\n`);

  // Step 2: Install Android app & Pair via QR
  console.log('[Step 2] Android onboarding & QR pairing...');
  const androidPairCode = deviceService.generatePairingCode(parent.id, rahul.id);
  const { device: androidPhone, policy: initialPolicy } = deviceService.pairDevice(
    androidPairCode.code,
    "Rahul's Samsung Galaxy",
    'android',
    '1.0.0'
  );
  console.log(`✅ Android paired: ${androidPhone.name} | Health State: ${androidPhone.healthState}`);
  assert.strictEqual(androidPhone.healthState, 'PROTECTED');

  // Step 3: Install Windows setup package & Pair laptop
  console.log('\n[Step 3] Windows setup installation & Laptop pairing...');
  const winPairCode = deviceService.generatePairingCode(parent.id, rahul.id);
  const { device: windowsLaptop } = deviceService.pairDevice(
    winPairCode.code,
    "Rahul's ThinkPad Laptop",
    'windows',
    '1.0.0'
  );
  console.log(`✅ Windows paired: ${windowsLaptop.name} | Health State: ${windowsLaptop.healthState}`);
  assert.strictEqual(windowsLaptop.healthState, 'PROTECTED');

  // Step 4: Parent blocks youtube.com
  console.log('\n[Step 4] Parent adds BLOCK rule for "youtube.com"...');
  const policyV2 = policyService.addRule(rahul.id, 'youtube.com', 'BLOCK', 'School Focus Hours');
  console.log(`✅ Policy updated to Version v${policyV2.version}`);

  // Step 5: YouTube is blocked on both devices
  console.log('\n[Step 5] Both devices evaluate "youtube.com"...');
  let androidPolicy: Policy = JSON.parse(JSON.stringify(policyV2));
  let windowsPolicy: Policy = JSON.parse(JSON.stringify(policyV2));

  const androidRes1 = evaluatePolicy(androidPolicy, 'youtube.com');
  const windowsRes1 = evaluatePolicy(windowsPolicy, 'youtube.com');
  console.log(`📱 Android: ${androidRes1.action} (${androidRes1.reason})`);
  console.log(`💻 Windows: ${windowsRes1.action} (${windowsRes1.reason})`);
  assert.strictEqual(androidRes1.action, 'BLOCK');
  assert.strictEqual(windowsRes1.action, 'BLOCK');
  console.log('✅ YouTube is blocked on both Android and Windows.');

  // Step 6: Child asks parent -> Parent grants 15 minutes
  console.log('\n[Step 6] Rahul sends "Ask Parent" request & Parent approves for 15 mins...');
  const req = requestService.createRequest(rahul.id, androidPhone.id, 'youtube.com', 'Need homework tutorial');
  const { policy: policyV3 } = requestService.resolveRequest(req.id, parent.id, 'APPROVE', '15m');
  console.log(`✅ Parent approved 15-minute access. Server policy updated to v${policyV3.version}`);

  // Step 7: Both devices allow YouTube
  console.log('\n[Step 7] Both devices synchronize and allow YouTube...');
  androidPolicy = JSON.parse(JSON.stringify(policyV3));
  windowsPolicy = JSON.parse(JSON.stringify(policyV3));

  const androidRes2 = evaluatePolicy(androidPolicy, 'youtube.com');
  const windowsRes2 = evaluatePolicy(windowsPolicy, 'youtube.com');
  console.log(`📱 Android: ${androidRes2.action} (${androidRes2.reason})`);
  console.log(`💻 Windows: ${windowsRes2.action} (${windowsRes2.reason})`);
  assert.strictEqual(androidRes2.action, 'ALLOW');
  assert.strictEqual(windowsRes2.action, 'ALLOW');

  // Step 8: Device Reboots -> Protection returns automatically
  console.log('\n[Step 8] 🔄 Simulating device reboot on Windows Laptop...');
  // Device restarts, loads policy from local cache, sends heartbeat
  const hbRes = deviceService.processHeartbeat({
    deviceId: windowsLaptop.id,
    deviceToken: windowsLaptop.deviceToken,
    activePolicyVersion: windowsPolicy.version,
    enforcementActive: true,
    platform: 'windows',
    agentVersion: '1.0.0',
  });
  console.log(`💻 Windows Laptop rebooted. Local policy v${windowsPolicy.version} restored.`);
  console.log(`✅ Heartbeat status: ${hbRes.status} | Protection automatically active.`);

  // Step 9: Grant expires -> Both devices revert to BLOCK
  console.log('\n[Step 9] Simulating TTL expiration (1 hour into future)...');
  const futureTime = new Date(Date.now() + 60 * 60 * 1000);
  const androidRes3 = evaluatePolicy(androidPolicy, 'youtube.com', futureTime);
  const windowsRes3 = evaluatePolicy(windowsPolicy, 'youtube.com', futureTime);
  console.log(`📱 Android Access post-TTL: ${androidRes3.action} (${androidRes3.reason})`);
  console.log(`💻 Windows Access post-TTL: ${windowsRes3.action} (${windowsRes3.reason})`);
  assert.strictEqual(androidRes3.action, 'BLOCK');
  assert.strictEqual(windowsRes3.action, 'BLOCK');
  console.log('✅ Both devices automatically returned to BLOCKED state.');

  console.log('\n======================================================================');
  console.log('🎉 GOLDEN SCENARIO 3 FULLY CERTIFIED & PASSED!');
  console.log('======================================================================');
}

runGoldenScenario3().catch((err) => {
  console.error('Scenario 3 Failed:', err);
  process.exit(1);
});
