import { Router } from 'express';
import { authService } from '../services/auth.service';
import { profileService } from '../services/profile.service';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { authRateLimiter } from '../middleware/rate-limiter';
import { prisma } from '../db/prisma';

export const authRouter = Router();

// Register new parent account
authRouter.post('/register', authRateLimiter, async (req, res) => {
  try {
    const { email, password, name, consentVersion } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password and name are required.' });
    }
    const userAgent = (req.headers['user-agent'] as string) || 'Web Browser';
    const ipAddress = (req.ip || req.socket.remoteAddress) as string;
    const result = await authService.register(email, password, name, userAgent, ipAddress);

    // Record verified Parental Consent
    if (result.user) {
      await prisma.user.update({
        where: { id: result.user.id },
        data: {
          notificationPrefs: {
            consentVersion: consentVersion || '1.0.0',
            consentTimestamp: new Date().toISOString(),
            privacyPolicyVersion: '2026.1',
          },
        },
      });
    }

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
authRouter.post('/login', authRateLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const userAgent = (req.headers['user-agent'] as string) || 'Web Browser';
    const ipAddress = (req.ip || req.socket.remoteAddress) as string;
    const result = await authService.login(email, password, userAgent, ipAddress);
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Complete Login with MFA OTP or Recovery Code
authRouter.post('/mfa-login', authRateLimiter, async (req, res) => {
  try {
    const { mfaTicket, code } = req.body;
    if (!mfaTicket || !code) {
      return res.status(400).json({ error: 'MFA ticket and 6-digit code or recovery code are required.' });
    }
    const userAgent = (req.headers['user-agent'] as string) || 'Web Browser';
    const ipAddress = (req.ip || req.socket.remoteAddress) as string;
    const result = await authService.verifyMfaLogin(mfaTicket, code, userAgent, ipAddress);
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Atomic Single-Use Refresh Token Rotation
authRouter.post('/refresh', authRateLimiter, async (req, res) => {
  try {
    const rawRefreshToken = req.body.refreshToken || (req as any).cookies?.refreshToken;
    if (!rawRefreshToken) {
      return res.status(400).json({ error: 'Refresh token is required.' });
    }
    const userAgent = (req.headers['user-agent'] as string) || 'Web Browser';
    const ipAddress = (req.ip || req.socket.remoteAddress) as string;
    const result = await authService.refreshSession(rawRefreshToken, userAgent, ipAddress);
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
authRouter.post('/logout', authMiddleware, async (req: AuthenticatedRequest, res) => {
  try {
    if (req.sessionId) {
      await prisma.userSession.update({
        where: { id: req.sessionId },
        data: { isRevoked: true },
      });
    }
    res.json({ success: true, message: 'Logged out successfully.' });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Verify Email with Token
authRouter.post('/verify-email', authRateLimiter, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Verification token is required.' });
    }
    const result = await authService.verifyEmail(token);
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Resend Email Verification Token
authRouter.post('/resend-verification', authRateLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }
    const result = await authService.resendEmailVerification(email);
    res.json({
      success: true,
      message: 'If the email is unverified, a new verification link has been sent.',
      ...result,
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Forgot Password - Request Reset Link
authRouter.post('/forgot-password', authRateLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }
    const result = await authService.requestPasswordReset(email);
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Reset Password with Token
authRouter.post('/reset-password', authRateLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Reset token and new password are required.' });
    }
    await authService.resetPassword(token, newPassword);
    res.json({ success: true, message: 'Password has been successfully reset. Please sign in with your new password.' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Formal Parental Consent Record Endpoint
authRouter.post('/consent', authMiddleware, async (req: AuthenticatedRequest, res) => {
  try {
    const { consentVersion, agreedToTerms, agreedToPrivacyPolicy } = req.body;
    if (!agreedToTerms || !agreedToPrivacyPolicy) {
      return res.status(400).json({ error: 'Affirmative consent to Terms of Service and Privacy Policy required.' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId! } });
    if (!user) {
      return res.status(404).json({ error: 'Parent account not found.' });
    }

    const consentTimestamp = new Date().toISOString();
    await prisma.user.update({
      where: { id: req.userId! },
      data: {
        notificationPrefs: {
          consentVersion: consentVersion || '1.0.0',
          consentTimestamp,
          privacyPolicyVersion: '2026.1',
        },
      },
    });

    res.json({
      success: true,
      message: 'Parental consent recorded successfully.',
      consentTimestamp,
    });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// GDPR / COPPA Privacy-First Data Export
authRouter.get('/export-data', authMiddleware, async (req: AuthenticatedRequest, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId! } });
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const children = await prisma.child.findMany({ where: { parentId: req.userId } });
    const childIds = children.map((c) => c.id);

    const devices = await prisma.device.findMany({ where: { parentId: req.userId } });
    const policies = await prisma.policy.findMany({ where: { childId: { in: childIds } } });
    const requests = await prisma.accessRequest.findMany({ where: { childId: { in: childIds } } });

    res.json({
      exportTimestamp: new Date().toISOString(),
      account: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt.toISOString(),
      },
      children,
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        pairedAt: d.createdAt.toISOString(),
        lastSyncAt: d.updatedAt.toISOString(),
      })),
      policies,
      accessRequests: requests,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Full Account & Child Data Permanent Deletion (Right to be Forgotten)
authRouter.delete('/account', authMiddleware, async (req: AuthenticatedRequest, res) => {
  try {
    await profileService.deleteAccount(req.userId!);
    res.json({
      success: true,
      message: 'Parent account, all child profiles, and device records have been permanently erased.',
    });
  } catch (e: any) {
    res.status(e.message.includes('sole owner') ? 403 : 500).json({ error: e.message });
  }
});
