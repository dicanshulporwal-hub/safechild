export interface OutboxMailRecord {
  id: string;
  to: string;
  subject: string;
  body: string;
  token?: string;
  status: 'DEVELOPMENT_CAPTURED' | 'MOCK_DELIVERED' | 'SENT_SMTP' | 'SENT_RESEND';
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
    if (process.env.NODE_ENV === 'production' && !process.env.SMTP_HOST && !process.env.RESEND_API_KEY) {
      throw new Error('SECURITY ERROR: DevelopmentMailAdapter is not allowed in production mode without explicit email provider credentials.');
    }
  }

  public async sendVerificationEmail(email: string, token: string): Promise<void> {
    const appUrl = process.env.APP_URL || 'http://localhost:1001';
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
      console.log(`[DevOutbox] 📥 [DEVELOPMENT_CAPTURED] Verification email captured for ${email} (Link: ${cleanAppUrl}/verify-email?token=${token.substring(0, 8)}...)`);
    }
  }

  public async sendPasswordResetEmail(email: string, token: string): Promise<void> {
    const appUrl = process.env.APP_URL || 'http://localhost:1001';
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
      console.log(`[DevOutbox] 📥 [DEVELOPMENT_CAPTURED] Password reset email captured for ${email} (Link: ${cleanAppUrl}/reset-password?token=${token.substring(0, 8)}...)`);
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
 * Resend API Transactional Mail Adapter.
 */
export class ResendMailAdapter implements IMailService {
  private apiKey: string;
  private fromEmail: string;

  constructor(apiKey: string, fromEmail: string = 'SafeBrowse <no-reply@safebrowse.io>') {
    this.apiKey = apiKey;
    this.fromEmail = fromEmail;
  }

  public validateConfiguration(): void {
    if (!this.apiKey || !this.apiKey.startsWith('re_')) {
      throw new Error('Invalid Resend API Key. Key must begin with "re_".');
    }
  }

  private async sendMail(to: string, subject: string, htmlBody: string): Promise<void> {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.fromEmail,
          to: [to],
          subject,
          html: htmlBody,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Resend HTTP ${response.status}: ${errorText}`);
      }
    } catch (e: any) {
      throw new MailDeliveryError(`Failed to deliver email via Resend: ${e.message}`, 'RESEND_DELIVERY_FAILED');
    }
  }

  public async sendVerificationEmail(email: string, token: string): Promise<void> {
    const appUrl = process.env.APP_URL || 'https://parent.safebrowse.io';
    const cleanAppUrl = appUrl.endsWith('/') ? appUrl.slice(0, -1) : appUrl;
    const link = `${cleanAppUrl}/verify-email?token=${encodeURIComponent(token)}`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
        <h2>Verify your SafeBrowse Parent Account</h2>
        <p>Click the button below to verify your email address:</p>
        <p><a href="${link}" style="background:#2563eb;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;">Verify Email</a></p>
      </div>
    `;
    await this.sendMail(email, 'Verify your SafeBrowse Parent Account', html);
  }

  public async sendPasswordResetEmail(email: string, token: string): Promise<void> {
    const appUrl = process.env.APP_URL || 'https://parent.safebrowse.io';
    const cleanAppUrl = appUrl.endsWith('/') ? appUrl.slice(0, -1) : appUrl;
    const link = `${cleanAppUrl}/reset-password?token=${encodeURIComponent(token)}`;
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
        <h2>Reset your SafeBrowse Password</h2>
        <p>Click the button below to reset your password:</p>
        <p><a href="${link}" style="background:#dc2626;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;">Reset Password</a></p>
      </div>
    `;
    await this.sendMail(email, 'Reset your SafeBrowse Password', html);
  }

  public async sendSecurityAlert(email: string, subject: string, message: string): Promise<void> {
    const html = `<div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px;"><h2 style="color:#dc2626;">[Security Alert] ${subject}</h2><p>${message}</p></div>`;
    await this.sendMail(email, `[Security Alert] ${subject}`, html);
  }

  public getOutbox(): OutboxMailRecord[] {
    return [];
  }

  public clearOutbox(): void {}
}

/**
 * Mock Mail Adapter for unit and integration testing.
 */
export class MockMailAdapter implements IMailService {
  private outbox: OutboxMailRecord[] = [];
  private shouldFail: boolean = false;
  private failureErrorMessage: string = 'Simulated mail gateway failure';

  public validateConfiguration(): void {}

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
 * Production Mail Adapter Placeholder when no credentials are provided.
 */
export class ProductionMailAdapter implements IMailService {
  public validateConfiguration(): void {
    throw new Error(
      'PRODUCTION_MAIL_PROVIDER_NOT_CONFIGURED: Production transactional mail provider (e.g. RESEND_API_KEY or SMTP_HOST) has not been configured. Real email delivery is deferred. Application startup aborted for safety.'
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
  if (process.env.RESEND_API_KEY) {
    return new ResendMailAdapter(process.env.RESEND_API_KEY, process.env.MAIL_FROM);
  }
  if (process.env.NODE_ENV === 'production') {
    return new ProductionMailAdapter();
  }
  if (process.env.NODE_ENV === 'test') {
    return new MockMailAdapter();
  }
  return new DevelopmentMailAdapter();
}

export const mailService: IMailService = createMailService();
