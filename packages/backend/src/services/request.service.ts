import { prisma } from '../db/prisma';
import {
  AccessRequest,
  TemporaryApprovalDuration,
  calculateExpirationDate,
  normalizeDomain,
  PolicyRule,
} from '@safebrowse/shared';
import { nanoid } from 'nanoid';
import { wsManager } from './websocket.service';
import { pushService } from './push.service';
import { rbacService } from './rbac.service';

export interface ExtendedAccessRequest extends AccessRequest {
  resolvedByUserId?: string;
  resolvedByName?: string;
}

export class RequestService {
  /**
   * Child creates access request from block page
   */
  public async createRequest(
    childId: string,
    deviceId: string,
    domain: string,
    reason?: string
  ): Promise<ExtendedAccessRequest> {
    const normDomain = normalizeDomain(domain);
    const child = await prisma.child.findUnique({
      where: { id: childId },
    });
    const device = await prisma.device.findUnique({
      where: { id: deviceId },
    });

    if (!child || !child.familyId) {
      throw new Error('Mandatory tenancy error: Child profile not found or has no valid family.');
    }

    const id = `req-${nanoid(10)}`;
    const now = new Date();

    const created = await prisma.accessRequest.create({
      data: {
        id,
        childId,
        deviceId,
        familyId: child.familyId,
        domain: normDomain,
        reason: reason ? reason.trim() : null,
        status: 'PENDING',
        requestedAt: now,
      },
    });

    const request: ExtendedAccessRequest = {
      id: created.id,
      childId: created.childId,
      deviceId: created.deviceId || '',
      familyId: created.familyId,
      deviceName: device ? device.name : 'Unknown Device',
      domain: created.domain,
      reason: created.reason || undefined,
      status: 'PENDING',
      requestedAt: created.requestedAt.toISOString(),
    };

    wsManager.broadcast({
      type: 'ACCESS_REQUEST_CREATED',
      payload: request,
      parentId: child.parentId,
      childId,
    });

    // Send Web Push notification to family parents
    pushService.sendPushToFamily(child.familyId, {
      title: 'Website Access Request',
      body: `${child.name} requested permission to visit ${normDomain}${reason ? ` (${reason})` : ''}`,
      tag: `req-${created.id}`,
      data: {
        requestId: created.id,
        childId,
        domain: normDomain,
        url: `/requests?id=${created.id}`,
      },
    }).catch(() => {});

    return request;
  }

