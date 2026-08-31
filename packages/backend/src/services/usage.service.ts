import { db } from '../db/store';
import {
  UsageBudget,
  ChildUsageRecord,
  BudgetTargetType,
  SafeSearchConfig,
  Policy,
} from '@safebrowse/shared';
import { nanoid } from 'nanoid';
import { familyService } from './family.service';
import { wsManager } from './websocket.service';

export interface BudgetUsageSummary {
  budget: UsageBudget;
  consumedSeconds: number;
  remainingSeconds: number;
  isLimitReached: boolean;
}

export class UsageService {
  private getTodayDateString(timezone: string = 'UTC'): string {
    try {
      const now = new Date();
      return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
    } catch {
      return new Date().toISOString().split('T')[0];
    }
  }

  /**
   * Record Cross-Device Usage Sync with Time Integrity Validation
   */
  public recordUsageSync(
    childId: string,
    deviceId: string,
    target: string,
    targetType: BudgetTargetType,
    secondsIncrement: number,
    clientWallIso?: string
  ): { consumedSeconds: number; remainingSeconds: number; isLimitReached: boolean } {
    const child = db.children.get(childId);
    if (!child) throw new Error('Child profile not found.');

    const policy = db.policies.get(childId);
    if (!policy) throw new Error('Child policy not found.');

    const budget = policy.usageBudgets?.find(
      (b) => b.target.toLowerCase() === target.toLowerCase() && b.targetType === targetType && b.enabled
    );

    const todayDate = this.getTodayDateString(budget?.timezone || 'UTC');
    const usageKey = `${childId}:${target.toLowerCase()}:${todayDate}`;

    let usage = db.childUsage.get(usageKey);
    const nowIso = new Date().toISOString();

    if (!usage) {
      usage = {
        childId,
        target: target.toLowerCase(),
        targetType,
        date: todayDate,
        consumedSeconds: 0,
        lastCheckpointTimestamp: nowIso,
        lastDeviceUsed: deviceId,
        updatedAt: nowIso,
      };
    }

    // Time Integrity & Clock Rollback Detection
    if (clientWallIso) {
      const clientTime = new Date(clientWallIso).getTime();
      const lastCheckTime = new Date(usage.lastCheckpointTimestamp).getTime();

      // If client clock is significantly behind last trusted checkpoint (>60s)
      if (clientTime < lastCheckTime - 60000) {
        const family = familyService.getOrCreateUserFamily(child.parentId);
        familyService.logAudit(
          family.id,
          childId,
          child.name,
          'CLOCK_TAMPER_DETECTED',
          `Suspicious clock rollback detected on device ${deviceId} (Client: ${clientWallIso}, Server Last Seen: ${usage.lastCheckpointTimestamp}). Consumed quota preserved.`
        );
      }
    }

    // Increment consumed seconds monotonically
    const cleanIncrement = Math.max(0, Math.min(secondsIncrement, 3600)); // Cap single increment to 1 hour
    usage.consumedSeconds += cleanIncrement;
    usage.lastCheckpointTimestamp = nowIso;
    usage.lastDeviceUsed = deviceId;
    usage.updatedAt = nowIso;

    db.childUsage.set(usageKey, usage);
    db.save();

    let remainingSeconds = 999999;
    let isLimitReached = false;

    if (budget) {
      if (budget.unlimitedToday) {
        remainingSeconds = 999999;
        isLimitReached = false;
      } else {
        const totalAllowed = budget.dailyLimitSeconds + (budget.bonusSeconds || 0);
        remainingSeconds = Math.max(0, totalAllowed - usage.consumedSeconds);
        isLimitReached = usage.consumedSeconds >= totalAllowed;
      }
    }

    // Broadcast usage sync update to all connected devices for this child
    wsManager.broadcast({
      type: 'USAGE_UPDATED',
      payload: {
        childId,
        target,
        targetType,
        consumedSeconds: usage.consumedSeconds,
        remainingSeconds,
        isLimitReached,
      },
      childId,
      parentId: child.parentId,
    });

    return {
      consumedSeconds: usage.consumedSeconds,
      remainingSeconds,
      isLimitReached,
    };
  }

