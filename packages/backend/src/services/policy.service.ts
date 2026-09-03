import { prisma } from '../db/prisma';
import {
  Policy,
  PolicyRule,
  RuleAction,
  normalizeDomain,
  calculateExpirationDate,
  TemporaryApprovalDuration,
} from '@safebrowse/shared';
import { nanoid } from 'nanoid';
import { wsManager } from './websocket.service';

export class PolicyService {
  public async getPolicyForChild(childId: string): Promise<Policy> {
    let policy = await prisma.policy.findUnique({
      where: { childId },
    });

    if (!policy) {
      const child = await prisma.child.findUnique({
        where: { id: childId },
      });
      if (!child || !child.familyId) {
        throw new Error('Mandatory tenancy error: Child not found or has no valid familyId.');
      }

      policy = await prisma.policy.create({
        data: {
          id: `policy-${nanoid(8)}`,
          childId,
          familyId: child.familyId,
          version: 1,
          isPaused: false,
          rules: [],
        },
      });
    }

    return {
      id: policy.id,
      childId: policy.childId,
      familyId: policy.familyId,
      version: policy.version,
      isPaused: policy.isPaused,
      rules: (policy.rules as any) || [],
      updatedAt: policy.updatedAt.toISOString(),
    };
  }

  public async getPolicyForDevice(deviceId: string): Promise<{ policy: Policy; child: any }> {
    const device = await prisma.device.findUnique({
      where: { id: deviceId },
    });
    if (!device) {
      throw new Error('Device not found.');
    }

    const policy = await this.getPolicyForChild(device.childId);
    const child = await prisma.child.findUnique({
      where: { id: device.childId },
    });

    return { policy, child };
  }

  /**
   * Adds or updates a rule for a child policy
   */
  public async addRule(
    childId: string,
    domain: string,
    action: RuleAction,
    reason?: string,
    duration?: TemporaryApprovalDuration
  ): Promise<Policy> {
    const policy = await this.getPolicyForChild(childId);
    const normDomain = normalizeDomain(domain);

    if (!normDomain) {
      throw new Error('Invalid domain specified.');
    }

    let expiresAt: string | null = null;
    if (action === 'TEMPORARY_ALLOW' && duration) {
      expiresAt = calculateExpirationDate(duration);
    }

    let updatedRules: PolicyRule[];

    if (action === 'TEMPORARY_ALLOW') {
      const nonTempRules = policy.rules.filter(
        (r: PolicyRule) => !(r.domain === normDomain && r.action === 'TEMPORARY_ALLOW')
      );
      const newTempRule: PolicyRule = {
        id: `r-${nanoid(6)}`,
        domain: normDomain,
        action: 'TEMPORARY_ALLOW',
        reason,
        addedAt: new Date().toISOString(),
        expiresAt: expiresAt || undefined,
      };
      updatedRules = [newTempRule, ...nonTempRules];
    } else {
      const filteredRules = policy.rules.filter((r: PolicyRule) => r.domain !== normDomain);
      const newPermanentRule: PolicyRule = {
        id: `r-${nanoid(6)}`,
        domain: normDomain,
        action,
        reason,
        addedAt: new Date().toISOString(),
      };
      updatedRules = [newPermanentRule, ...filteredRules];
    }

    const updated = await prisma.policy.update({
      where: { childId },
      data: {
        rules: updatedRules as any,
        version: { increment: 1 },
      },
    });

    const resultPolicy: Policy = {
      id: updated.id,
      childId: updated.childId,
      familyId: updated.familyId,
      version: updated.version,
      isPaused: updated.isPaused,
      rules: (updated.rules as any) || [],
      updatedAt: updated.updatedAt.toISOString(),
    };

    wsManager.broadcast({
      type: 'POLICY_UPDATED',
      payload: resultPolicy,
      childId,
    });

    return resultPolicy;
  }

  /**
   * Remove a rule by ruleId
   */
  public async removeRule(childId: string, ruleId: string): Promise<Policy> {
    const policy = await this.getPolicyForChild(childId);
    const updatedRules = policy.rules.filter((r: PolicyRule) => r.id !== ruleId);

    const updated = await prisma.policy.update({
      where: { childId },
      data: {
        rules: updatedRules as any,
        version: { increment: 1 },
      },
    });

    const resultPolicy: Policy = {
      id: updated.id,
      childId: updated.childId,
      familyId: updated.familyId,
      version: updated.version,
      isPaused: updated.isPaused,
      rules: (updated.rules as any) || [],
      updatedAt: updated.updatedAt.toISOString(),
    };

    wsManager.broadcast({
      type: 'POLICY_UPDATED',
      payload: resultPolicy,
      childId,
    });

    return resultPolicy;
  }

  /**
   * Pause or unpause internet access for a child
   */
  public async setInternetPause(
    childId: string,
    isPaused: boolean,
    duration?: '15m' | '30m' | '1h' | 'indefinite'
  ): Promise<Policy> {
    await this.getPolicyForChild(childId);

    const updated = await prisma.policy.update({
      where: { childId },
      data: {
        isPaused,
        version: { increment: 1 },
      },
    });

    const resultPolicy: Policy = {
      id: updated.id,
      childId: updated.childId,
      familyId: updated.familyId,
      version: updated.version,
      isPaused: updated.isPaused,
      rules: (updated.rules as any) || [],
      updatedAt: updated.updatedAt.toISOString(),
    };

    wsManager.broadcast({
      type: 'POLICY_UPDATED',
      payload: resultPolicy,
      childId,
    });

    return resultPolicy;
  }
}

export const policyService = new PolicyService();
