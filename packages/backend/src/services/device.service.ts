import { prisma } from '../db/prisma';
import {
  Device,
  PairingCode,
  DevicePlatform,
  HeartbeatPayload,
  HeartbeatResponse,
} from '@safebrowse/shared';
import { HealthState } from '@safebrowse/protocol';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { wsManager } from './websocket.service';
import { notificationService } from './notification.service';
import { rbacService, FamilyPermission } from './rbac.service';

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
  public async generatePairingCode(parentId: string, childId: string): Promise<PairingCode> {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let token = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) {
      token += chars[bytes[i] % chars.length];
    }
    const code = `SB-${token.slice(0, 4)}-${token.slice(4, 8)}`;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const child = await prisma.child.findUnique({
      where: { id: childId },
    });
    if (!child || !child.familyId) {
      throw new Error('Mandatory tenancy error: Child must belong to a valid family.');
    }

    const created = await prisma.pairingCode.create({
      data: {
        id: `pair-${nanoid(10)}`,
        code,
        childId,
        createdByParentId: parentId,
        familyId: child.familyId,
        expiresAt,
      },
    });

    return {
      code: created.code,
      childId: created.childId,
      parentId: created.createdByParentId,
      familyId: created.familyId,
      expiresAt: created.expiresAt.toISOString(),
    };
  }

  /**
   * Claim pairing code and issue unique permanent device credentials transactionally
   */
  public async pairDevice(
    code: string,
    deviceName: string,
    platform: DevicePlatform,
    agentVersion: string = '1.0.0'
  ): Promise<{ device: ExtendedDevice; policy: any }> {
    const cleanCode = code.trim().toUpperCase();

    return prisma.$transaction(async (tx) => {
      const pairing = await tx.pairingCode.findUnique({
        where: { code: cleanCode },
      });

      if (!pairing) {
        throw new Error('Invalid or expired pairing code.');
      }

      if (pairing.expiresAt.getTime() <= Date.now()) {
        await tx.pairingCode.delete({ where: { id: pairing.id } });
        throw new Error('Pairing code has expired. Please generate a new one.');
      }

      const deviceId = `dev-${nanoid(10)}`;
      const deviceToken = `dtk_${crypto.randomBytes(32).toString('hex')}`;

      const policy = await tx.policy.findUnique({
        where: { childId: pairing.childId },
      });
      const policyVersion = policy ? policy.version : 1;

      const deviceRecord = await tx.device.create({
        data: {
          id: deviceId,
          childId: pairing.childId,
          parentId: pairing.createdByParentId,
          familyId: pairing.familyId,
          name: deviceName || `${platform === 'android' ? 'Android Phone' : 'Windows Laptop'}`,
          platform,
          deviceToken,
          agentVersion,
          healthStatus: 'protected',
          healthState: 'PROTECTED',
          isRevoked: false,
        },
      });

      // Atomically consume pairing code (single-use)
      await tx.pairingCode.delete({
        where: { id: pairing.id },
      });

      const extendedDevice: ExtendedDevice = {
        id: deviceRecord.id,
        childId: deviceRecord.childId,
        parentId: deviceRecord.parentId,
        familyId: deviceRecord.familyId,
        name: deviceRecord.name,
        platform: deviceRecord.platform as DevicePlatform,
        deviceToken: deviceRecord.deviceToken || deviceToken,
        pairedAt: deviceRecord.createdAt.toISOString(),
        lastSyncAt: deviceRecord.updatedAt.toISOString(),
        lastHeartbeatAt: deviceRecord.lastHeartbeatAt.toISOString(),
        activePolicyVersion: policyVersion,
        healthStatus: deviceRecord.healthStatus as any,
        healthState: 'PROTECTED',
        isRevoked: false,
        agentVersion: deviceRecord.agentVersion,
      };

      wsManager.broadcast({
        type: 'DEVICE_PAIRED',
        payload: extendedDevice,
        parentId: deviceRecord.parentId,
        childId: deviceRecord.childId,
      });

      return {
        device: extendedDevice,
        policy: policy
          ? {
              ...policy,
              rules: (policy.rules as any) || [],
              updatedAt: policy.updatedAt.toISOString(),
            }
          : null,
      };
    });
  }

  /**
   * Process heartbeat ping from child device
   */
  public async processHeartbeat(payload: HeartbeatPayload): Promise<HeartbeatResponse> {
    const device = await prisma.device.findUnique({
      where: { id: payload.deviceId },
    });
    if (!device) {
      throw new Error('Device not registered.');
    }

    if (device.isRevoked || (device.deviceToken && this.revokedTokenBlacklist.has(device.deviceToken))) {
      throw new Error('Device credentials have been revoked.');
    }

    if (device.deviceToken !== payload.deviceToken) {
      throw new Error('Unauthorized device token.');
    }

    const policy = await prisma.policy.findUnique({
      where: { childId: device.childId },
    });
    const latestVersion = policy ? policy.version : 1;
    const isPolicyChanged = payload.activePolicyVersion < latestVersion;
    const now = new Date();

    let computedHealthState: any = 'PROTECTED';
    let computedHealthStatus = 'protected';

    if (!payload.enforcementActive) {
      computedHealthState = 'DEGRADED';
      computedHealthStatus = 'inactive';
    } else if (isPolicyChanged) {
      computedHealthState = 'DEGRADED';
      computedHealthStatus = 'syncing';
    }

    await prisma.device.update({
      where: { id: device.id },
      data: {
        lastHeartbeatAt: now,
        lastSeenAt: now,
        agentVersion: payload.agentVersion || device.agentVersion,
        healthState: computedHealthState,
        healthStatus: computedHealthStatus,
      },
    });

    wsManager.broadcast({
      type: 'DEVICE_HEALTH_CHANGED',
      payload: {
        deviceId: device.id,
        healthState: computedHealthState,
        healthStatus: computedHealthStatus,
        activePolicyVersion: payload.activePolicyVersion,
        lastHeartbeatAt: now.toISOString(),
      },
      parentId: device.parentId,
      childId: device.childId,
    });

    return {
      status: 'ok',
      latestPolicyVersion: latestVersion,
      policyChanged: isPolicyChanged,
      serverTime: now.toISOString(),
    };
  }

  public async revokeDevice(deviceId: string, actorUserId: string): Promise<void> {
    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) throw new Error('Device not found.');

    const family = await rbacService.getFamilyForDevice(deviceId);
    if (!family || !(await rbacService.getFamilyMembership(actorUserId, family.id))) {
      throw new Error('Forbidden. You do not belong to the family that owns this device.');
    }

    const hasPerm = await rbacService.hasFamilyPermission(
      actorUserId,
      family.id,
      FamilyPermission.DEVICE_MANAGE
    );
    if (!hasPerm) {
      throw new Error('Forbidden. Insufficient permissions to revoke device credentials.');
    }

    if (device.deviceToken) {
      this.revokedTokenBlacklist.add(device.deviceToken);
    }

    await prisma.device.update({
      where: { id: deviceId },
      data: {
        isRevoked: true,
        healthState: 'OFFLINE',
        healthStatus: 'inactive',
        deviceToken: `revoked_${nanoid(16)}`,
      },
    });

    wsManager.broadcast({
      type: 'DEVICE_HEALTH_CHANGED',
      payload: {
        deviceId: device.id,
        isRevoked: true,
        healthState: 'OFFLINE',
      },
      parentId: device.parentId,
      childId: device.childId,
    });
  }

  public async rotateDeviceToken(deviceId: string, currentToken: string): Promise<{ newDeviceToken: string }> {
    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device || device.deviceToken !== currentToken) {
      throw new Error('Unauthorized or device not found.');
    }
    if (device.isRevoked) {
      throw new Error('Cannot rotate token for a revoked device.');
    }

    if (device.deviceToken) {
      this.revokedTokenBlacklist.add(device.deviceToken);
    }
    const newToken = `dtk_${crypto.randomBytes(32).toString('hex')}`;

    await prisma.device.update({
      where: { id: deviceId },
      data: { deviceToken: newToken },
    });

    return { newDeviceToken: newToken };
  }

  public async getDevice(deviceId: string): Promise<ExtendedDevice | null> {
    const dev = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!dev) return null;
    return {
      id: dev.id,
      childId: dev.childId,
      parentId: dev.parentId,
      familyId: dev.familyId,
      name: dev.name,
      platform: dev.platform as DevicePlatform,
      deviceToken: dev.deviceToken || '',
      pairedAt: dev.createdAt.toISOString(),
      lastSyncAt: dev.updatedAt.toISOString(),
      lastHeartbeatAt: dev.lastHeartbeatAt.toISOString(),
      activePolicyVersion: 1,
      healthStatus: dev.healthStatus as any,
      healthState: dev.healthState as any,
      isRevoked: dev.isRevoked,
      agentVersion: dev.agentVersion,
    };
  }

  public async isDeviceRevoked(deviceId: string): Promise<boolean> {
    const device = await prisma.device.findUnique({
      where: { id: deviceId },
      select: { isRevoked: true },
    });
    return Boolean(device?.isRevoked);
  }

  public async getDevicesForChild(childId: string): Promise<ExtendedDevice[]> {
    const now = Date.now();
    const list = await prisma.device.findMany({
      where: { childId },
    });

    return list.map((dev) => {
      const lastHb = dev.lastHeartbeatAt.getTime();
      const elapsedSeconds = (now - lastHb) / 1000;
      let state: HealthState = (dev.healthState as any) || 'PROTECTED';
      if (dev.isRevoked) {
        state = 'INACTIVE';
      } else if (elapsedSeconds > 90) {
        state = 'OFFLINE';
      }

      return {
        id: dev.id,
        childId: dev.childId,
        parentId: dev.parentId,
        familyId: dev.familyId,
        name: dev.name,
        platform: dev.platform as DevicePlatform,
        deviceToken: dev.deviceToken || '',
        pairedAt: dev.createdAt.toISOString(),
        lastSyncAt: dev.updatedAt.toISOString(),
        lastHeartbeatAt: dev.lastHeartbeatAt.toISOString(),
        activePolicyVersion: 1,
        healthStatus: (state === 'OFFLINE' || state === 'INACTIVE' ? 'inactive' : dev.healthStatus) as any,
        healthState: state,
        isRevoked: dev.isRevoked,
        agentVersion: dev.agentVersion,
      };
    });
  }

  public async getDevicesForParent(parentId: string, familyId?: string): Promise<ExtendedDevice[]> {
    const userFamilyIds = (await rbacService.getUserFamilyMemberships(parentId)).map((m) => m.familyId);
    const targetFamilyIds = familyId ? [familyId] : userFamilyIds;
    const allowedSet = targetFamilyIds.filter((fid) => userFamilyIds.includes(fid));

    const now = Date.now();
    const list = await prisma.device.findMany({
      where: { familyId: { in: allowedSet } },
    });

    return list.map((dev) => {
      const lastHb = dev.lastHeartbeatAt.getTime();
      const elapsedSeconds = (now - lastHb) / 1000;
      let state: HealthState = (dev.healthState as any) || 'PROTECTED';
      if (dev.isRevoked) {
        state = 'INACTIVE';
      } else if (elapsedSeconds > 90) {
        state = 'OFFLINE';
      }

      return {
        id: dev.id,
        childId: dev.childId,
        parentId: dev.parentId,
        familyId: dev.familyId,
        name: dev.name,
        platform: dev.platform as DevicePlatform,
        deviceToken: dev.deviceToken || '',
        pairedAt: dev.createdAt.toISOString(),
        lastSyncAt: dev.updatedAt.toISOString(),
        lastHeartbeatAt: dev.lastHeartbeatAt.toISOString(),
        activePolicyVersion: 1,
        healthStatus: (state === 'OFFLINE' || state === 'INACTIVE' ? 'inactive' : dev.healthStatus) as any,
        healthState: state,
        isRevoked: dev.isRevoked,
        agentVersion: dev.agentVersion,
      };
    });
  }

  public async removeDevice(deviceId: string, actorUserId: string): Promise<void> {
    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) throw new Error('Device not found.');

    const family = await rbacService.getFamilyForDevice(deviceId);
    if (!family || !(await rbacService.getFamilyMembership(actorUserId, family.id))) {
      throw new Error('Forbidden. You do not belong to the family that owns this device.');
    }

    const hasPerm = await rbacService.hasFamilyPermission(
      actorUserId,
      family.id,
      FamilyPermission.DEVICE_MANAGE
    );
    if (!hasPerm) {
      throw new Error('Forbidden. Insufficient permissions to remove devices.');
    }

    await prisma.device.delete({
      where: { id: deviceId },
    });
  }
}

export const deviceService = new DeviceService();
