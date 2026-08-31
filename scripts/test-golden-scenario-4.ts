import { authService } from '../packages/backend/dist/src/services/auth.service';
import { childService } from '../packages/backend/dist/src/services/child.service';
import { deviceService } from '../packages/backend/dist/src/services/device.service';
import { notificationService } from '../packages/backend/dist/src/services/notification.service';
import assert from 'node:assert';

async function runGoldenScenario4() {
  console.log('======================================================================');
  console.log('🧪 Running SafeBrowse Stage 5 Golden Scenario 4');
  console.log('   (Protection Failure Detection, Tamper Alerting & Recovery)');
  console.log('======================================================================\n');

  // Step 1: Parent registration and Rahul creation
  const reg = authService.register('gs4_parent@porwal.io', 'StrongPassphrase2026!GS4', 'Sarah (Parent)');
  authService.verifyEmail(reg.emailVerificationToken);
  const { child: rahul } = childService.createChild(reg.user.id, 'Rahul', 10, '🧒');
  const parent = reg.user;

  // Step 2: Pair Rahul's Android Phone
  console.log("[Step 1] Pairing Rahul's Android Phone...");
  const pair = deviceService.generatePairingCode(parent.id, rahul.id);
  const { device: phone } = deviceService.pairDevice(pair.code, "Rahul's Android Phone", 'android');
  console.log(`✅ Phone paired: ${phone.name} (ID: ${phone.id}) | Status: ${phone.healthState}\n`);
  assert.strictEqual(phone.healthState, 'PROTECTED');

  // Step 3: Child disables VPN / Competing VPN takes over -> Enforcement becomes inactive
  console.log('[Step 2] ⚠️ Child disables Android VPN / Competing VPN activates...');
  const failHeartbeat = deviceService.processHeartbeat({
    deviceId: phone.id,
    deviceToken: phone.deviceToken,
    activePolicyVersion: phone.activePolicyVersion,
    enforcementActive: false, // VPN INACTIVE
    platform: 'android',
    agentVersion: '1.0.0',
  });

  const updatedPhone = deviceService.getDevicesForChild(rahul.id).find((d) => d.id === phone.id);
  console.log(`📱 Phone Health State: ${updatedPhone?.healthState} | Health Status: ${updatedPhone?.healthStatus}`);
  assert.strictEqual(updatedPhone?.healthState, 'INACTIVE');
  console.log('✅ Backend successfully detected enforcement failure!\n');

  // Step 4: Verify parent receives high-value notification
  console.log('[Step 3] 🔔 Checking Parent High-Value Notifications...');
  const notifications1 = notificationService.getNotificationsForParent(parent.id);
  const failureNotif = notifications1.find((n) => n.type === 'ENFORCEMENT_STOPPED');
  assert.ok(failureNotif);
  console.log(`✅ Parent Alert Received: "${failureNotif.title}" - ${failureNotif.message}\n`);

  // Step 5: Protection restored on phone
  console.log('[Step 4] 🛡️ SafeBrowse VPN is re-enabled & protection restored...');
  deviceService.processHeartbeat({
    deviceId: phone.id,
    deviceToken: phone.deviceToken,
    activePolicyVersion: phone.activePolicyVersion,
    enforcementActive: true, // RESTORED
    platform: 'android',
    agentVersion: '1.0.0',
  });

  const restoredPhone = deviceService.getDevicesForChild(rahul.id).find((d) => d.id === phone.id);
  console.log(`📱 Phone Health State: ${restoredPhone?.healthState}`);
  assert.strictEqual(restoredPhone?.healthState, 'PROTECTED');
  console.log('✅ Device successfully recovered to PROTECTED state!\n');

  // Step 6: Verify parent receives recovery notification
  console.log('[Step 5] 🔔 Checking Recovery Notification...');
  const notifications2 = notificationService.getNotificationsForParent(parent.id);
  const recoveryNotif = notifications2.find((n) => n.type === 'PROTECTION_RESTORED');
  assert.ok(recoveryNotif);
  console.log(`✅ Parent Recovery Alert: "${recoveryNotif.title}" - ${recoveryNotif.message}\n`);

  console.log('======================================================================');
  console.log('🎉 GOLDEN SCENARIO 4 FULLY CERTIFIED & PASSED!');
  console.log('======================================================================');
}

runGoldenScenario4().catch((err) => {
  console.error('Scenario 4 Failed:', err);
  process.exit(1);
});
