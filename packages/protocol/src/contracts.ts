export const CURRENT_PROTOCOL_VERSION = '1.0.0';

export type ProtocolVersion = '1.0.0';

export type DevicePlatform = 'android' | 'windows' | 'ios' | 'macos' | 'linux';

export type HealthState = 'PROTECTED' | 'WARNING' | 'INACTIVE' | 'OFFLINE';

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
  | 'TEMPORARY_GRANT'
  | 'EXPLICIT_ALLOW'
  | 'EXPLICIT_BLOCK'
  | 'STUDY_MODE'
  | 'BEDTIME'
  | 'CATEGORY'
  | 'DEFAULT';

export interface PolicyRuleContract {
  id: string;
  domain: string;
  action: RuleAction;
  category?: WebsiteCategory;
  addedAt: string;
  expiresAt?: string | null;
  reason?: string;
}

export interface PolicyDocument {
  protocolVersion: ProtocolVersion;
  id: string;
  childId: string;
  version: number;
  isPaused: boolean;
  pauseExpiresAt?: string | null;
  essentialAllowList?: string[]; // Always available (School, Emergency, etc.)
  studyMode?: {
    active: boolean;
    allowedCategories: WebsiteCategory[];
  };
  bedtime?: {
    enabled: boolean;
    startHour: number;
    startMinute: number;
    endHour: number;
    endMinute: number;
    allowEducationalOnly: boolean;
  };
  categoryControls?: Array<{
    category: WebsiteCategory;
    action: 'BLOCK' | 'ALLOW' | 'RESTRICT';
  }>;
  rules: PolicyRuleContract[];
  updatedAt: string;
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

export interface DeviceHeartbeat {
  protocolVersion: ProtocolVersion;
  deviceId: string;
  deviceToken: string;
  activePolicyVersion: number;
  enforcementActive: boolean;
  platform: DevicePlatform;
  agentVersion: string;
  tamperFlags?: {
    vpnRevoked?: boolean;
    serviceKilled?: boolean;
    adapterReset?: boolean;
  };
}

export interface DeviceHealth {
  protocolVersion: ProtocolVersion;
  deviceId: string;
  healthState: HealthState;
  activePolicyVersion: number;
  latestPolicyVersion: number;
  isPolicyStale: boolean;
  lastHeartbeatAt: string;
  details?: string;
}

export interface PairingRequest {
  protocolVersion: ProtocolVersion;
  code: string;
  deviceName: string;
  platform: DevicePlatform;
  agentVersion: string;
}

export interface PairingResponse {
  protocolVersion: ProtocolVersion;
  deviceId: string;
  deviceToken: string;
  childId: string;
  parentId: string;
  policy: PolicyDocument;
}

export interface AccessRequestPayload {
  protocolVersion: ProtocolVersion;
  childId: string;
  deviceId: string;
  domain: string;
  reason?: string;
}

export interface AccessDecisionPayload {
  protocolVersion: ProtocolVersion;
  requestId: string;
  action: 'APPROVE' | 'DENY';
  duration?: '15m' | '1h' | 'today' | 'always';
}

export interface TemporaryGrant {
  protocolVersion: ProtocolVersion;
  grantId: string;
  domain: string;
  grantedAt: string;
  expiresAt: string;
}

export interface NotificationItem {
  id: string;
  childId: string;
  childName: string;
  deviceId?: string;
  deviceName?: string;
  type: 'REQUEST_RECEIVED' | 'ENFORCEMENT_STOPPED' | 'POLICY_OUTDATED' | 'PROTECTION_RESTORED';
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
}

export interface TimelineEvent {
  id: string;
  childId: string;
  deviceId: string;
  deviceName: string;
  domain?: string;
  eventType: 'BLOCKED' | 'ALLOWED' | 'POLICY_APPLIED' | 'TEMP_GRANT' | 'GRANT_EXPIRED' | 'PROTECTION_RESTARTED' | 'NETWORK_SWITCH';
  decision?: 'BLOCK' | 'ALLOW';
  reason: string;
  policyVersion: number;
  timestamp: string;
}

export type WebSocketEventType =
  | 'POLICY_UPDATED'
  | 'ACCESS_REQUEST_CREATED'
  | 'ACCESS_REQUEST_RESOLVED'
  | 'DEVICE_HEALTH_CHANGED'
  | 'DEVICE_PAIRED'
  | 'DEVICE_REVOKED'
  | 'NOTIFICATION_CREATED'
  | 'TIMELINE_EVENT'
  | 'USAGE_UPDATED'
  | 'ACTIVITY_LOGGED';

export interface WebSocketEvent<T = any> {
  protocolVersion: ProtocolVersion;
  type: WebSocketEventType;
  payload: T;
  childId?: string;
  parentId?: string;
  deviceId?: string;
  timestamp: string;
}
