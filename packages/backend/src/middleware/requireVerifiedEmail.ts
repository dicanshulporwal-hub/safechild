import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth';
import { db } from '../db/store';

/**
 * Middleware that blocks unverified parent accounts from accessing product operations
 * (children, devices, policies, access requests, usage controls, family operations).
 *
 * Essential account and security functions (/api/auth/*, /api/me/sessions, etc.) remain accessible.
 */
export function requireVerifiedEmail(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const userId = req.userId;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized. Authentication required.' });
  }

  const user = db.users.get(userId);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized. User account not found.' });
  }

  if (!user.emailVerified) {
    return res.status(403).json({
      code: 'EMAIL_VERIFICATION_REQUIRED',
      error: 'Verify your email address before using SafeBrowse.',
    });
  }

  next();
}
