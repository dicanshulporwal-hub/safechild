import { Router, Request, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { familyService } from '../services/family.service';

const router = Router();

// GET /api/family - Overview & Members
router.get('/', authMiddleware, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const overview = familyService.getFamilyOverview(authReq.userId!);
    res.json(overview);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// PATCH /api/family - Update family settings
router.patch('/', authMiddleware, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { familyId, name, requireMfa, approvalRule } = req.body;
    const updated = familyService.updateFamily(familyId, authReq.userId!, {
      name,
      requireMfa,
      approvalRule,
    });
    res.json({ success: true, family: updated });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/family/members
router.get('/members', authMiddleware, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const overview = familyService.getFamilyOverview(authReq.userId!);
    res.json({ members: overview.members });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/family/members/:id - Remove member (Owner only)
router.delete('/members/:id', authMiddleware, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { familyId } = req.query;
    if (!familyId) throw new Error('familyId query param is required.');
    familyService.removeMember(String(familyId), req.params.id, authReq.userId!);
    res.json({ success: true, message: 'Member removed from family.' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/family/transfer-ownership
router.post('/transfer-ownership', authMiddleware, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { familyId, newOwnerUserId } = req.body;
    familyService.transferOwnership(familyId, newOwnerUserId, authReq.userId!);
    res.json({ success: true, message: 'Family ownership transferred.' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/family/invitations - Invite co-parent
router.post('/invitations', authMiddleware, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { familyId, email, role } = req.body;
    const invitation = familyService.inviteParent(familyId, authReq.userId!, email, role);
    res.json({ success: true, invitation });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/family/invitations - List invitations
router.get('/invitations', authMiddleware, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const overview = familyService.getFamilyOverview(authReq.userId!);
    res.json({ invitations: overview.invitations });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/family/invitations/:id - Revoke invitation
router.delete('/invitations/:id', authMiddleware, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    familyService.revokeInvitation(req.params.id, authReq.userId!);
    res.json({ success: true, message: 'Invitation revoked.' });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/family/invitations/accept - Accept invitation
router.post('/invitations/accept', authMiddleware, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { token } = req.body;
    const result = familyService.acceptInvitation(token, authReq.userId!);
    res.json({ success: true, ...result });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/family/audit - Family audit logs
router.get('/audit', authMiddleware, (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const family = familyService.getOrCreateUserFamily(authReq.userId!);
    const logs = familyService.getAuditLogs(family.id, authReq.userId!);
    res.json({ logs });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
