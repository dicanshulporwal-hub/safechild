import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service';

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
    req.userId = decoded.userId;
    req.sessionId = decoded.sessionId;
    req.tokenVersion = decoded.tokenVersion;
    next();
  } catch (e: any) {
    return res.status(401).json({ error: e.message || 'Unauthorized. Invalid, expired or revoked token.' });
  }
}
