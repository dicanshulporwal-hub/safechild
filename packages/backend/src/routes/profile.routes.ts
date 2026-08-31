import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { profileService } from '../services/profile.service';

const router = Router();

// GET /api/me - Full profile
router.get('/', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const profile = profileService.getProfile(req.userId!);
    res.json(profile);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// PATCH /api/me - Update profile details
router.patch('/', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, mobileNumber, profilePhoto, timezone, language, notificationPrefs } = req.body;
    const profile = profileService.updateProfile(req.userId!, {
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
router.post('/change-password', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    profileService.changePassword(req.userId!, currentPassword, newPassword, req.sessionId);
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
router.post('/mfa/verify', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { otpCode } = req.body;
    const result = profileService.verifyAndEnableMfa(req.userId!, otpCode);
    res.json({ success: true, recoveryCodes: result.recoveryCodes });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/me/mfa/disable
router.post('/mfa/disable', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { password, otpCode } = req.body;
    profileService.disableMfa(req.userId!, password, otpCode);
    res.json({ success: true, message: 'MFA has been disabled.' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/me/mfa/recovery-codes/regenerate
router.post('/mfa/recovery-codes/regenerate', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const { password, otpCode } = req.body;
    const result = profileService.regenerateRecoveryCodes(req.userId!, password, otpCode);
    res.json({ success: true, recoveryCodes: result.recoveryCodes });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/me/sessions (Sanitized: NO tokens or secrets returned)
router.get('/sessions', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    const sessions = profileService.getSessions(req.userId!, req.sessionId);
    res.json({ sessions });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/me/sessions/:id
router.delete('/sessions/:id', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    profileService.revokeSession(req.userId!, req.params.id);
    res.json({ success: true, message: 'Session revoked.' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/me/sessions/revoke-others
router.post('/sessions/revoke-others', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  try {
    profileService.revokeOtherSessions(req.userId!, req.sessionId);
    res.json({ success: true, message: 'All other sessions have been signed out.' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
