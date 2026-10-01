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

export const DEVICE_OFFLINE_THRESHOLD_SECONDS = 120;

export interface ExtendedDevice extends Device {
  isRevoked?: boolean;
  revokedAt?: string | null;
  healthState: HealthState;
  childName?: string;
  isOnline?: boolean;
  enforcementActive?: boolean;
  windowsAccountName?: string;
  hasMultipleSessions?: boolean;
  protectionStatus?: string;
  configuredPolicyVersion?: number;
  agentActivePolicyVersion?: number | null;
  policySyncStatus?: 'SYNCED' | 'SYNC_PENDING' | 'VERSION_MISMATCH' | 'UNKNOWN';
  capabilities?: any;
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
          activePolicyVersion: policyVersion,
          enforcementActive: true,
          protectionStatus: 'ACTIVE',
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
        configuredPolicyVersion: policyVersion,
        agentActivePolicyVersion: policyVersion,
        policySyncStatus: 'SYNCED',
        healthStatus: deviceRecord.healthStatus as any,
        healthState: 'PROTECTED',
        isRevoked: false,
        agentVersion: deviceRecord.agentVersion,
        windowsAccountName: '',
        hasMultipleSessions: false,
        protectionStatus: 'ACTIVE',
      };

      wsManager.broadcast({
        type: 'DEVICE_PAIRED',
        payload: extendedDevice,
        parentId: deviceRecord.parentId,
        childId: deviceRecord.childId,
      });

      const familyProfiles = await tx.child.findMany({
        where: {
          OR: [
            { familyId: deviceRecord.familyId },
            { parentId: deviceRecord.parentId },
          ],
        },
        select: {
          id: true,
          name: true,
          age: true,
        },
        orderBy: { name: 'asc' },
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
        familyProfiles,
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

    if (payload.hasMultipleSessions) {
      computedHealthState = 'DEGRADED';
      computedHealthStatus = 'attention_required';
    } else if (!payload.enforcementActive) {
      computedHealthState = 'DEGRADED';
      computedHealthStatus = 'inactive';
    } else if (isPolicyChanged) {
      computedHealthState = 'DEGRADED';
      computedHealthStatus = 'syncing';
    }

    const caps = (payload as any).capabilities;
    const mappedAccount = payload.mappedAccountName !== undefined ? payload.mappedAccountName : device.mappedAccountName;
    const multiSessions = payload.hasMultipleSessions !== undefined ? Boolean(payload.hasMultipleSessions) : device.hasMultipleSessions;
    const protStatus = payload.protectionStatus || device.protectionStatus || (computedHealthState === 'PROTECTED' ? 'MANAGED_CHILD' : 'UNKNOWN');

    await prisma.device.update({
      where: { id: device.id },
      data: {
        lastHeartbeatAt: now,
        lastSeenAt: now,
        agentVersion: payload.agentVersion || device.agentVersion,
        activePolicyVersion: payload.activePolicyVersion,
        enforcementActive: Boolean(payload.enforcementActive),
        healthState: computedHealthState,
        healthStatus: computedHealthStatus,
        mappedAccountName: mappedAccount,
        hasMultipleSessions: multiSessions,
        protectionStatus: protStatus,
        ...(caps
          ? {
              activityTelemetryAvailable: caps.activityTelemetryAvailable !== undefined ? Boolean(caps.activityTelemetryAvailable) : device.activityTelemetryAvailable,
              appUsageAvailable: caps.appUsageAvailable !== undefined ? Boolean(caps.appUsageAvailable) : device.appUsageAvailable,
              domainUsageAvailable: caps.domainUsageAvailable !== undefined ? Boolean(caps.domainUsageAvailable) : device.domainUsageAvailable,
              categoryUsageAvailable: caps.categoryUsageAvailable !== undefined ? Boolean(caps.categoryUsageAvailable) : device.categoryUsageAvailable,
              safeDinnerTimeSupported: caps.safeDinnerTimeSupported !== undefined ? Boolean(caps.safeDinnerTimeSupported) : device.safeDinnerTimeSupported,
              safeBedtimeSupported: caps.safeBedtimeSupported !== undefined ? Boolean(caps.safeBedtimeSupported) : device.safeBedtimeSupported,
              capabilities: caps as any,
            }
          : {}),
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
        mappedAccountName: payload.mappedAccountName,
        hasMultipleSessions: Boolean(payload.hasMultipleSessions),
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
    const dev = await prisma.device.findUnique({
      where: { id: deviceId },
      include: {
        child: {
          select: { name: true, policy: { select: { version: true } } },
        },
      },
    });
    if (!dev) return null;

    const now = Date.now();
    const lastHb = dev.lastHeartbeatAt.getTime();
    const elapsedSeconds = (now - lastHb) / 1000;
    const isOnline = elapsedSeconds < DEVICE_OFFLINE_THRESHOLD_SECONDS && !dev.isRevoked;
    let state: HealthState = (dev.healthState as any) || 'PROTECTED';
    if (dev.isRevoked) {
      state = 'INACTIVE';
    } else if (!isOnline) {
      state = 'OFFLINE';
    }

    const configuredVersion = dev.child?.policy?.version ?? 1;
    let policySyncStatus: 'SYNCED' | 'SYNC_PENDING' | 'VERSION_MISMATCH' | 'UNKNOWN' = 'UNKNOWN';
    if (dev.activePolicyVersion != null && configuredVersion != null) {
      if (dev.activePolicyVersion === configuredVersion) {
        policySyncStatus = 'SYNCED';
      } else if (dev.activePolicyVersion < configuredVersion) {
        policySyncStatus = 'SYNC_PENDING';
      } else {
        policySyncStatus = 'VERSION_MISMATCH';
      }
    }

    return {
      id: dev.id,
      childId: dev.childId,
      childName: dev.child?.name,
      parentId: dev.parentId,
      familyId: dev.familyId,
      name: dev.name,
      platform: dev.platform as DevicePlatform,
      deviceToken: dev.deviceToken || '',
      pairedAt: dev.createdAt.toISOString(),
      lastSyncAt: dev.updatedAt.toISOString(),
      lastHeartbeatAt: dev.lastHeartbeatAt.toISOString(),
      activePolicyVersion: dev.activePolicyVersion ?? configuredVersion,
      configuredPolicyVersion: configuredVersion,
      agentActivePolicyVersion: dev.activePolicyVersion ?? null,
      policySyncStatus,
      healthStatus: (state === 'OFFLINE' || state === 'INACTIVE' ? 'inactive' : dev.healthStatus) as any,
      healthState: state,
      isOnline,
      enforcementActive: dev.enforcementActive,
      isRevoked: dev.isRevoked,
      agentVersion: dev.agentVersion,
      windowsAccountName: dev.mappedAccountName || '',
      hasMultipleSessions: dev.hasMultipleSessions || false,
      protectionStatus: dev.protectionStatus || (state === 'PROTECTED' ? 'MANAGED_CHILD' : 'UNKNOWN'),
      capabilities: {
        activityTelemetryAvailable: dev.activityTelemetryAvailable,
        appUsageAvailable: dev.appUsageAvailable,
        domainUsageAvailable: dev.domainUsageAvailable,
        categoryUsageAvailable: dev.categoryUsageAvailable,
        safeDinnerTimeSupported: dev.safeDinnerTimeSupported,
        safeBedtimeSupported: dev.safeBedtimeSupported,
        dnsFilteringSupported: true,
        ...(dev.capabilities ? (dev.capabilities as object) : {}),
      },
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
      include: {
        child: {
          select: { name: true, policy: { select: { version: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return list.map((dev: any) => {
      const lastHb = dev.lastHeartbeatAt.getTime();
      const elapsedSeconds = (now - lastHb) / 1000;
      const isOnline = elapsedSeconds < DEVICE_OFFLINE_THRESHOLD_SECONDS && !dev.isRevoked;
      let state: HealthState = (dev.healthState as any) || 'PROTECTED';
      if (dev.isRevoked) {
        state = 'INACTIVE';
      } else if (!isOnline) {
        state = 'OFFLINE';
      }

      const configuredVersion = dev.child?.policy?.version ?? 1;
      let policySyncStatus: 'SYNCED' | 'SYNC_PENDING' | 'VERSION_MISMATCH' | 'UNKNOWN' = 'UNKNOWN';
      if (dev.activePolicyVersion != null && configuredVersion != null) {
        if (dev.activePolicyVersion === configuredVersion) {
          policySyncStatus = 'SYNCED';
        } else if (dev.activePolicyVersion < configuredVersion) {
          policySyncStatus = 'SYNC_PENDING';
        } else {
          policySyncStatus = 'VERSION_MISMATCH';
        }
      }

      return {
        id: dev.id,
        childId: dev.childId,
        childName: dev.child?.name,
        parentId: dev.parentId,
        familyId: dev.familyId,
        name: dev.name,
        platform: dev.platform as DevicePlatform,
        deviceToken: dev.deviceToken || '',
        pairedAt: dev.createdAt.toISOString(),
        lastSyncAt: dev.updatedAt.toISOString(),
        lastHeartbeatAt: dev.lastHeartbeatAt.toISOString(),
        activePolicyVersion: dev.activePolicyVersion ?? configuredVersion,
        configuredPolicyVersion: configuredVersion,
        agentActivePolicyVersion: dev.activePolicyVersion ?? null,
        policySyncStatus,
        healthStatus: (state === 'OFFLINE' || state === 'INACTIVE' ? 'inactive' : dev.healthStatus) as any,
        healthState: state,
        isOnline,
        enforcementActive: dev.enforcementActive,
        isRevoked: dev.isRevoked,
        agentVersion: dev.agentVersion,
        windowsAccountName: dev.mappedAccountName || '',
        hasMultipleSessions: dev.hasMultipleSessions || false,
        protectionStatus: dev.protectionStatus || (state === 'PROTECTED' ? 'MANAGED_CHILD' : 'UNKNOWN'),
        capabilities: {
          activityTelemetryAvailable: dev.activityTelemetryAvailable,
          appUsageAvailable: dev.appUsageAvailable,
          domainUsageAvailable: dev.domainUsageAvailable,
          categoryUsageAvailable: dev.categoryUsageAvailable,
          safeDinnerTimeSupported: dev.safeDinnerTimeSupported,
          safeBedtimeSupported: dev.safeBedtimeSupported,
          dnsFilteringSupported: true,
          ...(dev.capabilities ? (dev.capabilities as object) : {}),
        },
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
      include: {
        child: {
          select: { name: true, policy: { select: { version: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return list.map((dev: any) => {
      const lastHb = dev.lastHeartbeatAt.getTime();
      const elapsedSeconds = (now - lastHb) / 1000;
      const isOnline = elapsedSeconds < DEVICE_OFFLINE_THRESHOLD_SECONDS && !dev.isRevoked;
      let state: HealthState = (dev.healthState as any) || 'PROTECTED';
      if (dev.isRevoked) {
        state = 'INACTIVE';
      } else if (!isOnline) {
        state = 'OFFLINE';
      }

      const configuredVersion = dev.child?.policy?.version ?? 1;
      let policySyncStatus: 'SYNCED' | 'SYNC_PENDING' | 'VERSION_MISMATCH' | 'UNKNOWN' = 'UNKNOWN';
      if (dev.activePolicyVersion != null && configuredVersion != null) {
        if (dev.activePolicyVersion === configuredVersion) {
          policySyncStatus = 'SYNCED';
        } else if (dev.activePolicyVersion < configuredVersion) {
          policySyncStatus = 'SYNC_PENDING';
        } else {
          policySyncStatus = 'VERSION_MISMATCH';
        }
      }

      return {
        id: dev.id,
        childId: dev.childId,
        childName: dev.child?.name,
        parentId: dev.parentId,
        familyId: dev.familyId,
        name: dev.name,
        platform: dev.platform as DevicePlatform,
        deviceToken: dev.deviceToken || '',
        pairedAt: dev.createdAt.toISOString(),
        lastSyncAt: dev.updatedAt.toISOString(),
        lastHeartbeatAt: dev.lastHeartbeatAt.toISOString(),
        activePolicyVersion: dev.activePolicyVersion ?? configuredVersion,
        configuredPolicyVersion: configuredVersion,
        agentActivePolicyVersion: dev.activePolicyVersion ?? null,
        policySyncStatus,
        healthStatus: (state === 'OFFLINE' || state === 'INACTIVE' ? 'inactive' : dev.healthStatus) as any,
        healthState: state,
        isOnline,
        enforcementActive: dev.enforcementActive,
        isRevoked: dev.isRevoked,
        agentVersion: dev.agentVersion,
        windowsAccountName: dev.mappedAccountName || '',
        hasMultipleSessions: dev.hasMultipleSessions || false,
        protectionStatus: dev.protectionStatus || (state === 'PROTECTED' ? 'MANAGED_CHILD' : 'UNKNOWN'),
        capabilities: {
          activityTelemetryAvailable: dev.activityTelemetryAvailable,
          appUsageAvailable: dev.appUsageAvailable,
          domainUsageAvailable: dev.domainUsageAvailable,
          categoryUsageAvailable: dev.categoryUsageAvailable,
          safeDinnerTimeSupported: dev.safeDinnerTimeSupported,
          safeBedtimeSupported: dev.safeBedtimeSupported,
          dnsFilteringSupported: true,
          ...(dev.capabilities ? (dev.capabilities as object) : {}),
        },
      };
    });
  }

  public async getFamilyProfilesForDevice(deviceId: string): Promise<Array<{ id: string; name: string; age: number | null }>> {
    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) throw new Error('Device not found.');

    const children = await prisma.child.findMany({
      where: {
        OR: [
          { familyId: device.familyId },
          { parentId: device.parentId },
        ],
      },
      select: {
        id: true,
        name: true,
        age: true,
      },
      orderBy: { name: 'asc' },
    });

    return children;
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

    if (device.deviceToken) {
      this.revokedTokenBlacklist.add(device.deviceToken);
    }

    await prisma.device.delete({
      where: { id: deviceId },
    });

    wsManager.broadcast({
      type: 'DEVICE_HEALTH_CHANGED',
      payload: {
        deviceId,
        isRevoked: true,
        healthState: 'INACTIVE',
      },
      parentId: device.parentId,
      childId: device.childId,
    });
  }

  public async renameDevice(deviceId: string, newName: string, actorUserId: string): Promise<ExtendedDevice> {
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
      throw new Error('Forbidden. Insufficient permissions to rename devices.');
    }

    const trimmedName = (newName || '').trim();
    if (!trimmedName) {
      throw new Error('Device name cannot be empty.');
    }

    const updated = await prisma.device.update({
      where: { id: deviceId },
      data: { name: trimmedName },
    });

    const extended = await this.getDevice(updated.id);
    if (!extended) throw new Error('Failed to retrieve updated device.');

    wsManager.broadcast({
      type: 'DEVICE_HEALTH_CHANGED',
      payload: extended,
      parentId: updated.parentId,
      childId: updated.childId,
    });

    return extended;
  }

  public async reassignDevice(deviceId: string, targetChildId: string, actorUserId: string): Promise<ExtendedDevice> {
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
      throw new Error('Forbidden. Insufficient permissions to reassign devices.');
    }

    const targetChild = await prisma.child.findUnique({ where: { id: targetChildId } });
    if (!targetChild || targetChild.familyId !== family.id) {
      throw new Error('Target child does not belong to this family.');
    }

    const updated = await prisma.device.update({
      where: { id: deviceId },
      data: { childId: targetChildId },
    });

    const extended = await this.getDevice(updated.id);
    if (!extended) throw new Error('Failed to retrieve updated device.');

    wsManager.broadcast({
      type: 'DEVICE_HEALTH_CHANGED',
      payload: extended,
      parentId: updated.parentId,
      childId: targetChildId,
    });

    return extended;
  }

  public async triggerDevicePolicySync(deviceId: string, actorUserId: string): Promise<{ success: boolean; message: string }> {
    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) throw new Error('Device not found.');

    const family = await rbacService.getFamilyForDevice(deviceId);
    if (!family || !(await rbacService.getFamilyMembership(actorUserId, family.id))) {
      throw new Error('Forbidden. You do not belong to the family that owns this device.');
    }

    const hasPerm =
      (await rbacService.hasFamilyPermission(actorUserId, family.id, FamilyPermission.DEVICE_MANAGE)) ||
      (await rbacService.hasFamilyPermission(actorUserId, family.id, FamilyPermission.POLICY_MANAGE));
    if (!hasPerm) {
      throw new Error('Forbidden. Insufficient permissions to sync device policy.');
    }

    const policy = await prisma.policy.findUnique({ where: { childId: device.childId } });

    wsManager.broadcast({
      type: 'POLICY_UPDATED',
      payload: policy || { version: 1, rules: [] },
      childId: device.childId,
      parentId: device.parentId,
    });

    return { success: true, message: 'Policy synchronization signal queued for device.' };
  }

  public async getDeviceDetails(deviceId: string, actorUserId: string): Promise<any> {
    const device = await prisma.device.findUnique({
      where: { id: deviceId },
      include: {
        child: {
          include: {
            policy: true,
          },
        },
      },
    });
    if (!device) throw new Error('Device not found.');

    const family = await rbacService.getFamilyForDevice(deviceId);
    if (!family || !(await rbacService.getFamilyMembership(actorUserId, family.id))) {
      throw new Error('Forbidden. You do not belong to the family that owns this device.');
    }

    const hasPerm = await rbacService.hasFamilyPermission(
      actorUserId,
      family.id,
      FamilyPermission.DEVICE_READ
    );
    if (!hasPerm) {
      throw new Error('Forbidden. Insufficient permissions to view device details.');
    }

    const now = Date.now();
    const elapsedSeconds = (now - device.lastHeartbeatAt.getTime()) / 1000;
    const isOnline = elapsedSeconds < DEVICE_OFFLINE_THRESHOLD_SECONDS && !device.isRevoked;

    let computedHealthState: HealthState = (device.healthState as any) || 'PROTECTED';
    if (device.isRevoked) {
      computedHealthState = 'INACTIVE';
    } else if (!isOnline) {
      computedHealthState = 'OFFLINE';
    }

    const configuredVersion = device.child.policy?.version ?? 1;
    let policySyncStatus: 'SYNCED' | 'SYNC_PENDING' | 'VERSION_MISMATCH' | 'UNKNOWN' = 'UNKNOWN';
    if (device.activePolicyVersion != null && configuredVersion != null) {
      if (device.activePolicyVersion === configuredVersion) {
        policySyncStatus = 'SYNCED';
      } else if (device.activePolicyVersion < configuredVersion) {
        policySyncStatus = 'SYNC_PENDING';
      } else {
        policySyncStatus = 'VERSION_MISMATCH';
      }
    }

    return {
      device: {
        id: device.id,
        childId: device.childId,
        childName: device.child.name,
        parentId: device.parentId,
        familyId: device.familyId,
        name: device.name,
        platform: device.platform,
        agentVersion: device.agentVersion,
        healthStatus: (computedHealthState === 'OFFLINE' || computedHealthState === 'INACTIVE') ? 'inactive' : device.healthStatus,
        healthState: computedHealthState,
        isOnline,
        enforcementActive: device.enforcementActive,
        isRevoked: device.isRevoked,
        lastHeartbeatAt: device.lastHeartbeatAt.toISOString(),
        pairedAt: device.createdAt.toISOString(),
        configuredPolicyVersion: configuredVersion,
        agentActivePolicyVersion: device.activePolicyVersion ?? null,
        policySyncStatus,
        windowsAccountName: device.mappedAccountName || '',
        hasMultipleSessions: device.hasMultipleSessions || false,
        protectionStatus: device.protectionStatus || (computedHealthState === 'PROTECTED' ? 'MANAGED_CHILD' : 'UNKNOWN'),
        capabilities: {
          activityTelemetryAvailable: device.activityTelemetryAvailable,
          appUsageAvailable: device.appUsageAvailable,
          domainUsageAvailable: device.domainUsageAvailable,
          categoryUsageAvailable: device.categoryUsageAvailable,
          safeDinnerTimeSupported: device.safeDinnerTimeSupported,
          safeBedtimeSupported: device.safeBedtimeSupported,
          dnsFilteringSupported: true,
          ...(device.capabilities ? (device.capabilities as object) : {}),
        },
      },
      child: {
        id: device.child.id,
        name: device.child.name,
        age: device.child.age,
        avatar: device.child.avatar,
      },
      policy: device.child.policy ? {
        version: device.child.policy.version,
        isPaused: device.child.policy.isPaused,
        safeSearch: device.child.policy.safeSearch,
        routines: device.child.policy.routines,
        customRulesCount: Array.isArray(device.child.policy.rules) ? (device.child.policy.rules as any[]).length : 0,
        updatedAt: device.child.policy.updatedAt.toISOString(),
      } : null,
    };
  }
}

export const deviceService = new DeviceService();
