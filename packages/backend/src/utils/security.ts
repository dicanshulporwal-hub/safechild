import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { generateSecret, generateURI, generateSync, verifySync } from 'otplib';
import QRCode from 'qrcode';
import { ParentUser } from '../db/store';

export function getEncryptionKeyBuffer(): Buffer {
  const envKey = process.env.MFA_ENCRYPTION_KEY;
  if (process.env.NODE_ENV === 'production') {
    if (!envKey || envKey.trim().length === 0) {
      throw new Error('FATAL SECURITY ERROR: MFA_ENCRYPTION_KEY environment variable is required in production.');
    }
    if (envKey.length < 32) {
      throw new Error('FATAL SECURITY ERROR: MFA_ENCRYPTION_KEY must be at least 32 characters in production.');
    }
    return crypto.createHash('sha256').update(envKey).digest();
  }
  const key = envKey || 'dev-only-safebrowse-mfa-aes256-key-32b!';
  return crypto.createHash('sha256').update(key).digest();
}

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function generateCryptoToken(prefix: string = ''): string {
  return `${prefix}${crypto.randomBytes(32).toString('hex')}`;
}

const COMMON_PASSWORDS_BLACKLIST = new Set([
  'password1234567',
  '123456789012345',
  'qwertyuiopasdfg',
  'administrator12',
  'welcome12345678',
  'safebrowse12345',
  'letmein12345678',
  'changeme1234567',
  'passphrase12345',
  'secretpassword1',
  'ilovemychildren',
  'parentaccess123',
  'familyprotect12',
]);

/**
 * Validate password against NIST 800-63B standards:
 * - Minimum 15 characters (or 10 if MFA is active)
 * - Maximum at least 64 characters (supports up to 128 characters)
 * - Supports spaces / passphrases
 * - No arbitrary symbol/casing rules
 * - Compromised / common password blacklist check
 */
export function validatePasswordPolicy(password: string, mfaActive: boolean = false): void {
  if (!password) {
    throw new Error('Password is required.');
  }

  const minLength = mfaActive ? 10 : 15;
  if (password.length < minLength) {
    throw new Error(
      mfaActive
        ? `Password must be at least ${minLength} characters long.`
        : `Password must be at least 15 characters long (passphrases supported).`
    );
  }

  if (password.length > 128) {
    throw new Error('Password must not exceed 128 characters.');
  }

  const normalized = password.toLowerCase().trim();
  if (COMMON_PASSWORDS_BLACKLIST.has(normalized)) {
    throw new Error('This password is too common or easily guessed. Please choose a stronger passphrase.');
  }
}

/**
 * Encrypt MFA secret using AES-256-GCM
 */
