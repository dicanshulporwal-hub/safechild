import { db } from '../db/store';
import {
  Device,
  PairingCode,
  DevicePlatform,
  HeartbeatPayload,
  HeartbeatResponse,
} from '@safebrowse/shared';
import { HealthState, CURRENT_PROTOCOL_VERSION } from '@safebrowse/protocol';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { wsManager } from './websocket.service';
import { notificationService } from './notification.service';

export interface ExtendedDevice extends Device {
  isRevoked?: boolean;
  revokedAt?: string | null;
  healthState: HealthState;
}

export class DeviceService {
  private revokedTokenBlacklist: Set<string> = new Set();

  /**
   * Generate cryptographically secure, high-entropy pairing code (e.g. "SB-K8X9-M2W7")
   */
  public generatePairingCode(parentId: string, childId: string): PairingCode {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let token = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) {
      token += chars[bytes[i] % chars.length];
    }
    const code = `SB-${token.slice(0, 4)}-${token.slice(4, 8)}`;

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const child = db.children.get(childId);
    if (!child || !child.familyId || !db.families.has(child.familyId)) {
      throw new Error('Mandatory tenancy error: Child must belong to a valid family.');
    }
    const pairingCode: PairingCode = {
      code,
      childId,
      parentId,
      familyId: child.familyId,
      expiresAt,
    };

