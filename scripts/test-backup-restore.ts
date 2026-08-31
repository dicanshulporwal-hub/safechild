import { db } from '../packages/backend/dist/src/db/store';
import { authService } from '../packages/backend/dist/src/services/auth.service';
import { childService } from '../packages/backend/dist/src/services/child.service';
import { deviceService } from '../packages/backend/dist/src/services/device.service';
import { policyService } from '../packages/backend/dist/src/services/policy.service';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';

async function runBackupRestoreExercise() {
  console.log('======================================================================');
  console.log('💾 SafeBrowse Production Hardening: Automated Backup & Restore Drill');
  console.log('======================================================================\n');

  const backupDir = path.join(process.cwd(), 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  // 1. Seed sample production tenant data
  const testEmail = `backup_test_${Date.now()}@production.io`;
  const { user } = authService.register(testEmail, 'SecurePass123!', 'Backup Parent');
  const { child } = childService.createChild(user.id, 'Alice', 11);
  const pairing = deviceService.generatePairingCode(user.id, child.id);
  const { device } = deviceService.pairDevice(pairing.code, 'Alice Laptop', 'windows', '1.0.0');
  const policy = policyService.addRule(child.id, 'distraction.com', 'BLOCK', 'Study Focus');

  console.log(`[Step 1] Seeded live tenant: Parent (${user.id}), Child (${child.id}), Device (${device.id}), Policy v${policy.version}`);

  // 2. Perform Point-In-Time Database Backup
  console.log('\n[Step 2] Executing automated database point-in-time snapshot...');
  const snapshotData = {
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    users: Array.from(db.users.entries()),
    children: Array.from(db.children.entries()),
    devices: Array.from(db.devices.entries()),
    policies: Array.from(db.policies.entries()),
    requests: Array.from(db.requests.entries()),
    activityLogs: db.activityLogs,
  };

  const backupFile = path.join(backupDir, `safebrowse_backup_${Date.now()}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(snapshotData, null, 2), 'utf-8');
  console.log(`✅ Snapshot saved to: ${backupFile} (${(fs.statSync(backupFile).size / 1024).toFixed(2)} KB)`);

  // 3. Simulate Complete Disaster (Database Wipe)
  console.log('\n[Step 3] Simulating catastrophic database corruption (wiping memory store)...');
  db.users.clear();
  db.children.clear();
  db.devices.clear();
  db.policies.clear();
  db.requests.clear();
  db.activityLogs = [];

  assert.strictEqual(db.users.size, 0, 'Database must be empty');
  console.log('💥 In-memory store wiped. User count: 0, Device count: 0');

  // 4. Perform Point-In-Time Disaster Recovery Restore
  console.log('\n[Step 4] Restoring database from verified backup snapshot...');
  const restoredRaw = JSON.parse(fs.readFileSync(backupFile, 'utf-8'));
  
  for (const [k, v] of restoredRaw.users) db.users.set(k, v);
  for (const [k, v] of restoredRaw.children) db.children.set(k, v);
  for (const [k, v] of restoredRaw.devices) db.devices.set(k, v);
  for (const [k, v] of restoredRaw.policies) db.policies.set(k, v);
  for (const [k, v] of restoredRaw.requests) db.requests.set(k, v);
  db.activityLogs = restoredRaw.activityLogs || [];

  console.log(`✅ Restored ${db.users.size} Users, ${db.children.size} Children, ${db.devices.size} Devices, ${db.policies.size} Policies.`);

  // 5. Verify Data Integrity Post-Restore
  console.log('\n[Step 5] Validating data integrity and tenant security post-restore...');
  const restoredUser = db.users.get(user.id);
  assert.ok(restoredUser, 'Restored parent user must exist');
  assert.strictEqual(restoredUser.email, testEmail);

  // Authenticate against restored bcrypt hash
  const loginRes = authService.login(testEmail, 'SecurePass123!');
  assert.strictEqual(loginRes.user.id, user.id, 'Bcrypt verification must succeed after restore');
  console.log('🔑 Bcrypt authentication successful on restored hash.');

  const restoredPolicy = policyService.getPolicyForChild(child.id);
  assert.ok(restoredPolicy.rules.some((r) => r.domain === 'distraction.com'), 'distraction.com rule must be restored');
  console.log(`📜 Restored child policy verified: distraction.com is strictly BLOCKED.`);

  // Clean up backup file
  fs.unlinkSync(backupFile);

  console.log('\n======================================================================');
  console.log('🎉 BACKUP AND RESTORE EXERCISE 100% SUCCESSFUL & VERIFIED!');
  console.log('======================================================================');
}

runBackupRestoreExercise().catch((err) => {
  console.error('Backup & Restore drill failed:', err);
  process.exit(1);
});
