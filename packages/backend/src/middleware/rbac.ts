import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth';
import { rbacService, SystemPermission, FamilyPermission } from '../services/rbac.service';
import { prisma } from '../db/prisma';

/**
 * Middleware: Require System Administrator Role / Permission
 */
export function requireSystemAdmin(permission: SystemPermission = SystemPermission.SYSTEM_OPERATIONS_READ) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.userId) {
      return res.status(401).json({ error: 'Unauthorized: Authentication required.' });
    }

    try {
      const hasPerm = await rbacService.hasSystemPermission(req.userId, permission);
      if (!hasPerm) {
        return res.status(403).json({ error: 'Forbidden: System administrator privilege required.' });
      }

      next();
    } catch (err: any) {
      return res.status(500).json({ error: 'Internal server error verifying system admin privilege.' });
    }
  };
}

/**
 * Middleware: Require Family Membership & Specific Family Permission
 */
export function requireFamilyPermission(
  permission: FamilyPermission,
  getFamilyId?: (req: AuthenticatedRequest) => string | undefined
) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.userId) {
      return res.status(401).json({ error: 'Unauthorized: Authentication required.' });
    }

    try {
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
        familyId = (await rbacService.getFamilyForChild(req.params.childId))?.id;
      } else if (req.body && req.body.childId) {
        familyId = (await rbacService.getFamilyForChild(req.body.childId))?.id;
      } else if (req.params.deviceId) {
        familyId = (await rbacService.getFamilyForDevice(req.params.deviceId))?.id;
      } else if (req.params.id) {
        // Try resolving as childId, deviceId, or requestId
        const forChild = await rbacService.getFamilyForChild(req.params.id);
        const forDevice = await rbacService.getFamilyForDevice(req.params.id);
        const forRequest = await rbacService.getFamilyForRequest(req.params.id);
        familyId = forChild?.id || forDevice?.id || forRequest?.id;
      }

      if (!familyId) {
        // Fallback: If user has a membership and no specific target ID was requested (e.g. list children)
        const membership = await prisma.familyMember.findFirst({
          where: { userId: req.userId },
        });
        if (membership) {
          familyId = membership.familyId;
        }
      }

      if (!familyId) {
        return res.status(404).json({ error: 'Resource or family not found.' });
      }

      // Check membership
      const membership = await rbacService.getFamilyMembership(req.userId, familyId);
      if (!membership) {
        return res.status(403).json({ error: 'Forbidden: You do not belong to this family.' });
      }

      // Check permission
      const hasPerm = await rbacService.hasFamilyPermission(req.userId, familyId, permission);
      if (!hasPerm) {
        return res.status(403).json({
          error: `Forbidden: Insufficient family permissions. Role '${membership.role}' lacks permission '${permission}'.`,
        });
      }

      // Attach verified familyId to request for downstream handlers
      (req as any).familyId = familyId;
      (req as any).familyRole = membership.role;
      next();
    } catch (err: any) {
      return res.status(500).json({ error: 'Internal server error verifying family permission.' });
    }
  };
}
