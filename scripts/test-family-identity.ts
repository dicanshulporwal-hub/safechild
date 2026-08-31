import { authService } from '../packages/backend/src/services/auth.service';
import { familyService } from '../packages/backend/src/services/family.service';
import { profileService } from '../packages/backend/src/services/profile.service';
import { childService } from '../packages/backend/src/services/child.service';
import { deviceService } from '../packages/backend/src/services/device.service';
import { policyService } from '../packages/backend/src/services/policy.service';
import { requestService } from '../packages/backend/src/services/request.service';
import { evaluatePolicy } from '../packages/shared/src/policy/evaluator';
import { db } from '../packages/backend/src/db/store';
import assert from 'node:assert';

async function runFamilyIdentitySuite() {
  console.log('======================================================================');
  console.log('👨‍👩‍👧‍👦 SafeBrowse Parent Identity, Multi-Parent & Family Management Suite');
  console.log('======================================================================\n');

  // 1. Parent Profile & Default Family Creation
  console.log('[Step 1] Parent Registration & Automatic Family Creation...');
  const anshulEmail = `anshul_${Date.now()}@porwal.io`;
  const { user: anshul, token: anshulToken } = authService.register(
    anshulEmail,
    'StrongPassword2026!',
    'Anshul Porwal',
    'Firefox on Windows 11',
    '192.168.1.100'
  );

  assert.strictEqual(anshul.name, 'Anshul Porwal');
  console.log(`✅ Parent Registered: ${anshul.name} (${anshul.email})`);

  // Verify family auto-creation
  const familyOverview = familyService.getFamilyOverview(anshul.id);
  assert.strictEqual(familyOverview.myRole, 'OWNER');
  assert.strictEqual(familyOverview.family.ownerUserId, anshul.id);
  console.log(`✅ Family Initialized: '${familyOverview.family.name}' (Role: ${familyOverview.myRole})`);

  // Update profile details
  profileService.updateProfile(anshul.id, {
    mobileNumber: '+1 (555) 234-5678',
    timezone: 'America/New_York',
    language: 'en-US',
    notificationPrefs: {
      emailAlerts: true,
      pushNotifications: true,
      requestAlerts: true,
      tamperAlerts: true,
      weeklySummary: false,
    },
  });
  const anshulProfile = profileService.getProfile(anshul.id);
  assert.strictEqual(anshulProfile.mobileNumber, '+1 (555) 234-5678');
  assert.strictEqual(anshulProfile.timezone, 'America/New_York');
  console.log(`✅ Profile updated with mobile number and timezone.`);

  // 2. Change Password & Session Invalidation
  console.log('\n[Step 2] Change Password with Bcrypt Hashing & Session Invalidation...');
  // Simulate 2nd session
  const oldSessionLogin = authService.login(anshulEmail, 'StrongPassword2026!', 'Chrome on Android');
  assert.ok(oldSessionLogin.token);

  profileService.changePassword(anshul.id, 'StrongPassword2026!', 'NewHardPassword2026!', anshulToken);
  console.log(`🔑 Password changed successfully.`);

  // Verify login with new password succeeds
  const loginNew = authService.login(anshulEmail, 'NewHardPassword2026!');
  assert.ok(loginNew.token);

  // Verify old session token was revoked
  assert.throws(() => {
    authService.verifyToken(oldSessionLogin.token!);
  }, /revoked/i);
  console.log(`🔒 Old session token strictly revoked upon password change.`);

  // 3. MFA Setup (TOTP Authenticator & Recovery Codes)
  console.log('\n[Step 3] Multi-Factor Authentication (TOTP & Recovery Codes)...');
  const mfaSetup = profileService.setupMfa(anshul.id);
  assert.ok(mfaSetup.secret);
  assert.ok(mfaSetup.otpAuthUrl.includes('SafeBrowse'));
  console.log(`🛡️ MFA Secret generated: ${mfaSetup.secret.substring(0, 8)}...`);

  // Verify and activate MFA
  const { recoveryCodes } = profileService.verifyAndEnableMfa(anshul.id, '123456');
  assert.strictEqual(recoveryCodes.length, 8);
  console.log(`✅ MFA Activated! Generated 8 single-use recovery codes (e.g. ${recoveryCodes[0]})`);

  // Verify login now challenges for MFA
  const mfaChallenge = authService.login(anshulEmail, 'NewHardPassword2026!');
  assert.strictEqual(mfaChallenge.mfaRequired, true);
  assert.ok(mfaChallenge.mfaTicket);
  console.log(`🛡️ Login challenged with MFA ticket.`);

  // Complete login with MFA OTP
  const mfaCompleted = authService.verifyMfaLogin(mfaChallenge.mfaTicket!, '123456');
  assert.ok(mfaCompleted.token);
  console.log(`✅ MFA login completed with 6-digit code.`);

  // Test single-use recovery code login
  const mfaChallenge2 = authService.login(anshulEmail, 'NewHardPassword2026!');
  const testRecoveryCode = recoveryCodes[0];
  const recoveryLogin = authService.verifyMfaLogin(mfaChallenge2.mfaTicket!, testRecoveryCode);
  assert.ok(recoveryLogin.token);
  console.log(`✅ Login completed with recovery code '${testRecoveryCode}'.`);

  // Verify used recovery code cannot be reused (replay prevention)
  assert.strictEqual(profileService.verifyRecoveryCode(anshul.id, testRecoveryCode), false);
  console.log(`🔒 Recovery code consumed and cannot be replayed.`);

  // 4. Co-Parent Invitation & Onboarding Flow
  console.log('\n[Step 4] Co-Parent Invitation Flow (Anshul invites Priya)...');
  const priyaEmail = `priya_${Date.now()}@porwal.io`;
  const invitation = familyService.inviteParent(familyOverview.family.id, anshul.id, priyaEmail, 'PARENT');
  assert.strictEqual(invitation.status, 'PENDING');
  assert.ok(invitation.token.startsWith('inv_'));
  console.log(`✉️ Secure invitation generated for ${invitation.email} (Token: ${invitation.token})`);

  // Priya registers an account
  const { user: priya } = authService.register(priyaEmail, 'PriyaSecret2026!', 'Priya Porwal');
  console.log(`👤 Priya created account: ${priya.name}`);

  // Priya accepts invitation
  const joinResult = familyService.acceptInvitation(invitation.token, priya.id);
  assert.strictEqual(joinResult.role, 'PARENT');
  assert.strictEqual(joinResult.family.id, familyOverview.family.id);
  console.log(`🎉 Priya successfully joined '${joinResult.family.name}' as PARENT.`);

  // 5. Multi-Parent Child Management & Ask Parent Attribution
  console.log('\n[Step 5] Multi-Parent Child Management & Ask Parent Workflow...');
  // Anshul creates Rahul
  const { child: rahul } = childService.createChild(anshul.id, 'Rahul', 11);
  console.log(`👶 Child 'Rahul' created in family.`);

  // Priya pairs a device for Rahul
  const pCode = deviceService.generatePairingCode(priya.id, rahul.id);
  const { device: androidDev } = deviceService.pairDevice(pCode.code, "Rahul's Android", 'android', '1.0.0');
  console.log(`📱 Priya paired device: ${androidDev.name}`);

  // Anshul blocks youtube.com
  let rahulPolicy = policyService.addRule(rahul.id, 'youtube.com', 'BLOCK', 'Study Hours');
  const evalBlocked = evaluatePolicy(rahulPolicy, 'youtube.com');
  assert.strictEqual(evalBlocked.action, 'BLOCK');
  console.log(`🚫 youtube.com is strictly BLOCKED by policy.`);

  // Rahul requests access
  const accessReq = requestService.createRequest(rahul.id, androidDev.id, 'youtube.com', 'Tutorial for school project');
  console.log(`📨 Rahul requested 'youtube.com' (Req ID: ${accessReq.id})`);

  // Priya approves request for 15 minutes
  const { request: resolvedReq, policy: updatedPol } = requestService.resolveRequest(
    accessReq.id,
    priya.id,
    'APPROVE',
    '15m'
  );
  assert.strictEqual(resolvedReq.status, 'APPROVED');
  assert.strictEqual(resolvedReq.resolvedByName, 'Priya Porwal');
  console.log(`✅ Request resolved: Approved by ${resolvedReq.resolvedByName} for 15 minutes.`);

  // Verify access is ALLOW on device
  const evalAllowed = evaluatePolicy(updatedPol!, 'youtube.com');
  assert.strictEqual(evalAllowed.action, 'ALLOW');
  console.log(`🟢 Device Decision: ${evalAllowed.action} (${evalAllowed.reason})`);

  // 6. Family Activity Audit Trail
  console.log('\n[Step 6] Family Activity Audit Trail...');
  const auditLogs = familyService.getAuditLogs(familyOverview.family.id, anshul.id);
  assert.ok(auditLogs.length >= 3);
  const coparentJoinedLog = auditLogs.find((l) => l.action === 'COPARENT_JOINED');
  const requestResolvedLog = auditLogs.find((l) => l.action === 'REQUEST_RESOLVED');
  assert.ok(coparentJoinedLog);
  assert.ok(requestResolvedLog);
  console.log(`📜 Verified Audit Logs:`);
  console.log(`   • [${coparentJoinedLog?.action}] ${coparentJoinedLog?.details}`);
  console.log(`   • [${requestResolvedLog?.action}] ${requestResolvedLog?.details}`);

  // 7. Security & Role Authorization Negative Tests
  console.log('\n[Step 7] Security & Role Authorization Negative Tests...');
  // Negative: Priya (PARENT) cannot remove Anshul (OWNER)
  assert.throws(() => {
    familyService.removeMember(familyOverview.family.id, anshul.id, priya.id);
  }, /Forbidden|Only the Family Owner/i);
  console.log(`🔒 Negative Test Passed: PARENT cannot remove Family Owner.`);

  // Negative: Non-family member cannot access Porwal Family audit logs
  const { user: outsider } = authService.register(`outsider_${Date.now()}@other.io`, 'Pass12345!', 'Outsider');
  assert.throws(() => {
    familyService.getAuditLogs(familyOverview.family.id, outsider.id);
  }, /Forbidden|do not belong/i);
  console.log(`🔒 Negative Test Passed: Outsider cannot access family data.`);

  // Transfer ownership from Anshul to Priya
  console.log('\n[Step 8] Transferring Family Ownership to Priya...');
  familyService.transferOwnership(familyOverview.family.id, priya.id, anshul.id);
  const updatedFamily = familyService.getFamilyOverview(priya.id);
  assert.strictEqual(updatedFamily.myRole, 'OWNER');
  assert.strictEqual(updatedFamily.family.ownerUserId, priya.id);
  console.log(`👑 Ownership successfully transferred. Priya is now OWNER.`);

  console.log('\n======================================================================');
  console.log('🎉 PARENT IDENTITY & FAMILY MANAGEMENT SUITE 100% PASSED!');
  console.log('======================================================================');
}

runFamilyIdentitySuite().catch((err) => {
  console.error('Suite failed:', err);
  process.exit(1);
});
