const API_BASE = '/api';

export interface Child {
  id: string;
  parentId: string;
  familyId: string;
  name: string;
  age?: number;
  avatar?: string;
}

export interface PolicyRule {
  id: string;
  domain: string;
  action: 'BLOCK' | 'ALLOW' | 'TEMPORARY_ALLOW';
  reason?: string;
  addedAt: string;
  expiresAt?: string | null;
}

export interface CategoryControl {
  category: string;
  action: 'BLOCK' | 'ALLOW' | 'RESTRICT';
}

export interface Policy {
  id: string;
  childId: string;
  familyId: string;
  version: number;
  isPaused: boolean;
  pauseExpiresAt?: string | null;
  studyMode?: { active: boolean; allowedCategories: string[] };
  bedtime?: { enabled: boolean; startHour: number; startMinute: number; endHour: number; endMinute: number; allowEducationalOnly: boolean };
  categoryControls?: CategoryControl[];
  rules: PolicyRule[];
  usageBudgets?: any[];
  safeSearch?: {
    googleSafeSearch: boolean;
    bingSafeSearch: boolean;
    duckDuckGoSafeSearch: boolean;
    youtubeRestrictedMode: 'OFF' | 'MODERATE' | 'STRICT';
  };
  updatedAt: string;
}

export interface Device {
  id: string;
  childId: string;
  parentId: string;
  familyId: string;
  name: string;
  platform: 'android' | 'windows' | 'ios' | 'macos';
  deviceToken: string;
  lastHeartbeatAt: string;
  activePolicyVersion: number;
  healthStatus: 'protected' | 'syncing' | 'inactive' | 'PROTECTED' | 'DEGRADED' | 'OFFLINE' | 'BYPASSED';
  agentVersion?: string;
}

export interface AccessRequest {
  id: string;
  childId: string;
  deviceId: string;
  familyId: string;
  deviceName?: string;
  domain: string;
  reason?: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED';
  requestedAt?: string;
  createdAt?: string;
  resolvedAt?: string | null;
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
  action: 'BLOCKED' | 'ALLOWED' | 'TEMPORARY_ACCESSED';
  timestamp: string;
  reason?: string;
}

export interface Stats {
  todayBlockedCount: number;
  pendingRequestsCount: number;
  totalEventsToday: number;
}

class ApiClient {
  private token: string | null = null;
  private refreshToken: string | null = null;
  private userEmail: string = '';

  constructor() {
    this.token = localStorage.getItem('sb_auth_token') || null;
    this.refreshToken = localStorage.getItem('sb_refresh_token') || null;
    this.userEmail = localStorage.getItem('sb_user_email') || '';
  }

  public setToken(token: string, refreshToken?: string, email?: string) {
    this.token = token;
    localStorage.setItem('sb_auth_token', token);
    if (refreshToken) {
      this.refreshToken = refreshToken;
      localStorage.setItem('sb_refresh_token', refreshToken);
    }
    if (email) {
      this.userEmail = email;
      localStorage.setItem('sb_user_email', email);
    }
  }

  public getToken() {
    return this.token;
  }

  public getRefreshToken() {
    return this.refreshToken;
  }

  public getUserEmail() {
    return this.userEmail;
  }