    db.pairingCodes.set(code, pairingCode);
    return pairingCode;
  }

  /**
   * Claim pairing code and issue unique permanent device credentials
   */
  public pairDevice(
    code: string,
    deviceName: string,
    platform: DevicePlatform,
    agentVersion: string = '1.0.0'
  ): { device: ExtendedDevice; policy: any } {
    const cleanCode = code.trim().toUpperCase();
    const pairing = db.pairingCodes.get(cleanCode);

    if (!pairing) {
      throw new Error('Invalid or expired pairing code.');
    }

    if (new Date() > new Date(pairing.expiresAt)) {
      db.pairingCodes.delete(cleanCode);
      throw new Error('Pairing code has expired. Please generate a new one.');
    }

    const deviceId = `dev-${nanoid(10)}`;
    const deviceToken = `dtk_${crypto.randomBytes(32).toString('hex')}`;
    const now = new Date().toISOString();

    const policy = db.policies.get(pairing.childId);
    const policyVersion = policy ? policy.version : 1;
    const child = db.children.get(pairing.childId);
    if (!child || !child.familyId || !db.families.has(child.familyId)) {
      throw new Error('Mandatory tenancy error: Child must belong to a valid family.');
    }
    const familyId = child.familyId;

    const device: ExtendedDevice = {
      id: deviceId,
      childId: pairing.childId,
      parentId: pairing.parentId,
      familyId,
      name: deviceName || `${platform === 'android' ? 'Android Phone' : 'Windows Laptop'}`,
      platform,
      deviceToken,
      pairedAt: now,
      lastSyncAt: now,
      lastHeartbeatAt: now,
      activePolicyVersion: policyVersion,
      healthStatus: 'protected',
      healthState: 'PROTECTED',
      isRevoked: false,
      agentVersion,
    };

    db.devices.set(deviceId, device as any);
    db.pairingCodes.delete(cleanCode);
    db.save();

    wsManager.broadcast({
      type: 'DEVICE_PAIRED',
      payload: device,
      parentId: device.parentId,
      childId: device.childId,
    });

    return { device, policy };
  }

  /**
   * Process heartbeat ping from child device with 4-state health classification
   */
  public processHeartbeat(payload: HeartbeatPayload): HeartbeatResponse {
    const device = db.devices.get(payload.deviceId) as ExtendedDevice | undefined;
    if (!device) {
      throw new Error('Device not registered.');
    }

    // Check revocation
    if (device.isRevoked || this.revokedTokenBlacklist.has(device.deviceToken)) {
      throw new Error('Device credentials have been revoked.');
    }

    if (device.deviceToken !== payload.deviceToken) {
      throw new Error('Unauthorized device token.');
    }

    const policy = db.policies.get(device.childId);
    const latestVersion = policy ? policy.version : 1;
    const isPolicyChanged = payload.activePolicyVersion < latestVersion;

    const now = new Date().toISOString();
    device.lastHeartbeatAt = now;
    device.activePolicyVersion = payload.activePolicyVersion;
    device.agentVersion = payload.agentVersion || device.agentVersion;

    const prevHealth = device.healthState;

    // 4-State Health Evaluation: PROTECTED, WARNING, INACTIVE, OFFLINE
    if (!payload.enforcementActive) {
      device.healthState = 'INACTIVE';
      device.healthStatus = 'inactive';
      if (prevHealth !== 'INACTIVE') {
        notificationService.createNotification(
          device.childId,
          'ENFORCEMENT_STOPPED',
          'Protection Stopped',
          `SafeBrowse protection was stopped or VPN disconnected on ${device.name}.`,
          device.id,
          device.name
        );
      }
    } else if (isPolicyChanged) {
      device.healthState = 'WARNING';
      device.healthStatus = 'syncing';
      if (prevHealth !== 'WARNING') {
        notificationService.createNotification(
          device.childId,
          'POLICY_OUTDATED',
          'Policy Outdated',
          `${device.name} is running an older policy version (v${device.activePolicyVersion}). Syncing to v${latestVersion}...`,
          device.id,
          device.name
        );
      }
    } else {
      device.healthState = 'PROTECTED';
      device.healthStatus = 'protected';
      if (prevHealth === 'INACTIVE' || prevHealth === 'WARNING') {
        notificationService.createNotification(
          device.childId,
          'PROTECTION_RESTORED',
          'Protection Restored',
          `${device.name} is now protected and up-to-date.`,
          device.id,
          device.name
        );
      }
    }

    db.devices.set(device.id, device as any);

    wsManager.broadcast({
      type: 'DEVICE_HEALTH_CHANGED',
      payload: {
        deviceId: device.id,
        healthState: device.healthState,
        healthStatus: device.healthStatus,
        activePolicyVersion: device.activePolicyVersion,
        lastHeartbeatAt: device.lastHeartbeatAt,
      },
      parentId: device.parentId,
      childId: device.childId,
    });

    return {
      status: 'ok',
      latestPolicyVersion: latestVersion,
      policyChanged: isPolicyChanged,
      serverTime: now,
    };
  }

  /**
   * Revoke device credentials permanently
   */
  /**
   * Revoke device credentials permanently (Requires DEVICE_MANAGE permission in device's family)
   */
  public revokeDevice(deviceId: string, actorUserId: string) {
    const device = db.devices.get(deviceId) as ExtendedDevice | undefined;
    if (!device) {
      throw new Error('Device not found.');
    }

    const { rbacService, FamilyPermission } = require('./rbac.service');
    const family = rbacService.getFamilyForDevice(deviceId);
    if (!family || !rbacService.getFamilyMembership(actorUserId, family.id)) {
      throw new Error('Forbidden. You do not belong to the family that owns this device.');
    }

    if (!rbacService.hasFamilyPermission(actorUserId, family.id, FamilyPermission.DEVICE_MANAGE)) {
      throw new Error('Forbidden. Insufficient permissions to revoke device credentials.');
    }

    device.isRevoked = true;
    device.revokedAt = new Date().toISOString();
    device.healthState = 'INACTIVE';
    device.healthStatus = 'inactive';

    if (device.deviceToken) {
      this.revokedTokenBlacklist.add(device.deviceToken);
      device.deviceToken = `revoked_${nanoid(16)}`;
    }

    db.devices.set(deviceId, device as any);
    db.save();

    // Broadcast revocation event
    wsManager.broadcast({
      type: 'DEVICE_HEALTH_CHANGED',
      payload: {
        deviceId: device.id,
        isRevoked: true,
        healthState: 'INACTIVE',
      },
      parentId: device.parentId,
      childId: device.childId,
    });
  }

  /**
   * Rotate device secret token
   */
  public rotateDeviceToken(deviceId: string, currentToken: string): { newDeviceToken: string } {
    const device = db.devices.get(deviceId) as ExtendedDevice | undefined;
    if (!device || device.deviceToken !== currentToken) {
      throw new Error('Unauthorized or device not found.');
    }
    if (device.isRevoked) {
      throw new Error('Cannot rotate token for a revoked device.');
    }

    this.revokedTokenBlacklist.add(device.deviceToken);
    const newToken = `dtk_${crypto.randomBytes(32).toString('hex')}`;
    device.deviceToken = newToken;
    db.devices.set(deviceId, device as any);
    db.save();

    return { newDeviceToken: newToken };
  }

  public getDevice(deviceId: string): ExtendedDevice | undefined {
    return db.devices.get(deviceId) as ExtendedDevice | undefined;
  }

  public isDeviceRevoked(deviceId: string): boolean {
    const device = db.devices.get(deviceId) as ExtendedDevice | undefined;
    return Boolean(device?.isRevoked);
  }

  public getDevicesForChild(childId: string): ExtendedDevice[] {
    const now = Date.now();
    const childDevices = (Array.from(db.devices.values()) as ExtendedDevice[]).filter((d) => d.childId === childId);

    return childDevices.map((dev) => {
      const lastHb = new Date(dev.lastHeartbeatAt).getTime();
      const elapsedSeconds = (now - lastHb) / 1000;

      let state: HealthState = dev.healthState || 'PROTECTED';
      if (dev.isRevoked) {
        state = 'INACTIVE';
      } else if (elapsedSeconds > 90) {
        state = 'OFFLINE';
      }

      return {
        ...dev,
        healthState: state,
        healthStatus: state === 'OFFLINE' || state === 'INACTIVE' ? 'inactive' : dev.healthStatus,
      };
    });
  }

  public getDevicesForParent(parentId: string, familyId?: string): ExtendedDevice[] {
    const { rbacService } = require('./rbac.service');
    const userFamilyIds = rbacService.getUserFamilyMemberships(parentId).map((m: any) => m.familyId);
    const targetFamilyIds = familyId ? [familyId] : userFamilyIds;
    const allowedSet = new Set<string>(targetFamilyIds.filter((fid: string) => userFamilyIds.includes(fid)));

    const now = Date.now();
    const parentDevices = (Array.from(db.devices.values()) as ExtendedDevice[]).filter(
      (d) => d.familyId && allowedSet.has(d.familyId)
    );

    return parentDevices.map((dev) => {
      const lastHb = new Date(dev.lastHeartbeatAt).getTime();
      const elapsedSeconds = (now - lastHb) / 1000;

      let state: HealthState = dev.healthState || 'PROTECTED';
      if (dev.isRevoked) {
        state = 'INACTIVE';
      } else if (elapsedSeconds > 90) {
        state = 'OFFLINE';
      }

      return {
        ...dev,
        healthState: state,
        healthStatus: state === 'OFFLINE' || state === 'INACTIVE' ? 'inactive' : dev.healthStatus,
      };
    });
  }

  public removeDevice(deviceId: string, actorUserId: string) {
    const device = db.devices.get(deviceId);
    if (!device) {
      throw new Error('Device not found.');
    }

    const { rbacService, FamilyPermission } = require('./rbac.service');
    const family = rbacService.getFamilyForDevice(deviceId);
    if (!family || !rbacService.getFamilyMembership(actorUserId, family.id)) {
      throw new Error('Forbidden. You do not belong to the family that owns this device.');
    }

    if (!rbacService.hasFamilyPermission(actorUserId, family.id, FamilyPermission.DEVICE_MANAGE)) {
      throw new Error('Forbidden. Insufficient permissions to remove devices.');
    }

    db.devices.delete(deviceId);
    db.save();
  }
}

export const deviceService = new DeviceService();