  /**
   * Parent resolves access request with strict family role and approval rule enforcement transactionally
   */
  public async resolveRequest(
    requestId: string,
    actorUserId: string,
    action: 'APPROVE' | 'DENY',
    duration?: TemporaryApprovalDuration
  ): Promise<{ request: ExtendedAccessRequest; policy?: any }> {
    return prisma.$transaction(async (tx) => {
      const request = await tx.accessRequest.findUnique({
        where: { id: requestId },
        include: { child: true, device: true },
      });
      if (!request) {
        throw new Error('Access request not found.');
      }

      if (request.status !== 'PENDING') {
        throw new Error('REQUEST_ALREADY_RESOLVED: This request has already been processed by another parent.');
      }

      const family = await rbacService.getFamilyForRequest(requestId);
      if (!family || !(await rbacService.getFamilyMembership(actorUserId, family.id))) {
        throw new Error('Forbidden. You do not belong to the family associated with this request.');
      }

      const approvalCheck = await rbacService.canApproveRequest(actorUserId, requestId);
      if (!approvalCheck.allowed) {
        throw new Error(`Forbidden: ${approvalCheck.reason}`);
      }

      const actor = await tx.user.findUnique({ where: { id: actorUserId } });
      const actorName = actor ? actor.name : 'Parent';
      const now = new Date();

      let updatedPolicyRecord: any = null;
      let expiresAtDate: Date | null = null;

      if (action === 'APPROVE') {
        const ruleAction = duration === 'always' ? 'ALLOW' : 'TEMPORARY_ALLOW';
        if (duration && duration !== 'always') {
          const expStr = calculateExpirationDate(duration);
          expiresAtDate = new Date(expStr);
        }

        // Fetch and update policy
        const currentPolicy = await tx.policy.findUnique({
          where: { childId: request.childId },
        });

        const currentRules: PolicyRule[] = ((currentPolicy?.rules as any) || []) as PolicyRule[];
        let updatedRules: PolicyRule[];

        if (ruleAction === 'TEMPORARY_ALLOW') {
          const nonTempRules = currentRules.filter(
            (r) => !(r.domain === request.domain && r.action === 'TEMPORARY_ALLOW')
          );
          const newTempRule: PolicyRule = {
            id: `r-${nanoid(6)}`,
            domain: request.domain,
            action: 'TEMPORARY_ALLOW',
            reason: `Approved by ${actorName}: ${request.reason || 'Requested by child'}`,
            addedAt: now.toISOString(),
            expiresAt: expiresAtDate ? expiresAtDate.toISOString() : undefined,
          };
          updatedRules = [newTempRule, ...nonTempRules];
        } else {
          const filteredRules = currentRules.filter((r) => r.domain !== request.domain);
          const newPermRule: PolicyRule = {
            id: `r-${nanoid(6)}`,
            domain: request.domain,
            action: 'ALLOW',
            reason: `Approved by ${actorName}: ${request.reason || 'Requested by child'}`,
            addedAt: now.toISOString(),
          };
          updatedRules = [newPermRule, ...filteredRules];
        }

        updatedPolicyRecord = await tx.policy.upsert({
          where: { childId: request.childId },
          create: {
            id: `policy-${nanoid(8)}`,
            childId: request.childId,
            familyId: request.familyId,
            version: 1,
            rules: updatedRules as any,
          },
          update: {
            rules: updatedRules as any,
            version: { increment: 1 },
          },
        });
      }

      const updatedRequest = await tx.accessRequest.update({
        where: { id: requestId },
        data: {
          status: (action === 'APPROVE' ? 'APPROVED' : 'DENIED') as any,
          resolvedAt: now,
          resolvedByUserId: actorUserId,
          expiresAt: expiresAtDate,
        },
      });

      // Audit entry
      await tx.familyAuditLog.create({
        data: {
          id: `log-${nanoid(10)}`,
          familyId: request.familyId,
          actorUserId,
          actorName,
          action: 'REQUEST_RESOLVED',
          details: JSON.stringify({
            requestId: request.id,
            resolvedBy: actorName,
            decision: action,
            TTL: duration || '15m',
            policyVersion: updatedPolicyRecord?.version || 1,
            domain: request.domain,
            timestamp: now.toISOString(),
          }),
          childId: request.childId,
        },
      });

      const resRequest: ExtendedAccessRequest = {
        id: updatedRequest.id,
        childId: updatedRequest.childId,
        deviceId: updatedRequest.deviceId || '',
        familyId: updatedRequest.familyId,
        deviceName: request.device?.name || 'Unknown Device',
        domain: updatedRequest.domain,
        reason: updatedRequest.reason || undefined,
        status: updatedRequest.status as any,
        requestedAt: updatedRequest.requestedAt.toISOString(),
        resolvedAt: updatedRequest.resolvedAt ? updatedRequest.resolvedAt.toISOString() : undefined,
        resolvedByUserId: actorUserId,
        resolvedByName: actorName,
        resolvedDuration: duration,
        expiresAt: updatedRequest.expiresAt ? updatedRequest.expiresAt.toISOString() : undefined,
      };

      const resPolicy = updatedPolicyRecord
        ? {
            id: updatedPolicyRecord.id,
            childId: updatedPolicyRecord.childId,
            familyId: updatedPolicyRecord.familyId,
            version: updatedPolicyRecord.version,
            isPaused: updatedPolicyRecord.isPaused,
            rules: updatedPolicyRecord.rules,
            updatedAt: updatedPolicyRecord.updatedAt.toISOString(),
          }
        : undefined;

      wsManager.broadcast({
        type: 'ACCESS_REQUEST_RESOLVED',
        payload: {
          request: resRequest,
          policy: resPolicy,
        },
        parentId: request.child.parentId,
        childId: request.childId,
      });

      return { request: resRequest, policy: resPolicy };
    });
  }

  public async getRequestsForChild(childId: string): Promise<ExtendedAccessRequest[]> {
    const list = await prisma.accessRequest.findMany({
      where: { childId },
      include: { device: true },
      orderBy: { requestedAt: 'desc' },
    });

    return list.map((r) => ({
      id: r.id,
      childId: r.childId,
      deviceId: r.deviceId || '',
      familyId: r.familyId,
      deviceName: r.device?.name || 'Child Device',
      domain: r.domain,
      reason: r.reason || undefined,
      status: r.status as any,
      requestedAt: r.requestedAt.toISOString(),
      resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : undefined,
      resolvedByUserId: r.resolvedByUserId || undefined,
    }));
  }

  public async getPendingRequestsForParent(
    parentId: string,
    familyId?: string
  ): Promise<ExtendedAccessRequest[]> {
    const userFamilyIds = (await rbacService.getUserFamilyMemberships(parentId)).map((m) => m.familyId);
    const targetFamilyIds = familyId ? [familyId] : userFamilyIds;
    const allowedSet = targetFamilyIds.filter((fid) => userFamilyIds.includes(fid));

    const list = await prisma.accessRequest.findMany({
      where: {
        familyId: { in: allowedSet },
        status: 'PENDING',
      },
      include: { device: true },
      orderBy: { requestedAt: 'desc' },
    });

    return list.map((r) => ({
      id: r.id,
      childId: r.childId,
      deviceId: r.deviceId || '',
      familyId: r.familyId,
      deviceName: r.device?.name || 'Child Device',
      domain: r.domain,
      reason: r.reason || undefined,
      status: r.status as any,
      requestedAt: r.requestedAt.toISOString(),
    }));
  }
}

export const requestService = new RequestService();
