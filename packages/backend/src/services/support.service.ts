import { prisma } from '../db/prisma';
import { wsManager } from './websocket.service';

export interface DeviceConsoleItem {
  familyId: string;
  parentEmail: string;
  childId: string;
  childName: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  agentVersion: string;
  activePolicyVersion: number;
  latestPolicyVersion: number;
  healthState: string;
  healthStatus: string;
  lastHeartbeatAt: string;
  enforcementStatus: string;
  lastSyncAt: string;
  recentErrors: string[];
}

export class SupportConsoleService {
  private rollbackTargetVersion: string = '0.9.9';

  public async getFleetOverview(): Promise<DeviceConsoleItem[]> {
    const devices = await prisma.device.findMany({
      include: {
        parent: true,
        child: {
          include: {
            policy: true,
          },
        },
      },
    });

    const items: DeviceConsoleItem[] = [];
    const now = Date.now();

    for (const device of devices) {
      const parent = device.parent;
      const child = device.child;
      const policy = device.child?.policy;

      const elapsedSec = (now - device.lastHeartbeatAt.getTime()) / 1000;
      let computedHealth = (device.healthState as string) || 'PROTECTED';
      if (device.isRevoked || device.healthStatus === 'inactive') {
        computedHealth = 'INACTIVE';
      } else if (elapsedSec > 90) {
        computedHealth = 'OFFLINE';
      } else if (policy && 1 < policy.version) {
        computedHealth = 'WARNING';
      }

      items.push({
        familyId: device.familyId,
        parentEmail: parent?.email || 'unknown',
        childId: device.childId,
        childName: child?.name || 'Child',
        deviceId: device.id,
        deviceName: device.name,
        platform: device.platform,
        agentVersion: device.agentVersion || '1.0.0',
        activePolicyVersion: policy?.version || 1,
        latestPolicyVersion: policy?.version || 1,
        healthState: computedHealth,
        healthStatus: device.healthStatus || 'protected',
        lastHeartbeatAt: device.lastHeartbeatAt.toISOString(),
        enforcementStatus: computedHealth === 'PROTECTED' ? 'ACTIVE_ENFORCING' : 'SUSPENDED_OR_INACTIVE',
        lastSyncAt: device.updatedAt.toISOString(),
        recentErrors: computedHealth === 'INACTIVE' ? ['VPN disconnected / process stopped'] : [],
      });
    }

    return items;
  }

  public triggerRemoteRollback(targetVersion: string, affectedDevices?: string[]) {
    this.rollbackTargetVersion = targetVersion;

    wsManager.broadcast({
      type: 'POLICY_UPDATED',
      payload: {
        action: 'AGENT_ROLLBACK',
        targetVersion,
        safeFallback: true,
      },
    });

    return {
      success: true,
      message: `Rollback command dispatched to ${affectedDevices ? affectedDevices.length : 'all'} devices. Reverting to v${targetVersion}.`,
    };
  }
}

export const supportConsoleService = new SupportConsoleService();
