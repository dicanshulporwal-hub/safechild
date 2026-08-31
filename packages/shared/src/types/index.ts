export type DevicePlatform = 'android' | 'windows' | 'ios' | 'macos' | 'linux';

export type DeviceHealthStatus = 'protected' | 'syncing' | 'inactive';

export type RuleAction = 'BLOCK' | 'ALLOW' | 'TEMPORARY_ALLOW';

export type WebsiteCategory =
  | 'ADULT_CONTENT'
  | 'GAMBLING'
  | 'GAMING'
  | 'SOCIAL_MEDIA'
  | 'EDUCATION'
  | 'ENTERTAINMENT';

export type MatchedRuleType =
  | 'ESSENTIAL_ALLOW'
  | 'PAUSED_INTERNET'
  | 'USAGE_LIMIT_EXHAUSTED'
  | 'TEMPORARY_GRANT'
  | 'EXPLICIT_ALLOW'
  | 'EXPLICIT_BLOCK'
  | 'STUDY_MODE'
  | 'BEDTIME'
  | 'CATEGORY'
  | 'DEFAULT';

export interface CategoryControl {
  category: WebsiteCategory;
  action: 'BLOCK' | 'ALLOW' | 'RESTRICT';
}

export interface BedtimeSchedule {
  enabled: boolean;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  allowEducationalOnly: boolean;
}

export interface StudyMode {
  active: boolean;
  expiresAt?: string | null;
  allowedCategories: WebsiteCategory[];
}

export interface PolicyRule {
  id: string;
  domain: string;
  action: RuleAction;
  category?: WebsiteCategory;
  addedAt: string;
  expiresAt?: string | null;
  reason?: string;
}

export type BudgetTargetType = 'DOMAIN' | 'CATEGORY' | 'APP';

export interface UsageBudget {
  id: string;
  childId: string;
  targetType: BudgetTargetType;
  target: string; // e.g. 'youtube.com', 'GAMING', 'com.zhiliaoapp.musically'
  dailyLimitSeconds: number; // e.g. 3600 for 60 min
  bonusSeconds?: number;
  unlimitedToday?: boolean;
  timezone: string;
  resetTime: string; // '00:00'
  enabled: boolean;
  policyVersion: number;
  updatedAt: string;
}

export interface ChildUsageRecord {
  childId: string;
  target: string;
  targetType: BudgetTargetType;
  date: string; // 'YYYY-MM-DD'
  consumedSeconds: number;
  lastCheckpointTimestamp: string;
  lastDeviceUsed?: string;
  updatedAt: string;
}

export interface SafeSearchConfig {
  googleSafeSearch: boolean;
  bingSafeSearch: boolean;
  duckDuckGoSafeSearch: boolean;
  youtubeRestrictedMode: 'OFF' | 'MODERATE' | 'STRICT';
}

export interface Policy {
  id: string;
  childId: string;
  version: number;
  isPaused: boolean;
  pauseExpiresAt?: string | null;
  essentialAllowList?: string[]; // Layer 1: Always available (e.g. school.edu, emergency)
  studyMode?: StudyMode;
  bedtime?: BedtimeSchedule;
  categoryControls?: CategoryControl[];
  rules: PolicyRule[];
  usageBudgets?: UsageBudget[];
  safeSearch?: SafeSearchConfig;
  updatedAt: string;
}

export interface Child {
  id: string;
  parentId: string;
  name: string;
  avatar?: string;
  age?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Device {
  id: string;
  childId: string;
  parentId: string;
  name: string;
  platform: DevicePlatform;
  deviceToken: string;
  pairedAt: string;
  lastSyncAt: string;
  lastHeartbeatAt: string;
  activePolicyVersion: number;
  healthStatus: DeviceHealthStatus;
  ipAddress?: string;
  agentVersion?: string;
}

export interface PairingCode {
  code: string;
  childId: string;
  parentId: string;
  expiresAt: string;
}

export type AccessRequestStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';

export type TemporaryApprovalDuration = '15m' | '30m' | '1h' | 'today' | 'always';

export function calculateExpirationDate(duration: TemporaryApprovalDuration): string {
  const now = new Date();
  if (duration === '15m') {
    return new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  } else if (duration === '30m') {
    return new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  } else if (duration === '1h') {
    return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  } else if (duration === 'today') {
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return endOfDay.toISOString();
  }
  return new Date(now.getTime() + 15 * 60 * 1000).toISOString();
}

export type AccessRequestType = 'WEBSITE_UNLOCK' | 'MORE_TIME';

export interface AccessRequest {
  id: string;
  childId: string;
  deviceId: string;
  deviceName?: string;
  domain: string;
  reason?: string;
  type?: AccessRequestType;
  requestedDuration?: TemporaryApprovalDuration;
  status: AccessRequestStatus;
  requestedAt: string;
  resolvedAt?: string | null;
  resolvedDuration?: TemporaryApprovalDuration | null;
  resolvedByName?: string;
  resolvedByUserId?: string;
  expiresAt?: string | null;
}

export interface ActivityEvent {
  id: string;
  childId: string;
  deviceId: string;
  deviceName: string;
  domain: string;
  category?: WebsiteCategory;
  action: 'BLOCKED' | 'ALLOWED' | 'TEMPORARY_ACCESSED';
  reason?: string;
  timestamp: string;
}

export interface HeartbeatPayload {
  deviceId: string;
  deviceToken: string;
  activePolicyVersion: number;
  enforcementActive: boolean;
  platform: DevicePlatform;
  agentVersion: string;
}

export interface HeartbeatResponse {
  status: 'ok';
  latestPolicyVersion: number;
  policyChanged: boolean;
  serverTime: string;
}

export interface PolicyEvaluationResult {
  action: 'BLOCK' | 'ALLOW';
  reason:
    | 'ESSENTIAL_ALLOW'
    | 'PAUSED_INTERNET'
    | 'USAGE_LIMIT_EXHAUSTED'
    | 'BEDTIME_ACTIVE'
    | 'STUDY_MODE_ACTIVE'
    | 'CATEGORY_BLOCKED'
    | 'EXPLICIT_BLOCK'
    | 'EXPLICIT_ALLOW'
    | 'TEMPORARY_ALLOW'
    | 'DEFAULT_ALLOW';
  matchedRuleType?: MatchedRuleType;
  matchedRule?: PolicyRule;
  matchedDomain?: string;
  matchedCategory?: WebsiteCategory;
  budgetInfo?: {
    dailyLimitSeconds: number;
    consumedSeconds: number;
    remainingSeconds: number;
    resetTime: string;
  };
  safeSearchRedirect?: string;
  expiresAt?: string | null;
  explanation?: string;
}

export interface DetailedPolicyDecision {
  action: 'BLOCK' | 'ALLOW';
  matchedRuleType: MatchedRuleType;
  matchedRuleId?: string;
  matchedDomain?: string;
  policyVersion?: number;
  expiresAt?: string | null;
  reason: string;
  evaluationTrace: Array<{
    level: string;
    evaluated: boolean;
    matched: boolean;
    resultAction?: 'BLOCK' | 'ALLOW';
    detail: string;
  }>;
}
