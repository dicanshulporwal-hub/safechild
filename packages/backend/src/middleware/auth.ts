import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service';
import { prisma } from '../db/prisma';

export interface AuthenticatedRequest extends Request {
  userId?: string;
  sessionId?: string;
  tokenVersion?: number;
}

export async function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if ((req as any).cookies && (req as any).cookies.accessToken) {
    token = (req as any).cookies.accessToken;
  }

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized. Authentication token missing.' });
  }

  try {
    const decoded = await authService.verifyToken(token);
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { status: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized. User account not found.' });
    }

    if (user.status === 'DISABLED') {
      return res.status(403).json({
        error: 'This account has been disabled. Contact the administrator.',
        code: 'ACCOUNT_DISABLED',
      });
    }

    req.userId = decoded.userId;
    req.sessionId = decoded.sessionId;
    req.tokenVersion = decoded.tokenVersion;
    next();
  } catch (e: any) {
    if (e.code === 'ACCOUNT_DISABLED' || e.message?.includes('ACCOUNT_DISABLED') || e.message?.includes('account has been disabled')) {
      return res.status(403).json({
        error: 'This account has been disabled. Contact the administrator.',
        code: 'ACCOUNT_DISABLED',
      });
    }
    return res.status(401).json({ error: e.message || 'Unauthorized. Invalid, expired or revoked token.' });
  }
}
