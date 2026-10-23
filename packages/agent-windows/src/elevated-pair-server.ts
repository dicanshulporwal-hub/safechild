import http from 'http';
import url from 'url';
import * as fs from 'fs';
import * as path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { configManager, ConfigManager, DeviceConfig } from './config-manager';
import { accountManager, WindowsAccountManager } from './account-manager';
import { networkManager, WindowsNetworkManager, logServiceMessage } from './network-manager';
import { parentPinManager, ParentPinManager } from './parent-pin-manager';
import { WINDOWS_AGENT_VERSION } from './sync-client';
import { normalizePairingCode } from '@safebrowse/shared';

const execAsync = promisify(exec);

export class ElevatedPairServer {
  private server: http.Server | null = null;
  private port: number = 8887;
  private configMgr: ConfigManager;
  private accountMgr: WindowsAccountManager;
  private networkMgr: WindowsNetworkManager;
  private pinMgr: ParentPinManager;
  private idleTimer: NodeJS.Timeout | null = null;
  private prefillCode: string = '';
  private prefillName: string = '';
  private autoCloseTimer: NodeJS.Timeout | null = null;

  constructor(
    customConfigMgr?: ConfigManager,
    customAccountMgr?: WindowsAccountManager,
    customNetworkMgr?: WindowsNetworkManager,
    customPinMgr?: ParentPinManager
  ) {
    this.configMgr = customConfigMgr || configManager;
    this.accountMgr = customAccountMgr || accountManager;
    this.networkMgr = customNetworkMgr || networkManager;
    this.pinMgr = customPinMgr || (customConfigMgr ? new ParentPinManager(customConfigMgr) : parentPinManager);
    if (this.networkMgr.setConfigManagerForTesting) {
      this.networkMgr.setConfigManagerForTesting(this.configMgr);
    }
  }

  public getPort(): number {
    return this.port;
  }

  public setPrefill(code?: string, name?: string): void {
    if (code) this.prefillCode = code;
    if (name) this.prefillName = name;
  }

  public async start(preferredPort: number = 8887): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        this.resetIdleTimer();

