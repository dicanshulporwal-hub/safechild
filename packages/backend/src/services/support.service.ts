import { db } from '../db/store';
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
  private rolloutRings = {
    ring0: ['dev-internal-1'],
    ring1: [] as string[], // 1 family
    ring2: [] as string[], // 3 families
    ring3: [] as string[], // All beta families
  };

  private currentTargetVersion: string = '1.0.0';
  private rollbackTargetVersion: string = '0.9.9';

  public getFleetOverview(): DeviceConsoleItem[] {
    const items: DeviceConsoleItem[] = [];
    const now = Date.now();

    for (const device of db.devices.values()) {
      const devAny = device as any;
      const parent = db.users.get(device.parentId);
      const child = db.children.get(device.childId);
      const policy = db.policies.get(device.childId);

      const elapsedSec = (now - new Date(device.lastHeartbeatAt || 0).getTime()) / 1000;
      let computedHealth = devAny.healthState || 'PROTECTED';
      if (devAny.isRevoked || device.healthStatus === 'inactive') {
        computedHealth = 'INACTIVE';
      } else if (elapsedSec > 90) {
        computedHealth = 'OFFLINE';
      } else if (policy && device.activePolicyVersion < policy.version) {
        computedHealth = 'WARNING';
      }

      items.push({
        familyId: device.parentId,
        parentEmail: parent?.email || 'unknown',
        childId: device.childId,
        childName: child?.name || 'Child',
        deviceId: device.id,
        deviceName: device.name,
        platform: device.platform,
        agentVersion: device.agentVersion || '1.0.0',
        activePolicyVersion: device.activePolicyVersion || 1,
        latestPolicyVersion: policy?.version || 1,
        healthState: computedHealth,
        healthStatus: device.healthStatus || 'protected',
        lastHeartbeatAt: device.lastHeartbeatAt,
        enforcementStatus: computedHealth === 'PROTECTED' ? 'ACTIVE_ENFORCING' : 'SUSPENDED_OR_INACTIVE',
        lastSyncAt: device.lastSyncAt,
        recentErrors: computedHealth === 'INACTIVE' ? ['VPN disconnected / process stopped'] : [],
      });
    }

    return items;
  }

  public triggerRemoteRollback(targetVersion: string, affectedDevices?: string[]) {
    console.log(`[Support Console] 🚨 Triggering safe remote agent rollback to v${targetVersion}...`);
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
