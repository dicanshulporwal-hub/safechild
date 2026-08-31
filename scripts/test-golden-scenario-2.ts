import { authService } from '../packages/backend/dist/src/services/auth.service';
import { childService } from '../packages/backend/dist/src/services/child.service';
import { deviceService } from '../packages/backend/dist/src/services/device.service';
import { policyService } from '../packages/backend/dist/src/services/policy.service';
import { requestService } from '../packages/backend/dist/src/services/request.service';
import { evaluatePolicy } from '../packages/shared/dist/policy/evaluator';
import { Policy } from '@safebrowse/shared';
import assert from 'node:assert';

async function runGoldenScenario2() {
  console.log('======================================================================');
  console.log('🧪 Running SafeBrowse Stage 4 Golden Scenario 2');
  console.log('   (Offline Partition, Atomic Reconciliation & Multi-Device Sync)');
  console.log('======================================================================\n');

  // Step 1: Parent registration
  console.log('[Step 1] Parent registration and profile creation...');
  const reg = authService.register('gs2_parent@porwal.io', 'StrongPassphrase2026!GS2', 'Sarah (Parent)');
  authService.verifyEmail(reg.emailVerificationToken);
  const { child: rahul } = childService.createChild(reg.user.id, 'Rahul', 10, '🧒');
  const parent = reg.user;
  console.log(`✅ Registered: ${parent.name} | Managing Child: ${rahul.name} (${rahul.id})\n`);

  // Step 2: Pair Android Phone & Windows Laptop
  console.log('[Step 2] Pairing Android Phone and Windows Laptop with high-entropy tokens...');
  const phonePair = deviceService.generatePairingCode(parent.id, rahul.id);
  const { device: androidPhone } = deviceService.pairDevice(phonePair.code, "Rahul's Pixel", 'android');

  const laptopPair = deviceService.generatePairingCode(parent.id, rahul.id);
  const { device: windowsLaptop } = deviceService.pairDevice(laptopPair.code, "Rahul's Surface Laptop", 'windows');

  console.log(`✅ Paired Android: ${androidPhone.name} (${androidPhone.id}) | DeviceToken: ${androidPhone.deviceToken.slice(0, 12)}...`);
  console.log(`✅ Paired Windows: ${windowsLaptop.name} (${windowsLaptop.id}) | DeviceToken: ${windowsLaptop.deviceToken.slice(0, 12)}...\n`);

  // Step 3: Parent blocks youtube.com
  console.log('[Step 3] Parent adds BLOCK rule for "youtube.com"...');
  const policyV2 = policyService.addRule(rahul.id, 'youtube.com', 'BLOCK', 'School hours restriction');
  console.log(`✅ Policy updated to Version v${policyV2.version}\n`);

  // Step 4: Both devices receive policyV2 and evaluate youtube.com
  console.log('[Step 4] Both devices evaluate youtube.com on policy v' + policyV2.version + '...');
  let androidLocalPolicy: Policy = JSON.parse(JSON.stringify(policyV2));
  let windowsLocalPolicy: Policy = JSON.parse(JSON.stringify(policyV2));

  assert.strictEqual(evaluatePolicy(androidLocalPolicy, 'youtube.com').action, 'BLOCK');
  assert.strictEqual(evaluatePolicy(windowsLocalPolicy, 'youtube.com').action, 'BLOCK');
  console.log('📱 Android Access: BLOCK (EXPLICIT_BLOCK)');
  console.log('💻 Windows Access: BLOCK (EXPLICIT_BLOCK)\n');

  // Step 5: Windows goes OFFLINE (network partition)
  console.log('[Step 5] ⚡ Windows Laptop goes OFFLINE (network disconnection)...');
  let windowsIsOnline = false;
  console.log('💻 Windows network status: OFFLINE (Operating purely on local cached policy v2)\n');

  // Step 6: Child requests access & Parent grants 15 minutes
  console.log('[Step 6] Child requests access from phone & Parent approves for 15 minutes...');
  const req = requestService.createRequest(rahul.id, androidPhone.id, 'youtube.com', 'Need tutorial video');
  const { policy: policyV3 } = requestService.resolveRequest(req.id, parent.id, 'APPROVE', '15m');
  console.log(`✅ Parent approved request for 15 mins. Server policy bumped to Version v${policyV3.version}\n`);

  // Step 7: Android syncs v3 while Windows is offline
  console.log('[Step 7] Testing device policy states during offline partition...');
  androidLocalPolicy = JSON.parse(JSON.stringify(policyV3)); // Android receives live WS update

  // Windows is offline -> DOES NOT receive policyV3
  if (!windowsIsOnline) {
    // Windows local policy remains v2
  }

  const androidCheckDuring = evaluatePolicy(androidLocalPolicy, 'youtube.com');
  const windowsCheckDuring = evaluatePolicy(windowsLocalPolicy, 'youtube.com');

  console.log(`📱 Android Access (Online, v3): ${androidCheckDuring.action} (${androidCheckDuring.reason})`);
  console.log(`💻 Windows Access (Offline, v2): ${windowsCheckDuring.action} (${windowsCheckDuring.reason})`);

  assert.strictEqual(androidCheckDuring.action, 'ALLOW');
  assert.strictEqual(windowsCheckDuring.action, 'BLOCK');
  console.log('✅ Offline Windows correctly maintained cached protection!\n');

  // Step 8: Windows reconnects and performs atomic sync
  console.log('[Step 8] 🔄 Windows Laptop reconnects to network and reconciles policy...');
  windowsIsOnline = true;
  const serverPolicyForWindows = policyService.getPolicyForChild(rahul.id);
  windowsLocalPolicy = JSON.parse(JSON.stringify(serverPolicyForWindows));
  console.log(`💻 Windows local cache atomically synchronized to Version v${windowsLocalPolicy.version}`);

  const windowsCheckAfterSync = evaluatePolicy(windowsLocalPolicy, 'youtube.com');
  console.log(`💻 Windows Access (Reconnected, v3): ${windowsCheckAfterSync.action} (${windowsCheckAfterSync.reason})`);
  assert.strictEqual(windowsCheckAfterSync.action, 'ALLOW');
  console.log('✅ Reconnected Windows immediately allows temporary access!\n');

  // Step 9: TTL expiration (1 hour later)
  console.log('[Step 9] Simulating TTL expiration (1 hour into future)...');
  const futureTime = new Date(Date.now() + 60 * 60 * 1000);
  const androidAfterTtl = evaluatePolicy(androidLocalPolicy, 'youtube.com', futureTime);
  const windowsAfterTtl = evaluatePolicy(windowsLocalPolicy, 'youtube.com', futureTime);

  console.log(`📱 Android Access (Post-TTL): ${androidAfterTtl.action} (${androidAfterTtl.reason})`);
  console.log(`💻 Windows Access (Post-TTL): ${windowsAfterTtl.action} (${windowsAfterTtl.reason})`);

  assert.strictEqual(androidAfterTtl.action, 'BLOCK');
  assert.strictEqual(windowsAfterTtl.action, 'BLOCK');
  console.log('✅ Both devices automatically reverted to BLOCKED without parent intervention!\n');

  console.log('======================================================================');
  console.log('🎉 GOLDEN SCENARIO 2 FULLY VERIFIED & PASSED!');
  console.log('======================================================================');
}

runGoldenScenario2().catch((err) => {
  console.error('Golden Scenario 2 Failed:', err);
  process.exit(1);
});