  public logout() {
    if (this.token) {
      fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: this.getHeaders(),
      }).catch(() => {});
    }
    this.token = null;
    this.refreshToken = null;
    localStorage.removeItem('sb_auth_token');
    localStorage.removeItem('sb_refresh_token');
    localStorage.removeItem('sb_user_email');
  }

  public getHeaders(): HeadersInit {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  async login(email: string, password: string) {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    if (data.token) {
      this.setToken(data.token, data.refreshToken, data.user?.email || email);
    }
    return data;
  }

  async mfaLogin(mfaTicket: string, code: string) {
    const res = await fetch(`${API_BASE}/auth/mfa-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mfaTicket, code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'MFA Login failed');
    if (data.token) {
      this.setToken(data.token, data.refreshToken, data.user?.email);
    }
    return data;
  }

  async refreshAuth() {
    if (!this.refreshToken) throw new Error('No refresh token available');
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: this.refreshToken }),
    });
    const data = await res.json();
    if (!res.ok) {
      this.logout();
      throw new Error(data.error || 'Failed to refresh session');
    }
    this.setToken(data.accessToken || data.token, data.refreshToken);
    return data;
  }

  async register(email: string, password: string, name: string) {
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    this.setToken(data.token, data.refreshToken, data.user?.email || email);
    return data;
  }

  async forgotPassword(email: string) {
    const res = await fetch(`${API_BASE}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    return res.json();
  }

  async resetPassword(token: string, newPassword: string) {
    const res = await fetch(`${API_BASE}/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Password reset failed');
    return data;
  }

  async verifyEmail(token: string) {
    const res = await fetch(`${API_BASE}/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Email verification failed');
    return data;
  }

  // --- Children & Policies ---
  async getChildren(): Promise<Child[]> {
    const res = await fetch(`${API_BASE}/children`, { headers: this.getHeaders() });
    if (!res.ok) throw new Error('Failed to load children');
    return res.json();
  }

  async createChild(name: string, age?: number, avatar?: string): Promise<{ child: Child; policy: Policy }> {
    const res = await fetch(`${API_BASE}/children`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ name, age, avatar }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create child');
    return data;
  }

  async getPolicy(childId: string): Promise<Policy> {
    const res = await fetch(`${API_BASE}/policies/child/${childId}`, { headers: this.getHeaders() });
    if (!res.ok) throw new Error('Failed to load policy');
    return res.json();
  }

  async addRule(childId: string, domain: string, action: 'BLOCK' | 'ALLOW', reason?: string): Promise<Policy> {
    const res = await fetch(`${API_BASE}/policies/child/${childId}/rules`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ domain, action, reason }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to add rule');
    return data;
  }

  async removeRule(childId: string, ruleId: string): Promise<Policy> {
    const res = await fetch(`${API_BASE}/policies/child/${childId}/rules/${ruleId}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to remove rule');
    return data;
  }

  async setPauseInternet(childId: string, isPaused: boolean, duration?: string): Promise<Policy> {
    const res = await fetch(`${API_BASE}/policies/child/${childId}/pause`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ isPaused, duration }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update internet pause');
    return data;
  }

  async updateCategories(childId: string, categoryControls: CategoryControl[]): Promise<Policy> {
    const res = await fetch(`${API_BASE}/policies/child/${childId}/categories`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ categoryControls }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update categories');
    return data;
  }

  async toggleStudyMode(childId: string, active: boolean): Promise<Policy> {
    const res = await fetch(`${API_BASE}/policies/child/${childId}/study-mode`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ active }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to toggle study mode');
    return data;
  }

  async toggleBedtime(childId: string, bedtime: any): Promise<Policy> {
    const res = await fetch(`${API_BASE}/policies/child/${childId}/bedtime`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ bedtime }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to toggle bedtime');
    return data;
  }

  // --- Devices & Health ---
  async getDevices(childId: string): Promise<Device[]> {
    const res = await fetch(`${API_BASE}/devices/child/${childId}`, { headers: this.getHeaders() });
    if (!res.ok) throw new Error('Failed to load devices');
    return res.json();
  }

  async getDeviceHealth(deviceId: string) {
    const res = await fetch(`${API_BASE}/devices/${deviceId}/health`, { headers: this.getHeaders() });
    if (!res.ok) throw new Error('Failed to fetch device health');
    return res.json();
  }

  async createPairingCode(childId: string): Promise<{ code: string; expiresAt: string }> {
    const res = await fetch(`${API_BASE}/devices/pairing-code`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ childId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create pairing code');
    return data;
  }

  async claimPairingCode(code: string, deviceName: string, platform: 'android' | 'windows') {
    const res = await fetch(`${API_BASE}/devices/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName, platform }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to claim pairing code');
    return data;
  }

  async removeDevice(deviceId: string) {
    const res = await fetch(`${API_BASE}/devices/${deviceId}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return res.json();
  }

  // --- Requests & Activity ---
  async getAllRequests(): Promise<AccessRequest[]> {
    const res = await fetch(`${API_BASE}/requests`, { headers: this.getHeaders() });
    if (!res.ok) return [];
    return res.json();
  }

  async getPendingRequests(): Promise<AccessRequest[]> {
    const res = await fetch(`${API_BASE}/requests/pending`, { headers: this.getHeaders() });
    if (!res.ok) return [];
    return res.json();
  }

  async resolveRequest(requestId: string, action: 'APPROVE' | 'DENY', duration?: string) {
    const res = await fetch(`${API_BASE}/requests/${requestId}/resolve`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ action, duration }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to resolve request');
    return data;
  }

  async getActivity(childId: string): Promise<ActivityEvent[]> {
    const res = await fetch(`${API_BASE}/activity/child/${childId}`, { headers: this.getHeaders() });
    if (!res.ok) return [];
    return res.json();
  }

  async getTimeline(childId: string) {
    const res = await fetch(`${API_BASE}/operations/timeline/${childId}`, { headers: this.getHeaders() });
    if (!res.ok) return [];
    return res.json();
  }

  async getStats(childId: string): Promise<Stats> {
    const res = await fetch(`${API_BASE}/activity/stats/${childId}`, { headers: this.getHeaders() });
    if (!res.ok) return { todayBlockedCount: 0, pendingRequestsCount: 0, totalEventsToday: 0 };
    return res.json();
  }

  // --- Profile & Security ---
  async getProfile() {
    const res = await fetch(`${API_BASE}/me`, { headers: this.getHeaders() });
    if (!res.ok) throw new Error('Failed to load profile');
    return res.json();
  }

  async updateProfile(data: any) {
    const res = await fetch(`${API_BASE}/me`, {
      method: 'PATCH',
      headers: this.getHeaders(),
      body: JSON.stringify(data),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to update profile');
    return result;
  }

  async changePassword(currentPassword: string, newPassword: string) {
    const res = await fetch(`${API_BASE}/me/change-password`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to change password');
    return result;
  }

  async setupMfa() {
    const res = await fetch(`${API_BASE}/me/mfa/setup`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    return res.json();
  }

  async verifyMfa(otpCode: string) {
    const res = await fetch(`${API_BASE}/me/mfa/verify`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ otpCode }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to verify MFA');
    return result;
  }

  async disableMfa(password: string) {
    const res = await fetch(`${API_BASE}/me/mfa/disable`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ password }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Failed to disable MFA');
    return result;
  }

  async getSessions() {
    const res = await fetch(`${API_BASE}/me/sessions`, { headers: this.getHeaders() });
    return res.json();
  }

  async revokeSession(sessionId: string) {
    const res = await fetch(`${API_BASE}/me/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return res.json();
  }

  async revokeOtherSessions() {
    const res = await fetch(`${API_BASE}/me/sessions/revoke-others`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    return res.json();
  }

  // --- Family & Referrals ---
  async getFamily() {
    const res = await fetch(`${API_BASE}/family`, { headers: this.getHeaders() });
    return res.json();
  }

  async getFamilyAudit() {
    const res = await fetch(`${API_BASE}/family/audit`, { headers: this.getHeaders() });
    return res.json();
  }

  async updateFamily(payload: { familyId: string; name?: string; requireMfa?: boolean; approvalRule?: string }) {
    const res = await fetch(`${API_BASE}/family`, {
      method: 'PATCH',
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update family settings');
    return data;
  }

  async inviteParent(familyId: string, email: string, role: string) {
    const res = await fetch(`${API_BASE}/family/invitations`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ familyId, email, role }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to send invite');
    return data;
  }

  async revokeInvitation(id: string) {
    const res = await fetch(`${API_BASE}/family/invitations/${id}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return res.json();
  }

  async changeFamilyMemberRole(memberId: string, familyId: string, role: 'PARENT' | 'VIEWER') {
    const res = await fetch(`${API_BASE}/family/members/${memberId}/role`, {
      method: 'PATCH',
      headers: this.getHeaders(),
      body: JSON.stringify({ familyId, role }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to change member role');
    return data;
  }

  async removeFamilyMember(memberId: string, familyId: string) {
    const res = await fetch(`${API_BASE}/family/members/${memberId}?familyId=${familyId}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return res.json();
  }

  async transferOwnership(familyId: string, newOwnerUserId: string, password?: string, otpCode?: string) {
    const res = await fetch(`${API_BASE}/family/transfer-ownership`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ familyId, newOwnerUserId, password, otpCode }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Transfer failed');
    return data;
  }

  async getReferrals() {
    const res = await fetch(`${API_BASE}/referrals`, { headers: this.getHeaders() });
    return res.json();
  }

  // --- Canonical Admin Endpoints ---
  async getAdminMetrics() {
    const res = await fetch(`${API_BASE}/admin/metrics`, { headers: this.getHeaders() });
    if (!res.ok) throw new Error('Forbidden. System administrator privilege required.');
    return res.json();
  }

  async getAdminFleet() {
    const res = await fetch(`${API_BASE}/admin/fleet`, { headers: this.getHeaders() });
    if (!res.ok) throw new Error('Forbidden. System administrator privilege required.');
    return res.json();
  }

  async getAdminAudit() {
    const res = await fetch(`${API_BASE}/admin/audit`, { headers: this.getHeaders() });
    if (!res.ok) throw new Error('Forbidden. System administrator privilege required.');
    return res.json();
  }

  async getAdminSupport() {
    const res = await fetch(`${API_BASE}/admin/support`, { headers: this.getHeaders() });
    if (!res.ok) throw new Error('Forbidden. System administrator privilege required.');
    return res.json();
  }

  async dispatchAdminRollback(targetVersion: string, reason?: string) {
    const res = await fetch(`${API_BASE}/admin/rollback`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ targetVersion, reason }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Rollback failed');
    return data;
  }

  async bootstrapDevAdmin(bootstrapSecret?: string) {
    const headers: Record<string, string> = { ...(this.getHeaders() as Record<string, string>) };
    if (bootstrapSecret) {
      headers['x-admin-bootstrap-secret'] = bootstrapSecret;
    }
    const res = await fetch(`${API_BASE}/admin/bootstrap-dev`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ bootstrapSecret }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Bootstrap failed');
    return data;
  }

  async getOperationsFleet() {
    const res = await fetch(`${API_BASE}/admin/fleet`, { headers: this.getHeaders() });
    return res.json();
  }

  async dispatchRollback(targetVersion: string, reason?: string) {
    const res = await fetch(`${API_BASE}/admin/rollback`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ targetVersion, reason }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Rollback failed');
    return data;
  }

  async getHealth() {
    const res = await fetch(`${API_BASE}/health`);
    return res.json();
  }

  async submitFeedback(data: any) {
    const res = await fetch(`${API_BASE}/feedback`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(data),
    });
    return res.json();
  }

  // --- Screen Time & Usage Budgets ---
  async getUsageBudgets(childId: string) {
    const res = await fetch(`${API_BASE}/usage/child/${childId}`, { headers: this.getHeaders() });
    if (!res.ok) throw new Error('Failed to load screen time budgets');
    return res.json();
  }

  async setUsageBudget(childId: string, target: string, targetType: string, dailyLimitMinutes: number) {
    const res = await fetch(`${API_BASE}/usage/child/${childId}/budget`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ target, targetType, dailyLimitMinutes }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save usage budget');
    return data;
  }

  async addBonusTime(childId: string, budgetId: string, bonusMinutes: number) {
    const res = await fetch(`${API_BASE}/usage/child/${childId}/budget/${budgetId}/bonus`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ bonusMinutes }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to grant bonus time');
    return data;
  }

  async setUnlimitedToday(childId: string, budgetId: string) {
    const res = await fetch(`${API_BASE}/usage/child/${childId}/budget/${budgetId}/unlimited`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to set unlimited today');
    return data;
  }

  async removeUsageBudget(childId: string, budgetId: string) {
    const res = await fetch(`${API_BASE}/usage/child/${childId}/budget/${budgetId}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete budget');
    return data;
  }

  async updateSafeSearch(childId: string, config: any) {
    const res = await fetch(`${API_BASE}/usage/child/${childId}/safesearch`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(config),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update SafeSearch');
    return data;
  }

  async getWeeklyDigest() {
    const res = await fetch(`${API_BASE}/usage/digest`, { headers: this.getHeaders() });
    if (!res.ok) throw new Error('Failed to load weekly digest');
    return res.json();
  }
}

export const api = new ApiClient();
