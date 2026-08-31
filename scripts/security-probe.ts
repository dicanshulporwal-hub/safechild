import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import http from 'http';
import { authService, getJwtSecret } from '../packages/backend/src/services/auth.service';
import { profileService } from '../packages/backend/src/services/profile.service';
import { deviceService } from '../packages/backend/src/services/device.service';
import { childService } from '../packages/backend/src/services/child.service';
import { db } from '../packages/backend/src/db/store';
import {
  generateBase32Secret,
  encryptMfaSecret,
  generateCurrentTotp,
} from '../packages/backend/src/utils/security';
import { app } from '../packages/backend/src/server';

let probeServer: http.Server;
let probePort: number = 0;

function makeRequest(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: any
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: probePort,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        let respBody = '';
        res.on('data', (chunk) => {
          respBody += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = respBody ? JSON.parse(respBody) : {};
            resolve({ status: res.statusCode || 500, body: parsed });
          } catch {
            resolve({ status: res.statusCode || 500, body: respBody });
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function runProbe() {
  await new Promise<void>((resolve) => {
    probeServer = http.createServer(app);
    probeServer.listen(0, '127.0.0.1', () => {
      probePort = (probeServer.address() as any).port;
      resolve();
    });
  });

  const probePass = 'ProbeStrongPassphrase2026!';
  const probeUserEmail = `probe-${nanoid(8)}@safebrowse.io`;
  const reg = authService.register(probeUserEmail, probePass, 'Probe Parent');
  const userId = reg.user.id;
  const decoded = authService.verifyToken(reg.accessToken);
  const sessionId = decoded.sessionId;

  // Set up child and device for device auth probes
  const { child } = childService.createChild(userId, 'ProbeChild', 10, '🧒');
  const pairing = deviceService.generatePairingCode(userId, child.id);
  const { device } = deviceService.pairDevice(pairing.code, 'Probe Device', 'windows', '1.0.0');

  // 1. Probe sessionlessSignedJwtAccepted
  let sessionlessSignedJwtAccepted = false;
  try {
    const sessionlessToken = jwt.sign(
      { userId, tokenVersion: 1, jti: `at_${nanoid(16)}`, sub: userId },
      getJwtSecret(),
      { algorithm: 'HS256', issuer: 'safebrowse-auth', audience: 'safebrowse-client', subject: userId }
    );
    authService.verifyToken(sessionlessToken);
    sessionlessSignedJwtAccepted = true;
  } catch {
    sessionlessSignedJwtAccepted = false;
  }

  // 2. Probe missingSubAccessTokenAccepted
  let missingSubAccessTokenAccepted = false;
  try {
    const noSubToken = jwt.sign(
      { userId, sessionId, tokenVersion: 1, jti: `at_${nanoid(16)}` },
      getJwtSecret(),
      { algorithm: 'HS256', issuer: 'safebrowse-auth', audience: 'safebrowse-client' }
    );
    authService.verifyToken(noSubToken);
    missingSubAccessTokenAccepted = true;
  } catch {
    missingSubAccessTokenAccepted = false;
  }

  // 3. Probe missingJtiAccessTokenAccepted
  let missingJtiAccessTokenAccepted = false;
  try {
    const noJtiToken = jwt.sign(
      { userId, sessionId, tokenVersion: 1, sub: userId },
      getJwtSecret(),
      { algorithm: 'HS256', issuer: 'safebrowse-auth', audience: 'safebrowse-client', subject: userId }
    );
    authService.verifyToken(noJtiToken);
    missingJtiAccessTokenAccepted = true;
  } catch {
    missingJtiAccessTokenAccepted = false;
  }

  // 4. Probe mfaTicketWithoutJtiAccepted
  let mfaTicketWithoutJtiAccepted = false;
  try {
    const forgedMfaTicketNoJti = jwt.sign(
      { userId, purpose: 'mfa_challenge', ticketId: `tkt_${nanoid(16)}` },
      getJwtSecret(),
      { algorithm: 'HS256', issuer: 'safebrowse-auth', audience: 'safebrowse-mfa' }
    );
    authService.verifyMfaLogin(forgedMfaTicketNoJti, '123456');
    mfaTicketWithoutJtiAccepted = true;
  } catch {
    mfaTicketWithoutJtiAccepted = false;
  }

  // 5. Probe recoveryCodesRegeneratedWithoutPasswordOrOtp
  let recoveryCodesRegeneratedWithoutPasswordOrOtp = false;
  try {
    const secret = generateBase32Secret();
    reg.user.mfaEnabled = true;
    reg.user.mfaSecret = encryptMfaSecret(secret);
    reg.user.mfaRecoveryCodes = [];
    db.users.set(userId, reg.user);

    (profileService as any).regenerateRecoveryCodes(userId, '', '');
    recoveryCodesRegeneratedWithoutPasswordOrOtp = true;
  } catch {
    recoveryCodesRegeneratedWithoutPasswordOrOtp = false;
  }

  // 6. Probe unverifiedParentAcceptedForProductRoutes
  let unverifiedParentAcceptedForProductRoutes = false;
  try {
    const unverifiedUser = authService.register(`unver-probe-${nanoid(6)}@safebrowse.io`, probePass, 'Unverified');
    const res = await makeRequest('GET', '/api/children', {
      Authorization: `Bearer ${unverifiedUser.accessToken}`,
    });
    unverifiedParentAcceptedForProductRoutes = (res.status === 200);
  } catch {
    unverifiedParentAcceptedForProductRoutes = false;
  }

  // 7. Probe anonymousDeviceActivityAccepted
  let anonymousDeviceActivityAccepted = false;
  try {
    const res = await makeRequest('POST', '/api/activity', {}, {
      deviceId: device.id,
      domain: 'wikipedia.org',
      action: 'ALLOW',
    });
    anonymousDeviceActivityAccepted = (res.status === 200);
  } catch {
    anonymousDeviceActivityAccepted = false;
  }

  // 8. Probe wrongDeviceTokenAccepted
  let wrongDeviceTokenAccepted = false;
  try {
    const res = await makeRequest('POST', '/api/activity', {
      'x-device-id': device.id,
      'x-device-token': 'dtk_wrong_token',
    }, {
      domain: 'wikipedia.org',
      action: 'ALLOW',
    });
    wrongDeviceTokenAccepted = (res.status === 200);
  } catch {
    wrongDeviceTokenAccepted = false;
  }

  // 9. Probe consumedRecoveryCodeReused
  let consumedRecoveryCodeReused = false;
  try {
    const mfaSecret = generateBase32Secret();
    const userForRecovery = authService.register(`rec-probe-${nanoid(6)}@safebrowse.io`, probePass, 'Recovery User');
    userForRecovery.user.pendingMfaSecret = encryptMfaSecret(mfaSecret);
    db.users.set(userForRecovery.user.id, userForRecovery.user);

    const validTotp = generateCurrentTotp(mfaSecret);
    const mfaSetupResult = profileService.verifyAndEnableMfa(userForRecovery.user.id, validTotp);
    const recoveryCodeToUse = mfaSetupResult.recoveryCodes[0];

    // First use: Login with recovery code (should succeed)
    const login1 = authService.login(userForRecovery.user.email, probePass);
    authService.verifyMfaLogin(login1.mfaTicket!, recoveryCodeToUse);

    // Second use: Replay the same recovery code (must fail)
    const login2 = authService.login(userForRecovery.user.email, probePass);
    authService.verifyMfaLogin(login2.mfaTicket!, recoveryCodeToUse);
    consumedRecoveryCodeReused = true;
  } catch {
    consumedRecoveryCodeReused = false;
  }

  // 10. Probe consumedMfaTicketReusedAfterReload
  let consumedMfaTicketReusedAfterReload = false;
  try {
    const mfaSecret = generateBase32Secret();
    const userForReload = authService.register(`reload-probe-${nanoid(6)}@safebrowse.io`, probePass, 'Reload User');
    userForReload.user.pendingMfaSecret = encryptMfaSecret(mfaSecret);
    db.users.set(userForReload.user.id, userForReload.user);

    const validTotp = generateCurrentTotp(mfaSecret);
    profileService.verifyAndEnableMfa(userForReload.user.id, validTotp);

    const loginRes = authService.login(userForReload.user.email, probePass);
    const mfaTicket = loginRes.mfaTicket!;
    const totpForLogin = generateCurrentTotp(mfaSecret);

    // Consume ticket
    authService.verifyMfaLogin(mfaTicket, totpForLogin);

    // Reload datastore
    db.load();

    // Try reusing ticket
    authService.verifyMfaLogin(mfaTicket, totpForLogin);
    consumedMfaTicketReusedAfterReload = true;
  } catch {
    consumedMfaTicketReusedAfterReload = false;
  }

  // 11. Probe sameAcceptedTotpTimestepReused
  let sameAcceptedTotpTimestepReused = false;
  try {
    const mfaSecret = generateBase32Secret();
    const userForTotp = authService.register(`totp-probe-${nanoid(6)}@safebrowse.io`, probePass, 'Totp User');
    userForTotp.user.pendingMfaSecret = encryptMfaSecret(mfaSecret);
    db.users.set(userForTotp.user.id, userForTotp.user);

    const validTotp = generateCurrentTotp(mfaSecret);
    profileService.verifyAndEnableMfa(userForTotp.user.id, validTotp);

    const login1 = authService.login(userForTotp.user.email, probePass);
    authService.verifyMfaLogin(login1.mfaTicket!, validTotp);

    const login2 = authService.login(userForTotp.user.email, probePass);
    authService.verifyMfaLogin(login2.mfaTicket!, validTotp);
    sameAcceptedTotpTimestepReused = true;
  } catch {
    sameAcceptedTotpTimestepReused = false;
  }

  const probeResult = {
    sessionlessSignedJwtAccepted,
    missingSubAccessTokenAccepted,
    missingJtiAccessTokenAccepted,
    mfaTicketWithoutJtiAccepted,
    recoveryCodesRegeneratedWithoutPasswordOrOtp,
    unverifiedParentAcceptedForProductRoutes,
    anonymousDeviceActivityAccepted,
    wrongDeviceTokenAccepted,
    consumedRecoveryCodeReused,
    consumedMfaTicketReusedAfterReload,
    sameAcceptedTotpTimestepReused,
  };

  console.log(JSON.stringify(probeResult, null, 2));

  probeServer.close();
}

runProbe().catch((err) => {
  console.error('Probe encountered unexpected fatal error:', err);
  process.exit(1);
});
