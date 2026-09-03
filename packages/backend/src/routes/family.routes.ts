import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail';
import { familyService } from '../services/family.service';
import { DataPersistenceError } from '../types/models';

const router = Router();

// All family management endpoints require authenticated user with verified email
router.use(authMiddleware, requireVerifiedEmail);

// GET /api/family - Overview & Members
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reqFamilyId = req.query.familyId as string | undefined;
    const overview = await familyService.getFamilyOverview(req.userId!, reqFamilyId);
    res.json(overview);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// PATCH /api/family - Update family settings
router.patch('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { familyId, name, requireMfa, approvalRule } = req.body;
    if (!familyId) {
      return res.status(400).json({ error: 'familyId is required.' });
    }
    const updated = await familyService.updateFamily(familyId, req.userId!, {
      name,
      requireMfa,
      approvalRule,
    });
    res.json({ success: true, family: updated });
  } catch (e: any) {
    const status = e.message.includes('Forbidden') ? 403 : 400;
    res.status(status).json({ error: e.message });
  }
});

// GET /api/family/members - List members
router.get('/members', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const overview = await familyService.getFamilyOverview(req.userId!);
    res.json({ members: overview.members });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// PATCH /api/family/members/:id/role - Change member role (Owner only)
router.patch('/members/:id/role', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { familyId, role } = req.body;
    if (!familyId || !role) {
      return res.status(400).json({ error: 'familyId and role are required.' });
    }
    const updated = await familyService.changeMemberRole(familyId, req.params.id, role, req.userId!);
    res.json({ success: true, member: updated });
  } catch (e: any) {
    const status = e.message.includes('Forbidden') ? 403 : 400;
    res.status(status).json({ error: e.message });
  }
});

// DELETE /api/family/members/:id - Remove member (Owner only)
router.delete('/members/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { familyId } = req.query;
    if (!familyId) {
      return res.status(400).json({ error: 'familyId query param is required.' });
    }
    await familyService.removeMember(String(familyId), req.params.id, req.userId!);
    res.json({ success: true, message: 'Member removed from family.' });
  } catch (e: any) {
    const status = e.message.includes('Forbidden') || e.message.includes('Cannot remove') ? 403 : 400;
    res.status(status).json({ error: e.message });
  }
});

// POST /api/family/transfer-ownership - Transfer ownership with step-up verification
router.post('/transfer-ownership', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { familyId, newOwnerUserId, password, otpCode, timeSec } = req.body;
    if (!familyId || !newOwnerUserId) {
      return res.status(400).json({ error: 'familyId and newOwnerUserId are required.' });
    }
    await familyService.transferOwnership(familyId, newOwnerUserId, req.userId!, password, otpCode, timeSec);
    res.json({ success: true, message: 'Family ownership transferred.' });
  } catch (e: any) {
    if (e instanceof DataPersistenceError || e.name === 'DataPersistenceError') {
      return res.status(500).json({ error: 'Database persistence failure. Changes were safely rolled back.' });
    }
    const status =
      e.message.includes('Forbidden') ||
      e.message.includes('Step-up') ||
      e.message.includes('password') ||
      e.message.includes('MFA') ||
      e.message.includes('already been used') ||
      e.message.includes('Target user') ||
      e.message.includes('yourself')
        ? 403
        : 400;
    res.status(status).json({ error: e.message });
  }
});

// POST /api/family/invitations - Invite co-parent
router.post('/invitations', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { familyId, email, role } = req.body;
    if (!familyId || !email) {
      return res.status(400).json({ error: 'familyId and email are required.' });
    }
    const result = await familyService.inviteMember(familyId, email, role || 'PARENT', req.userId!);
    res.json({
      success: true,
      invitation: {
        ...result.invitation,
        token: result.rawToken,
      },
      rawToken: result.rawToken,
      token: result.rawToken,
    });
  } catch (e: any) {
    const status = e.message.includes('Forbidden') ? 403 : 400;
    res.status(status).json({ error: e.message });
  }
});

// GET /api/family/invitations - List invitations
router.get('/invitations', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const overview = await familyService.getFamilyOverview(req.userId!);
    res.json({ invitations: overview.invitations });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/family/invitations/:id - Revoke invitation
router.delete('/invitations/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    await familyService.revokeInvitation(req.params.id, req.userId!);
    res.json({ success: true, message: 'Invitation revoked.' });
  } catch (e: any) {
    const status = e.message.includes('Forbidden') ? 403 : 400;
    res.status(status).json({ error: e.message });
  }
});

// POST /api/family/invitations/accept - Accept invitation
router.post('/invitations/accept', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'token is required.' });
    }
    const result = await familyService.acceptInvitation(token, req.userId!);
    res.json({ success: true, ...result });
  } catch (e: any) {
    const status = e.message.includes('MISMATCH') || e.message.includes('Invalid') ? 400 : 400;
    res.status(status).json({ error: e.message });
  }
});

// GET /api/family/audit - Family audit logs
router.get('/audit', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const family = await familyService.getOrCreateUserFamily(req.userId!);
    const logs = await familyService.getAuditLogs(family.id, req.userId!);
    res.json({ logs });
  } catch (e: any) {
    const status = e.message.includes('Forbidden') ? 403 : 400;
    res.status(status).json({ error: e.message });
  }
});

export default router;