export function encryptMfaSecret(secret: string): string {
  const keyBuffer = getEncryptionKeyBuffer();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
  let encrypted = cipher.update(secret, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

/**
 * Decrypt MFA secret using AES-256-GCM
 */
export function decryptMfaSecret(encryptedPayload: string): string {
  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    // Fallback for unencrypted legacy secrets
    return encryptedPayload;
  }
  const keyBuffer = getEncryptionKeyBuffer();
  const [ivHex, tagHex, encryptedText] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Generate standards-compliant 160-bit Base32 MFA secret
 */
export function generateBase32Secret(): string {
  return generateSecret({ length: 20 });
}

/**
 * Generate standards-compliant otpauth URI
 */
export function generateOtpAuthUri(email: string, secret: string, issuer: string = 'SafeBrowse Family'): string {
  return generateURI({
    strategy: 'totp',
    secret,
    label: email,
    issuer,
    digits: 6,
    period: 30,
  });
}

/**
 * Generate local offline QR code data URL (PNG)
 */
export async function generateLocalQrDataUrl(otpAuthUrl: string): Promise<string> {
  return QRCode.toDataURL(otpAuthUrl, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 240,
    color: {
      dark: '#0f172a',
      light: '#ffffff',
    },
  });
}

export interface TotpVerificationResult {
  valid: boolean;
  acceptedTimeStep?: number;
}

/**
 * Returns the TOTP 30-second time step counter for a given Unix timestamp in seconds (or Date.now()).
 */
export function getCurrentTotpTimeStep(timeSec?: number): number {
  const t = timeSec !== undefined ? timeSec : Math.floor(Date.now() / 1000);
  return Math.floor(t / 30);
}

/**
 * Generate a 6-digit TOTP code for a specific timestep or timestamp (supports controlled clock testing)
 */
export function generateTotpAtStep(secret: string, step: number): string {
  return (generateSync as any)({
    strategy: 'totp',
    secret,
    digits: 6,
    period: 30,
    epoch: step * 30,
  });
}

/**
 * Generate a 6-digit TOTP code for the current time (or specified timestamp in seconds)
 */
export function generateCurrentTotp(secret: string, timeSec?: number): string {
  const step = getCurrentTotpTimeStep(timeSec);
  return generateTotpAtStep(secret, step);
}

/**
 * Verify TOTP token against permitted timestep window [current, current-1, current+1]
 * and return the exact matching acceptedTimeStep.
 */
export function verifyTotpToken(
  secret: string,
  token: string,
  timeSec?: number
): TotpVerificationResult {
  if (!token || !/^\d{6}$/.test(token.trim())) {
    return { valid: false };
  }
  const cleanToken = token.trim();
  const currentStep = getCurrentTotpTimeStep(timeSec);

  // Permitted tolerance offsets: current step (0), past step (-1), future step (+1)
  const windowOffsets = [0, -1, 1];

  for (const offset of windowOffsets) {
    const candidateStep = currentStep + offset;
    try {
      const candidateCode = generateTotpAtStep(secret, candidateStep);
      if (candidateCode === cleanToken) {
        return {
          valid: true,
          acceptedTimeStep: candidateStep,
        };
      }
    } catch {
      // Continue checking next window offset
    }
  }

  return { valid: false };
}

/**
 * Structured result from step-up authentication — tells caller which method was used
 * so it can atomically consume a recovery code or record the consumed TOTP timestep.
 */
export interface StepUpResult {
  method: 'TOTP' | 'RECOVERY_CODE';
  recoveryCodeIndex?: number; // Index in user.mfaRecoveryCodes[] to splice — callers must do the splice
  totpTimeStep?: number;      // Exact accepted TOTP time step that was verified — callers must persist this
}

/**
 * Step-up authentication validation:
 * Password is ALWAYS mandatory.
 * When MFA is enabled, a 6-digit TOTP or recovery code is ALWAYS mandatory.
 * Returns StepUpResult with exact acceptedTimeStep so callers can atomically consume credentials.
 */
export function verifyStepUpAuth(
  user: ParentUser,
  password: string,
  otpCode?: string,
  timeSec?: number
): StepUpResult {
  // Password is unconditionally required — no conditional check
  if (!password || typeof password !== 'string' || password.trim() === '') {
    throw new Error('Step-up authentication failed: Current password is required.');
  }

  if (!bcrypt.compareSync(password, user.passwordHash)) {
    throw new Error('Step-up authentication failed: Incorrect password.');
  }

  if (user.mfaEnabled) {
    if (!otpCode || typeof otpCode !== 'string' || otpCode.trim() === '') {
      throw new Error('Step-up authentication failed: MFA verification code is required for this action.');
    }
    if (!user.mfaSecret) {
      throw new Error('MFA configuration error.');
    }
    const cleanOtp = otpCode.trim().toUpperCase();
    const decryptedSecret = decryptMfaSecret(user.mfaSecret);

    // 1. Try TOTP first and get exact accepted time step
    const totpResult = verifyTotpToken(decryptedSecret, cleanOtp, timeSec);
    if (totpResult.valid && totpResult.acceptedTimeStep !== undefined) {
      return {
        method: 'TOTP',
        totpTimeStep: totpResult.acceptedTimeStep,
      };
    }

    // 2. Fall back to recovery code check
    if (user.mfaRecoveryCodes && user.mfaRecoveryCodes.length > 0) {
      for (let i = 0; i < user.mfaRecoveryCodes.length; i++) {
        if (bcrypt.compareSync(cleanOtp, user.mfaRecoveryCodes[i])) {
          return {
            method: 'RECOVERY_CODE',
            recoveryCodeIndex: i,
          };
        }
      }
    }

    throw new Error('Step-up authentication failed: Invalid MFA verification code.');
  }

  // No MFA enabled — password alone suffices
  return { method: 'TOTP' };
}
