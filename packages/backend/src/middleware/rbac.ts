import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth';
import { rbacService, SystemPermission, FamilyPermission } from '../services/rbac.service';
import { db } from '../db/store';

/**
 * Middleware: Require System Administrator Role / Permission
 */
export function requireSystemAdmin(permission: SystemPermission = SystemPermission.SYSTEM_OPERATIONS_READ) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.userId) {
      return res.status(401).json({ error: 'Unauthorized: Authentication required.' });
    }

    if (!rbacService.hasSystemPermission(req.userId, permission)) {
      return res.status(403).json({ error: 'Forbidden: System administrator privilege required.' });
    }

    next();
  };
}

/**
 * Middleware: Require Family Membership & Specific Family Permission
 */
export function requireFamilyPermission(
  permission: FamilyPermission,
  getFamilyId?: (req: AuthenticatedRequest) => string | undefined
) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.userId) {
      return res.status(401).json({ error: 'Unauthorized: Authentication required.' });
    }

    let familyId: string | undefined;

    if (getFamilyId) {
      familyId = getFamilyId(req);
    } else if (req.params.familyId) {
      familyId = req.params.familyId;
    } else if (req.body && req.body.familyId) {
      familyId = req.body.familyId;
    } else if (req.query && req.query.familyId) {
      familyId = String(req.query.familyId);
    } else if (req.params.childId) {
      familyId = rbacService.getFamilyForChild(req.params.childId)?.id;
    } else if (req.body && req.body.childId) {
      familyId = rbacService.getFamilyForChild(req.body.childId)?.id;
    } else if (req.params.deviceId) {
      familyId = rbacService.getFamilyForDevice(req.params.deviceId)?.id;
    } else if (req.params.id) {
      // Try resolving as childId, deviceId, or requestId
      familyId =
        rbacService.getFamilyForChild(req.params.id)?.id ||
        rbacService.getFamilyForDevice(req.params.id)?.id ||
        rbacService.getFamilyForRequest(req.params.id)?.id;
    }

    if (!familyId) {
      // Fallback: If user has a primary family and no specific target ID was requested (e.g. list children)
      const membership = Array.from(db.familyMembers.values()).find((m) => m.userId === req.userId);
      if (membership) {
        familyId = membership.familyId;
      }
    }

    if (!familyId) {
      return res.status(404).json({ error: 'Resource or family not found.' });
    }

    // Check membership
    const membership = rbacService.getFamilyMembership(req.userId, familyId);
    if (!membership) {
      return res.status(403).json({ error: 'Forbidden: You do not belong to this family.' });
    }

    // Check permission
    if (!rbacService.hasFamilyPermission(req.userId, familyId, permission)) {
      return res.status(403).json({
        error: `Forbidden: Insufficient family permissions. Role '${membership.role}' lacks permission '${permission}'.`,
      });
    }

    // Attach verified familyId to request for downstream handlers
    (req as any).familyId = familyId;
    (req as any).familyRole = membership.role;
    next();
  };
}