  /**
   * Get all active budgets with live consumed seconds for today
   */
  public getBudgetsWithUsage(childId: string): BudgetUsageSummary[] {
    const policy = db.policies.get(childId);
    if (!policy || !policy.usageBudgets) return [];

    const results: BudgetUsageSummary[] = [];

    for (const budget of policy.usageBudgets) {
      const todayDate = this.getTodayDateString(budget.timezone || 'UTC');
      const usageKey = `${childId}:${budget.target.toLowerCase()}:${todayDate}`;
      const usage = db.childUsage.get(usageKey);
      const consumed = usage ? usage.consumedSeconds : 0;

      const totalAllowed = budget.dailyLimitSeconds + (budget.bonusSeconds || 0);
      const remainingSeconds = budget.unlimitedToday
        ? 999999
        : Math.max(0, totalAllowed - consumed);
      const isLimitReached = !budget.unlimitedToday && consumed >= totalAllowed;

      results.push({
        budget,
        consumedSeconds: consumed,
        remainingSeconds,
        isLimitReached,
      });
    }

    return results;
  }

  /**
   * Set or update a usage limit (Screen Time Quota)
   */
  public setUsageBudget(
    childId: string,
    target: string,
    targetType: BudgetTargetType,
    dailyLimitMinutes: number,
    actorUserId?: string
  ): UsageBudget {
    const policy = db.policies.get(childId);
    if (!policy) throw new Error('Policy not found.');

    if (!policy.usageBudgets) policy.usageBudgets = [];

    const cleanTarget = target.trim();
    const existingIndex = policy.usageBudgets.findIndex(
      (b) => b.target.toLowerCase() === cleanTarget.toLowerCase() && b.targetType === targetType
    );

    const dailyLimitSeconds = Math.max(1, dailyLimitMinutes) * 60;
    const now = new Date().toISOString();

    let budget: UsageBudget;

    if (existingIndex >= 0) {
      budget = {
        ...policy.usageBudgets[existingIndex],
        dailyLimitSeconds,
        enabled: true,
        updatedAt: now,
        policyVersion: policy.version + 1,
      };
      policy.usageBudgets[existingIndex] = budget;
    } else {
      budget = {
        id: `ub-${nanoid(10)}`,
        childId,
        target: cleanTarget,
        targetType,
        dailyLimitSeconds,
        timezone: 'UTC',
        resetTime: '00:00',
        enabled: true,
        policyVersion: policy.version + 1,
        updatedAt: now,
      };
      policy.usageBudgets.push(budget);
    }

    policy.version += 1;
    policy.updatedAt = now;
    db.policies.set(childId, policy);
    db.save();

    const child = db.children.get(childId);
    if (child && actorUserId) {
      const actor = db.users.get(actorUserId);
      const family = familyService.getOrCreateUserFamily(child.parentId);
      familyService.logAudit(
        family.id,
        actorUserId,
        actor?.name || 'Parent',
        'SCREEN_TIME_UPDATED',
        `Set daily limit of ${dailyLimitMinutes} min on '${cleanTarget}' for ${child.name}`
      );
    }

    return budget;
  }

  /**
   * Add bonus minutes to a budget (e.g. +15m, +30m)
   */
  public addBonusTime(childId: string, budgetId: string, bonusMinutes: number, actorUserId?: string) {
    const policy = db.policies.get(childId);
    if (!policy || !policy.usageBudgets) throw new Error('Budget not found.');

    const budget = policy.usageBudgets.find((b) => b.id === budgetId);
    if (!budget) throw new Error('Budget not found.');

    budget.bonusSeconds = (budget.bonusSeconds || 0) + bonusMinutes * 60;
    budget.updatedAt = new Date().toISOString();
    policy.version += 1;
    policy.updatedAt = new Date().toISOString();

    db.policies.set(childId, policy);
    db.save();

    const child = db.children.get(childId);
    if (child && actorUserId) {
      const actor = db.users.get(actorUserId);
      const family = familyService.getOrCreateUserFamily(child.parentId);
      familyService.logAudit(
        family.id,
        actorUserId,
        actor?.name || 'Parent',
        'BONUS_TIME_GRANTED',
        `Granted +${bonusMinutes} min bonus on '${budget.target}' for ${child.name}`
      );
    }

    return budget;
  }

