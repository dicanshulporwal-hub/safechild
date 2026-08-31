import { db } from '../db/store';
import {
  AccessRequest,
  TemporaryApprovalDuration,
  calculateExpirationDate,
  normalizeDomain,
} from '@safebrowse/shared';
import { nanoid } from 'nanoid';
import { wsManager } from './websocket.service';
import { policyService } from './policy.service';
import { familyService } from './family.service';
import { usageService } from './usage.service';

export interface ExtendedAccessRequest extends AccessRequest {
  resolvedByUserId?: string;
  resolvedByName?: string;
}

export class RequestService {
  /**
   * Child creates access request from block page
   */
  public createRequest(
    childId: string,
    deviceId: string,
    domain: string,
    reason?: string
  ): ExtendedAccessRequest {
    const normDomain = normalizeDomain(domain);
    const child = db.children.get(childId);
    const device = db.devices.get(deviceId);

    if (!child) {
      throw new Error('Child profile not found.');
    }

    const request: ExtendedAccessRequest = {
      id: `req-${nanoid(10)}`,
      childId,
      deviceId,
      deviceName: device ? device.name : 'Unknown Device',
      domain: normDomain,
      reason: reason ? reason.trim() : undefined,
      status: 'PENDING',
      requestedAt: new Date().toISOString(),
    };

    db.requests.set(request.id, request as any);
    db.save();

    // Broadcast to Parent Dashboard across all family members
    wsManager.broadcast({
      type: 'ACCESS_REQUEST_CREATED',
      payload: request,
      parentId: child.parentId,
      childId,
    });

    return request;
  }

  /**
   * Parent resolves access request with strict multi-parent tenancy validation
   */
  public resolveRequest(
    requestId: string,
    parentId: string,
    action: 'APPROVE' | 'DENY',
    duration?: TemporaryApprovalDuration
  ): { request: ExtendedAccessRequest; policy?: any } {
    const request = db.requests.get(requestId) as ExtendedAccessRequest | undefined;
    if (!request) {
      throw new Error('Access request not found.');
    }

    const child = db.children.get(request.childId);
    if (!child) {
      throw new Error('Child profile not found.');
    }

    // Validate if parentId is owner OR authorized family member of child's family
    const childFamilies = Array.from(db.familyMembers.values())
      .filter((m) => m.userId === child.parentId)
      .map((m) => m.familyId);

    const isAuthorized =
      child.parentId === parentId ||
      Array.from(db.familyMembers.values()).some(
        (m) => m.userId === parentId && childFamilies.includes(m.familyId)
      );

    if (!isAuthorized) {
      throw new Error('Forbidden. You do not have permission to resolve requests for this child.');
    }

    if (request.status !== 'PENDING') {
      throw new Error('REQUEST_ALREADY_RESOLVED: This request has already been processed by another parent.');
    }

    const actor = db.users.get(parentId);
    const actorName = actor ? actor.name : 'Parent';

    request.resolvedAt = new Date().toISOString();
    request.resolvedByUserId = parentId;
    request.resolvedByName = actorName;

    let updatedPolicy = null;

    if (action === 'APPROVE') {
      request.status = 'APPROVED';
      request.resolvedDuration = duration || '15m';
      const ruleAction = duration === 'always' ? 'ALLOW' : 'TEMPORARY_ALLOW';

      if (duration && duration !== 'always') {
        request.expiresAt = calculateExpirationDate(duration);
      }

      if (request.type === 'MORE_TIME') {
        const policy = db.policies.get(request.childId);
        const budget = policy?.usageBudgets?.find(
          (b) => b.target.toLowerCase() === request.domain.toLowerCase()
        );
        if (budget) {
          const minutes = duration === '1h' ? 60 : duration === '30m' ? 30 : 15;
          if (duration === 'today') {
            usageService.setUnlimitedToday(request.childId, budget.id, parentId);
          } else {
            usageService.addBonusTime(request.childId, budget.id, minutes, parentId);
          }
        }
      }

      // Add rule to child policy and bump version
      updatedPolicy = policyService.addRule(
        request.childId,
        request.domain,
        ruleAction,
        `Approved by ${actorName}: ${request.reason || 'Requested by child'}`,
        duration || '15m'
      );
    } else {
      request.status = 'DENIED';
    }

    db.requests.set(request.id, request as any);
    db.save();

    // Log in Family Audit Trail with full metadata
    familyService.logAudit(
      childFamilies[0] || 'fam-default',
      parentId,
      actorName,
      'REQUEST_RESOLVED',
      JSON.stringify({
        requestId: request.id,
        resolvedBy: actorName,
        decision: action,
        TTL: duration || '15m',
        policyVersion: updatedPolicy?.version || 1,
        domain: request.domain,
        timestamp: request.resolvedAt,
      }),
      child.id
    );

    // Broadcast resolution to all of child's devices + all parents
    wsManager.broadcast({
      type: 'ACCESS_REQUEST_RESOLVED',
      payload: {
        request,
        policy: updatedPolicy,
      },
      parentId: child.parentId,
      childId: request.childId,
    });

    return { request, policy: updatedPolicy };
  }

  public getRequestsForChild(childId: string): ExtendedAccessRequest[] {
    return (Array.from(db.requests.values()) as ExtendedAccessRequest[])
      .filter((r) => r.childId === childId)
      .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime());
  }

  public getPendingRequestsForParent(parentId: string): ExtendedAccessRequest[] {
    const family = familyService.getOrCreateUserFamily(parentId);
    const familyOwnerId = family.ownerUserId;

    const parentChildrenIds = Array.from(db.children.values())
      .filter((c) => c.parentId === parentId || c.parentId === familyOwnerId)
      .map((c) => c.id);

    return (Array.from(db.requests.values()) as ExtendedAccessRequest[])
      .filter((r) => parentChildrenIds.includes(r.childId) && r.status === 'PENDING')
      .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime());
  }
}

export const requestService = new RequestService();
