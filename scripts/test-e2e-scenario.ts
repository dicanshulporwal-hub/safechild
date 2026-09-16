import { authService } from '../packages/backend/dist/src/services/auth.service';
import { familyService } from '../packages/backend/dist/src/services/family.service';
import { childService } from '../packages/backend/dist/src/services/child.service';
import { deviceService } from '../packages/backend/dist/src/services/device.service';
import { policyService } from '../packages/backend/dist/src/services/policy.service';
import { requestService } from '../packages/backend/dist/src/services/request.service';
import { evaluatePolicy } from '../packages/shared/dist/policy/evaluator';

async function runE2EAcceptanceScenario() {
  console.log('======================================================================');
  console.log('🧪 Running SafeBrowse Section 22 End-to-End MVP Acceptance Scenario');
  console.log('======================================================================\n');

  const uniqueEmail = `e2e_parent_${Date.now()}@porwal.io`;

  // Step 1: Parent registers and creates Rahul profile
  console.log('[Step 1] Parent signs in and retrieves Rahul profile...');
  const reg = await authService.register(uniqueEmail, 'StrongPassphrase2026!E2E', 'Sarah (Parent)');
  await authService.verifyEmail(reg.emailVerificationToken);
  const parent = reg.user;
  const family = await familyService.getOrCreateUserFamily(parent.id);
  const { child: rahul } = await childService.createChild(parent.id, 'Rahul', 10, '🧒', family.id);
  console.log(`✅ Parent: ${parent.name} | Child: ${rahul.name} (${rahul.id})\n`);

  // Step 2: Pairs Rahul's Phone
  console.log("[Step 2] Generating pairing code and pairing Rahul's Android Phone...");
  const phonePairCode = await deviceService.generatePairingCode(parent.id, rahul.id);
  const { device: phone } = await deviceService.pairDevice(
    phonePairCode.code,
    "Rahul's Samsung Phone",
    'android',
    '1.0.0'
  );
  console.log(`✅ Paired Android Phone: ${phone.name} (ID: ${phone.id})\n`);

  // Step 3: Pairs Rahul's Laptop
  console.log("[Step 3] Generating pairing code and pairing Rahul's Windows Laptop...");
  const laptopPairCode = await deviceService.generatePairingCode(parent.id, rahul.id);
  const { device: laptop } = await deviceService.pairDevice(
    laptopPairCode.code,
    "Rahul's Windows Laptop",
    'windows',
    '1.0.0'
  );
  console.log(`✅ Paired Windows Laptop: ${laptop.name} (ID: ${laptop.id})\n`);

  // Step 4: Blocks youtube.com
  console.log('[Step 4] Parent adds BLOCK rule for "youtube.com"...');
  const policyV2 = await policyService.addRule(rahul.id, 'youtube.com', 'BLOCK', 'Distracting entertainment');
  console.log(`✅ Policy updated to Version v${policyV2.version}\n`);

  // Step 5: Both devices synchronize and test policy
  console.log('[Step 5] Both devices evaluate "youtube.com"...');
  const phoneCheck1 = evaluatePolicy(policyV2, 'https://m.youtube.com/watch?v=test');
  const laptopCheck1 = evaluatePolicy(policyV2, 'youtube.com');

  console.log(`📱 Phone Access to youtube.com: ${phoneCheck1.action} (${phoneCheck1.reason})`);
  console.log(`💻 Laptop Access to youtube.com: ${laptopCheck1.action} (${laptopCheck1.reason})`);

  if (phoneCheck1.action !== 'BLOCK' || laptopCheck1.action !== 'BLOCK') {
    throw new Error('❌ Policy check failed! YouTube should be blocked on both devices.');
  }
  console.log('✅ YouTube is blocked on both Phone and Laptop.\n');

  // Step 6: Rahul selects "Ask Parent"
  console.log('[Step 6] Rahul sends "Ask Parent" request from phone for "youtube.com"...');
  const request = await requestService.createRequest(
    rahul.id,
    phone.id,
    'youtube.com',
    'Need a maths tutorial for school project'
  );
  console.log(`✅ Request ID: ${request.id} | Reason: "${request.reason}" | Status: ${request.status}\n`);

  // Step 7: Parent receives request and approves for 15 minutes
  console.log('[Step 7] Parent approves access for 15 minutes...');
  const { request: approvedReq, policy: policyV3 } = await requestService.resolveRequest(
    request.id,
    parent.id,
    'APPROVE',
    '15m'
  );
  console.log(`✅ Request Status: ${approvedReq.status} | Expires At: ${approvedReq.expiresAt}`);
  console.log(`✅ Policy updated to Version v${policyV3.version}\n`);

  // Step 8: Both devices re-evaluate youtube.com (Active temporary grant)
  console.log('[Step 8] Both devices synchronize new policy with temporary approval...');
  const phoneCheck2 = evaluatePolicy(policyV3, 'youtube.com');
  const laptopCheck2 = evaluatePolicy(policyV3, 'm.youtube.com');

  console.log(`📱 Phone Access to youtube.com: ${phoneCheck2.action} (${phoneCheck2.reason})`);
  console.log(`💻 Laptop Access to youtube.com: ${laptopCheck2.action} (${laptopCheck2.reason})`);

  if (phoneCheck2.action !== 'ALLOW' || laptopCheck2.action !== 'ALLOW') {
    throw new Error('❌ Temporary grant failed! YouTube should be allowed on both devices.');
  }
  console.log('✅ YouTube is temporarily ALLOWED on both Phone and Laptop.\n');

  // Step 9: Simulate TTL expiration
  console.log('[Step 9] Simulating TTL expiration (1 hour into the future)...');
  const futureTime = new Date(Date.now() + 60 * 60 * 1000); // 1 hour later
  const phoneCheck3 = evaluatePolicy(policyV3, 'youtube.com', futureTime);
  const laptopCheck3 = evaluatePolicy(policyV3, 'youtube.com', futureTime);

  console.log(`📱 Phone Access to youtube.com after expiry: ${phoneCheck3.action} (${phoneCheck3.reason})`);
  console.log(`💻 Laptop Access to youtube.com after expiry: ${laptopCheck3.action} (${laptopCheck3.reason})`);

  if (phoneCheck3.action !== 'BLOCK' || laptopCheck3.action !== 'BLOCK') {
    throw new Error('❌ Expiration check failed! YouTube should revert to BLOCKED after TTL.');
  }
  console.log('✅ YouTube automatically reverted to BLOCKED after expiration without parent action.\n');

  console.log('======================================================================');
  console.log('🎉 SECTION 22 MVP ACCEPTANCE CRITERIA FULLY VERIFIED & PASSED!');
  console.log('======================================================================');
}

runE2EAcceptanceScenario().catch((err) => {
  console.error('Test Failed:', err);
  process.exit(1);
});
