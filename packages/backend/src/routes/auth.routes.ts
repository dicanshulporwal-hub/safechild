import { Router } from 'express';
import { authService } from '../services/auth.service';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { authRateLimiter } from '../middleware/rate-limiter';
import { db } from '../db/store';

export const authRouter = Router();

// Register new parent account
authRouter.post('/register', authRateLimiter, (req, res) => {
  try {
    const { email, password, name, consentVersion } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password and name are required.' });
    }
    const userAgent = (req.headers['user-agent'] as string) || 'Web Browser';
    const ipAddress = (req.ip || req.socket.remoteAddress) as string;
    const result = authService.register(email, password, name, userAgent, ipAddress);

    // Record verified Parental Consent
    if (result.user) {
      (result.user as any).consentVersion = consentVersion || '1.0.0';
      (result.user as any).consentTimestamp = new Date().toISOString();
      (result.user as any).privacyPolicyVersion = '2026.1';
      db.users.set(result.user.id, result.user);
      db.save();
    }

    // In production, suppress raw email verification token in API response
    const responsePayload: any = {
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      token: result.token,
      emailVerificationPending: true,
    };
    if (process.env.NODE_ENV !== 'production') {
      responsePayload.emailVerificationToken = result.emailVerificationToken;
    }

    res.json(responsePayload);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Primary Login
authRouter.post('/login', authRateLimiter, (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const userAgent = (req.headers['user-agent'] as string) || 'Web Browser';
    const ipAddress = (req.ip || req.socket.remoteAddress) as string;
    const result = authService.login(email, password, userAgent, ipAddress);
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Complete Login with MFA OTP or Recovery Code
authRouter.post('/mfa-login', authRateLimiter, (req, res) => {
  try {
    const { mfaTicket, code } = req.body;
    if (!mfaTicket || !code) {
      return res.status(400).json({ error: 'MFA ticket and 6-digit code or recovery code are required.' });
    }
    const userAgent = (req.headers['user-agent'] as string) || 'Web Browser';
    const ipAddress = (req.ip || req.socket.remoteAddress) as string;
    const result = authService.verifyMfaLogin(mfaTicket, code, userAgent, ipAddress);
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Atomic Single-Use Refresh Token Rotation
authRouter.post('/refresh', authRateLimiter, (req, res) => {
  try {
    const rawRefreshToken = req.body.refreshToken || (req as any).cookies?.refreshToken;
    if (!rawRefreshToken) {
      return res.status(400).json({ error: 'Refresh token is required.' });
    }
    const userAgent = (req.headers['user-agent'] as string) || 'Web Browser';
    const ipAddress = (req.ip || req.socket.remoteAddress) as string;
    const result = authService.refreshSession(rawRefreshToken, userAgent, ipAddress);
    res.json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      token: result.accessToken,
    });
  } catch (e: any) {
    res.status(401).json({ error: e.message });
  }
});

// Logout Current Session
authRouter.post('/logout', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    if (req.sessionId) {
      const session = db.userSessions.get(req.sessionId);
      if (session) {
        session.isRevoked = true;
        db.userSessions.set(req.sessionId, session);
        db.save();
      }
    }
    res.json({ success: true, message: 'Logged out successfully.' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Verify Email with Token
authRouter.post('/verify-email', authRateLimiter, (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Verification token is required.' });
    }
    const result = authService.verifyEmail(token);
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Resend Email Verification
authRouter.post('/resend-verification', authRateLimiter, (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }
    const result = authService.resendEmailVerification(email);
    const responsePayload: any = {
      success: true,
      message: 'If an unverified account exists with this email, a verification link has been sent.',
    };
    if (process.env.NODE_ENV !== 'production' && result.token) {
      responsePayload.token = result.token;
    }
    res.json(responsePayload);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Forgot Password -> Generic non-enumerating response
authRouter.post('/forgot-password', authRateLimiter, (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }
    const result = authService.requestPasswordReset(email);
    const responsePayload: any = {
      success: true,
      message: result.message,
    };
    if (process.env.NODE_ENV !== 'production' && result.resetToken) {
      responsePayload.resetToken = result.resetToken;
    }
    res.json(responsePayload);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Reset Password with Token
authRouter.post('/reset-password', authRateLimiter, (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Reset token and new password are required.' });
    }
    authService.resetPassword(token, newPassword);
    res.json({ success: true, message: 'Password has been successfully reset. All existing sessions have been signed out. Please sign in with your new password.' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

authRouter.get('/me', authMiddleware, (req: AuthenticatedRequest, res) => {
  const user = authService.getUser(req.userId!);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }
  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
    emailVerified: Boolean(user.emailVerified),
    mfaEnabled: Boolean(user.mfaEnabled),
    consentVersion: (user as any).consentVersion || '1.0.0',
    consentTimestamp: (user as any).consentTimestamp,
  });
});

// Formal Parental Consent Record Endpoint
authRouter.post('/consent', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const { consentVersion, agreedToTerms, agreedToPrivacyPolicy } = req.body;
    if (!agreedToTerms || !agreedToPrivacyPolicy) {
      return res.status(400).json({ error: 'Affirmative consent to Terms of Service and Privacy Policy required.' });
    }

    const user = db.users.get(req.userId!);
    if (!user) {
      return res.status(404).json({ error: 'Parent account not found.' });
    }

    (user as any).consentVersion = consentVersion || '1.0.0';
    (user as any).consentTimestamp = new Date().toISOString();
    (user as any).privacyPolicyVersion = '2026.1';
    db.users.set(user.id, user);
    db.save();

    res.json({
      success: true,
      message: 'Parental consent recorded successfully.',
      consentTimestamp: (user as any).consentTimestamp,
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// GDPR / COPPA Privacy-First Data Export
authRouter.get('/export-data', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const user = db.users.get(req.userId!);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const children = Array.from(db.children.values()).filter((c) => c.parentId === req.userId);
    const childIds = children.map((c) => c.id);

    const devices = Array.from(db.devices.values()).filter((d) => d.parentId === req.userId);
    const policies = childIds.map((cId) => db.policies.get(cId)).filter(Boolean);
    const requests = Array.from(db.requests.values()).filter((r) => childIds.includes(r.childId));

    res.json({
      exportTimestamp: new Date().toISOString(),
      account: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt,
        consentVersion: (user as any).consentVersion,
        consentTimestamp: (user as any).consentTimestamp,
      },
      children,
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        pairedAt: d.pairedAt,
        lastSyncAt: d.lastSyncAt,
      })),
      policies,
      accessRequests: requests,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Full Account & Child Data Permanent Deletion (Right to be Forgotten)
authRouter.delete('/account', authMiddleware, (req: AuthenticatedRequest, res) => {
  try {
    const parentId = req.userId!;
    const children = Array.from(db.children.values()).filter((c) => c.parentId === parentId);
    const childIds = children.map((c) => c.id);

    // Delete devices
    for (const [dId, dev] of db.devices.entries()) {
      if (dev.parentId === parentId) db.devices.delete(dId);
    }

    // Delete policies
    for (const cId of childIds) {
      db.policies.delete(cId);
    }

    // Delete requests
    for (const [rId, reqItem] of db.requests.entries()) {
      if (childIds.includes(reqItem.childId)) db.requests.delete(rId);
    }

    // Delete children
    for (const cId of childIds) {
      db.children.delete(cId);
    }

    // Delete sessions
    for (const [sId, sess] of db.userSessions.entries()) {
      if (sess.userId === parentId) db.userSessions.delete(sId);
    }

    // Delete user
    db.users.delete(parentId);
    db.save();

    res.json({
      success: true,
      message: 'Parent account, all child profiles, and device records have been permanently erased.',
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
