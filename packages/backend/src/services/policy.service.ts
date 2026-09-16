import { prisma } from '../db/prisma';
import { Child } from '@prisma/client';
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
          blockedCategories: ['ADULT_CONTENT', 'GAMBLING', 'MALWARE_SECURITY'],
          safeSearch: {
            googleSafeSearch: true,
            bingSafeSearch: true,
            duckDuckGoSafeSearch: true,
            youtubeRestrictedMode: 'OFF',
          },
          rules: [],
        },
      });
    }

    const blockedList = policy.blockedCategories || [];
    const categoryControls: any[] = blockedList.map((cat: string) => ({
      category: cat,
      action: 'BLOCK',
    }));

    let formattedRules: PolicyRule[] = [];
    if (Array.isArray(policy.rules)) {
      formattedRules = policy.rules as unknown as PolicyRule[];
    } else if (policy.rules && typeof policy.rules === 'object' && Array.isArray((policy.rules as any).create)) {
      formattedRules = (policy.rules as any).create.map((r: any) => ({
        id: r.id || `r-${nanoid(6)}`,
        domain: r.domain || r.pattern || '',
        action: (r.action as any) || 'BLOCK',
        reason: r.reason,
        addedAt: r.addedAt || new Date().toISOString(),
      }));
    } else if (Array.isArray(policy.blacklistedDomains) && policy.blacklistedDomains.length > 0) {
      formattedRules = policy.blacklistedDomains.map((d: string) => ({
        id: `r-${nanoid(6)}`,
        domain: d,
        action: 'BLOCK',
        addedAt: new Date().toISOString(),
      }));
    }

    return {
      id: policy.id,
      childId: policy.childId,
      familyId: policy.familyId,
      version: policy.version,
      isPaused: policy.isPaused,
      categoryControls,
      studyMode: {
        active: Boolean(policy.studyMode),
        allowedCategories: ['EDUCATION'],
      },
      bedtime: (policy.routines as any) || {
        enabled: false,
        startHour: 21,
        startMinute: 30,
        endHour: 7,
        endMinute: 0,
        allowEducationalOnly: true,
      },
      safeSearch: (policy.safeSearch as any) || {
        googleSafeSearch: true,
        bingSafeSearch: true,
        duckDuckGoSafeSearch: true,
        youtubeRestrictedMode: 'OFF',
      },
      usageBudgets: (policy.usageBudgets as any) || [],
      rules: formattedRules,
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

    await prisma.policy.update({
      where: { childId },
      data: {
        rules: updatedRules as any,
        version: { increment: 1 },
      },
    });

    const resultPolicy = await this.getPolicyForChild(childId);

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

    await prisma.policy.update({
      where: { childId },
      data: {
        rules: updatedRules as any,
        version: { increment: 1 },
      },
    });

    const resultPolicy = await this.getPolicyForChild(childId);

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

    await prisma.policy.update({
      where: { childId },
      data: {
        isPaused,
        version: { increment: 1 },
      },
    });

    const resultPolicy = await this.getPolicyForChild(childId);

    wsManager.broadcast({
      type: 'POLICY_UPDATED',
      payload: resultPolicy,
      childId,
    });

    return resultPolicy;
  }

  /**
   * Global 1-Tap Family Internet Pause (Dinner Time)
   */
  public async setFamilyInternetPause(familyId: string, isPaused: boolean): Promise<Child[]> {
    const children = await prisma.child.findMany({
      where: { familyId },
    });

    for (const ch of children) {
      await prisma.policy.updateMany({
        where: { childId: ch.id },
        data: {
          isPaused,
          version: { increment: 1 },
        },
      });

      const updated = await this.getPolicyForChild(ch.id);
      wsManager.broadcast({
        type: 'POLICY_UPDATED',
        payload: updated,
        childId: ch.id,
      });
    }

    return children as any;
  }

  /**
   * Update Category Controls (1-Click Category Blocking)
   */
  public async updateCategoryControls(childId: string, categoryControls: Array<{ category: string; action: 'BLOCK' | 'ALLOW' }>): Promise<Policy> {
    const blockedList = categoryControls
      .filter((c) => c.action === 'BLOCK')
      .map((c) => c.category);

    await prisma.policy.update({
      where: { childId },
      data: {
        blockedCategories: blockedList,
        version: { increment: 1 },
      },
    });

    const resultPolicy = await this.getPolicyForChild(childId);

    wsManager.broadcast({
      type: 'POLICY_UPDATED',
      payload: resultPolicy,
      childId,
    });

    return resultPolicy;
  }

  /**
   * Update SafeSearch & YouTube Restricted Mode
   */
  public async updateSafeSearch(childId: string, safeSearchConfig: any): Promise<Policy> {
    await prisma.policy.update({
      where: { childId },
      data: {
        safeSearch: safeSearchConfig,
        version: { increment: 1 },
      },
    });

    const resultPolicy = await this.getPolicyForChild(childId);

    wsManager.broadcast({
      type: 'POLICY_UPDATED',
      payload: resultPolicy,
      childId,
    });

    return resultPolicy;
  }

  /**
   * Update Routines & Bedtime Curfew
   */
  public async updateRoutines(childId: string, routinesConfig: any): Promise<Policy> {
    await prisma.policy.update({
      where: { childId },
      data: {
        routines: routinesConfig,
        version: { increment: 1 },
      },
    });

    const resultPolicy = await this.getPolicyForChild(childId);

    wsManager.broadcast({
      type: 'POLICY_UPDATED',
      payload: resultPolicy,
      childId,
    });

    return resultPolicy;
  }
}

export const policyService = new PolicyService();
