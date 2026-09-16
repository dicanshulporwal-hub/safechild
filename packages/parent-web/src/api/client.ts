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
  private userRole: string = '';

  // Green Code: In-flight deduplication & TTL Cache
  private requestCache = new Map<string, { data: any; expiresAt: number }>();
  private inFlightRequests = new Map<string, Promise<any>>();

  constructor() {
    this.token = localStorage.getItem('sb_auth_token') || null;
    this.refreshToken = localStorage.getItem('sb_refresh_token') || null;
    this.userEmail = localStorage.getItem('sb_user_email') || '';
    this.userRole = localStorage.getItem('sb_user_role') || '';
  }

  public invalidateCache(prefix?: string) {
    if (!prefix) {
      this.requestCache.clear();
      return;
    }
    for (const key of this.requestCache.keys()) {
      if (key.startsWith(prefix)) {
        this.requestCache.delete(key);
      }
    }
  }

  public async cachedGet<T = any>(url: string, ttlMs: number = 6000, forceRefresh: boolean = false): Promise<T> {
    const cacheKey = `${url}:${this.token || 'anon'}`;
    const now = Date.now();

    if (!forceRefresh) {
      const cached = this.requestCache.get(cacheKey);
      if (cached && cached.expiresAt > now) {
        return cached.data as T;
      }
    }

    if (this.inFlightRequests.has(cacheKey)) {
      return this.inFlightRequests.get(cacheKey) as Promise<T>;
    }

    const requestPromise = (async () => {
      try {
        const res = await fetch(url, { headers: this.getHeaders() });
        const data = await this.parseResponse(res);
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        this.requestCache.set(cacheKey, { data, expiresAt: Date.now() + ttlMs });
        return data as T;
      } finally {
        this.inFlightRequests.delete(cacheKey);
      }
    })();

    this.inFlightRequests.set(cacheKey, requestPromise);
    return requestPromise;
  }

  public setToken(token: string, refreshToken?: string, email?: string, role?: string) {
    this.token = token;
    this.invalidateCache();
    localStorage.setItem('sb_auth_token', token);
    if (refreshToken) {
      this.refreshToken = refreshToken;
      localStorage.setItem('sb_refresh_token', refreshToken);
    }
    if (email) {
      this.userEmail = email;
      localStorage.setItem('sb_user_email', email);
    }
    if (role) {
      this.userRole = role;
      localStorage.setItem('sb_user_role', role);
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

  public getUserRole() {
    return this.userRole;
  }

  public logout() {
    this.invalidateCache();
    if (this.token) {
      fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: this.getHeaders(),
      }).catch(() => {});
    }
    this.token = null;
    this.refreshToken = null;
    this.userRole = '';
    localStorage.removeItem('sb_auth_token');
    localStorage.removeItem('sb_refresh_token');
    localStorage.removeItem('sb_user_email');
    localStorage.removeItem('sb_user_role');
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

  private async parseResponse(res: Response): Promise<any> {
    const text = await res.text();
    if (!text || text.trim().length === 0) {
      if (!res.ok) throw new Error(`Server returned status ${res.status} (${res.statusText || 'Error'})`);
      return {};
    }
    try {
      return JSON.parse(text);
    } catch {
      if (!res.ok) throw new Error(`Server returned status ${res.status}: ${text.slice(0, 100)}`);
      return { message: text };
    }
  }

  async login(email: string, password: string) {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Login failed');
    if (data.token) {
      this.setToken(data.token, data.refreshToken, data.user?.email || email, data.user?.systemRole || 'USER');
    }
    return data;
  }

  async mfaLogin(mfaTicket: string, code: string) {
    const res = await fetch(`${API_BASE}/auth/mfa-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mfaTicket, code }),
    });
    const data = await this.parseResponse(res);
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
    const data = await this.parseResponse(res);
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
    const data = await this.parseResponse(res);
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
    return this.parseResponse(res);
  }

  async resetPassword(token: string, newPassword: string) {
    const res = await fetch(`${API_BASE}/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Password reset failed');
    return data;
  }

  async verifyEmail(token: string) {
    const res = await fetch(`${API_BASE}/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Email verification failed');
    return data;
  }

  // --- Children & Policies ---
  async getChildren(forceRefresh: boolean = false): Promise<Child[]> {
    return this.cachedGet<Child[]>(`${API_BASE}/children`, 8000, forceRefresh);
  }

  async createChild(name: string, age?: number, avatar?: string): Promise<{ child: Child; policy: Policy }> {
    this.invalidateCache(`${API_BASE}/children`);
    const res = await fetch(`${API_BASE}/children`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ name, age, avatar }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to create child');
    return data;
  }

  async getPolicy(childId: string, forceRefresh: boolean = false): Promise<Policy> {
    return this.cachedGet<Policy>(`${API_BASE}/policies/child/${childId}`, 8000, forceRefresh);
  }

  async addRule(childId: string, domain: string, action: 'BLOCK' | 'ALLOW', reason?: string): Promise<Policy> {
    this.invalidateCache(`${API_BASE}/policies/child/${childId}`);
    const res = await fetch(`${API_BASE}/policies/child/${childId}/rules`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ domain, action, reason }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to add rule');
    return data;
  }

  async removeRule(childId: string, ruleId: string): Promise<Policy> {
    this.invalidateCache(`${API_BASE}/policies/child/${childId}`);
    const res = await fetch(`${API_BASE}/policies/child/${childId}/rules/${ruleId}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to remove rule');
    return data;
  }

  async setPauseInternet(childId: string, isPaused: boolean, duration?: string): Promise<Policy> {
    this.invalidateCache(`${API_BASE}/policies/child/${childId}`);
    const res = await fetch(`${API_BASE}/policies/child/${childId}/pause`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ isPaused, duration }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to update internet pause');
    return data;
  }

  async updateCategories(childId: string, categoryControls: CategoryControl[]): Promise<Policy> {
    this.invalidateCache(`${API_BASE}/policies/child/${childId}`);
    const res = await fetch(`${API_BASE}/policies/child/${childId}/categories`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ categoryControls }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to update categories');
    return data;
  }

  async toggleStudyMode(childId: string, active: boolean): Promise<Policy> {
    this.invalidateCache(`${API_BASE}/policies/child/${childId}`);
    const res = await fetch(`${API_BASE}/policies/child/${childId}/study-mode`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ active }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to toggle study mode');
    return data;
  }

  async toggleBedtime(childId: string, bedtime: any): Promise<Policy> {
    this.invalidateCache(`${API_BASE}/policies/child/${childId}`);
    const res = await fetch(`${API_BASE}/policies/child/${childId}/bedtime`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ bedtime }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to toggle bedtime');
    return data;
  }

  async updateSafeSearch(childId: string, safeSearch: any): Promise<Policy> {
    this.invalidateCache(`${API_BASE}/policies/child/${childId}`);
    const res = await fetch(`${API_BASE}/policies/child/${childId}/safesearch`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ safeSearch }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to update SafeSearch');
    return data;
  }

  async pauseFamilyAll(isPaused: boolean = true): Promise<{ message: string; children: Child[] }> {
    this.invalidateCache();
    const res = await fetch(`${API_BASE}/policies/family/pause-all`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ isPaused }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to update family pause');
    return data;
  }

  // --- Devices & Health ---
  async getDevices(childId: string, forceRefresh: boolean = false): Promise<Device[]> {
    return this.cachedGet<Device[]>(`${API_BASE}/devices/child/${childId}`, 8000, forceRefresh);
  }

  async getDeviceHealth(deviceId: string) {
    return this.cachedGet(`${API_BASE}/devices/${deviceId}/health`, 6000);
  }

  async createPairingCode(childId: string): Promise<{ code: string; expiresAt: string }> {
    const res = await fetch(`${API_BASE}/devices/pairing-code`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ childId }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to create pairing code');
    return data;
  }

  async claimPairingCode(code: string, deviceName: string, platform: 'android' | 'windows') {
    this.invalidateCache();
    const res = await fetch(`${API_BASE}/devices/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName, platform }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to claim pairing code');
    return data;
  }

  async removeDevice(deviceId: string) {
    this.invalidateCache();
    const res = await fetch(`${API_BASE}/devices/${deviceId}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return this.parseResponse(res);
  }

  // --- Notifications ---
  async getNotifications(forceRefresh: boolean = false): Promise<any[]> {
    return this.cachedGet<any[]>(`${API_BASE}/notifications`, 4000, forceRefresh);
  }

  async markNotificationRead(id: string) {
    this.invalidateCache(`${API_BASE}/notifications`);
    const res = await fetch(`${API_BASE}/notifications/${id}/read`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    return this.parseResponse(res);
  }

  async markAllNotificationsRead(ids?: string[]) {
    this.invalidateCache(`${API_BASE}/notifications`);
    const res = await fetch(`${API_BASE}/notifications/read-all`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ ids }),
    });
    return this.parseResponse(res);
  }

  async triggerTestAlert(type: 'REQUEST' | 'SECURITY' = 'REQUEST', domain: string = 'discord.com', reason: string = 'Homework research') {
    this.invalidateCache(`${API_BASE}/notifications`);
    const res = await fetch(`${API_BASE}/notifications/test-alert`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ type, domain, reason }),
    });
    return this.parseResponse(res);
  }

  // --- Requests & Activity ---
  async getAllRequests(): Promise<AccessRequest[]> {
    return this.cachedGet<AccessRequest[]>(`${API_BASE}/requests`, 5000);
  }

  async getPendingRequests(): Promise<AccessRequest[]> {
    return this.cachedGet<AccessRequest[]>(`${API_BASE}/requests/pending`, 4000);
  }

  async resolveRequest(requestId: string, action: 'APPROVE' | 'DENY', duration?: string) {
    this.invalidateCache(`${API_BASE}/requests`);
    this.invalidateCache(`${API_BASE}/notifications`);
    const res = await fetch(`${API_BASE}/requests/${requestId}/resolve`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ action, duration }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to resolve request');
    return data;
  }

  async getActivity(childId: string): Promise<ActivityEvent[]> {
    return this.cachedGet<ActivityEvent[]>(`${API_BASE}/activity/child/${childId}`, 5000);
  }

  async getTimeline(childId: string) {
    return this.cachedGet(`${API_BASE}/operations/timeline/${childId}`, 5000);
  }

  async getStats(childId: string): Promise<Stats> {
    return this.cachedGet<Stats>(`${API_BASE}/activity/stats/${childId}`, 5000);
  }

  // --- Profile & Security ---
  async getProfile(forceRefresh: boolean = false) {
    return this.cachedGet(`${API_BASE}/me`, 15000, forceRefresh);
  }

  async updateProfile(data: any) {
    this.invalidateCache(`${API_BASE}/me`);
    const res = await fetch(`${API_BASE}/me`, {
      method: 'PATCH',
      headers: this.getHeaders(),
      body: JSON.stringify(data),
    });
    const result = await this.parseResponse(res);
    if (!res.ok) throw new Error(result.error || 'Failed to update profile');
    return result;
  }

  async changePassword(currentPassword: string, newPassword: string) {
    this.invalidateCache();
    const res = await fetch(`${API_BASE}/me/change-password`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const result = await this.parseResponse(res);
    if (!res.ok) throw new Error(result.error || 'Failed to change password');
    return result;
  }

  async setupMfa() {
    const res = await fetch(`${API_BASE}/me/mfa/setup`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    return this.parseResponse(res);
  }

  async verifyMfa(otpCode: string) {
    this.invalidateCache(`${API_BASE}/me`);
    const res = await fetch(`${API_BASE}/me/mfa/verify`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ otpCode }),
    });
    const result = await this.parseResponse(res);
    if (!res.ok) throw new Error(result.error || 'Failed to verify MFA');
    return result;
  }

  async disableMfa(password: string) {
    this.invalidateCache(`${API_BASE}/me`);
    const res = await fetch(`${API_BASE}/me/mfa/disable`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ password }),
    });
    const result = await this.parseResponse(res);
    if (!res.ok) throw new Error(result.error || 'Failed to disable MFA');
    return result;
  }

  async getSessions() {
    return this.cachedGet(`${API_BASE}/me/sessions`, 6000);
  }

  async revokeSession(sessionId: string) {
    this.invalidateCache(`${API_BASE}/me/sessions`);
    const res = await fetch(`${API_BASE}/me/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return this.parseResponse(res);
  }

  async revokeOtherSessions() {
    this.invalidateCache(`${API_BASE}/me/sessions`);
    const res = await fetch(`${API_BASE}/me/sessions/revoke-others`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    return this.parseResponse(res);
  }

  // --- Family & Referrals ---
  async getFamily(forceRefresh: boolean = false) {
    return this.cachedGet(`${API_BASE}/family`, 10000, forceRefresh);
  }

  async getFamilyAudit() {
    return this.cachedGet(`${API_BASE}/family/audit`, 8000);
  }

  async updateFamily(payload: { familyId: string; name?: string; requireMfa?: boolean; approvalRule?: string }) {
    this.invalidateCache(`${API_BASE}/family`);
    const res = await fetch(`${API_BASE}/family`, {
      method: 'PATCH',
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to update family settings');
    return data;
  }

  async inviteParent(familyId: string, email: string, role: string) {
    this.invalidateCache(`${API_BASE}/family`);
    const res = await fetch(`${API_BASE}/family/invitations`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ familyId, email, role }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to send invite');
    return data;
  }

  async revokeInvitation(id: string) {
    this.invalidateCache(`${API_BASE}/family`);
    const res = await fetch(`${API_BASE}/family/invitations/${id}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return this.parseResponse(res);
  }

  async changeFamilyMemberRole(memberId: string, familyId: string, role: 'PARENT' | 'VIEWER') {
    this.invalidateCache(`${API_BASE}/family`);
    const res = await fetch(`${API_BASE}/family/members/${memberId}/role`, {
      method: 'PATCH',
      headers: this.getHeaders(),
      body: JSON.stringify({ familyId, role }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to change member role');
    return data;
  }

  async removeFamilyMember(memberId: string, familyId: string) {
    this.invalidateCache(`${API_BASE}/family`);
    const res = await fetch(`${API_BASE}/family/members/${memberId}?familyId=${familyId}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return this.parseResponse(res);
  }

  async transferOwnership(familyId: string, newOwnerUserId: string, password?: string, otpCode?: string) {
    this.invalidateCache();
    const res = await fetch(`${API_BASE}/family/transfer-ownership`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ familyId, newOwnerUserId, password, otpCode }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Transfer failed');
    return data;
  }

  async getReferrals() {
    return this.cachedGet(`${API_BASE}/referrals`, 15000);
  }

  // --- Canonical Admin Endpoints (Green Caching Enabled) ---
  async getAdminMetrics(forceRefresh: boolean = false) {
    return this.cachedGet(`${API_BASE}/admin/metrics`, 8000, forceRefresh);
  }

  async getAdminFleet(forceRefresh: boolean = false) {
    return this.cachedGet(`${API_BASE}/admin/fleet`, 8000, forceRefresh);
  }

  async getAdminAudit(forceRefresh: boolean = false) {
    return this.cachedGet(`${API_BASE}/admin/audit`, 6000, forceRefresh);
  }

  async getAdminSupport(forceRefresh: boolean = false) {
    return this.cachedGet(`${API_BASE}/admin/support`, 6000, forceRefresh);
  }

  async getAdminParents(forceRefresh: boolean = false) {
    return this.cachedGet(`${API_BASE}/admin/parents`, 8000, forceRefresh);
  }

  async getAdminParentDetails(id: string, forceRefresh: boolean = false) {
    return this.cachedGet(`${API_BASE}/admin/parents/${id}`, 8000, forceRefresh);
  }

  async adminVerifyParentEmail(id: string) {
    this.invalidateCache(`${API_BASE}/admin/parents`);
    const res = await fetch(`${API_BASE}/admin/parents/${id}/verify-email`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to verify email');
    return data;
  }

  async adminResetParentPassword(id: string, newPassword: string) {
    this.invalidateCache(`${API_BASE}/admin/parents`);
    const res = await fetch(`${API_BASE}/admin/parents/${id}/reset-password`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ newPassword }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to reset password');
    return data;
  }

  async adminDisableParentMfa(id: string) {
    this.invalidateCache(`${API_BASE}/admin/parents`);
    const res = await fetch(`${API_BASE}/admin/parents/${id}/disable-mfa`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to disable MFA');
    return data;
  }

  async adminChangeUserRole(id: string, systemRole: 'USER' | 'SYSTEM_ADMIN') {
    this.invalidateCache();
    const res = await fetch(`${API_BASE}/admin/parents/${id}/role`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ systemRole }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to update role');
    return data;
  }

  async adminDisableUser(id: string, reason: string) {
    this.invalidateCache(`${API_BASE}/admin/parents`);
    const res = await fetch(`${API_BASE}/admin/parents/${id}/disable`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ reason }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to disable user');
    return data;
  }

  async adminEnableUser(id: string) {
    this.invalidateCache(`${API_BASE}/admin/parents`);
    const res = await fetch(`${API_BASE}/admin/parents/${id}/enable`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to enable user');
    return data;
  }

  async dispatchAdminRollback(targetVersion: string, reason?: string) {
    this.invalidateCache();
    const res = await fetch(`${API_BASE}/admin/rollback`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ targetVersion, reason }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Rollback failed');
    return data;
  }

  async bootstrapDevAdmin(bootstrapSecret?: string) {
    this.invalidateCache();
    const headers: Record<string, string> = { ...(this.getHeaders() as Record<string, string>) };
    if (bootstrapSecret) {
      headers['x-admin-bootstrap-secret'] = bootstrapSecret;
    }
    const res = await fetch(`${API_BASE}/admin/bootstrap-dev`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ bootstrapSecret }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Bootstrap failed');
    return data;
  }

  async getOperationsFleet(forceRefresh: boolean = false) {
    return this.cachedGet(`${API_BASE}/admin/fleet`, 8000, forceRefresh);
  }

  async dispatchRollback(targetVersion: string, reason?: string) {
    this.invalidateCache();
    const res = await fetch(`${API_BASE}/admin/rollback`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ targetVersion, reason }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Rollback failed');
    return data;
  }

  async getHealth() {
    return this.cachedGet(`${API_BASE}/health`, 10000);
  }

  async submitFeedback(data: any) {
    const res = await fetch(`${API_BASE}/feedback`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(data),
    });
    return this.parseResponse(res);
  }

  // --- Screen Time & Usage Budgets ---
  async getUsageBudgets(childId: string, forceRefresh: boolean = false) {
    return this.cachedGet(`${API_BASE}/usage/child/${childId}`, 8000, forceRefresh);
  }

  async setUsageBudget(childId: string, target: string, targetType: string, dailyLimitMinutes: number) {
    this.invalidateCache(`${API_BASE}/usage/child/${childId}`);
    const res = await fetch(`${API_BASE}/usage/child/${childId}/budget`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ target, targetType, dailyLimitMinutes }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to save usage budget');
    return data;
  }

  async addBonusTime(childId: string, budgetId: string, bonusMinutes: number) {
    this.invalidateCache(`${API_BASE}/usage/child/${childId}`);
    const res = await fetch(`${API_BASE}/usage/child/${childId}/budget/${budgetId}/bonus`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ bonusMinutes }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to grant bonus time');
    return data;
  }

  async setUnlimitedToday(childId: string, budgetId: string) {
    this.invalidateCache(`${API_BASE}/usage/child/${childId}`);
    const res = await fetch(`${API_BASE}/usage/child/${childId}/budget/${budgetId}/unlimited`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to set unlimited today');
    return data;
  }

  async removeUsageBudget(childId: string, budgetId: string) {
    this.invalidateCache(`${API_BASE}/usage/child/${childId}`);
    const res = await fetch(`${API_BASE}/usage/child/${childId}/budget/${budgetId}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to delete budget');
    return data;
  }

  async getWeeklyDigest() {
    return this.cachedGet(`${API_BASE}/usage/digest`, 15000);
  }

  async regenerateRecoveryCodes(): Promise<{ success: boolean; recoveryCodes: string[] }> {
    const res = await fetch(`${API_BASE}/profile/mfa/recovery-codes/regenerate`, {
      method: 'POST',
      headers: this.getHeaders(),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to regenerate recovery codes');
    return data;
  }

  async getVapidPublicKey(): Promise<{ publicKey: string }> {
    const res = await fetch(`${API_BASE}/notifications/vapid-public-key`, {
      headers: this.getHeaders(),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to fetch VAPID public key');
    return data;
  }

  async subscribePush(subscription: any) {
    const res = await fetch(`${API_BASE}/notifications/push-subscribe`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ subscription }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to register push subscription');
    return data;
  }

  async unsubscribePush(endpoint: string) {
    const res = await fetch(`${API_BASE}/notifications/push-unsubscribe`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ endpoint }),
    });
    const data = await this.parseResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to remove push subscription');
    return data;
  }
}

export const api = new ApiClient();
