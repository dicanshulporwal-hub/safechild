import { prisma } from '../db/prisma';
import {
  UsageBudget,
  BudgetTargetType,
  SafeSearchConfig,
  Policy,
} from '@safebrowse/shared';
import { nanoid } from 'nanoid';
import { wsManager } from './websocket.service';
import { rbacService } from './rbac.service';

export interface BudgetUsageSummary {
  budget: UsageBudget;
  consumedSeconds: number;
  remainingSeconds: number;
  isLimitReached: boolean;
}

export class UsageService {
  public getTodayDateString(timezone: string = 'UTC'): string {
    try {
      const now = new Date();
      return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
    } catch {
      return new Date().toISOString().split('T')[0];
    }
  }

  public async getFamilyTimezone(familyId?: string, childId?: string): Promise<string> {
    if (familyId) {
      const fam = await prisma.family.findUnique({
        where: { id: familyId },
        select: { timezone: true },
      });
      if (fam?.timezone) return fam.timezone;
    }
    if (childId) {
      const child = await prisma.child.findUnique({
        where: { id: childId },
        include: { family: { select: { timezone: true } } },
      });
      if (child?.family?.timezone) return child.family.timezone;
    }
    return 'UTC';
  }

  public resolveEffectiveTimezone(budget: UsageBudget | undefined | null, familyTimezone: string): string {
    if (budget?.isCustomTimezone && budget?.timezone) {
      return budget.timezone;
    }
    if (budget?.timezone && budget.timezone !== 'UTC') {
      return budget.timezone;
    }
    // If budget.timezone is 'UTC' without isCustomTimezone, treat it as the legacy default and follow familyTimezone
    return familyTimezone || 'UTC';
  }

