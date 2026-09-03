import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { profileService } from '../services/profile.service';

const router = Router();

// GET /api/me - Full profile
router.get('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const profile = await profileService.getProfile(req.userId!);
    res.json(profile);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// PATCH /api/me - Update profile details
router.patch('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, mobileNumber, profilePhoto, timezone, language, notificationPrefs } = req.body;
    const profile = await profileService.updateProfile(req.userId!, {
      name,
      mobileNumber,
      profilePhoto,
      timezone,
      language,
      notificationPrefs,
    });
    res.json(profile);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/me/change-password
router.post('/change-password', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    await profileService.changePassword(req.userId!, currentPassword, newPassword, req.sessionId);
    res.json({ success: true, message: 'Password updated successfully. Other active sessions have been signed out.' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/me/mfa/setup
router.post('/mfa/setup', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const setupData = await profileService.setupMfa(req.userId!);
    res.json(setupData);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/me/mfa/verify
router.post('/mfa/verify', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { otpCode } = req.body;
    const result = await profileService.verifyAndEnableMfa(req.userId!, otpCode);
    res.json({ success: true, recoveryCodes: result.recoveryCodes });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/me/mfa/disable
router.post('/mfa/disable', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { password, otpCode } = req.body;
    await profileService.disableMfa(req.userId!, password, otpCode);
    res.json({ success: true, message: 'MFA has been disabled.' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/me/mfa/recovery-codes/regenerate
router.post('/mfa/recovery-codes/regenerate', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { password, otpCode } = req.body;
    const result = await profileService.regenerateRecoveryCodes(req.userId!, password, otpCode);
    res.json({ success: true, recoveryCodes: result.recoveryCodes });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/me/sessions (Sanitized: NO tokens or secrets returned)
router.get('/sessions', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const sessions = await profileService.getSessions(req.userId!, req.sessionId);
    res.json({ sessions });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/me/sessions/:id
router.delete('/sessions/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await profileService.revokeSession(req.userId!, req.params.id);
    res.json({ success: true, message: 'Session revoked.' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/me/sessions/revoke-others
router.post('/sessions/revoke-others', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await profileService.revokeOtherSessions(req.userId!, req.sessionId);
    res.json({ success: true, message: 'All other sessions have been signed out.' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/me - Delete account (Requires password verification & sole owner check)
router.delete('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: 'Password is required to confirm account deletion.' });
    }
    await profileService.deleteAccount(req.userId!, password);
    res.json({ success: true, message: 'Account deleted successfully.' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