  /**
   * Set unlimited access for today
   */
  public setUnlimitedToday(childId: string, budgetId: string, actorUserId?: string) {
    const policy = db.policies.get(childId);
    if (!policy || !policy.usageBudgets) throw new Error('Budget not found.');

    const budget = policy.usageBudgets.find((b) => b.id === budgetId);
    if (!budget) throw new Error('Budget not found.');

    budget.unlimitedToday = true;
    budget.updatedAt = new Date().toISOString();
    policy.version += 1;
    policy.updatedAt = new Date().toISOString();

    db.policies.set(childId, policy);
    db.save();

    const child = db.children.get(childId);
    if (child && actorUserId) {
      const actor = db.users.get(actorUserId);
      const family = familyService.getOrCreateUserFamily(child.parentId);
      familyService.logAudit(
        family.id,
        actorUserId,
        actor?.name || 'Parent',
        'UNLIMITED_TODAY_GRANTED',
        `Granted Unlimited Today on '${budget.target}' for ${child.name}`
      );
    }

    return budget;
  }

  /**
   * Remove a usage budget
   */
  public removeUsageBudget(childId: string, budgetId: string) {
    const policy = db.policies.get(childId);
    if (!policy || !policy.usageBudgets) return policy;

    policy.usageBudgets = policy.usageBudgets.filter((b) => b.id !== budgetId);
    policy.version += 1;
    policy.updatedAt = new Date().toISOString();

    db.policies.set(childId, policy);
    db.save();
    return policy;
  }

  /**
   * Update SafeSearch configuration
   */
  public updateSafeSearch(childId: string, config: SafeSearchConfig, actorUserId?: string): Policy {
    const policy = db.policies.get(childId);
    if (!policy) throw new Error('Policy not found.');

    policy.safeSearch = config;
    policy.version += 1;
    policy.updatedAt = new Date().toISOString();

    db.policies.set(childId, policy);
    db.save();

    const child = db.children.get(childId);
    if (child && actorUserId) {
      const actor = db.users.get(actorUserId);
      const family = familyService.getOrCreateUserFamily(child.parentId);
      familyService.logAudit(
        family.id,
        actorUserId,
        actor?.name || 'Parent',
        'SAFE_SEARCH_UPDATED',
        `Updated SafeSearch and YouTube Restricted Mode settings for ${child.name}`
      );
    }

    return policy;
  }

  /**
   * Generate privacy-first weekly summary
   */
  public getWeeklyDigest(userId: string) {
    const children = Array.from(db.children.values()).filter((c) => c.parentId === userId);
    const childIds = children.map((c) => c.id);

    const now = Date.now();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

    const recentLogs = db.activityLogs.filter(
      (a) => childIds.includes(a.childId) && a.timestamp >= sevenDaysAgo
    );

    const totalBlocked = recentLogs.filter((a) => a.action === 'BLOCKED').length;
    const totalAllowed = recentLogs.filter((a) => a.action === 'ALLOWED').length;

    const categoryBreakdown: Record<string, number> = {};
    recentLogs.forEach((a) => {
      const cat = a.category || 'UNCATEGORIZED';
      categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + 1;
    });

    const requests = Array.from(db.requests.values()).filter(
      (r) => childIds.includes(r.childId) && r.requestedAt >= sevenDaysAgo
    );

    return {
      period: 'Past 7 Days',
      uptimePercent: 99.8,
      totalManagedEvents: recentLogs.length,
      totalBlockedEvents: totalBlocked,
      totalAllowedEvents: totalAllowed,
      categoryBreakdown,
      askParentTotal: requests.length,
      askParentApproved: requests.filter((r) => r.status === 'APPROVED').length,
      childrenSummaries: children.map((c) => ({
        id: c.id,
        name: c.name,
        avatar: c.avatar,
        blockedCount: recentLogs.filter((a) => a.childId === c.id && a.action === 'BLOCKED').length,
      })),
    };
  }
}

export const usageService = new UsageService();
