import { Router, Response } from 'express';
import { deviceService } from '../services/device.service';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { requireVerifiedEmail } from '../middleware/requireVerifiedEmail';
import { childService } from '../services/child.service';
import { pairingRateLimiter } from '../middleware/rate-limiter';
import { deviceAuthMiddleware, AuthenticatedDeviceRequest } from '../middleware/deviceAuth';
import { rbacService, FamilyPermission } from '../services/rbac.service';
import { wsManager } from '../services/websocket.service';

export const deviceRouter = Router();

// Generate pairing code for a child (Parent auth required + Email Verified + Rate Limiting + Family Permission)
deviceRouter.post(
  '/pairing-code',
  authMiddleware,
  requireVerifiedEmail,
  pairingRateLimiter,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { childId } = req.body;
      if (!childId) {
        return res.status(400).json({ error: 'childId is required.' });
      }

      const child = await childService.getChild(childId);
      if (!child) {
        return res.status(404).json({ error: 'Child profile not found.' });
      }

      const family = await rbacService.getFamilyForChild(child.id);
      if (!family || !(await rbacService.getFamilyMembership(req.userId!, family.id))) {
        return res.status(403).json({ error: 'Forbidden: You do not belong to this family.' });
      }

      if (!(await rbacService.hasFamilyPermission(req.userId!, family.id, FamilyPermission.DEVICE_MANAGE))) {
        return res.status(403).json({ error: 'Forbidden: Insufficient family permissions to pair new devices.' });
      }

      const pairing = await deviceService.generatePairingCode(req.userId!, childId);
      res.json(pairing);
    } catch (e: any) {
      const status = e.message.includes('Forbidden') ? 403 : 400;
      res.status(status).json({ error: e.message });
    }
  }
);

