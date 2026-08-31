import { authService } from '../packages/backend/src/services/auth.service';
import { childService } from '../packages/backend/src/services/child.service';
import { usageService } from '../packages/backend/src/services/usage.service';
import { requestService } from '../packages/backend/src/services/request.service';
import { policyService } from '../packages/backend/src/services/policy.service';
import { familyService } from '../packages/backend/src/services/family.service';
import { evaluatePolicy, getSafeSearchRedirect } from '../packages/shared/src/policy/evaluator';
import { db } from '../packages/backend/src/db/store';
import assert from 'node:assert';

async function runStage9TestSuite() {
  console.log('======================================================================');
  console.log('🚀 SafeBrowse Stage 9 — Time Controls & Safer Search Test Suite');
  console.log('======================================================================\n');

  const timestamp = Date.now();

  // -------------------------------------------------------------------------
  // 1. Setup Parent, Child & Daily Budget
  // -------------------------------------------------------------------------
  console.log('[Test 1] User Registration & Screen Time Daily Budget Initialization...');
  
  const parent = authService.register(
    `anshul_stage9_${timestamp}@porwal.io`,
    'StrongPassphrase2026!Stage9Secure',
    'Anshul Porwal'
  );
  authService.verifyEmail(parent.emailVerificationToken);
  const childRes = childService.createChild(parent.user.id, 'Rahul', 11, '👦');
  const childId = childRes.child.id;

  // Set 60 minutes/day YouTube daily allowance
  const budget = usageService.setUsageBudget(
    childId,
    'youtube.com',
    'DOMAIN',
    60,
    parent.user.id
  );
  assert.strictEqual(budget.dailyLimitSeconds, 3600);
  assert.strictEqual(budget.target, 'youtube.com');
  console.log(`✅ Daily allowance initialized: 60 minutes (3600s) on 'youtube.com' for Rahul.`);

  // -------------------------------------------------------------------------
  // 2. Golden Scenario 10 — Cross-Device Daily Limit & MORE_TIME Request
  // -------------------------------------------------------------------------
  console.log('\n[Test 2: Golden Scenario 10] Cross-Device Daily Limit & MORE_TIME Request...');
  
  // Step A: Android watches 35 min (2100s)
  const androidSync1 = usageService.recordUsageSync(
    childId,
    'dev-android-1',
    'youtube.com',
    'DOMAIN',
    2100
  );
  assert.strictEqual(androidSync1.consumedSeconds, 2100);
  assert.strictEqual(androidSync1.remainingSeconds, 1500); // 25 min remaining
  assert.strictEqual(androidSync1.isLimitReached, false);
  console.log(`📱 Android watches 35 min -> Remaining: 25 min (1500s)`);

  // Step B: Windows watches 20 min (1200s)
  const winSync1 = usageService.recordUsageSync(
    childId,
    'dev-windows-1',
    'youtube.com',
    'DOMAIN',
    1200
  );
  assert.strictEqual(winSync1.consumedSeconds, 3300); // 55 min total
  assert.strictEqual(winSync1.remainingSeconds, 300); // 5 min remaining
  assert.strictEqual(winSync1.isLimitReached, false);
  console.log(`💻 Windows watches 20 min -> Remaining: 5 min (300s)`);

  // Step C: Android watches 5 min (300s) -> Quota Exhausted!
  const androidSync2 = usageService.recordUsageSync(
    childId,
    'dev-android-1',
    'youtube.com',
    'DOMAIN',
    300
  );
  assert.strictEqual(androidSync2.consumedSeconds, 3600); // 60 min total
  assert.strictEqual(androidSync2.remainingSeconds, 0);
  assert.strictEqual(androidSync2.isLimitReached, true);
  console.log(`📱 Android watches 5 min -> Quota Exhausted! (60/60 min consumed).`);

  // Verify policy evaluation on both Android & Windows yields BLOCK with USAGE_LIMIT_EXHAUSTED
  const policy = db.policies.get(childId)!;
  const evalBlocked = evaluatePolicy(policy, 'youtube.com', new Date(), 3600);
  assert.strictEqual(evalBlocked.action, 'BLOCK');
  assert.strictEqual(evalBlocked.reason, 'USAGE_LIMIT_EXHAUSTED');
  assert.ok(evalBlocked.explanation?.includes('Daily screen-time limit of 60 minutes reached'));
  console.log(`🔒 Policy Evaluator correctly BLOCKS 'youtube.com' with reason: 'USAGE_LIMIT_EXHAUSTED'.`);

  // Step D: Rahul asks for More Time (+15 min)
  const moreTimeReq = requestService.createRequest(
    childId,
    'dev-android-1',
    'youtube.com',
    'Need 15 min to finish coding video tutorial'
  );
  moreTimeReq.type = 'MORE_TIME';
  db.requests.set(moreTimeReq.id, moreTimeReq);

  // Parent grants +15m
  const resolveRes = requestService.resolveRequest(
    moreTimeReq.id,
    parent.user.id,
    'APPROVE',
    '15m'
  );
  assert.strictEqual(resolveRes.request.status, 'APPROVED');

  // Verify updated policy has +15m (900s) bonus time
  const updatedPolicy = db.policies.get(childId)!;
  const updatedBudget = updatedPolicy.usageBudgets?.find((b) => b.target === 'youtube.com')!;
  assert.strictEqual(updatedBudget.bonusSeconds, 900);

  // Verify both devices now see 15 min available
  const evalBonus = evaluatePolicy(updatedPolicy, 'youtube.com', new Date(), 3600);
  assert.strictEqual(evalBonus.action, 'ALLOW');
  console.log(`🎉 Parent approved +15m bonus. Policy unblocks YouTube (15 min available).`);

  // Step E: 15 min consumed -> Returns to BLOCK
  const bonusConsumedSync = usageService.recordUsageSync(
    childId,
    'dev-android-1',
    'youtube.com',
    'DOMAIN',
    900
  );
  assert.strictEqual(bonusConsumedSync.consumedSeconds, 4500); // 75 min total
  assert.strictEqual(bonusConsumedSync.remainingSeconds, 0);
  assert.strictEqual(bonusConsumedSync.isLimitReached, true);

  const evalFinalBlock = evaluatePolicy(updatedPolicy, 'youtube.com', new Date(), 4500);
  assert.strictEqual(evalFinalBlock.action, 'BLOCK');
  assert.strictEqual(evalFinalBlock.reason, 'USAGE_LIMIT_EXHAUSTED');
  console.log(`🔒 Bonus 15 min consumed. Both devices returned to BLOCK. Golden Scenario 10 PASSED.`);

  // -------------------------------------------------------------------------
  // 3. Golden Scenario 11 — Offline Quota Accumulation & Cloud Reconciliation
  // -------------------------------------------------------------------------
  console.log('\n[Test 3: Golden Scenario 11] Offline Quota Accumulation & Cloud Reconciliation...');
  
  // Set Roblox quota: 60 min
  const robloxBudget = usageService.setUsageBudget(childId, 'roblox.com', 'DOMAIN', 60, parent.user.id);
  assert.strictEqual(robloxBudget.dailyLimitSeconds, 3600);

  // Windows goes offline and accumulates 25 min (1500s) locally
  // Android stays online and consumes 30 min (1800s)
  usageService.recordUsageSync(childId, 'dev-android-1', 'roblox.com', 'DOMAIN', 1800);

  // Windows reconnects and syncs its offline 25 min (1500s)
  const robloxSync = usageService.recordUsageSync(childId, 'dev-windows-1', 'roblox.com', 'DOMAIN', 1500);
  
  // Total = 1800 + 1500 = 3300s (55 min). Remaining = 300s (5 min).
  assert.strictEqual(robloxSync.consumedSeconds, 3300);
  assert.strictEqual(robloxSync.remainingSeconds, 300);
  assert.strictEqual(robloxSync.isLimitReached, false);
  console.log(`✅ Cloud reconciled offline usage: Total 55 min used, exactly 5 min remaining without duplicate counting.`);
  console.log(`Golden Scenario 11 PASSED.`);

  // -------------------------------------------------------------------------
  // 4. Golden Scenario 12 — Clock Rollback & Time Tamper Protection
  // -------------------------------------------------------------------------
  console.log('\n[Test 4: Golden Scenario 12] Clock Rollback & Time Tamper Protection...');
  
  // Gaming category quota: 30 min (1800s)
  usageService.setUsageBudget(childId, 'GAMING', 'CATEGORY', 30, parent.user.id);
  usageService.recordUsageSync(childId, 'dev-android-1', 'GAMING', 'CATEGORY', 1800);

  // Child changes system clock backward 5 hours (e.g. from 18:00 to 13:00)
  const backwardTime = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
  
  const tamperSync = usageService.recordUsageSync(
    childId,
    'dev-android-1',
    'GAMING',
    'CATEGORY',
    0,
    backwardTime
  );

  // Consumed quota MUST NOT be restored
  assert.strictEqual(tamperSync.consumedSeconds, 1800);
  assert.strictEqual(tamperSync.remainingSeconds, 0);
  assert.strictEqual(tamperSync.isLimitReached, true);

  // Verify Audit Log captured the clock tamper detection event
  const family = familyService.getOrCreateUserFamily(parent.user.id);
  const auditLogs = familyService.getAuditLogs(family.id, parent.user.id);
  const clockEvent = auditLogs.find((l) => l.action === 'CLOCK_TAMPER_DETECTED');
  assert.ok(clockEvent, 'Must record CLOCK_TAMPER_DETECTED audit event');
  console.log(`🛡️ Tamper Detected: Consumed quota remained intact at 30 min. Event recorded in Family Audit Trail.`);
  console.log(`Golden Scenario 12 PASSED.`);

  // -------------------------------------------------------------------------
  // 5. SafeSearch & YouTube Restricted Mode Redirection Tests
  // -------------------------------------------------------------------------
  console.log('\n[Test 5] SafeSearch & YouTube Restricted Mode Engine Verification...');
  
  const safeConfig = {
    googleSafeSearch: true,
    bingSafeSearch: true,
    duckDuckGoSafeSearch: true,
    youtubeRestrictedMode: 'STRICT' as const,
  };

  usageService.updateSafeSearch(childId, safeConfig, parent.user.id);

  // Google -> forcesafesearch.google.com
  const googleRedirect = getSafeSearchRedirect('google.com', safeConfig);
  assert.strictEqual(googleRedirect, 'forcesafesearch.google.com');

  // Bing -> strict.bing.com
  const bingRedirect = getSafeSearchRedirect('bing.com', safeConfig);
  assert.strictEqual(bingRedirect, 'strict.bing.com');

  // DuckDuckGo -> safe.duckduckgo.com
  const ddgRedirect = getSafeSearchRedirect('duckduckgo.com', safeConfig);
  assert.strictEqual(ddgRedirect, 'safe.duckduckgo.com');

  // YouTube (Strict) -> restrict.youtube.com
  const ytRedirect = getSafeSearchRedirect('youtube.com', safeConfig);
  assert.strictEqual(ytRedirect, 'restrict.youtube.com');
  console.log(`✅ SafeSearch CNAME Redirections verified for Google, Bing, DuckDuckGo & YouTube STRICT.`);

  // -------------------------------------------------------------------------
  // 6. Privacy-Preserving Weekly Digest
  // -------------------------------------------------------------------------
  console.log('\n[Test 6] Privacy-Preserving Weekly Summary Digest Verification...');
  
  const digest = usageService.getWeeklyDigest(parent.user.id);
  assert.ok(digest.period);
  assert.strictEqual(typeof digest.uptimePercent, 'number');
  assert.strictEqual(typeof digest.totalManagedEvents, 'number');
  assert.ok(digest.categoryBreakdown);
  assert.ok(digest.childrenSummaries);
  
  // Verify ZERO leak of full URLs, search queries, or page contents
  const serialized = JSON.stringify(digest);
  assert.ok(!serialized.includes('http://'));
  assert.ok(!serialized.includes('https://'));
  assert.ok(!serialized.includes('search?q='));
  console.log(`🔒 Weekly Digest verified: aggregates statistics with ZERO search query or full URL leakage.`);

  console.log('\n======================================================================');
  console.log('🎉 ALL STAGE 9 TIME CONTROLS & SAFER SEARCH TESTS 100% PASSED!');
  console.log('======================================================================\n');
}

runStage9TestSuite().catch((err) => {
  console.error('\n❌ STAGE 9 TEST SUITE FAILED:', err);
  process.exit(1);
});
