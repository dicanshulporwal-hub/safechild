import { nanoid } from 'nanoid';
import { db } from '../db/store';

export type FeedbackCategory =
  | 'WEBSITE_WRONGLY_BLOCKED'
  | 'WEBSITE_SHOULD_HAVE_BEEN_BLOCKED'
  | 'PROTECTION_STOPPED'
  | 'INTERNET_STOPPED_WORKING'
  | 'INSTALLATION_PROBLEM'
  | 'ASK_PARENT_PROBLEM'
  | 'DASHBOARD_CONFUSING'
  | 'OTHER';

export interface ParentFeedback {
  id: string;
  parentId: string;
  parentEmail?: string;
  category: FeedbackCategory;
  notes?: string;
  submittedAt: string;
  status: 'NEW' | 'REVIEWED' | 'RESOLVED';
}

export interface FalsePositiveReport {
  id: string;
  parentId: string;
  childId: string;
  deviceId?: string;
  domain: string;
  policyDecision: 'BLOCK';
  matchedRuleType: string;
  category?: string;
  policyVersion: number;
  notes?: string;
  timestamp: string;
  status: 'PENDING_REVIEW' | 'WHITELISTED' | 'REJECTED';
}

export class FeedbackService {
  private feedbackList: ParentFeedback[] = [];
  private falsePositiveReports: FalsePositiveReport[] = [];

  public submitFeedback(parentId: string, category: FeedbackCategory, notes?: string): ParentFeedback {
    const user = db.users.get(parentId);
    const item: ParentFeedback = {
      id: `fb-${nanoid(10)}`,
      parentId,
      parentEmail: user?.email,
      category,
      notes,
      submittedAt: new Date().toISOString(),
      status: 'NEW',
    };

    this.feedbackList.unshift(item);
    return item;
  }

  public reportFalsePositive(
    parentId: string,
    childId: string,
    domain: string,
    matchedRuleType: string,
    policyVersion: number,
    category?: string,
    deviceId?: string,
    notes?: string
  ): FalsePositiveReport {
    const report: FalsePositiveReport = {
      id: `fp-${nanoid(10)}`,
      parentId,
      childId,
      deviceId,
      domain,
      policyDecision: 'BLOCK',
      matchedRuleType,
      category,
      policyVersion,
      notes,
      timestamp: new Date().toISOString(),
      status: 'PENDING_REVIEW',
    };

    this.falsePositiveReports.unshift(report);
    return report;
  }

  public getAllFeedback(): ParentFeedback[] {
    return this.feedbackList;
  }

  public getAllFalsePositives(): FalsePositiveReport[] {
    return this.falsePositiveReports;
  }
}

export const feedbackService = new FeedbackService();