        const parsed = url.parse(req.url || '', true);
        const pathname = parsed.pathname || '/';

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        const origin = req.headers['origin'];
        if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cross-origin requests forbidden.' }));
          return;
        }

        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }

        // Endpoint: GET /api/status
        if (pathname === '/api/status' && req.method === 'GET') {
          const isAdmin = await this.configMgr.isAdministrator();
          const sanitized = await this.configMgr.loadSanitizedConfig();
          const onboardingState = this.configMgr.getOnboardingState();
          const onboardingReason = this.configMgr.getOnboardingReason();
          const hasMappings = await this.accountMgr.hasProfileMappings();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              isElevated: isAdmin,
              isPaired: Boolean(sanitized),
              deviceId: sanitized?.deviceId || null,
              deviceName: sanitized?.deviceName || null,
              onboardingState,
              onboardingReason,
              hasMappings,
            })
          );
          return;
        }

        // Endpoint: GET /api/version-check (Cloud Deployment Version Gate)
        if (pathname === '/api/version-check' && req.method === 'GET') {
          const rawBackendUrl =
            (parsed.query?.backendUrl as string) ||
            (parsed.query?.url as string) ||
            ConfigManager.DEFAULT_PILOT_URL;
          try {
            const backendUrl = this.configMgr.validateBackendUrl(rawBackendUrl);
            const vRes = await fetch(`${backendUrl}/api/version`);
            if (!vRes.ok) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ compatible: false, error: 'SafeBrowse service needs an update. Please try again shortly.' }));
              return;
            }
            const vData: any = await vRes.json();
            const protocolVer = Number(vData.windowsProtocolVersion || 1);
            if (protocolVer < 2) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  compatible: false,
                  windowsProtocolVersion: protocolVer,
                  error: 'Production backend is running an older protocol (version 1). Please update production backend before pairing.',
                  versionInfo: vData,
                })
              );
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ compatible: true, windowsProtocolVersion: protocolVer, versionInfo: vData }));
          } catch (vErr: any) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ compatible: false, error: 'SafeBrowse service needs an update. Please try again shortly.' }));
          }
          return;
        }

        // Endpoint: POST /api/reconnect (Clears stale validation credentials and resets state to NOT_CONNECTED)
        if (pathname === '/api/reconnect' && req.method === 'POST') {
          const isAdmin = await this.configMgr.isAdministrator();
          if (!isAdmin && (process.platform === 'win32' || this.configMgr.getPlatform() === 'win32')) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Administrator elevation required.' }));
            return;
          }
          try {
            await this.networkMgr.restoreOriginalDns();
            await this.configMgr.deleteDeviceConfig();
            await this.accountMgr.clearProfileMappings();
            await this.pinMgr.clearPin();
            this.configMgr.setOnboardingState('NOT_CONNECTED');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, onboardingState: 'NOT_CONNECTED' }));
          } catch (rErr: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: rErr.message }));
          }
          return;
        }

        // Endpoint: POST /api/claim-and-pair
        if (pathname === '/api/claim-and-pair' && req.method === 'POST') {
          const isAdmin = await this.configMgr.isAdministrator();
          if (!isAdmin && (process.platform === 'win32' || this.configMgr.getPlatform() === 'win32')) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'Administrator approval is required to attach this device.',
              })
            );
            return;
          }

          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', async () => {
            try {
              const data = JSON.parse(body || '{}');
              const code = (data.code || '').trim();
              const deviceName = (data.deviceName || 'Family Laptop').trim();
              const rawBackendUrl = data.backendUrl || ConfigManager.DEFAULT_PILOT_URL;

              if (!code) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Pairing code is required.' }));
                return;
              }

              let backendUrl: string;
              try {
                backendUrl = this.configMgr.validateBackendUrl(rawBackendUrl);
              } catch (urlErr: any) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid backend URL: ${urlErr.message}` }));
                return;
              }

              // 0. Cloud Version Gate check before claim
              try {
                const vRes = await fetch(`${backendUrl}/api/version`);
                if (vRes.ok) {
                  const vData: any = await vRes.json().catch(() => ({}));
                  if (Number(vData.windowsProtocolVersion || 1) < 2) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(
                      JSON.stringify({
                        error: 'SafeBrowse service needs an update. Please try again shortly.',
                      })
                    );
                    return;
                  }
                }
              } catch {}

              // 1. Claim pairing code from SafeBrowse cloud backend
              let claimRes: Response;
              try {
                claimRes = await fetch(`${backendUrl}/api/devices/claim`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    code,
                    deviceName,
                    platform: 'windows',
                    agentVersion: WINDOWS_AGENT_VERSION,
                  }),
                });
              } catch (netErr: any) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    error: 'SafeBrowse cloud service is currently unreachable. Please check your internet connection.',
                  })
                );
                return;
              }

              if (!claimRes.ok) {
                const errData: any = await claimRes.json().catch(() => ({}));
                const status = claimRes.status;
                let userFriendlyError = errData.error || 'Server rejected pairing code.';
                if (status === 400 || status === 404) {
                  userFriendlyError =
                    'The pairing code is invalid or has expired. Please generate a new pairing code from the Parent Dashboard.';
                }
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: userFriendlyError }));
                return;
              }

              const claimData: any = await claimRes.json();
              const dev = claimData.device;
              if (!dev || !dev.id || !dev.deviceToken) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Incomplete device credentials received from server.' }));
                return;
              }

              // 2. Encrypt token with machine DPAPI and persist secure/sanitized config
              const newConfig: DeviceConfig = {
                deviceId: dev.id,
                deviceToken: dev.deviceToken,
                childId: dev.childId,
                parentId: dev.parentId,
                familyId: dev.familyId,
                deviceName: dev.name || deviceName,
                backendUrl,
                pairedAt: new Date().toISOString(),
                onboardingState: 'ACCOUNT_SETUP_REQUIRED',
              };

              try {
                await this.configMgr.saveDeviceConfig(newConfig);
              } catch (saveErr: any) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    error: `Failed to persist secure credentials: ${saveErr.message}`,
                  })
                );
                return;
              }

              // 3. Harden machine directory ACLs
              try {
                await this.configMgr.hardenMachineDirectories();
              } catch (aclErr: any) {
                logServiceMessage('WARN', `[ElevatedPairServer] Directory ACL hardening note: ${aclErr.message}`);
              }

              // 4. Pre-cache family profiles for immediate account mapping readiness
              try {
                if (dev.deviceToken) {
                  await this.accountMgr.fetchFamilyProfilesWithResilience(backendUrl, dev.id, dev.deviceToken);
                }
              } catch (profErr: any) {
                logServiceMessage('INFO', `[ElevatedPairServer] Pre-caching family profiles note: ${profErr.message}`);
              }

              // 5. Return success to client with state ACCOUNT_SETUP_REQUIRED
              // Note: System DNS remains DHCP/untouched until account mapping and activation complete.
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  success: true,
                  message: 'Device attached successfully.',
                  state: 'ACCOUNT_SETUP_REQUIRED',
                  device: {
                    deviceId: dev.id,
                    deviceName: dev.name || deviceName,
                    childId: dev.childId,
                    familyId: dev.familyId,
                  },
                })
              );
            } catch (err: any) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message || 'Unexpected error during pairing' }));
            }
          });
          return;
        }

        // Endpoint: GET /api/accounts
        if (pathname === '/api/accounts' && req.method === 'GET') {
          try {
            const accounts = await this.accountMgr.discoverAccounts();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ accounts }));
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message, accounts: [] }));
          }
          return;
        }

        // Endpoint: GET /api/family-profiles
        if (pathname === '/api/family-profiles' && req.method === 'GET') {
          try {
            const secureConfig = await this.configMgr.loadDeviceConfig();
            if (!secureConfig) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Device is not paired yet.', profiles: [] }));
              return;
            }
            const result = await this.accountMgr.fetchFamilyProfilesWithResilience(
              secureConfig.backendUrl,
              secureConfig.deviceId,
              secureConfig.deviceToken
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message, profiles: [] }));
          }
          return;
        }

        // Endpoint: POST /api/finish-setup
        if (pathname === '/api/finish-setup' && req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', async () => {
            try {
              const data = JSON.parse(body || '{}');
              const mappings = Array.isArray(data.mappings) ? data.mappings : [];
              const parentPin = String(data.parentPin || '').trim();

              if (!/^\d{6,8}$/.test(parentPin)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'SafeBrowse Parent PIN must be between 6 and 8 numeric digits.' }));
                return;
              }

              const secureConfig = await this.configMgr.loadDeviceConfig();
              if (!secureConfig) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Device is not paired.' }));
                return;
              }

              // Step 0: Set SafeBrowse Parent PIN verifier securely
              await this.pinMgr.setPin(parentPin);

              // Step 1: Transition state to ACTIVATING
              this.configMgr.setOnboardingState('ACTIVATING');

              // Step 2: Persist mappings locally to config.json
              await this.accountMgr.saveProfileMappingsTransaction(
                mappings,
                secureConfig.deviceId,
                secureConfig.deviceName,
                { isElevated: true }
              );

              // Step 3: Sync mappings to backend: PUT /api/devices/:deviceId/account-mappings
              const syncResult = await this.accountMgr.syncAccountMappingsToCloud(
                secureConfig.backendUrl,
                secureConfig.deviceId,
                secureConfig.deviceToken,
                mappings
              );
              if (!syncResult || !syncResult.success) {
                throw new Error('Failed to synchronize account mappings with SafeBrowse cloud.');
              }

              // Step 4: Fetch policies for all mapped children
              for (const m of mappings) {
                if (m.childId && m.enabled) {
                  try {
                    await this.triggerInitialPolicySync(
                      secureConfig.backendUrl,
                      secureConfig.deviceId,
                      secureConfig.deviceToken,
                      m.childId
                    );
                  } catch {}
                }
              }

              // Step 5: Start & verify SafeBrowse background service
              await this.startAndVerifyService();

              // Step 6: Fail-Safe Network DNS Activation (127.0.0.1)
              const netActivation = await this.networkMgr.activateFailSafeDns(53, 1);
              if (!netActivation.success) {
                await this.networkMgr.restoreOriginalDns();
                this.configMgr.setOnboardingState('ATTENTION_REQUIRED', netActivation.message || 'DNS activation failed');
                throw new Error(`DNS activation failed: ${netActivation.message}. Windows networking restored to original safe settings.`);
              }

              // Step 7: Verify Resolver Health
              const healthy = await this.networkMgr.verifyEndToEndResolverHealth(53, { timeoutMs: 2000 });
              if (!healthy) {
                await this.networkMgr.restoreOriginalDns();
                this.configMgr.setOnboardingState('ATTENTION_REQUIRED', 'Resolver health check failed');
                throw new Error('Local DNS proxy did not respond healthy. Windows networking restored to original safe settings.');
              }

              // Step 8: Send initial heartbeat with active context
              try {
                const activeSession = await this.accountMgr.getActiveConsoleSession();
                const activeMapping = mappings.find((m: any) => m.windowsSid === activeSession.sid && m.enabled);
                await fetch(`${secureConfig.backendUrl}/api/devices/heartbeat`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'x-device-id': secureConfig.deviceId,
                    'x-device-token': secureConfig.deviceToken,
                  },
                  body: JSON.stringify({
                    deviceId: secureConfig.deviceId,
                    deviceToken: secureConfig.deviceToken,
                    activePolicyVersion: 1,
                    enforcementActive: true,
                    platform: 'windows',
                    agentVersion: WINDOWS_AGENT_VERSION,
                    mappedAccountName: activeSession.username,
                    mappedAccountSid: activeSession.sid,
                    activeChildId: activeMapping ? activeMapping.childId : null,
                    hasMultipleSessions: false,
                    protectionStatus: activeMapping?.childId ? 'MANAGED_CHILD' : 'UNMANAGED_USER',
                  }),
                });
              } catch {}

              // Step 9: Transition to PROTECTED
              this.configMgr.setOnboardingState('PROTECTED');

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, state: 'PROTECTED' }));
            } catch (e: any) {
              try {
                await this.networkMgr.restoreOriginalDns();
              } catch {}
              this.configMgr.setOnboardingState('ATTENTION_REQUIRED', e.message);
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: e.message }));
            }
          });
          return;
        }

        // Endpoint: POST /api/close
        if (pathname === '/api/close' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, closed: true }));
          this.autoCloseTimer = setTimeout(() => {
            this.stop();
            if (process.env.NODE_ENV !== 'test') {
              process.exit(0);
            }
          }, 300);
          this.autoCloseTimer.unref();
          return;
        }

        // Endpoint: POST /api/cancel
        if (pathname === '/api/cancel' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, cancelled: true }));
          this.autoCloseTimer = setTimeout(() => {
            this.stop();
            if (process.env.NODE_ENV !== 'test') {
              process.exit(0);
            }
          }, 300);
          this.autoCloseTimer.unref();
          return;
        }

        // Serve HTML UI
        const queryCode = (parsed.query?.code as string) || this.prefillCode || '';
        const queryName = (parsed.query?.name as string) || this.prefillName || 'Family Laptop';

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.renderHtml(queryCode, queryName));
      });

      server.listen(preferredPort, '127.0.0.1', () => {
        this.server = server;
        const addr = server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : preferredPort;
        logServiceMessage(
          'INFO',
          `[SafeBrowse Pair] Elevated pairing server running on http://127.0.0.1:${this.port}`
        );
        this.resetIdleTimer();
        resolve(this.port);
      });

      server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE' && preferredPort !== 0) {
          logServiceMessage('INFO', `[SafeBrowse Pair] Port ${preferredPort} in use, trying ephemeral port...`);
          server.listen(0, '127.0.0.1', () => {
            this.server = server;
            const addr = server.address();
            this.port = typeof addr === 'object' && addr ? addr.port : 0;
            this.resetIdleTimer();
            resolve(this.port);
          });
        } else {
          reject(err);
        }
      });
    });
  }

  public async startAndVerifyService(): Promise<{ running: boolean; message: string }> {
    if (process.platform !== 'win32') {
      return { running: true, message: 'Non-Windows environment simulated.' };
    }

    try {
      // 1. Dispatch sc start
      try {
        await execAsync('sc.exe start SafeBrowseChildService');
      } catch (startErr: any) {
        const startMsg = (startErr.message || '').toString();
        // If already running (error 1056), proceed to query verification
        if (!startMsg.includes('1056')) {
          logServiceMessage('INFO', `[ElevatedPairServer] sc start notice: ${startMsg}`);
        }
      }

      // 2. Poll sc query for up to 8 seconds to verify RUNNING
      const maxAttempts = 8;
      for (let i = 0; i < maxAttempts; i++) {
        try {
          const { stdout } = await execAsync('sc.exe query SafeBrowseChildService');
          if (stdout.includes('STATE') && stdout.includes('RUNNING')) {
            logServiceMessage('INFO', '[ElevatedPairServer] SafeBrowseChildService verified in RUNNING state.');
            return { running: true, message: 'SafeBrowseChildService is running.' };
          }
        } catch (queryErr: any) {
          if (queryErr.message?.includes('1060')) {
            // Service not installed on this system
            return { running: false, message: 'SafeBrowseChildService is not installed as a Windows service.' };
          }
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      return { running: false, message: 'SafeBrowseChildService was signaled to start.' };
    } catch (e: any) {
      logServiceMessage('WARN', `[ElevatedPairServer] Service verification note: ${e.message}`);
      return { running: false, message: e.message };
    }
  }

  public async triggerInitialPolicySync(
    backendUrl: string,
    deviceId: string,
    deviceToken: string,
    childId?: string
  ): Promise<void> {
    if (!childId) return;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      const url = `${backendUrl}/api/policies/device/${encodeURIComponent(deviceId)}?childId=${encodeURIComponent(childId)}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'x-device-id': deviceId,
          'x-device-token': deviceToken,
        },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));

      if (res.ok) {
        const data: any = await res.json();
        const policy = data?.policy || data;
        if (policy && typeof policy === 'object') {
          const cacheDir = this.configMgr.getCacheDir();
          if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
          }
          fs.writeFileSync(path.join(cacheDir, `policy-${deviceId}.json`), JSON.stringify(policy, null, 2), 'utf8');
          fs.writeFileSync(
            path.join(cacheDir, `policy-${deviceId}-${childId}.json`),
            JSON.stringify(policy, null, 2),
            'utf8'
          );
          logServiceMessage('INFO', `[ElevatedPairServer] Initial policy synchronized for child ${childId}.`);
        }
      }
    } catch (err: any) {
      logServiceMessage('INFO', `[ElevatedPairServer] Initial policy sync note: ${err.message}`);
    }
  }

  public resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    // Auto-terminate after 8 minutes of inactivity
    this.idleTimer = setTimeout(() => {
      logServiceMessage('INFO', '[SafeBrowse Pair] Idle timeout reached. Closing elevated pairing window.');
      this.stop();
      if (process.env.NODE_ENV !== 'test') {
        process.exit(0);
      }
    }, 8 * 60 * 1000);
    this.idleTimer.unref();
  }

  public async launchWindow(prefillCode?: string, deviceName?: string): Promise<void> {
    const params = new URLSearchParams();
    if (prefillCode) params.set('code', prefillCode);
    if (deviceName) params.set('name', deviceName);
    const queryString = params.toString() ? `?${params.toString()}` : '';
    const url = `http://127.0.0.1:${this.port}${queryString}`;

    if (process.platform === 'win32') {
      try {
        const cmd = `start msedge.exe --app="${url}" --window-size=780,640 --user-data-dir="%LOCALAPPDATA%\\SafeBrowse\\elevated-edge-profile"`;
        await execAsync(cmd);
        return;
      } catch (e) {
        try {
          await execAsync(`start "" "${url}"`);
          return;
        } catch {}
      }
    } else {
      try {
        await execAsync(`xdg-open "${url}" || open "${url}"`);
      } catch {}
    }
  }

  public stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.autoCloseTimer) {
      clearTimeout(this.autoCloseTimer);
      this.autoCloseTimer = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private renderHtml(prefillCode: string = '', prefillName: string = 'Family Laptop'): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SafeBrowse — Computer Setup</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card-bg: rgba(17, 24, 39, 0.95);
      --border: #1e293b;
      --accent: #2563eb;
      --accent-hover: #1d4ed8;
      --success: #22c55e;
      --warning: #f59e0b;
      --danger: #ef4444;
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; }
    body {
      font-family: 'Plus Jakarta Sans', sans-serif;
      background: radial-gradient(circle at 50% 10%, #1e1b4b 0%, var(--bg) 100%);
      color: var(--text);
      margin: 0;
      padding: 24px 20px;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .container {
      max-width: 680px;
      width: 100%;
      background: var(--card-bg);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 24px;
      padding: 36px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.8);
      backdrop-filter: blur(20px);
    }
    .brand {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }
    .brand-left {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .brand-icon {
      background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
      color: white;
      width: 48px;
      height: 48px;
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 10px 15px -3px rgba(37, 99, 235, 0.4);
    }
    h1 { margin: 0; font-size: 20px; font-weight: 800; }
    .subtitle { color: var(--text-muted); font-size: 13px; margin-top: 3px; }
    .badge-admin {
      background: rgba(37, 99, 235, 0.15);
      border: 1px solid rgba(37, 99, 235, 0.4);
      color: #93c5fd;
      padding: 6px 12px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.5px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .screen { display: none; }
    .screen.active { display: block; animation: fadeIn 0.25s ease-out; }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .feature-grid {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 12px;
      margin: 24px 0;
    }
    .feature-card {
      background: rgba(30, 41, 59, 0.5);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px 14px;
      text-align: center;
    }
    .feature-icon { font-size: 24px; margin-bottom: 8px; }
    .feature-title { font-weight: 700; font-size: 13px; margin-bottom: 4px; }
    .feature-desc { font-size: 11px; color: var(--text-muted); line-height: 1.4; }
    .callout {
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 16px 20px;
      margin-bottom: 24px;
      font-size: 13px;
      color: #cbd5e1;
      line-height: 1.6;
    }
    .input-group {
      margin-bottom: 20px;
      text-align: left;
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 700;
      color: #cbd5e1;
      margin-bottom: 8px;
    }
    input[type="text"] {
      width: 100%;
      background: rgba(15, 23, 42, 0.8);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 16px;
      color: #fff;
      font-size: 15px;
      font-family: inherit;
      outline: none;
      transition: all 0.2s;
    }
    input[type="text"]:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.2);
    }
    .input-code {
      font-family: 'Courier New', monospace;
      font-size: 22px !important;
      font-weight: 800 !important;
      letter-spacing: 4px !important;
      text-align: center;
      text-transform: uppercase !important;
    }
    .alert {
      padding: 14px 18px;
      border-radius: 12px;
      margin-bottom: 20px;
      font-size: 13px;
      font-weight: 600;
      display: none;
      line-height: 1.5;
    }
    .alert-error {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.4);
      color: #fca5a5;
    }
    .alert-success {
      background: rgba(34, 197, 94, 0.15);
      border: 1px solid rgba(34, 197, 94, 0.4);
      color: #86efac;
    }
    .button-row {
      display: flex;
      gap: 12px;
      margin-top: 28px;
    }
    .btn {
      flex: 1;
      padding: 14px 20px;
      border-radius: 12px;
      font-weight: 700;
      font-size: 14px;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
    }
    .btn-primary {
      background: var(--accent);
      color: white;
    }
    .btn-primary:hover {
      background: var(--accent-hover);
      box-shadow: 0 4px 12px rgba(37, 99, 235, 0.35);
    }
    .btn-primary:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      box-shadow: none;
    }
    .btn-secondary {
      background: rgba(30, 41, 59, 0.8);
      color: var(--text-muted);
      border: 1px solid var(--border);
    }
    .btn-secondary:hover {
      background: rgba(51, 65, 85, 0.8);
      color: #fff;
    }
    .account-card {
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px 20px;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .account-info {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .account-avatar {
      width: 38px;
      height: 38px;
      border-radius: 10px;
      background: rgba(37, 99, 235, 0.2);
      color: #93c5fd;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
    }
    .account-name { font-weight: 700; font-size: 14px; }
    .account-badge {
      font-size: 11px;
      background: rgba(255, 255, 255, 0.1);
      padding: 2px 8px;
      border-radius: 9999px;
      color: var(--text-muted);
      margin-left: 6px;
    }
    select.account-select {
      background: rgba(30, 41, 59, 0.9);
      color: #fff;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 14px;
      font-size: 13px;
      font-weight: 600;
      outline: none;
      cursor: pointer;
      min-width: 220px;
    }
    select.account-select:focus {
      border-color: var(--accent);
    }
    .summary-card {
      background: rgba(30, 41, 59, 0.6);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px 20px;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .pill-protected {
      background: rgba(34, 197, 94, 0.2);
      border: 1px solid rgba(34, 197, 94, 0.4);
      color: #86efac;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 800;
    }
    .pill-parent {
      background: rgba(148, 163, 184, 0.15);
      border: 1px solid rgba(148, 163, 184, 0.3);
      color: #cbd5e1;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand">
      <div class="brand-left">
        <div class="brand-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
        </div>
        <div>
          <h1 id="headerTitle">SafeBrowse Setup Wizard</h1>
          <div class="subtitle" id="headerSubtitle">Attach Device to Family</div>
        </div>
      </div>
      <div class="badge-admin">
        <span>🛡️</span>
        <span>ADMINISTRATOR APPROVED</span>
      </div>
    </div>

    <div id="alertBox" class="alert"></div>

    <!-- SCREEN 1: WELCOME -->
    <div id="screenWelcome" class="screen active">
      <h2 style="font-size: 22px; font-weight: 800; margin: 0 0 8px 0;">Let's protect this computer</h2>
      <p style="color: var(--text-muted); font-size: 14px; line-height: 1.6; margin-bottom: 20px;">
        SafeBrowse helps keep your family safe on this PC by blocking harmful content, enforcing healthy screen time schedules, and providing family insights. Setup takes about 1 minute.
      </p>

      <div class="feature-grid">
        <div class="feature-card">
          <div class="feature-icon">🛡️</div>
          <div class="feature-title">Safe Browsing</div>
          <div class="feature-desc">Automatic protection from adult and harmful websites.</div>
        </div>
        <div class="feature-card">
          <div class="feature-icon">⏰</div>
          <div class="feature-title">Healthy Routines</div>
          <div class="feature-desc">Dinner Time and Bedtime schedules enforced seamlessly.</div>
        </div>
        <div class="feature-card">
          <div class="feature-icon">👨‍👩‍👧‍👦</div>
          <div class="feature-title">Family Control</div>
          <div class="feature-desc">Manage rules anytime from your Parent Dashboard.</div>
        </div>
      </div>

      <div class="button-row">
        <button class="btn btn-primary" onclick="showScreen('screenPair')">Continue to Connect</button>
        <button class="btn btn-secondary" onclick="cancelSetup()">Cancel</button>
      </div>
    </div>

    <!-- SCREEN 2: CONNECT TO YOUR FAMILY -->
    <div id="screenPair" class="screen">
      <h2 style="font-size: 22px; font-weight: 800; margin: 0 0 8px 0;">Connect to your family</h2>
      <p style="color: var(--text-muted); font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
        Enter the 8-character code shown in your <strong>Parent Dashboard</strong> (<a href="https://safebrowse.porwal.online" target="_blank" style="color: #60a5fa; text-decoration: underline;">safebrowse.porwal.online</a>) under <strong>Add Device</strong>.
      </p>

      <div class="input-group">
        <label for="pairingCode">Pairing Code</label>
        <input type="text" id="pairingCode" class="input-code" placeholder="K8X9-M2W7" maxlength="16" value="${prefillCode}" autofocus oninput="this.value = this.value.toUpperCase()">
      </div>

      <div class="input-group">
        <label for="deviceName">Computer Display Name</label>
        <input type="text" id="deviceName" value="${prefillName}">
      </div>

      <div class="button-row">
        <button class="btn btn-primary" id="btnPair" onclick="submitPairing()">Connect Computer</button>
        <button class="btn btn-secondary" onclick="showScreen('screenWelcome')">Back</button>
      </div>
    </div>

    <!-- SCREEN 3: WHO USES THIS COMPUTER? -->
    <div id="screenAccounts" class="screen">
      <h2 style="font-size: 22px; font-weight: 800; margin: 0 0 8px 0;">Who uses this computer?</h2>
      <p style="color: var(--text-muted); font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
        Choose who uses each Windows account. Accounts marked <strong>Parent / Do not protect</strong> will not be filtered.
      </p>

      <div id="accountsContainer">
        <div style="text-align: center; padding: 24px; color: var(--text-muted);">
          Discovering Windows computer accounts...
        </div>
      </div>

      <div class="button-row">
        <button class="btn btn-primary" id="btnReview" onclick="reviewProtection()">Continue to Parent PIN</button>
        <button class="btn btn-secondary" onclick="showScreen('screenPair')">Back</button>
      </div>
    </div>

    <!-- SCREEN 4: SET PARENT PIN -->
    <div id="screenPin" class="screen">
      <h2 style="font-size: 22px; font-weight: 800; margin: 0 0 8px 0;">Set SafeBrowse Parent PIN</h2>
      <p style="color: var(--text-muted); font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
        Create a 6 to 8 digit PIN. This PIN prevents children from changing settings, switching protection off, or disconnecting SafeBrowse on this computer.
      </p>

      <div class="input-group">
        <label for="parentPin">SafeBrowse Parent PIN (6–8 digits)</label>
        <input type="password" id="parentPin" class="input-code" placeholder="••••••" maxlength="8" pattern="[0-9]*" inputmode="numeric">
      </div>

      <div class="input-group">
        <label for="confirmPin">Confirm Parent PIN</label>
        <input type="password" id="confirmPin" class="input-code" placeholder="••••••" maxlength="8" pattern="[0-9]*" inputmode="numeric">
      </div>

      <div class="callout" style="margin-top: 16px;">
        🔒 <strong>Tamper Protection:</strong> Standard child accounts cannot bypass SafeBrowse without this PIN. You can reset it anytime from your online Parent Dashboard.
      </div>

      <div class="button-row">
        <button class="btn btn-primary" id="btnPinNext" onclick="validatePinAndProceed()">Continue to Review</button>
        <button class="btn btn-secondary" onclick="showScreen('screenAccounts')">Back</button>
      </div>
    </div>

    <!-- SCREEN 5: READY TO PROTECT / REVIEW -->
    <div id="screenReview" class="screen">
      <h2 style="font-size: 22px; font-weight: 800; margin: 0 0 8px 0;">Ready to Protect</h2>
      <p style="color: var(--text-muted); font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
        Review your family's protection settings for this computer:
      </p>

      <div id="reviewContainer">
        <!-- Populated dynamically -->
      </div>

      <div class="callout" style="margin-top: 20px;">
        <strong>What SafeBrowse will do on this computer:</strong><br>
        ✓ Block adult and harmful content for protected children<br>
        ✓ Enforce Bedtime and Dinner Time schedules automatically<br>
        ✓ Provide an Ask Parent button when a site is blocked
      </div>

      <div class="button-row">
        <button class="btn btn-primary" id="btnStartProtection" onclick="finishSetup()">Confirm Account Assignments & Activate</button>
        <button class="btn btn-secondary" onclick="showScreen('screenPin')">Back</button>
      </div>
    </div>

    <!-- SCREEN 5: SUCCESS -->
    <div id="screenSuccess" class="screen">
      <div style="text-align: center; padding: 20px 0;">
        <div style="width: 64px; height: 64px; border-radius: 50%; background: rgba(34, 197, 94, 0.2); border: 2px solid var(--success); color: var(--success); font-size: 32px; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px;">
          ✓
        </div>
        <h2 style="font-size: 24px; font-weight: 800; margin: 0 0 10px 0;">You're all set!</h2>
        <p style="color: var(--text-muted); font-size: 15px; line-height: 1.6; max-width: 480px; margin: 0 auto 24px;">
          This computer is now protected by SafeBrowse. Protection is active in the background.
        </p>

        <div class="callout" style="text-align: left; max-width: 520px; margin: 0 auto 28px;">
          You can manage rules, set schedules, and view activity anytime from your Parent Dashboard at <a href="https://safebrowse.porwal.online" target="_blank" style="color: #60a5fa; text-decoration: underline;">safebrowse.porwal.online</a>.
        </div>

        <button class="btn btn-primary" style="max-width: 240px; margin: 0 auto;" onclick="closeSetup()">Close Setup</button>
      </div>
    </div>

    <!-- SCREEN 6: ATTENTION REQUIRED / RECONNECT -->
    <div id="screenAttention" class="screen">
      <div style="text-align: center; padding: 20px 0;">
        <div style="width: 64px; height: 64px; border-radius: 50%; background: rgba(245, 158, 11, 0.2); border: 2px solid var(--warning); color: var(--warning); font-size: 32px; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px;">
          ⚠️
        </div>
        <h2 style="font-size: 24px; font-weight: 800; margin: 0 0 10px 0;">Reconnect This Computer</h2>
        <p style="color: var(--text-muted); font-size: 15px; line-height: 1.6; max-width: 500px; margin: 0 auto 20px;" id="attentionMessage">
          This computer requires reconnection to your SafeBrowse family account. Protection has been paused safely to ensure your internet connection works.
        </p>

        <div class="callout" style="text-align: left; max-width: 520px; margin: 0 auto 28px;">
          Click Reconnect below to enter a fresh pairing code from your Parent Dashboard (<a href="https://safebrowse.porwal.online" target="_blank" style="color: #60a5fa; text-decoration: underline;">safebrowse.porwal.online</a>).
        </div>

        <div class="button-row" style="max-width: 360px; margin: 0 auto;">
          <button class="btn btn-primary" id="btnReconnect" onclick="reconnectComputer()">Reconnect This Computer</button>
          <button class="btn btn-secondary" onclick="cancelSetup()">Close</button>
        </div>
      </div>
    </div>

    <!-- SCREEN 7: ALREADY CONNECTED -->
    <div id="screenAlreadyConnected" class="screen">
      <div style="text-align: center; padding: 20px 0;">
        <div style="width: 64px; height: 64px; border-radius: 50%; background: rgba(34, 197, 94, 0.2); border: 2px solid var(--success); color: var(--success); font-size: 32px; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px;">
          ✓
        </div>
        <h2 style="font-size: 24px; font-weight: 800; margin: 0 0 10px 0;">This Computer is Protected</h2>
        <p style="color: var(--text-muted); font-size: 15px; line-height: 1.6; max-width: 500px; margin: 0 auto 24px;">
          SafeBrowse is active and actively filtering internet content for your family.
        </p>

        <div class="button-row" style="max-width: 420px; margin: 0 auto;">
          <button class="btn btn-primary" onclick="loadAccountsScreen().then(() => showScreen('screenAccounts'))">Reconfigure Accounts</button>
          <button class="btn btn-secondary" onclick="closeSetup()">Close</button>
        </div>
      </div>
    </div>

  </div>

  <script>
    let appState = {
      deviceId: null,
      deviceName: '${prefillName}',
      accounts: [],
      familyProfiles: [],
      selectedMappings: [],
      parentPin: ''
    };

    function showAlert(msg, isError = false) {
      const b = document.getElementById('alertBox');
      b.className = 'alert ' + (isError ? 'alert-error' : 'alert-success');
      b.innerText = msg;
      b.style.display = 'block';
    }

    function clearAlert() {
      const b = document.getElementById('alertBox');
      b.style.display = 'none';
    }

    function showScreen(id) {
      clearAlert();
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      const target = document.getElementById(id);
      if (target) target.classList.add('active');
    }

    async function submitPairing() {
      const codeInput = document.getElementById('pairingCode');
      const rawCode = (codeInput?.value || '').trim();
      const name = (document.getElementById('deviceName')?.value || '').trim() || 'Family Laptop';
      const btn = document.getElementById('btnPair');

      let clean = rawCode.toUpperCase().replace(/[\s-]+/g, '');
      if (clean.startsWith('SB')) {
        clean = clean.slice(2);
      }

      if (!rawCode) {
        showAlert('Please enter the 8-character code shown in your Parent Dashboard.', true);
        return;
      }

      if (clean.length !== 8) {
        showAlert('Please enter a valid 8-character pairing code (e.g. K8X9-M2W7).', true);
        return;
      }

      btn.disabled = true;
      btn.innerText = 'Connecting to SafeBrowse...';
      showAlert('Connecting to your family account...', false);

      try {
        const res = await fetch('/api/claim-and-pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: clean, deviceName: name })
        });

        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          appState.deviceId = data.device.deviceId;
          appState.deviceName = data.device.deviceName;
          clearAlert();
          await loadAccountsScreen();
          showScreen('screenAccounts');
        } else {
          showAlert(data.error || 'Pairing failed. Please check the code and retry.', true);
          btn.disabled = false;
          btn.innerText = 'Connect Computer';
        }
      } catch (e) {
        showAlert('Error communicating with setup service: ' + e.message, true);
        btn.disabled = false;
        btn.innerText = 'Connect Computer';
      }
    }

    async function loadAccountsScreen() {
      const container = document.getElementById('accountsContainer');
      container.innerHTML = '<div style="text-align: center; padding: 24px; color: var(--text-muted);">Discovering Windows computer accounts...</div>';

      try {
        const [accRes, profRes] = await Promise.all([
          fetch('/api/accounts').then(r => r.json()),
          fetch('/api/family-profiles').then(r => r.json())
        ]);

        appState.accounts = accRes.accounts || [];
        appState.familyProfiles = profRes.profiles || [];

        renderAccounts();
      } catch (err) {
        container.innerHTML = '<div style="color: var(--danger); padding: 16px;">Failed to discover accounts: ' + err.message + '</div>';
      }
    }

    function renderAccounts() {
      const container = document.getElementById('accountsContainer');
      if (appState.accounts.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--text-muted);">No interactive human accounts detected on this computer.</div>';
        return;
      }

      let html = '';

      appState.accounts.forEach((acc, idx) => {
        const isCurrent = Boolean(acc.isCurrentConsoleUser);
        const displayName = acc.name || 'User Account';
        const cleanName = displayName.replace(/^.*\\\\/, '');

        html += \`
          <div class="account-card">
            <div class="account-info">
              <div class="account-avatar">👤</div>
              <div>
                <div class="account-name">
                  \${cleanName}
                  \${isCurrent ? '<span class="account-badge">Current User</span>' : ''}
                </div>
                <div style="font-size: 11px; color: var(--text-muted);">\${displayName}</div>
              </div>
            </div>
            <div>
              <select class="account-select" data-sid="\${acc.sid}" data-username="\${displayName}">
                <option value="" disabled selected>Choose who uses this account...</option>
                <option value="__PARENT_UNMANAGED__">Parent / Do not protect</option>
                \${appState.familyProfiles.map(p => {
                  return \`<option value="\${p.id}">\${p.name}\${p.age ? ' (Age ' + p.age + ')' : ''}</option>\`;
                }).join('')}
              </select>
            </div>
          </div>
        \`;
      });

      container.innerHTML = html;
    }

    function reviewProtection() {
      const selects = document.querySelectorAll('.account-select');
      const mappings = [];

      let hasUnselected = false;
      selects.forEach(sel => {
        if (!sel.value) hasUnselected = true;
      });
      if (hasUnselected) {
        showAlert('Please choose who uses each account before continuing.', true);
        return;
      }

      selects.forEach(sel => {
        const sid = sel.getAttribute('data-sid');
        const username = sel.getAttribute('data-username');
        const val = sel.value;
        const isParent = val === '__PARENT_UNMANAGED__';
        const childId = isParent ? null : (val || null);

        let childName = null;
        if (childId) {
          const prof = appState.familyProfiles.find(p => p.id === childId);
          childName = prof ? prof.name : 'Protected Child';
        }

        mappings.push({
          windowsSid: sid,
          windowsUsername: username,
          childId: childId,
          childName: childName,
          enabled: Boolean(childId)
        });
      });

      appState.selectedMappings = mappings;
      showScreen('screenPin');
    }

    function validatePinAndProceed() {
      const pin = (document.getElementById('parentPin')?.value || '').trim();
      const confirm = (document.getElementById('confirmPin')?.value || '').trim();

      if (!/^\\d{6,8}$/.test(pin)) {
        showAlert('SafeBrowse Parent PIN must be between 6 and 8 numeric digits.', true);
        return;
      }
      if (pin !== confirm) {
        showAlert('Parent PINs do not match. Please verify and retry.', true);
        return;
      }

      appState.parentPin = pin;

      const reviewContainer = document.getElementById('reviewContainer');
      let reviewHtml = '';

      appState.selectedMappings.forEach(m => {
        const cleanName = m.windowsUsername.replace(/^.*\\\\/, '');
        reviewHtml += \`
          <div class="summary-card">
            <div>
              <div style="font-weight: 700; font-size: 14px;">\${cleanName}</div>
              <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
                \${m.childId ? 'Protected profile for ' + (m.childName || 'Child') : 'Parent account (Unrestricted)'}
              </div>
            </div>
            <div>
              \${m.childId ? '<span class="pill-protected">Protected</span>' : '<span class="pill-parent">Parent (Unrestricted)</span>'}
            </div>
          </div>
        \`;
      });

      reviewHtml += \`
        <div class="summary-card" style="border-color: rgba(37, 99, 235, 0.4); background: rgba(37, 99, 235, 0.1);">
          <div>
            <div style="font-weight: 700; font-size: 14px; color: #93c5fd;">Parent Security Lock</div>
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">SafeBrowse Parent PIN is configured</div>
          </div>
          <div>
            <span class="pill-protected" style="background: rgba(37, 99, 235, 0.2); border-color: rgba(37, 99, 235, 0.5); color: #93c5fd;">Locked with PIN</span>
          </div>
        </div>
      \`;

      reviewContainer.innerHTML = reviewHtml;
      showScreen('screenReview');
    }

    async function finishSetup() {
      const btn = document.getElementById('btnStartProtection');
      btn.disabled = true;
      btn.innerText = 'Applying protection and syncing...';
      showAlert('Securing computer and synchronizing protection rules...', false);

      try {
        const res = await fetch('/api/finish-setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mappings: appState.selectedMappings,
            parentPin: appState.parentPin
          })
        });

        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          clearAlert();
          showScreen('screenSuccess');
        } else {
          showAlert(data.error || 'Failed to finish setup. Please retry.', true);
          btn.disabled = false;
          btn.innerText = 'Confirm Account Assignments & Activate';
        }
      } catch (err) {
        showAlert('Error finishing setup: ' + err.message, true);
        btn.disabled = false;
        btn.innerText = 'Confirm Account Assignments & Activate';
      }
    }

    async function reconnectComputer() {
      const btn = document.getElementById('btnReconnect');
      btn.disabled = true;
      btn.innerText = 'Resetting connection...';
      try {
        const res = await fetch('/api/reconnect', { method: 'POST' });
        if (res.ok) {
          showScreen('screenPair');
        } else {
          showAlert('Failed to reset connection state. Please retry.', true);
          btn.disabled = false;
          btn.innerText = 'Reconnect This Computer';
        }
      } catch (e) {
        showAlert('Error: ' + e.message, true);
        btn.disabled = false;
        btn.innerText = 'Reconnect This Computer';
      }
    }

    async function cancelSetup() {
      try {
        await fetch('/api/cancel', { method: 'POST' });
      } catch {}
      window.close();
    }

    async function closeSetup() {
      try {
        await fetch('/api/close', { method: 'POST' });
      } catch {}
      window.close();
    }

    window.addEventListener('DOMContentLoaded', async () => {
      // 1. Version check against cloud
      try {
        const vRes = await fetch('/api/version-check');
        const vData = await vRes.json();
        if (!vData.compatible) {
          showAlert(vData.error || 'SafeBrowse service needs an update. Please try again shortly.', true);
          const btn = document.getElementById('btnPair');
          if (btn) btn.disabled = true;
        }
      } catch {}

      // 2. Setup state check
      try {
        const sRes = await fetch('/api/status');
        const sData = await sRes.json();
        if (sData.onboardingState === 'ATTENTION_REQUIRED') {
          showScreen('screenAttention');
          if (sData.onboardingReason) {
            const el = document.getElementById('attentionMessage');
            if (el) el.innerText = 'Device status: ' + sData.onboardingReason + '. Please reconnect this computer to your SafeBrowse family account.';
          }
        } else if (sData.onboardingState === 'ACCOUNT_SETUP_REQUIRED') {
          appState.deviceId = sData.deviceId;
          appState.deviceName = sData.deviceName || 'Family Laptop';
          await loadAccountsScreen();
          showScreen('screenAccounts');
        } else if (sData.onboardingState === 'PROTECTED') {
          showScreen('screenAlreadyConnected');
        }
      } catch {}
    });
  </script>
</body>
</html>`;
  }
}
