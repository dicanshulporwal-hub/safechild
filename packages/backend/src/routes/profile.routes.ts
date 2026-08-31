import { Router, Request, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { profileService } from '../services/profile.service';

const router = Router();

// GET /api/me - Full profile
router.get('/', authMiddleware, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const profile = profileService.getProfile(authReq.userId!);
    res.json(profile);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// PATCH /api/me - Update profile details
router.patch('/', authMiddleware, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { name, mobileNumber, profilePhoto, timezone, language, notificationPrefs } = req.body;
    const profile = profileService.updateProfile(authReq.userId!, {
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
router.post('/change-password', authMiddleware, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { currentPassword, newPassword } = req.body;
    const token = req.headers.authorization?.replace('Bearer ', '');
    profileService.changePassword(authReq.userId!, currentPassword, newPassword, token);
    res.json({ success: true, message: 'Password updated successfully.' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/me/mfa/setup
router.post('/mfa/setup', authMiddleware, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const setupData = profileService.setupMfa(authReq.userId!);
    res.json(setupData);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/me/mfa/verify
router.post('/mfa/verify', authMiddleware, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { otpCode } = req.body;
    const result = profileService.verifyAndEnableMfa(authReq.userId!, otpCode);
    res.json({ success: true, recoveryCodes: result.recoveryCodes });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/me/mfa/disable
router.post('/mfa/disable', authMiddleware, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { password } = req.body;
    profileService.disableMfa(authReq.userId!, password);
    res.json({ success: true, message: 'MFA has been disabled.' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/me/mfa/recovery-codes/regenerate
router.post('/mfa/recovery-codes/regenerate', authMiddleware, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const result = profileService.regenerateRecoveryCodes(authReq.userId!);
    res.json({ success: true, recoveryCodes: result.recoveryCodes });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/me/sessions
router.get('/sessions', authMiddleware, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const sessions = profileService.getSessions(authReq.userId!);
    res.json({ sessions });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/me/sessions/:id
router.delete('/sessions/:id', authMiddleware, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    profileService.revokeSession(authReq.userId!, req.params.id);
    res.json({ success: true, message: 'Session revoked.' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/me/sessions/revoke-others
router.post('/sessions/revoke-others', authMiddleware, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const token = req.headers.authorization?.replace('Bearer ', '');
    profileService.revokeOtherSessions(authReq.userId!, token || '');
    res.json({ success: true, message: 'All other sessions have been signed out.' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