  /**
   * Record Cross-Device Usage Sync with Time Integrity Validation & Idempotency
   */
  public async recordUsageSync(
    childId: string,
    deviceId: string,
    target: string,
    targetType: BudgetTargetType,
    secondsIncrement: number,
    clientWallIso?: string,
    syncId?: string
  ): Promise<{ consumedSeconds: number; remainingSeconds: number; isLimitReached: boolean }> {
    const child = await prisma.child.findUnique({
      where: { id: childId },
    });
    if (!child) throw new Error('Child profile not found.');

    const device = await prisma.device.findUnique({
      where: { id: deviceId },
    });
    if (!device) throw new Error('Device not found.');

    if (device.familyId !== child.familyId) {
      throw new Error('Forbidden: Device and child do not belong to the same family.');
    }

    if (!['APP', 'DOMAIN', 'CATEGORY'].includes(targetType)) {
      throw new Error('Unsupported targetType. Must be APP, DOMAIN, or CATEGORY.');
    }

    if (!Number.isFinite(secondsIncrement) || secondsIncrement <= 0 || secondsIncrement > 3600) {
      throw new Error('Invalid secondsIncrement: must be between 1 and 3600.');
    }

    if (clientWallIso) {
      const candidate = new Date(clientWallIso);
      const maxFutureMs = 5 * 60 * 1000;
      const maxPastMs = 30 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      if (
        Number.isNaN(candidate.getTime()) ||
        candidate.getTime() > now + maxFutureMs ||
        candidate.getTime() < now - maxPastMs
      ) {
        throw new Error('Invalid clientWallIso: must be a valid ISO date within the last 30 days.');
      }
    }

    const policy = await prisma.policy.findUnique({
      where: { childId },
    });
    if (!policy) throw new Error('Child policy not found.');

    const usageBudgets = (policy.usageBudgets as any as UsageBudget[]) || [];
    const budget = usageBudgets.find(
      (b) => b.target.toLowerCase() === target.toLowerCase() && b.targetType === targetType && b.enabled
    );

    const familyTimezone = await this.getFamilyTimezone(child.familyId);
    const effectiveTz = this.resolveEffectiveTimezone(budget, familyTimezone);
    const todayDate = this.getTodayDateString(effectiveTz);
    const cleanIncrement = Math.round(secondsIncrement);

    // Durable Receipt-Level Idempotency Check
    if (syncId) {
      const existingReceipt = await prisma.usageSyncReceipt.findUnique({
        where: {
          deviceId_syncId: {
            deviceId,
            syncId,
          },
        },
      });

      if (existingReceipt) {
        const existingUsage = await prisma.childUsageRecord.findUnique({
          where: {
            childId_targetType_target_date: {
              childId,
              targetType,
              target: target.toLowerCase(),
              date: todayDate,
            },
          },
        });
        const consumed = existingUsage?.consumedSeconds || 0;
        let remSec = 999999;
        let limitReached = false;
        if (budget) {
          const isUnlimited = Boolean(budget.unlimitedDate && budget.unlimitedDate === todayDate);
          if (isUnlimited) {
            remSec = 999999;
            limitReached = false;
          } else {
            const effectiveBonus = (budget.bonusDate === todayDate) ? (budget.bonusSeconds || 0) : 0;
            const totalAllowed = budget.dailyLimitSeconds + effectiveBonus;
            remSec = Math.max(0, totalAllowed - consumed);
            limitReached = consumed >= totalAllowed;
          }
        }
        return {
          consumedSeconds: consumed,
          remainingSeconds: remSec,
          isLimitReached: limitReached,
        };
      }
    }

    const now = new Date();
    const canLinkDevice = device.childId === childId;

    let usage: { consumedSeconds: number };

    try {
      usage = await prisma.$transaction(async (tx) => {
        if (syncId) {
          await tx.usageSyncReceipt.create({
            data: {
              id: `rec-${nanoid(12)}`,
              syncId,
              familyId: child.familyId,
              childId,
              deviceId,
              targetType,
              target: target.toLowerCase(),
              usageDate: todayDate,
              secondsIncrement: cleanIncrement,
            },
          });
        }

        const upserted = await tx.childUsageRecord.upsert({
          where: {
            childId_targetType_target_date: {
              childId,
              targetType,
              target: target.toLowerCase(),
              date: todayDate,
            },
          },
          create: {
            id: `use-${nanoid(10)}`,
            familyId: child.familyId,
            childId,
            deviceId: canLinkDevice ? deviceId : null,
            target: target.toLowerCase(),
            targetType,
            date: todayDate,
            consumedSeconds: cleanIncrement,
            lastSyncId: syncId || null,
            lastCheckpointTimestamp: now,
            lastSyncAt: now,
          },
          update: {
            consumedSeconds: { increment: cleanIncrement },
            deviceId: canLinkDevice ? deviceId : null,
            lastSyncId: syncId || null,
            lastCheckpointTimestamp: now,
            lastSyncAt: now,
          },
        });

        return upserted;
      });
    } catch (err: any) {
      if (err.code === 'P2002' && syncId) {
        // Unique conflict on deviceId + syncId from a concurrent duplicate request
        const existingUsage = await prisma.childUsageRecord.findUnique({
          where: {
            childId_targetType_target_date: {
              childId,
              targetType,
              target: target.toLowerCase(),
              date: todayDate,
            },
          },
        });
        const consumed = existingUsage?.consumedSeconds || 0;
        let remSec = 999999;
        let limitReached = false;
        if (budget) {
          const isUnlimited = Boolean(budget.unlimitedDate && budget.unlimitedDate === todayDate);
          if (isUnlimited) {
            remSec = 999999;
            limitReached = false;
          } else {
            const effectiveBonus = (budget.bonusDate === todayDate) ? (budget.bonusSeconds || 0) : 0;
            const totalAllowed = budget.dailyLimitSeconds + effectiveBonus;
            remSec = Math.max(0, totalAllowed - consumed);
            limitReached = consumed >= totalAllowed;
          }
        }
        return {
          consumedSeconds: consumed,
          remainingSeconds: remSec,
          isLimitReached: limitReached,
        };
      }
      throw err;
    }

    let remainingSeconds = 999999;
    let isLimitReached = false;

    if (budget) {
      const isUnlimited = Boolean(budget.unlimitedDate && budget.unlimitedDate === todayDate);
      if (isUnlimited) {
        remainingSeconds = 999999;
        isLimitReached = false;
      } else {
        const effectiveBonus = (budget.bonusDate === todayDate) ? (budget.bonusSeconds || 0) : 0;
        const totalAllowed = budget.dailyLimitSeconds + effectiveBonus;
        remainingSeconds = Math.max(0, totalAllowed - usage.consumedSeconds);
        isLimitReached = usage.consumedSeconds >= totalAllowed;
      }
    }

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
  public async getBudgetsWithUsage(childId: string): Promise<BudgetUsageSummary[]> {
    const policy = await prisma.policy.findUnique({
      where: { childId },
    });
    const usageBudgets = (policy?.usageBudgets as any as UsageBudget[]) || [];
    if (usageBudgets.length === 0) return [];

    const results: BudgetUsageSummary[] = [];
    const familyTimezone = await this.getFamilyTimezone(undefined, childId);

    for (const budget of usageBudgets) {
      const effectiveTz = this.resolveEffectiveTimezone(budget, familyTimezone);
      const todayDate = this.getTodayDateString(effectiveTz);
      const usage = await prisma.childUsageRecord.findUnique({
        where: {
          childId_targetType_target_date: {
            childId,
            targetType: budget.targetType,
            target: budget.target.toLowerCase(),
            date: todayDate,
          },
        },
      });

      const consumed = usage ? usage.consumedSeconds : 0;
      const isUnlimitedToday = Boolean(budget.unlimitedDate && budget.unlimitedDate === todayDate);
      const effectiveBonus = (budget.bonusDate === todayDate) ? (budget.bonusSeconds || 0) : 0;
      const totalAllowed = budget.dailyLimitSeconds + effectiveBonus;
      const remainingSeconds = isUnlimitedToday ? 999999 : Math.max(0, totalAllowed - consumed);
      const isLimitReached = !isUnlimitedToday && consumed >= totalAllowed;

      results.push({
        budget: {
          ...budget,
          unlimitedToday: isUnlimitedToday,
          bonusSeconds: effectiveBonus,
        },
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
  public async setUsageBudget(
    childId: string,
    target: string,
    targetType: BudgetTargetType,
    dailyLimitMinutes: number,
    actorUserId?: string,
    customTimezone?: string
  ): Promise<UsageBudget> {
    const policy = await prisma.policy.findUnique({
      where: { childId },
    });
    if (!policy) throw new Error('Policy not found.');

    const usageBudgets = (policy.usageBudgets as any as UsageBudget[]) || [];
    const cleanTarget = target.trim();
    const existingIndex = usageBudgets.findIndex(
      (b) => b.target.toLowerCase() === cleanTarget.toLowerCase() && b.targetType === targetType
    );

    const dailyLimitSeconds = Math.max(1, dailyLimitMinutes) * 60;
    const now = new Date().toISOString();

    const familyTimezone = await this.getFamilyTimezone(undefined, childId);
    let budgetTimezone = familyTimezone;
    let isCustomTimezone = false;
    if (customTimezone && customTimezone.trim()) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: customTimezone.trim() });
        budgetTimezone = customTimezone.trim();
        isCustomTimezone = true;
      } catch {
        throw new Error(`Invalid IANA timezone: ${customTimezone}`);
      }
    }

    let budget: UsageBudget;

    if (existingIndex >= 0) {
      const existing = usageBudgets[existingIndex];
      budget = {
        ...existing,
        dailyLimitSeconds,
        timezone: isCustomTimezone ? budgetTimezone : (existing.isCustomTimezone ? existing.timezone : familyTimezone),
        isCustomTimezone: isCustomTimezone || existing.isCustomTimezone,
        enabled: true,
        updatedAt: now,
        policyVersion: policy.version + 1,
      };
      usageBudgets[existingIndex] = budget;
    } else {
      budget = {
        id: `ub-${nanoid(10)}`,
        childId,
        target: cleanTarget,
        targetType,
        dailyLimitSeconds,
        timezone: budgetTimezone,
        isCustomTimezone,
        resetTime: '00:00',
        enabled: true,
        policyVersion: policy.version + 1,
        updatedAt: now,
      };
      usageBudgets.push(budget);
    }

    await prisma.policy.update({
      where: { childId },
      data: {
        usageBudgets: usageBudgets as any,
        version: { increment: 1 },
      },
    });

    const child = await prisma.child.findUnique({ where: { id: childId } });
    if (child && actorUserId && child.familyId) {
      const actor = await prisma.user.findUnique({ where: { id: actorUserId } });
      await prisma.familyAuditLog.create({
        data: {
          id: `log-${nanoid(10)}`,
          familyId: child.familyId,
          actorUserId,
          actorName: actor?.name || 'Parent',
          action: 'SCREEN_TIME_UPDATED',
          details: `Set daily limit of ${dailyLimitMinutes} min on '${cleanTarget}' for ${child.name}`,
        },
      });
    }

    return budget;
  }

  /**
   * Add bonus minutes to a budget
   */
  public async addBonusTime(
    childId: string,
    budgetId: string,
    bonusMinutes: number,
    actorUserId?: string
  ): Promise<UsageBudget> {
    const policy = await prisma.policy.findUnique({
      where: { childId },
    });
    const usageBudgets = (policy?.usageBudgets as any as UsageBudget[]) || [];
    const budget = usageBudgets.find((b) => b.id === budgetId);
    if (!budget) throw new Error('Budget not found.');

    const familyTimezone = await this.getFamilyTimezone(undefined, childId);
    const effectiveTz = this.resolveEffectiveTimezone(budget, familyTimezone);
    const todayDate = this.getTodayDateString(effectiveTz);

    if (budget.bonusDate === todayDate) {
      budget.bonusSeconds = (budget.bonusSeconds || 0) + bonusMinutes * 60;
    } else {
      budget.bonusSeconds = bonusMinutes * 60;
      budget.bonusDate = todayDate;
    }
    budget.updatedAt = new Date().toISOString();

    await prisma.policy.update({
      where: { childId },
      data: {
        usageBudgets: usageBudgets as any,
        version: { increment: 1 },
      },
    });

    const child = await prisma.child.findUnique({ where: { id: childId } });
    if (child && actorUserId && child.familyId) {
      const actor = await prisma.user.findUnique({ where: { id: actorUserId } });
      await prisma.familyAuditLog.create({
        data: {
          id: `log-${nanoid(10)}`,
          familyId: child.familyId,
          actorUserId,
          actorName: actor?.name || 'Parent',
          action: 'BONUS_TIME_GRANTED',
          details: `Granted +${bonusMinutes} min bonus on '${budget.target}' for ${child.name}`,
        },
      });
    }

    return budget;
  }

  /**
   * Set unlimited access for today
   */
  public async setUnlimitedToday(
    childId: string,
    budgetId: string,
    actorUserId?: string
  ): Promise<UsageBudget> {
    const policy = await prisma.policy.findUnique({
      where: { childId },
    });
    const usageBudgets = (policy?.usageBudgets as any as UsageBudget[]) || [];
    const budget = usageBudgets.find((b) => b.id === budgetId);
    if (!budget) throw new Error('Budget not found.');

    const familyTimezone = await this.getFamilyTimezone(undefined, childId);
    const effectiveTz = this.resolveEffectiveTimezone(budget, familyTimezone);
    const todayDate = this.getTodayDateString(effectiveTz);

    budget.unlimitedToday = true;
    budget.unlimitedDate = todayDate;
    budget.updatedAt = new Date().toISOString();

    await prisma.policy.update({
      where: { childId },
      data: {
        usageBudgets: usageBudgets as any,
        version: { increment: 1 },
      },
    });

    const child = await prisma.child.findUnique({ where: { id: childId } });
    if (child && actorUserId && child.familyId) {
      const actor = await prisma.user.findUnique({ where: { id: actorUserId } });
      await prisma.familyAuditLog.create({
        data: {
          id: `log-${nanoid(10)}`,
          familyId: child.familyId,
          actorUserId,
          actorName: actor?.name || 'Parent',
          action: 'UNLIMITED_TODAY_GRANTED',
          details: `Granted Unlimited Today on '${budget.target}' for ${child.name}`,
        },
      });
    }

    return budget;
  }

  /**
   * Remove a usage budget
   */
  public async removeUsageBudget(childId: string, budgetId: string) {
    const policy = await prisma.policy.findUnique({
      where: { childId },
    });
    const usageBudgets = (policy?.usageBudgets as any as UsageBudget[]) || [];
    const filtered = usageBudgets.filter((b) => b.id !== budgetId);

    const updated = await prisma.policy.update({
      where: { childId },
      data: {
        usageBudgets: filtered as any,
        version: { increment: 1 },
      },
    });

    return updated;
  }

  /**
   * Update SafeSearch configuration
   */
  public async updateSafeSearch(
    childId: string,
    config: SafeSearchConfig,
    actorUserId?: string
  ): Promise<any> {
    const updated = await prisma.policy.update({
      where: { childId },
      data: {
        safeSearch: config as any,
        version: { increment: 1 },
      },
    });

    const child = await prisma.child.findUnique({ where: { id: childId } });
    if (child && actorUserId && child.familyId) {
      const actor = await prisma.user.findUnique({ where: { id: actorUserId } });
      await prisma.familyAuditLog.create({
        data: {
          id: `log-${nanoid(10)}`,
          familyId: child.familyId,
          actorUserId,
          actorName: actor?.name || 'Parent',
          action: 'SAFE_SEARCH_UPDATED',
          details: `Updated SafeSearch and YouTube Restricted Mode settings for ${child.name}`,
        },
      });
    }

    return updated;
  }

  /**
   * Generate privacy-first weekly summary
   */
  public async getWeeklyDigest(userId: string, familyId?: string) {
    const userFamilyIds = (await rbacService.getUserFamilyMemberships(userId)).map((m) => m.familyId);
    const targetFamilyIds = familyId ? [familyId] : userFamilyIds;
    const allowedSet = targetFamilyIds.filter((fid) => userFamilyIds.includes(fid));

    const children = await prisma.child.findMany({
      where: { familyId: { in: allowedSet } },
    });
    const childIds = children.map((c) => c.id);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const recentLogs = await prisma.activityEvent.findMany({
      where: {
        childId: { in: childIds },
        timestamp: { gte: sevenDaysAgo },
      },
    });

    const totalBlocked = recentLogs.filter((a) => a.action === 'BLOCKED').length;
    const totalAllowed = recentLogs.filter((a) => a.action === 'ALLOWED').length;

    const categoryBreakdown: Record<string, number> = {};
    recentLogs.forEach((a) => {
      const cat = (a as any).category || 'UNCATEGORIZED';
      categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + 1;
    });

    const requests = await prisma.accessRequest.findMany({
      where: {
        childId: { in: childIds },
        requestedAt: { gte: sevenDaysAgo },
      },
    });

    return {
      period: 'Past 7 Days',
      uptimePercent: null,
      uptimeAvailable: false,
      totalManagedEvents: recentLogs.length,
      totalBlockedEvents: totalBlocked,
      totalAllowedEvents: totalAllowed,
      categoryBreakdown,
      askParentTotal: requests.length,
      askParentApproved: requests.filter((r) => (r.status as string) === 'APPROVED').length,
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
