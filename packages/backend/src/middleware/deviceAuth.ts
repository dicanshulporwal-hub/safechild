import { Request, Response, NextFunction } from 'express';
import { db } from '../db/store';
import { Device } from '@safebrowse/shared';

export interface AuthenticatedDeviceRequest extends Request {
  device?: Device;
  deviceId?: string;
  childId?: string;
}

/**
 * Middleware that validates device-agent authentication for device operations:
 * - Extracts deviceId from request header ('x-device-id'), query ('deviceId'), body ('deviceId'), or params ('deviceId'/'id')
 * - Extracts deviceToken from header ('x-device-token' or 'Authorization: Bearer dtk_...'), query ('deviceToken'), or body ('deviceToken')
 * - Validates device existence
 * - Validates that device credentials are not revoked
 * - Validates device token equality
 * - If request specifies childId, validates child/device association (device.childId === req.body.childId)
 * - Rejects parent JWT tokens as device credentials
 */
export function deviceAuthMiddleware(
  req: AuthenticatedDeviceRequest,
  res: Response,
  next: NextFunction
) {
  const deviceId =
    (req.headers['x-device-id'] as string) ||
    (req.query.deviceId as string) ||
    (req.body && req.body.deviceId) ||
    req.params.deviceId ||
    req.params.id;

  let deviceToken =
    (req.headers['x-device-token'] as string) ||
    (req.query.deviceToken as string) ||
    (req.body && req.body.deviceToken);

  const authHeader = req.headers.authorization;
  if (!deviceToken && authHeader && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.substring(7).trim();
    if (bearer.startsWith('dtk_')) {
      deviceToken = bearer;
    } else {
      // Parent JWT or invalid bearer supplied for device endpoint
      return res.status(401).json({
        error: 'Invalid device credentials. Parent tokens are not accepted for device endpoints.',
      });
    }
  }

  if (!deviceId || typeof deviceId !== 'string' || deviceId.trim() === '') {
    return res.status(401).json({ error: 'Device authentication failed: deviceId is required.' });
  }

  if (!deviceToken || typeof deviceToken !== 'string' || deviceToken.trim() === '') {
    return res.status(401).json({ error: 'Device authentication failed: deviceToken is required.' });
  }

  const device = db.devices.get(deviceId.trim());
  if (!device) {
    return res.status(401).json({ error: 'Device authentication failed: Device not found.' });
  }

  if ((device as any).isRevoked) {
    return res.status(403).json({ error: 'Forbidden: Device credentials have been revoked.' });
  }

  if (device.deviceToken !== deviceToken.trim()) {
    return res.status(401).json({ error: 'Device authentication failed: Invalid device token.' });
  }

  // If request specifies a childId in body or query, enforce strict child/device tenancy association
  const targetChildId = (req.body && req.body.childId) || (req.query && req.query.childId);
  if (targetChildId && targetChildId !== device.childId) {
    return res.status(403).json({
      error: 'Forbidden: Device is not associated with the requested child profile.',
    });
  }

  req.device = device;
  req.deviceId = device.id;
  req.childId = device.childId;

  next();
}
