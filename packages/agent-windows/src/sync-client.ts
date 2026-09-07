import { Policy, HeartbeatPayload, HeartbeatResponse } from '@safebrowse/shared';
import * as fs from 'fs';
import * as path from 'path';
import WebSocket from 'ws';

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
  private cacheFilePath: string;
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(config: DeviceConfig, cacheDir?: string) {
    this.config = config;
    const dir = cacheDir || path.join(process.cwd(), 'cache');
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {}
    }
    this.cacheFilePath = path.join(dir, `policy-${config.deviceId}.json`);
    this.loadCachedPolicy();
  }

  public getActivePolicy(): Policy | null {
    return this.currentPolicy;
  }

  private loadCachedPolicy() {
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        const raw = fs.readFileSync(this.cacheFilePath, 'utf-8');
        this.currentPolicy = JSON.parse(raw);
        console.log(`[Agent] Loaded cached local policy v${this.currentPolicy?.version}`);
      }
    } catch (e) {
      console.warn('[Agent] Could not load cached policy:', e);
    }
  }

  private saveCachedPolicy(policy: Policy) {
    this.currentPolicy = policy;
    try {
      fs.writeFileSync(this.cacheFilePath, JSON.stringify(policy, null, 2), 'utf-8');
      console.log(`[Agent] Synchronized & cached active policy v${policy.version}`);
    } catch (e) {
      console.warn('[Agent] Failed to write local policy cache:', e);
    }
  }

  public async fetchLatestPolicy(): Promise<Policy | null> {
    if (!this.config?.deviceId || !this.config?.deviceToken || !this.config.deviceId.trim() || !this.config.deviceToken.trim()) {
      console.warn('[Agent] Cannot fetch policy: deviceId or deviceToken is missing or blank.');
      return this.currentPolicy;
    }

    try {
      const res = await fetch(`${this.config.backendUrl}/api/policies/device/${encodeURIComponent(this.config.deviceId)}`, {
        method: 'GET',
        headers: {
          'x-device-id': this.config.deviceId,
          'x-device-token': this.config.deviceToken,
        },
      });

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
        return this.currentPolicy;
      }
    } catch (e: any) {
      console.warn(`[Agent] Failed to fetch latest policy from cloud. Running on local cache. Error: ${e.message}`);
      return this.currentPolicy;
    }
  }

  public async sendHeartbeat(enforcementActive: boolean = true): Promise<HeartbeatResponse | null> {
    try {
      const payload: HeartbeatPayload = {
        deviceId: this.config.deviceId,
        deviceToken: this.config.deviceToken,
        activePolicyVersion: this.currentPolicy?.version || 1,
        enforcementActive,
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
      }

      return data;
    } catch (e) {
      // Offline heartbeat failure
      return null;
    }
  }

  public connectWebSocket() {
    const wsUrl = `${this.config.backendUrl.replace(/^http/, 'ws')}/ws?deviceId=${encodeURIComponent(this.config.deviceId)}&deviceToken=${encodeURIComponent(this.config.deviceToken)}`;
    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('[Agent] Real-time policy sync connected via authenticated WebSocket.');
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
        setTimeout(() => this.connectWebSocket(), 5000); // Reconnect
      });
    } catch (e) {
      setTimeout(() => this.connectWebSocket(), 5000);
    }
  }

  public start() {
    this.fetchLatestPolicy();
    this.connectWebSocket();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(true), 30000);
  }

  public stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.ws?.close();
  }
}
