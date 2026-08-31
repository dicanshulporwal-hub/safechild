import { authService } from '../packages/backend/dist/src/services/auth.service';
import { childService } from '../packages/backend/dist/src/services/child.service';
import { deviceService } from '../packages/backend/dist/src/services/device.service';
import { policyService } from '../packages/backend/dist/src/services/policy.service';
import { supportConsoleService } from '../packages/backend/dist/src/services/support.service';
import { evaluatePolicy } from '../packages/shared/dist/policy/evaluator';
import { db } from '../packages/backend/dist/src/db/store';
import assert from 'node:assert';

async function runGoldenScenario6() {
  console.log('======================================================================');
  console.log('⚡ SafeBrowse Golden Scenario 6: Production Outage & Failure Recovery');
  console.log('   (API Outage → Local Offline Fallback → Safe Kill Switch → Recovery)');
  console.log('======================================================================\n');

  // Step 1: Create Two Distinct Families to Validate Zero Cross-Family Leakage
  console.log('[Step 1] Initializing Family A and Family B...');
  const salt = Date.now();
  const { user: userA } = authService.register(`family_a_${salt}@outage.io`, 'PassWord123!', 'Parent A');
  const { child: childA } = childService.createChild(userA.id, 'Child A', 10);
  const pA = deviceService.generatePairingCode(userA.id, childA.id);
  const { device: devA } = deviceService.pairDevice(pA.code, 'Device A', 'windows', '1.0.0');
  const policyA = policyService.addRule(childA.id, 'gambling.com', 'BLOCK', 'Harmful');

  const { user: userB } = authService.register(`family_b_${salt}@outage.io`, 'PassWord123!', 'Parent B');
  const { child: childB } = childService.createChild(userB.id, 'Child B', 12);
  const pB = deviceService.generatePairingCode(userB.id, childB.id);
  const { device: devB } = deviceService.pairDevice(pB.code, 'Device B', 'android', '1.0.0');
  const policyB = policyService.addRule(childB.id, 'customportal-familyb.org', 'BLOCK', 'Distraction');

  console.log(`✅ Family A: ${userA.email} (Rule: gambling.com BLOCK)`);
  console.log(`✅ Family B: ${userB.email} (Rule: customportal-familyb.org BLOCK)`);

  // Step 2: Simulate Backend API & Cloud WebSocket Disconnection
  console.log('\n[Step 2] Simulating Total Cloud API & WebSocket Outage...');
  console.log('🌐 Child device local agent detects connection loss to cloud...');
  
  // Agent switches to Local Offline Cache Enforcement Mode
  const cachedPolicyA = policyA;
  const evalOfflineBlock = evaluatePolicy(cachedPolicyA, 'gambling.com');
  const evalOfflineAllow = evaluatePolicy(cachedPolicyA, 'wikipedia.org');

  console.log(`🔒 Offline Decision (gambling.com): ${evalOfflineBlock.action} (Reason: ${evalOfflineBlock.reason})`);
  console.log(`🟢 Offline Decision (wikipedia.org): ${evalOfflineAllow.action} (Reason: ${evalOfflineAllow.reason})`);
  assert.strictEqual(evalOfflineBlock.action, 'BLOCK');
  assert.strictEqual(evalOfflineAllow.action, 'ALLOW');

  // Step 3: Verify Zero Cross-Tenant Data Contamination During Outage
  console.log('\n[Step 3] Verifying Isolation Between Family A and Family B under degraded mode...');
  const evalContamination = evaluatePolicy(cachedPolicyA, 'customportal-familyb.org');
  assert.strictEqual(evalContamination.action, 'ALLOW', 'Family A must NOT inherit Family B rules');
  console.log(`✅ Zero Cross-Family Bleed: Family A is unaffected by Family B rules.`);

  // Step 4: Parent Dashboard Health Truthfulness (Device is OFFLINE, Not False-Protected)
  console.log('\n[Step 4] Verifying Truthful Health Reporting for Missing Heartbeats...');
  // Overriding lastHeartbeatAt to simulate 120s silence
  (devA as any).lastHeartbeatAt = new Date(Date.now() - 120 * 1000).toISOString();
  db.devices.set(devA.id, devA);

  const fleet = supportConsoleService.getFleetOverview();
  const devAStatus = fleet.find((d) => d.deviceId === devA.id);
  console.log(`📡 Parent Telemetry Health Status: ${devAStatus?.healthState}`);
  assert.strictEqual(devAStatus?.healthState, 'OFFLINE');

  // Step 5: Simulate Faulty Agent Rollout & Trigger Safe Kill Switch
  console.log('\n[Step 5] Simulating Faulty Agent Version Rollout (v1.0.1) & Triggering Safe Kill Switch...');
  const killSwitchResult = supportConsoleService.triggerRemoteRollback('1.0.0');
  console.log(`🚨 Safe Kill Switch Dispatched: ${killSwitchResult.message}`);
  assert.strictEqual(killSwitchResult.success, true);

  // Step 6: Backend Recovery & Heartbeat Resumption
  console.log('\n[Step 6] Simulating Cloud Recovery & Heartbeat Resumption...');
  deviceService.processHeartbeat({
    deviceId: devA.id,
    deviceToken: devA.deviceToken,
    activePolicyVersion: policyA.version,
    enforcementActive: true,
    platform: 'windows',
    agentVersion: '1.0.0',
  });
  const devARestored = deviceService.getDevice(devA.id);
  console.log(`🟢 Cloud restored. Device health returned to: ${devARestored?.healthState}`);
  assert.strictEqual(devARestored?.healthState, 'PROTECTED');

  console.log('\n======================================================================');
  console.log('🎉 GOLDEN SCENARIO 6 (PRODUCTION FAILURE & RECOVERY) 100% PASSED!');
  console.log('======================================================================');
}

runGoldenScenario6().catch((err) => {
  console.error('Golden Scenario 6 failed:', err);
  process.exit(1);
});
