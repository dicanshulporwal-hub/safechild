import crypto from 'crypto';
import bcrypt from 'bcryptjs';
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
 * Step-up authentication validation:
 * Requires current password and, if MFA is enabled, 6-digit TOTP verification.
 */
export function verifyStepUpAuth(
  user: ParentUser,
  password?: string,
  otpCode?: string
): void {
  if (!password) {
    throw new Error('Step-up authentication failed: Current password is required.');
  }

  if (!bcrypt.compareSync(password, user.passwordHash)) {
    throw new Error('Step-up authentication failed: Incorrect password.');
  }

  if (user.mfaEnabled) {
    if (!otpCode) {
      throw new Error('Step-up authentication failed: 6-digit MFA code is required for this action.');
    }
    // Verify TOTP
    if (!user.mfaSecret) {
      throw new Error('MFA configuration error.');
    }
    const decryptedSecret = decryptMfaSecret(user.mfaSecret);
    const expectedOtp = generateTotp(decryptedSecret);
    if (otpCode.trim() !== expectedOtp) {
      throw new Error('Step-up authentication failed: Invalid MFA verification code.');
    }
  }
}

/**
 * TOTP verification helper
 */
export function generateTotp(secret: string, timeStep: number = 30): string {
  const epoch = Math.floor(Date.now() / 1000);
  const time = Math.floor(epoch / timeStep);
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeBigInt64BE(BigInt(time));

  const hmac = crypto.createHmac('sha1', Buffer.from(secret, 'hex'));
  hmac.update(timeBuffer);
  const digest = hmac.digest();

  const offset = digest[digest.length - 1] & 0xf;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  const otp = (binary % 1000000).toString().padStart(6, '0');
  return otp;
}
