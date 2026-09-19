import { Policy, HeartbeatPayload, HeartbeatResponse } from '@safebrowse/shared';
import * as fs from 'fs';
import * as path from 'path';
import WebSocket from 'ws';

import { configManager } from './config-manager';

export type PolicyStatus = 'POLICY_LIVE' | 'POLICY_CACHED' | 'POLICY_UNAVAILABLE';

export interface DeviceConfig {
  deviceId: string;
  deviceToken: string;
  childId: string;
  parentId: string;
  deviceName: string;
  backendUrl: string;
}

export class PolicySyncClient {
  private config: DeviceConfig;
  private currentPolicy: Policy | null = null;
  private policyStatus: PolicyStatus = 'POLICY_UNAVAILABLE';
  private cacheFilePath: string;
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private wsReconnectTimer: NodeJS.Timeout | null = null;
  private enforcementActiveProvider?: () => boolean;
  private onPolicyStatusChangeCallback?: (newStatus: PolicyStatus, previousStatus: PolicyStatus) => void;

  constructor(config: DeviceConfig, cacheDir?: string, enforcementActiveProvider?: () => boolean) {
    this.config = config;
    this.enforcementActiveProvider = enforcementActiveProvider;
    const dir = cacheDir || configManager.getCacheDir();
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {}
    }
    this.cacheFilePath = path.join(dir, `policy-${config.deviceId}.json`);
    this.loadCachedPolicy();
  }

  public setEnforcementActiveProvider(provider: () => boolean): void {
    this.enforcementActiveProvider = provider;
  }

  public setOnPolicyStatusChange(cb: (newStatus: PolicyStatus, previousStatus: PolicyStatus) => void): void {
    this.onPolicyStatusChangeCallback = cb;
  }

  private setPolicyStatus(newStatus: PolicyStatus): void {
    const prev = this.policyStatus;
    this.policyStatus = newStatus;
    if (prev !== newStatus && this.onPolicyStatusChangeCallback) {
      try {
        this.onPolicyStatusChangeCallback(newStatus, prev);
      } catch (e: any) {
        console.warn('[PolicySyncClient] Error in onPolicyStatusChange callback:', e.message);
      }
    }
  }

  public getActivePolicy(): Policy | null {
    return this.currentPolicy;
  }

  public getPolicyStatus(): PolicyStatus {
    return this.policyStatus;
  }

  private loadCachedPolicy() {
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        const raw = fs.readFileSync(this.cacheFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && typeof parsed.version === 'number') {
          this.currentPolicy = parsed;
          this.setPolicyStatus('POLICY_CACHED');
          console.log(`[Agent] Loaded cached local policy v${this.currentPolicy?.version} (${this.policyStatus})`);
          return;
        }
      }
    } catch (e: any) {
      console.warn('[Agent] Could not load cached policy:', e.message);
    }
    this.setPolicyStatus('POLICY_UNAVAILABLE');
  }

  private saveCachedPolicy(policy: Policy) {
    this.currentPolicy = policy;
    this.setPolicyStatus('POLICY_LIVE');
    try {
      fs.writeFileSync(this.cacheFilePath, JSON.stringify(policy, null, 2), 'utf-8');
      console.log(`[Agent] Synchronized & cached active policy v${policy.version} (${this.policyStatus})`);
    } catch (e: any) {
      console.warn('[Agent] Failed to write local policy cache:', e.message);
    }
  }

  public async fetchLatestPolicy(timeoutMs: number = 5000): Promise<Policy | null> {
    if (!this.config?.deviceId || !this.config?.deviceToken || !this.config.deviceId.trim() || !this.config.deviceToken.trim()) {
      console.warn('[Agent] Cannot fetch policy: deviceId or deviceToken is missing or blank.');
      return this.currentPolicy;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.config.backendUrl}/api/policies/device/${encodeURIComponent(this.config.deviceId)}`, {
        method: 'GET',
        headers: {
          'x-device-id': this.config.deviceId,
          'x-device-token': this.config.deviceToken,
        },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data: any = await res.json();
      const policy: Policy = data?.policy || data;

      if (policy && typeof policy === 'object' && typeof policy.version === 'number') {
        this.saveCachedPolicy(policy);
        return policy;
      } else {
        console.warn('[Agent] Received invalid policy payload from cloud. Retaining local cache.');
        if (this.currentPolicy) {
          this.setPolicyStatus('POLICY_CACHED');
        } else {
          this.setPolicyStatus('POLICY_UNAVAILABLE');
        }
        return this.currentPolicy;
      }
    } catch (e: any) {
      if (this.currentPolicy) {
        this.setPolicyStatus('POLICY_CACHED');
        console.warn(`[Agent] Failed to fetch latest policy from cloud (${e.message}). Running on local cache v${this.currentPolicy.version} (POLICY_CACHED).`);
      } else {
        this.setPolicyStatus('POLICY_UNAVAILABLE');
        console.warn(`[Agent] Failed to fetch latest policy from cloud (${e.message}) and no local cache exists (POLICY_UNAVAILABLE).`);
      }
      return this.currentPolicy;
    }
  }

  public async sendHeartbeat(enforcementActive?: boolean): Promise<HeartbeatResponse | null> {
    try {
      let isEnforcing = enforcementActive;
      if (isEnforcing === undefined) {
        isEnforcing = this.enforcementActiveProvider ? this.enforcementActiveProvider() : Boolean(this.currentPolicy);
      }

      // Invariant: If no usable policy exists, enforcementActive MUST NOT be true
      if (!this.currentPolicy) {
        isEnforcing = false;
      }

      const payload: HeartbeatPayload = {
        deviceId: this.config.deviceId,
        deviceToken: this.config.deviceToken,
        activePolicyVersion: this.currentPolicy?.version || 1,
        enforcementActive: isEnforcing,
        platform: 'windows',
        agentVersion: '1.0.0',
      };

      const res = await fetch(`${this.config.backendUrl}/api/devices/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as HeartbeatResponse;

      if (data.policyChanged) {
        console.log('[Agent] Server indicates newer policy version available. Fetching...');
        await this.fetchLatestPolicy();
      } else {
        if (this.currentPolicy) {
          this.setPolicyStatus('POLICY_LIVE');
        }
      }

      return data;
    } catch (e) {
      // Offline heartbeat failure: preserve cached policy safely
      if (this.currentPolicy) {
        this.setPolicyStatus('POLICY_CACHED');
      }
      return null;
    }
  }

  public connectWebSocket() {
    const wsUrl = `${this.config.backendUrl.replace(/^http/, 'ws')}/ws?deviceId=${encodeURIComponent(this.config.deviceId)}&deviceToken=${encodeURIComponent(this.config.deviceToken)}`;
    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('[Agent] Real-time policy sync connected via authenticated WebSocket.');
        if (this.currentPolicy) {
          this.setPolicyStatus('POLICY_LIVE');
        }
        this.ws?.send(
          JSON.stringify({
            type: 'AUTH_DEVICE',
            deviceId: this.config.deviceId,
            deviceToken: this.config.deviceToken,
          })
        );
      });

      this.ws.on('message', (data: string) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'POLICY_UPDATED' && msg.childId === this.config.childId) {
            console.log(`[Agent] Received instant push for policy v${msg.payload.version}`);
            this.saveCachedPolicy(msg.payload);
          } else if (msg.type === 'ACCESS_REQUEST_RESOLVED' && msg.childId === this.config.childId) {
            if (msg.payload.policy) {
              console.log(`[Agent] Access request approved! Applied policy v${msg.payload.policy.version}`);
              this.saveCachedPolicy(msg.payload.policy);
            }
          }
        } catch (e) {}
      });

      this.ws.on('close', () => {
        if (this.currentPolicy) {
          this.setPolicyStatus('POLICY_CACHED');
        }
        if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = setTimeout(() => this.connectWebSocket(), 5000);
      });

      this.ws.on('error', () => {
        if (this.currentPolicy) {
          this.setPolicyStatus('POLICY_CACHED');
        }
      });
    } catch (e) {
      if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = setTimeout(() => this.connectWebSocket(), 5000);
    }
  }

  public async start(timeoutMs: number = 5000): Promise<PolicyStatus> {
    try {
      await this.fetchLatestPolicy(timeoutMs);
    } catch (e) {}
    this.connectWebSocket();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 30000);
    return this.policyStatus;
  }

  public stop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.ws) {
      const wsInstance = this.ws;
      this.ws = null;
      wsInstance.removeAllListeners();
      wsInstance.on('error', () => {});
      try {
        wsInstance.terminate();
      } catch (e) {}
    }
  }
}
