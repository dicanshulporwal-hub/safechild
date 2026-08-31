export interface OutboxMailRecord {
  id: string;
  to: string;
  subject: string;
  body: string;
  token?: string;
  status: 'DEVELOPMENT_CAPTURED' | 'MOCK_DELIVERED';
  createdAt: string;
}

export interface IMailService {
  sendVerificationEmail(email: string, token: string): Promise<void>;
  sendPasswordResetEmail(email: string, token: string): Promise<void>;
  sendSecurityAlert(email: string, subject: string, message: string): Promise<void>;
  getOutbox(): OutboxMailRecord[];
  clearOutbox(): void;
  validateConfiguration(): void;
}

export class MailDeliveryError extends Error {
  public readonly code: string;
  constructor(message: string, code: string = 'MAIL_DELIVERY_FAILED') {
    super(message);
    this.name = 'MailDeliveryError';
    this.code = code;
  }
}

/**
 * Development Mail Adapter.
 * Captures outgoing emails into a local in-memory outbox labeled DEVELOPMENT_CAPTURED.
 * Tokens are accessible only in development mode; never in production.
 */
export class DevelopmentMailAdapter implements IMailService {
  private outbox: OutboxMailRecord[] = [];

  public validateConfiguration(): void {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SECURITY ERROR: DevelopmentMailAdapter is not allowed in production mode.');
    }
  }

  public async sendVerificationEmail(email: string, token: string): Promise<void> {
    const appUrl = process.env.APP_URL || 'https://parent.safebrowse.io';
    const cleanAppUrl = appUrl.endsWith('/') ? appUrl.slice(0, -1) : appUrl;
    const link = `${cleanAppUrl}/verify-email?token=${encodeURIComponent(token)}`;

    const record: OutboxMailRecord = {
      id: `mail_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      to: email,
      subject: 'Verify your SafeBrowse Parent Account',
      body: `Please verify your email using the link: ${link}`,
      token: process.env.NODE_ENV !== 'production' ? token : undefined,
      status: 'DEVELOPMENT_CAPTURED',
      createdAt: new Date().toISOString(),
    };
    this.outbox.push(record);

    if (process.env.NODE_ENV !== 'test') {
      console.log(`[DevOutbox] 📥 [DEVELOPMENT_CAPTURED] Verification email captured for ${email} (Redacted link: ${cleanAppUrl}/verify-email?token=${token.substring(0, 8)}...)`);
    }
  }

  public async sendPasswordResetEmail(email: string, token: string): Promise<void> {
    const appUrl = process.env.APP_URL || 'https://parent.safebrowse.io';
    const cleanAppUrl = appUrl.endsWith('/') ? appUrl.slice(0, -1) : appUrl;
    const link = `${cleanAppUrl}/reset-password?token=${encodeURIComponent(token)}`;

    const record: OutboxMailRecord = {
      id: `mail_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      to: email,
      subject: 'Reset your SafeBrowse Password',
      body: `Please reset your password using the link: ${link}`,
      token: process.env.NODE_ENV !== 'production' ? token : undefined,
      status: 'DEVELOPMENT_CAPTURED',
      createdAt: new Date().toISOString(),
    };
    this.outbox.push(record);

    if (process.env.NODE_ENV !== 'test') {
      console.log(`[DevOutbox] 📥 [DEVELOPMENT_CAPTURED] Password reset email captured for ${email} (Redacted link: ${cleanAppUrl}/reset-password?token=${token.substring(0, 8)}...)`);
    }
  }

  public async sendSecurityAlert(email: string, subject: string, message: string): Promise<void> {
    const record: OutboxMailRecord = {
      id: `mail_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      to: email,
      subject: `[Security Alert] ${subject}`,
      body: message,
      status: 'DEVELOPMENT_CAPTURED',
      createdAt: new Date().toISOString(),
    };
    this.outbox.push(record);

    if (process.env.NODE_ENV !== 'test') {
      console.log(`[DevOutbox] 🚨 [DEVELOPMENT_CAPTURED] Security alert captured for ${email}: ${subject}`);
    }
  }

  public getOutbox(): OutboxMailRecord[] {
    return [...this.outbox];
  }

  public clearOutbox(): void {
    this.outbox = [];
  }
}

/**
 * Mock Mail Adapter for unit and integration testing.
 * Provides deterministic behavior and configurable simulated failures.
 */
export class MockMailAdapter implements IMailService {
  private outbox: OutboxMailRecord[] = [];
  private shouldFail: boolean = false;
  private failureErrorMessage: string = 'Simulated mail gateway failure';

  public validateConfiguration(): void {
    // Tests are always valid
  }

  public setShouldFail(fail: boolean, errorMessage?: string) {
    this.shouldFail = fail;
    if (errorMessage) this.failureErrorMessage = errorMessage;
  }

  public async sendVerificationEmail(email: string, token: string): Promise<void> {
    if (this.shouldFail) {
      throw new MailDeliveryError(this.failureErrorMessage, 'MOCK_MAIL_FAILURE');
    }
    const appUrl = process.env.APP_URL || 'https://parent.safebrowse.io';
    const link = `${appUrl}/verify-email?token=${encodeURIComponent(token)}`;
    this.outbox.push({
      id: `mock_${Date.now()}`,
      to: email,
      subject: 'Verify your SafeBrowse Parent Account',
      body: link,
      token,
      status: 'MOCK_DELIVERED',
      createdAt: new Date().toISOString(),
    });
  }

  public async sendPasswordResetEmail(email: string, token: string): Promise<void> {
    if (this.shouldFail) {
      throw new MailDeliveryError(this.failureErrorMessage, 'MOCK_MAIL_FAILURE');
    }
    const appUrl = process.env.APP_URL || 'https://parent.safebrowse.io';
    const link = `${appUrl}/reset-password?token=${encodeURIComponent(token)}`;
    this.outbox.push({
      id: `mock_${Date.now()}`,
      to: email,
      subject: 'Reset your SafeBrowse Password',
      body: link,
      token,
      status: 'MOCK_DELIVERED',
      createdAt: new Date().toISOString(),
    });
  }

  public async sendSecurityAlert(email: string, subject: string, message: string): Promise<void> {
    if (this.shouldFail) {
      throw new MailDeliveryError(this.failureErrorMessage, 'MOCK_MAIL_FAILURE');
    }
    this.outbox.push({
      id: `mock_${Date.now()}`,
      to: email,
      subject,
      body: message,
      status: 'MOCK_DELIVERED',
      createdAt: new Date().toISOString(),
    });
  }

  public getOutbox(): OutboxMailRecord[] {
    return [...this.outbox];
  }

  public clearOutbox(): void {
    this.outbox = [];
  }
}

/**
 * Production Mail Adapter Placeholder.
 * In this step, external mail provider integration is intentionally deferred.
 * Application startup in production mode MUST fail with PRODUCTION_MAIL_PROVIDER_NOT_CONFIGURED.
 * It will never report false delivery or fall back to development/mock modes in production.
 */
export class ProductionMailAdapter implements IMailService {
  public validateConfiguration(): void {
    throw new Error(
      'PRODUCTION_MAIL_PROVIDER_NOT_CONFIGURED: Production transactional mail provider (e.g. AWS SES, SendGrid, or verified TLS SMTP) has not been configured. Real email delivery is deferred. Application startup aborted for safety.'
    );
  }

  public async sendVerificationEmail(): Promise<void> {
    throw new MailDeliveryError(
      'PRODUCTION_MAIL_PROVIDER_NOT_CONFIGURED: Cannot deliver verification email.',
      'PRODUCTION_MAIL_PROVIDER_NOT_CONFIGURED'
    );
  }

  public async sendPasswordResetEmail(): Promise<void> {
    throw new MailDeliveryError(
      'PRODUCTION_MAIL_PROVIDER_NOT_CONFIGURED: Cannot deliver password reset email.',
      'PRODUCTION_MAIL_PROVIDER_NOT_CONFIGURED'
    );
  }

  public async sendSecurityAlert(): Promise<void> {
    throw new MailDeliveryError(
      'PRODUCTION_MAIL_PROVIDER_NOT_CONFIGURED: Cannot deliver security alert.',
      'PRODUCTION_MAIL_PROVIDER_NOT_CONFIGURED'
    );
  }

  public getOutbox(): OutboxMailRecord[] {
    return [];
  }

  public clearOutbox(): void {}
}

export function createMailService(): IMailService {
  if (process.env.NODE_ENV === 'production') {
    return new ProductionMailAdapter();
  }
  if (process.env.NODE_ENV === 'test') {
    return new MockMailAdapter();
  }
  return new DevelopmentMailAdapter();
}

export const mailService: IMailService = createMailService();