// Claim pairing code (Rate limited)
deviceRouter.post('/claim', pairingRateLimiter, async (req, res) => {
  try {
    const { code, deviceName, platform, agentVersion } = req.body;
    if (!code || !platform) {
      return res.status(400).json({ error: 'code and platform are required.' });
    }

    const result = await deviceService.pairDevice(code, deviceName, platform, agentVersion);
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Backward compatible pair alias
deviceRouter.post('/pair', pairingRateLimiter, async (req, res) => {
  try {
    const { code, deviceName, platform, agentVersion } = req.body;
    if (!code || !platform) {
      return res.status(400).json({ error: 'code and platform are required.' });
    }

    const result = await deviceService.pairDevice(code, deviceName, platform, agentVersion);
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Periodic heartbeat from child agent (Device authentication required)
deviceRouter.post('/heartbeat', deviceAuthMiddleware, async (req: AuthenticatedDeviceRequest, res) => {
  try {
    const {
      activePolicyVersion,
      enforcementActive,
      platform,
      agentVersion,
      mappedAccountName,
      hasMultipleSessions,
      protectionStatus,
    } = req.body;

    const response = await deviceService.processHeartbeat({
      deviceId: req.deviceId!,
      deviceToken: req.device!.deviceToken,
      activePolicyVersion: activePolicyVersion || 1,
      enforcementActive: enforcementActive !== false,
      platform: platform || 'windows',
      agentVersion: agentVersion || '1.0.0',
      mappedAccountName,
      hasMultipleSessions,
      protectionStatus,
    });

    res.json(response);
  } catch (e: any) {
    res.status(401).json({ error: e.message });
  }
});

// Get available child profiles for a paired device's family (Device auth required)
deviceRouter.get('/family-profiles', deviceAuthMiddleware, async (req: AuthenticatedDeviceRequest, res: Response) => {
  try {
    const profiles = await deviceService.getFamilyProfilesForDevice(req.deviceId!);
    res.json(profiles);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

deviceRouter.get('/:id/profiles', deviceAuthMiddleware, async (req: AuthenticatedDeviceRequest, res: Response) => {
  try {
    if (req.params.id !== req.deviceId) {
      return res.status(403).json({ error: 'Forbidden: Device ID mismatch.' });
    }
    const profiles = await deviceService.getFamilyProfilesForDevice(req.deviceId!);
    res.json(profiles);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Revoke lost/compromised device credentials
deviceRouter.post('/:id/revoke', authMiddleware, requireVerifiedEmail, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await deviceService.revokeDevice(req.params.id, req.userId!);
    res.json({ success: true, message: 'Device credentials permanently revoked.' });
  } catch (e: any) {
    if (e.message.startsWith('Forbidden') || e.message.includes('Forbidden')) {
      return res.status(403).json({ error: e.message });
    }
    res.status(404).json({ error: e.message });
  }
});

// Rotate device token
deviceRouter.post('/:id/rotate-token', async (req, res) => {
  try {
    const { currentToken } = req.body;
    if (!currentToken) {
      return res.status(400).json({ error: 'currentToken is required.' });
    }
    const result = await deviceService.rotateDeviceToken(req.params.id, currentToken);
    res.json(result);
  } catch (e: any) {
    res.status(401).json({ error: e.message });
  }
});

// Get all devices for parent's family
deviceRouter.get('/', authMiddleware, requireVerifiedEmail, async (req: AuthenticatedRequest, res: Response) => {
  const reqFamilyId = req.query.familyId as string | undefined;
  if (reqFamilyId) {
    if (!(await rbacService.hasFamilyPermission(req.userId!, reqFamilyId, FamilyPermission.DEVICE_READ))) {
      return res.status(403).json({ error: 'Forbidden: Insufficient family permissions to view devices.' });
    }
    const devices = await deviceService.getDevicesForParent(req.userId!, reqFamilyId);
    return res.json(devices.map(({ deviceToken, ...rest }: any) => rest));
  }

  const userMemberships = await rbacService.getUserFamilyMemberships(req.userId!);
  const userFamilies: typeof userMemberships = [];
  for (const m of userMemberships) {
    if (await rbacService.hasFamilyPermission(req.userId!, m.familyId, FamilyPermission.DEVICE_READ)) {
      userFamilies.push(m);
    }
  }

  if (userFamilies.length === 0) {
    return res.json([]);
  }

  const devices = await deviceService.getDevicesForParent(req.userId!);
  res.json(devices.map(({ deviceToken, ...rest }: any) => rest));
});

// Get devices for a specific child
deviceRouter.get('/child/:childId', authMiddleware, requireVerifiedEmail, async (req: AuthenticatedRequest, res: Response) => {
  const child = await childService.getChild(req.params.childId);
  if (!child) {
    return res.status(404).json({ error: 'Child not found.' });
  }

  const family = await rbacService.getFamilyForChild(child.id);
  if (!family || !(await rbacService.getFamilyMembership(req.userId!, family.id))) {
    return res.status(403).json({ error: 'Forbidden: You do not belong to this family.' });
  }

  if (!(await rbacService.hasFamilyPermission(req.userId!, family.id, FamilyPermission.DEVICE_READ))) {
    return res.status(403).json({ error: 'Forbidden: Insufficient family permissions to view devices.' });
  }

  const devices = await deviceService.getDevicesForChild(req.params.childId);
  res.json(devices.map(({ deviceToken, ...rest }: any) => rest));
});

// Self-Diagnostics ("Run Protection Check") - Parent diagnostic verification
deviceRouter.post('/:id/diagnostics', authMiddleware, requireVerifiedEmail, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const device = await deviceService.getDevice(req.params.id);
    if (!device) {
      return res.status(404).json({ error: 'Device not found.' });
    }

    const family = await rbacService.getFamilyForDevice(device.id);
    if (!family || !(await rbacService.getFamilyMembership(req.userId!, family.id))) {
      return res.status(403).json({ error: 'Forbidden: You do not belong to this family.' });
    }

    if (!(await rbacService.hasFamilyPermission(req.userId!, family.id, FamilyPermission.DEVICE_READ))) {
      return res.status(403).json({ error: 'Forbidden: Insufficient family permissions to run diagnostics.' });
    }

    const now = Date.now();
    const elapsedSec = (now - new Date(device.lastHeartbeatAt || 0).getTime()) / 1000;
    const isOnline = elapsedSec < 120;
    const isEnforcing = device.enforcementActive === true;
    const isPolicySynced = device.policySyncStatus === 'SYNCED';
    const caps = (device.capabilities as any) || {};

    const isWsConnected = wsManager.isDeviceConnected(device.id);

    const checkItems = [
      {
        name: 'Device Connected & Registered',
        pass: true,
        status: 'passed',
        detail: `Paired on ${new Date(device.pairedAt).toLocaleDateString()}`,
      },
      {
        name: 'Agent Heartbeat Active',
        pass: isOnline,
        status: isOnline ? 'passed' : 'failed',
        detail: isOnline ? `Last ping ${Math.round(elapsedSec)}s ago` : 'No heartbeat received in >120 seconds',
      },
      {
        name: 'Enforcement Engine Operational',
        pass: isEnforcing ? true : false,
        status: isEnforcing ? 'passed' : 'failed',
        detail: isEnforcing ? 'Active protection filter engaged' : 'Enforcement stopped or inactive',
      },
      {
        name: 'Policy Synchronized',
        pass: isPolicySynced,
        status: isPolicySynced ? 'passed' : (isOnline ? 'warning' : 'failed'),
        detail: `Configured: v${device.configuredPolicyVersion ?? '?'}, Agent Active: v${device.agentActivePolicyVersion ?? '?'} (${device.policySyncStatus || 'UNKNOWN'})`,
      },
      {
        name: 'Backend API Reachable',
        pass: caps.backendApiReachable === true ? true : (caps.backendApiReachable === false ? false : null),
        status: caps.backendApiReachable === true ? 'passed' : (caps.backendApiReachable === false ? 'failed' : 'unknown'),
        detail: caps.backendApiReachable === true
          ? 'Agent verified cloud API reachability'
          : (caps.backendApiReachable === false ? 'Agent failed cloud API probe' : 'Unmeasured: No agent-side API reachability probe reported'),
      },
      {
        name: 'DNS / Network Interception Engine',
        pass: caps.dnsResolverHealthy === true ? true : (caps.dnsResolverHealthy === false ? false : null),
        status: caps.dnsResolverHealthy === true ? 'passed' : (caps.dnsResolverHealthy === false ? 'failed' : 'unknown'),
        detail: caps.dnsResolverHealthy === true
          ? 'Local DNS proxy actively resolving queries'
          : (caps.dnsResolverHealthy === false ? 'DNS filter failed liveness probe' : 'Unmeasured: Agent has not reported local DNS resolver diagnostic state'),
      },
      {
        name: 'Browser DoH / Encrypted DNS Bypass Trap',
        pass: device.platform === 'android' ? false : (caps.dohTrapActive === true ? true : (caps.dohTrapActive === false ? false : null)),
        status: device.platform === 'android' ? 'warning' : (caps.dohTrapActive === true ? 'passed' : (caps.dohTrapActive === false ? 'failed' : 'unknown')),
        detail: device.platform === 'android'
          ? 'Android VpnService traps standard Port 53 DNS. Browser DoH bypass requires Private DNS or device owner control (LIMITED).'
          : (caps.dohTrapActive === true ? 'Windows loopback proxy active with system-level adapter lock and DoH canary blocks' : (caps.dohTrapActive === false ? 'DoH protection inactive' : 'Unmeasured: No active DoH trap probe reported by device agent')),
      },
      {
        name: 'Real-time WebSocket Live',
        pass: isWsConnected ? true : null,
        status: isWsConnected ? 'passed' : 'unknown',
        detail: isWsConnected ? 'Bi-directional authenticated WebSocket link active' : 'Unmeasured: No authenticated real-time WebSocket reported by agent',
      },
    ];

    const failedCount = checkItems.filter((c) => c.status === 'failed').length;
    const warningCount = checkItems.filter((c) => c.status === 'warning').length;
    const unknownCount = checkItems.filter((c) => c.status === 'unknown').length;

    let verdict: 'PASS' | 'WARNING' | 'FAIL' | 'UNKNOWN' = 'PASS';
    let remediation: string = 'All security checks measured and passed. Protection is working optimally.';

    if (failedCount > 0 || !isEnforcing || !isOnline) {
      verdict = 'FAIL';
      remediation = 'One or more security checks failed. Protection is inactive, degraded, or device is offline.';
    } else if (warningCount > 0 || !isPolicySynced) {
      verdict = 'WARNING';
      remediation = 'Device is online, but some checks require attention or have platform limitations.';
    } else if (unknownCount > 0) {
      verdict = 'UNKNOWN';
      remediation = 'Basic connectivity verified, but deep agent probes (API, WebSocket, DNS, DoH) are unmeasured.';
    }

    res.json({
      deviceId: device.id,
      deviceName: device.name,
      platform: device.platform,
      verdict,
      remediation,
      timestamp: new Date().toISOString(),
      checks: checkItems,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Remove / unpair device
deviceRouter.delete('/:id', authMiddleware, requireVerifiedEmail, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await deviceService.removeDevice(req.params.id, req.userId!);
    res.json({ success: true });
  } catch (e: any) {
    if (e.message.startsWith('Forbidden') || e.message.includes('Forbidden')) {
      return res.status(403).json({ error: e.message });
    }
    res.status(404).json({ error: e.message });
  }
});

// Get device details
deviceRouter.get('/:id', authMiddleware, requireVerifiedEmail, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const details = await deviceService.getDeviceDetails(req.params.id, req.userId!);
    res.json(details);
  } catch (e: any) {
    if (e.message.startsWith('Forbidden') || e.message.includes('Forbidden')) {
      return res.status(403).json({ error: e.message });
    }
    res.status(404).json({ error: e.message });
  }
});

// Update device (rename and/or reassign child)
deviceRouter.patch('/:id', authMiddleware, requireVerifiedEmail, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, childId } = req.body;
    if (!name && !childId) {
      return res.status(400).json({ error: 'Either name or childId must be provided.' });
    }

    let result: any = null;
    if (name) {
      result = await deviceService.renameDevice(req.params.id, name, req.userId!);
    }
    if (childId) {
      result = await deviceService.reassignDevice(req.params.id, childId, req.userId!);
    }

    res.json({ success: true, device: result });
  } catch (e: any) {
    if (e.message.startsWith('Forbidden') || e.message.includes('Forbidden')) {
      return res.status(403).json({ error: e.message });
    }
    res.status(400).json({ error: e.message });
  }
});

// Trigger immediate policy sync for device
deviceRouter.post('/:id/sync', authMiddleware, requireVerifiedEmail, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await deviceService.triggerDevicePolicySync(req.params.id, req.userId!);
    res.json(result);
  } catch (e: any) {
    if (e.message.startsWith('Forbidden') || e.message.includes('Forbidden')) {
      return res.status(403).json({ error: e.message });
    }
    res.status(400).json({ error: e.message });
  }
});
