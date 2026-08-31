import { db } from '../db/store';
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
  public getPolicyForChild(childId: string): Policy {
    let policy = db.policies.get(childId);
    if (!policy) {
      policy = {
        id: `policy-${nanoid(8)}`,
        childId,
        version: 1,
        isPaused: false,
        rules: [],
        updatedAt: new Date().toISOString(),
      };
      db.policies.set(childId, policy);
      db.save();
    }
    return policy;
  }

  public getPolicyForDevice(deviceId: string): { policy: Policy; child: any } {
    const device = db.devices.get(deviceId);
    if (!device) {
      throw new Error('Device not found.');
    }
    const policy = this.getPolicyForChild(device.childId);
    const child = db.children.get(device.childId);
    return { policy, child };
  }

  /**
   * Adds or updates a rule for a child policy
   */
  public addRule(
    childId: string,
    domain: string,
    action: RuleAction,
    reason?: string,
    duration?: TemporaryApprovalDuration
  ): Policy {
    const policy = this.getPolicyForChild(childId);
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
      // Remove any existing temporary rule for this domain, but PRESERVE base permanent rules (e.g. BLOCK)
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
      // Permanent rule: replace all existing rules for this domain
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

    policy.rules = updatedRules;
    policy.version += 1;
    policy.updatedAt = new Date().toISOString();

    db.policies.set(childId, policy);
    db.save();

    // Broadcast policy update to connected child devices and parent dashboard
    wsManager.broadcast({
      type: 'POLICY_UPDATED',
      payload: policy,
      childId,
    });

    return policy;
  }

  /**
   * Remove a rule by ruleId
   */
  public removeRule(childId: string, ruleId: string): Policy {
    const policy = this.getPolicyForChild(childId);
    policy.rules = policy.rules.filter((r: PolicyRule) => r.id !== ruleId);
    policy.version += 1;
    policy.updatedAt = new Date().toISOString();

    db.policies.set(childId, policy);
    db.save();

    wsManager.broadcast({
      type: 'POLICY_UPDATED',
      payload: policy,
      childId,
    });

    return policy;
  }

  /**
   * Pause or unpause internet access for a child
   */
  public setInternetPause(
    childId: string,
    isPaused: boolean,
    duration?: '15m' | '30m' | '1h' | 'indefinite'
  ): Policy {
    const policy = this.getPolicyForChild(childId);
    policy.isPaused = isPaused;

    if (isPaused && duration && duration !== 'indefinite') {
      const now = new Date();
      if (duration === '15m') now.setMinutes(now.getMinutes() + 15);
      if (duration === '30m') now.setMinutes(now.getMinutes() + 30);
      if (duration === '1h') now.setHours(now.getHours() + 1);
      policy.pauseExpiresAt = now.toISOString();
    } else {
      policy.pauseExpiresAt = null;
    }

    policy.version += 1;
    policy.updatedAt = new Date().toISOString();

    db.policies.set(childId, policy);
    db.save();

    wsManager.broadcast({
      type: 'POLICY_UPDATED',
      payload: policy,
      childId,
    });

    return policy;
  }
}

export const policyService = new PolicyService();
