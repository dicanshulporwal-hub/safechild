import http from 'http';
import url from 'url';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { safeExecAsync, safeExecFileAsync } from './process-exec';
import { configManager, DeviceConfig, ConfigManager } from './config-manager';
import {
  accountManager,
  WindowsAccountManager,
  WindowsAccount,
  WindowsProfileMapping,
} from './account-manager';
import { sessionMonitor } from './session-monitor';
import { WINDOWS_AGENT_VERSION, BUILD_COMMIT } from './sync-client';
import { evaluateSystemStatus } from './agent-cli';
import { networkManager, WindowsNetworkManager, logServiceMessage } from './network-manager';
import { parentPinManager, ParentPinManager } from './parent-pin-manager';
import { normalizePairingCode, CURRENT_WINDOWS_PROTOCOL_VERSION } from '@safebrowse/shared';
import {
  blockIpcServer,
  BlockIpcServer,
  InteractiveDesktopAction,
  InteractiveActionResultStatus,
  InteractiveDesktopActionResult,
} from './block-ipc';

/**
 * Sanitizes raw technical error strings (PowerShell, CLIXML, CIM, WMI, stack traces, file paths)
 * to ensure parents only see clear, friendly, and non-technical error messages. (P0-10, P0-11)
 */
export function sanitizeParentErrorMessage(raw: any): string {
  if (!raw) return 'An unexpected error occurred. Please try again.';
  const str = typeof raw === 'string' ? raw : (raw.message || String(raw));

  const isTechnical =
    str.includes('CLIXML') ||
    str.includes('Set-DnsClientServerAddress') ||
    str.includes('Get-DnsClientServerAddress') ||
    str.includes('Get-NetAdapter') ||
    str.includes('Get-NetRoute') ||
    str.includes('MSFT_') ||
    str.includes('InterfaceIndex') ||
    str.includes('PowerShell') ||
    str.includes('powershell') ||
    str.includes('pwsh') ||
    str.includes('At line:') ||
    str.includes('CategoryInfo') ||
    str.includes('FullyQualifiedErrorId') ||
    str.includes('EncodedCommand') ||
    str.includes('trapped at 127.0.0.1') ||
    str.includes('DNS read-back verification failed') ||
    str.includes('EACCES') ||
    str.includes('ECONNREFUSED') ||
    str.includes('ETIMEDOUT') ||
    str.includes('WMI') ||
    str.includes('CIM') ||
    str.includes('Session 0') ||
    str.includes('session 0') ||
    str.includes('WTS') ||
    str.includes('SafeBrowseUserHelper') ||
    str.includes('UserHelper') ||
    str.includes('Win32Exception') ||
    str.includes('NativeErrorCode') ||
    str.includes('1223') ||
    str.includes('NO_CONNECTED_HELPER') ||
    str.includes('HELPER_DISCONNECTED') ||
    str.includes('PIPE_SECURITY') ||
    str.includes('pipe') ||
    str.includes('C:\\Program Files') ||
    str.includes('packages/agent-windows') ||
    str.includes('Traceback') ||
    str.includes('Stack trace:');

  if (!isTechnical) {
    return str;
  }

  const lower = str.toLowerCase();
  if (lower.includes('1223') || lower.includes('cancel')) {
    return 'Administrator approval was cancelled. No changes were made.';
  }

  if (
    lower.includes('userhelper') ||
    lower.includes('helper') ||
    lower.includes('session 0') ||
    lower.includes('wts') ||
    lower.includes('pipe') ||
    lower.includes('ipc')
  ) {
    return 'SafeBrowse could not start secure Windows approval. Please close and reopen SafeBrowse and try again.';
  }

  if (
    lower.includes('dns') ||
    lower.includes('interfaceindex') ||
    lower.includes('network') ||
    lower.includes('trapped') ||
    lower.includes('msft_') ||
    lower.includes('restore')
  ) {
    return "SafeBrowse could not safely restore this computer's network settings. No device settings were removed. Please try again.";
  }

  if (lower.includes('profile') || lower.includes('mapping') || lower.includes('account')) {
    return "SafeBrowse could not update account protection settings. Please try again.";
  }

  if (lower.includes('pair') || lower.includes('connect')) {
    return "SafeBrowse could not connect this computer to your family account. Please check your network connection and try again.";
  }

  return "An unexpected error occurred while communicating with SafeBrowse. Please try again.";
}

export class GuiServer {
  private server: http.Server | null = null;
  private port: number = 8885;
  private configMgr: ConfigManager;
  private accountMgr: WindowsAccountManager;
  private networkMgr: WindowsNetworkManager;
  private pinMgr: ParentPinManager;
  private cachedSystemStatus: any = null;
  private lastSystemStatusTime: number = 0;
  private isEvaluatingSystemStatus: boolean = false;
  private interactiveElevationTestingEnabled: boolean = false;
  private helperRecoveryHook?: (sessionId?: number) => void;
  private ipcServer: BlockIpcServer;

  public setInteractiveElevationTestingEnabled(enabled: boolean): void {
    this.interactiveElevationTestingEnabled = enabled;
  }

  public setHelperRecoveryHook(hook: (sessionId?: number) => void): void {
    this.helperRecoveryHook = hook;
  }

  public setBlockIpcServerForTesting(server: BlockIpcServer): void {
    this.ipcServer = server;
  }

  public async requestInteractiveElevation(
    action: InteractiveDesktopAction,
    options?: { code?: string; deviceName?: string }
  ): Promise<{ success: boolean; status: InteractiveActionResultStatus; error?: string; message?: string; requestId?: string }> {
    if (process.env.NODE_ENV === 'test' && !this.interactiveElevationTestingEnabled && !this.ipcServer.isRunning()) {
      const actionMsg =
        action === 'ATTACH_DEVICE'
          ? 'Windows administrator approval prompt requested in the active desktop session.'
          : action === 'SETUP_PIN'
          ? 'Administrator approval requested for Parent PIN setup in the active Windows desktop session.'
          : 'Administrator approval requested in the active Windows desktop session.';
      return {
        success: true,
        status: 'ELEVATED_PROCESS_STARTED',
        message: actionMsg,
        requestId: 'test-simulated-req',
      };
    }

    let activeConsole: { sid: string | null; username: string | null; sessionId?: number | null } | null = null;
    try {
      activeConsole = await this.accountMgr.getActiveConsoleSession();
    } catch {}

    const sessionId = typeof activeConsole?.sessionId === 'number' ? activeConsole.sessionId : undefined;
    const username = activeConsole?.username || undefined;

    let helper = this.ipcServer.getRegisteredHelper(sessionId, username);
    if (!helper) {
      if (this.helperRecoveryHook) {
        try {
          this.helperRecoveryHook(sessionId);
        } catch (e: any) {
          logServiceMessage('WARN', `[SafeBrowse GUI] Helper recovery hook error: ${e?.message || e}`);
        }
      }

      try {
        const hostExe = path.join(this.configMgr.getInstallDir(), 'SafeBrowseServiceHost.exe');
        if (fs.existsSync(hostExe) && process.platform === 'win32') {
          const args = sessionId !== undefined ? ['--recover-helper', String(sessionId)] : ['--recover-helper'];
          await safeExecFileAsync(hostExe, args, { windowsHide: true });
        }
      } catch (e: any) {
        logServiceMessage('WARN', `[SafeBrowse GUI] ServiceHost --recover-helper invocation error: ${e?.message || e}`);
      }

      try {
        helper = await this.ipcServer.waitForRegisteredHelper(sessionId, username, 7000);
      } catch (waitErr: any) {
        logServiceMessage('WARN', `[SafeBrowse GUI] Helper registration timed out for session ${sessionId ?? 'N/A'}: ${waitErr?.message || waitErr}`);
        return {
          success: false,
          status: 'TIMEOUT',
          error: 'SafeBrowse could not start secure Windows approval. Please close and reopen SafeBrowse and try again.',
        };
      }
    }

    const result = await this.ipcServer.dispatchInteractiveDesktopActionWithCorrelation(
      action,
      sessionId,
      username,
      options,
      30000
    );

    if (result.success && result.status === 'ELEVATED_PROCESS_STARTED') {
      const actionMsg =
        action === 'ATTACH_DEVICE'
          ? 'Windows administrator approval prompt requested in the active desktop session.'
          : action === 'SETUP_PIN'
          ? 'Administrator approval requested for Parent PIN setup in the active Windows desktop session.'
          : 'Administrator approval requested in the active Windows desktop session.';
      return {
        success: true,
        status: 'ELEVATED_PROCESS_STARTED',
        message: actionMsg,
        requestId: result.requestId,
      };
    }

    if (result.status === 'UAC_CANCELLED') {
      return {
        success: false,
        status: 'UAC_CANCELLED',
        error: 'Administrator approval was cancelled. No changes were made.',
        requestId: result.requestId,
      };
    }

    if (result.status === 'TIMEOUT') {
      return {
        success: false,
        status: 'TIMEOUT',
        error: 'SafeBrowse administrator approval timed out. Please try again.',
        requestId: result.requestId,
      };
    }

    if (result.status === 'HELPER_DISCONNECTED') {
      return {
        success: false,
        status: 'HELPER_DISCONNECTED',
        error: 'SafeBrowse helper disconnected. Please try again.',
        requestId: result.requestId,
      };
    }

    return {
      success: false,
      status: result.status || 'ACTION_FAILED',
      error: sanitizeParentErrorMessage(result.error || 'Failed to start Windows administrator approval.'),
      requestId: result.requestId,
    };
  }

  public async getOrRefreshSystemStatus(): Promise<any> {
    const now = Date.now();
    if (this.cachedSystemStatus && now - this.lastSystemStatusTime < 30000) {
      return this.cachedSystemStatus;
    }
    if (this.isEvaluatingSystemStatus) {
      return this.cachedSystemStatus;
    }
    this.isEvaluatingSystemStatus = true;
    evaluateSystemStatus()
      .then((st) => {
        this.cachedSystemStatus = st;
        this.lastSystemStatusTime = Date.now();
      })
      .catch(() => {})
      .finally(() => {
        this.isEvaluatingSystemStatus = false;
      });
    return this.cachedSystemStatus;
  }

  constructor(
    customConfigMgr?: ConfigManager,
    customAccountMgr?: WindowsAccountManager,
    customNetworkMgr?: WindowsNetworkManager,
    customPinMgr?: ParentPinManager,
    customBlockIpcServer?: BlockIpcServer
  ) {
    this.configMgr = customConfigMgr || configManager;
    this.accountMgr = customAccountMgr || accountManager;
    this.networkMgr = customNetworkMgr || networkManager;
    this.pinMgr = customPinMgr || (customConfigMgr ? new ParentPinManager(customConfigMgr) : parentPinManager);
    this.ipcServer = customBlockIpcServer || blockIpcServer;
    if (this.networkMgr.setConfigManagerForTesting) {
      this.networkMgr.setConfigManagerForTesting(this.configMgr);
    }
  }

  public async start(port: number = 8885): Promise<number> {
    this.port = port;

    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const parsed = url.parse(req.url || '', true);
        const pathname = parsed.pathname || '/';

        // Enable CORS for loopback
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-device-id, x-device-token, x-management-session');

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

        // Dedicated lightweight health endpoint (P0-8)
        // Must return HTTP 200 immediately with ZERO PowerShell/CIM calls, ZERO DNS inspection,
        // ZERO policy evaluation, ZERO active-session lookup, ZERO cloud sync.
        if (pathname === '/api/health' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'ok',
              service: 'SafeBrowse',
              version: '1.0.4.16',
            })
          );
          return;
        }

        const isPinSet = await this.pinMgr.isPinSet();
        const sessionToken = req.headers['x-management-session'] as string;
        let activeConsole: { sid: string | null; username: string | null; sessionId?: number | null } | null = null;
        try {
          activeConsole = await this.accountMgr.getActiveConsoleSession();
        } catch {}

        const isManagementActive = Boolean(
          isPinSet &&
          sessionToken &&
          this.pinMgr.validateSession(sessionToken, activeConsole?.sid || undefined)
        );

        const checkManagementAuth = async (): Promise<{ authorized: boolean; reason?: string }> => {
          if (!isPinSet) {
            return {
              authorized: false,
              reason: 'SafeBrowse Parent PIN has not been configured. Protected management is locked.',
            };
          }
          if (!sessionToken || !this.pinMgr.validateSession(sessionToken, activeConsole?.sid || undefined)) {
            return {
              authorized: false,
              reason: 'SafeBrowse Parent PIN authentication required.',
            };
          }
          return { authorized: true };
        };

        const dispatchInteractiveAction = async (
          action: InteractiveDesktopAction,
          options?: { code?: string; deviceName?: string }
        ): Promise<{ sent: boolean; reason: string; requestId?: string; status?: InteractiveActionResultStatus; error?: string }> => {
          const elev = await this.requestInteractiveElevation(action, options);
          return {
            sent: elev.success,
            reason: elev.success ? 'DISPATCHED_TO_INTERACTIVE_HELPER' : (elev.status || 'FAILED'),
            status: elev.status,
            error: elev.error,
            requestId: elev.requestId,
          };
        };

        // Endpoint: POST /api/verify-pin (Parent lock unlock)
        if (pathname === '/api/verify-pin' && req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', async () => {
            try {
              const data = JSON.parse(body || '{}');
              const pin = String(data.pin || '').trim();
              const result = await this.pinMgr.verifyPin(
                pin,
                activeConsole?.sid || undefined,
                activeConsole?.username || undefined
              );
              if (!result.success) {
                const statusCode = result.locked ? 429 : 401;
                res.writeHead(statusCode, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  error: result.error || 'Invalid Parent PIN.',
                  attemptsRemaining: result.attemptsRemaining,
                  retryAfterMs: result.retryAfterMs,
                  locked: Boolean(result.locked),
                }));
                return;
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, sessionToken: result.sessionToken }));
            } catch (e: any) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: sanitizeParentErrorMessage(e.message) }));
            }
          });
          return;
        }

        // API Routes
        if (pathname === '/api/status' && req.method === 'GET') {
          try {
            const config = await this.configMgr.loadSanitizedConfig();
            const isLocallyConfigured = this.configMgr.isConfigured() || Boolean(config);
            const pairingStatus = this.configMgr.getPairingStatus();
            const mappings = await this.accountMgr.loadProfileMappings();
            const activeSession = await this.accountMgr.getActiveConsoleSession();
            const activePolicy = await this.accountMgr.resolveUserPolicy(activeSession.sid, activeSession.username);
            let systemStatus: any = null;
            try {
              systemStatus = await this.getOrRefreshSystemStatus();
            } catch {}

            const hasMultipleSessions = sessionMonitor.hasMultipleSessions();
            const sessionWarning = sessionMonitor.getSessionWarning();
            const multiSessionState = sessionMonitor.getMultiSessionState();
            const protectionState = hasMultipleSessions
              ? 'ATTENTION_REQUIRED'
              : activePolicy.isManaged
              ? 'PROTECTED'
              : 'PARENT_BYPASS';

            const onboardingState = this.configMgr.getOnboardingState();
            const onboardingReason = this.configMgr.getOnboardingReason();
            let cloudConnectionStatus: 'HEALTHY_CONNECTED' | 'CLOUD_TEMPORARILY_UNAVAILABLE' | 'DEVICE_TOKEN_REVOKED' | 'LOCAL_ONLY_STALE_STATE' = 'HEALTHY_CONNECTED';
            if (onboardingState === 'ATTENTION_REQUIRED' && (onboardingReason === 'DEVICE_REVOKED' || onboardingReason === 'DEVICE_NOT_FOUND')) {
              cloudConnectionStatus = 'DEVICE_TOKEN_REVOKED';
            } else if (onboardingState === 'ATTENTION_REQUIRED') {
              cloudConnectionStatus = 'LOCAL_ONLY_STALE_STATE';
            } else if (pairingStatus === 'CONNECTED_LOCAL') {
              cloudConnectionStatus = 'CLOUD_TEMPORARILY_UNAVAILABLE';
            }

            if (!isManagementActive) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  isPaired: isLocallyConfigured,
                  pairingStatus,
                  cloudConnectionStatus,
                  onboardingState,
                  onboardingReason,
                  agentVersion: WINDOWS_AGENT_VERSION,
                  buildCommit: BUILD_COMMIT,
                  config: config
                    ? {
                        deviceName: config.deviceName,
                        pairedAt: config.pairedAt,
                      }
                    : null,
                  activeSession: {
                    username: activeSession.username,
                    isManaged: activePolicy.isManaged,
                    childName: activePolicy.childName,
                    accountType: activePolicy.accountType || (activePolicy.isManaged ? 'CHILD' : 'NOT_ASSIGNED'),
                    isMapped: Boolean(activePolicy.isMapped),
                  },
                  hasMultipleSessions,
                  sessionWarning,
                  activeUsers: multiSessionState.activeUsers,
                  protectionState,
                  mappings: mappings.map((m) => ({
                    windowsUsername: m.windowsUsername,
                    isManaged: Boolean(m.enabled && m.childId),
                    childName: m.childName,
                    accountType: m.accountType || (m.childId ? 'CHILD' : 'PARENT'),
                  })),
                  systemStatus: systemStatus ? { dnsEnforced: Boolean(systemStatus.dnsEnforced) } : null,
                  pinConfigured: isPinSet,
                  parentPinSetupRequired: Boolean(config && !isPinSet),
                  managementUnlocked: false,
                })
              );
              return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                isPaired: isLocallyConfigured,
                pairingStatus,
                cloudConnectionStatus,
                onboardingState,
                onboardingReason,
                agentVersion: WINDOWS_AGENT_VERSION,
                buildCommit: BUILD_COMMIT,
                config: config
                  ? {
                      deviceId: config.deviceId,
                      deviceName: config.deviceName,
                      childId: config.childId,
                      pairedAt: config.pairedAt,
                    }
                  : null,
                activeSession: {
                  username: activeSession.username,
                  isManaged: activePolicy.isManaged,
                  childId: activePolicy.childId,
                  childName: activePolicy.childName,
                  sid: activeSession.sid,
                  accountType: activePolicy.accountType || (activePolicy.isManaged ? 'CHILD' : 'NOT_ASSIGNED'),
                  isMapped: Boolean(activePolicy.isMapped),
                },
                hasMultipleSessions,
                sessionWarning,
                activeUsers: multiSessionState.activeUsers,
                protectionState,
                mappings,
                systemStatus,
                pinConfigured: isPinSet,
                parentPinSetupRequired: Boolean(config && !isPinSet),
                managementUnlocked: true,
              })
            );
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: sanitizeParentErrorMessage(e.message) }));
          }
          return;
        }

        if (pathname === '/api/accounts' && req.method === 'GET') {
          try {
            const accounts = await this.accountMgr.discoverAccounts();
            const mappings = await this.accountMgr.loadProfileMappings();
            const activeSession = await this.accountMgr.getActiveConsoleSession();
            const marked = accounts.map((acc: WindowsAccount) => {
              const mapping = mappings.find(
                (m) =>
                  (acc.sid && m.windowsSid && m.windowsSid.toUpperCase() === acc.sid.toUpperCase()) ||
                  (acc.name && m.windowsUsername && m.windowsUsername.toLowerCase() === acc.name.toLowerCase())
              );
              const accountType = mapping
                ? (mapping.accountType || (mapping.childId ? 'CHILD' : 'PARENT'))
                : 'NOT_ASSIGNED';
              const isMapped = Boolean(mapping);
              const isProtected = Boolean(mapping && mapping.enabled && mapping.childId);
              return {
                ...acc,
                isCurrentConsoleUser:
                  (activeSession.sid && acc.sid === activeSession.sid) ||
                  (activeSession.username && acc.name.toLowerCase() === activeSession.username.toLowerCase()),
                accountType,
                isMapped,
                childId: mapping ? mapping.childId : null,
                childName: mapping ? mapping.childName : null,
                isProtected,
              };
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ accounts: marked }));
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: sanitizeParentErrorMessage(e.message) }));
          }
          return;
        }

        if (pathname === '/api/family-profiles' && req.method === 'GET') {
          try {
            const sanitized = await this.configMgr.loadSanitizedConfig();
            if (!sanitized) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Device is not yet paired.' }));
              return;
            }

            let profileRes: any = null;
            // 1. If elevated or credentials accessible, attempt live cloud fetch
            try {
              const fullConfig = await this.configMgr.loadDeviceConfig();
              if (fullConfig && fullConfig.deviceToken) {
                profileRes = await this.accountMgr.fetchFamilyProfilesWithResilience(
                  fullConfig.backendUrl,
                  fullConfig.deviceId,
                  fullConfig.deviceToken
                );
              }
            } catch (cloudErr: any) {
              console.warn(`[SafeBrowse GUI] Cloud profile fetch note: ${cloudErr.message}`);
            }

            // 2. If cloud fetch unavailable or caller is unelevated, fallback seamlessly to local cache
            if (!profileRes) {
              const cached = await this.accountMgr.getCachedFamilyProfiles();
              if (cached && Array.isArray(cached.profiles) && cached.profiles.length > 0) {
                profileRes = {
                  profiles: cached.profiles,
                  fromCache: true,
                  cachedAt: cached.cachedAt,
                };
              }
            }

            if (profileRes) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  profiles: profileRes.profiles,
                  fromCache: Boolean(profileRes.fromCache),
                  cachedAt: profileRes.cachedAt,
                })
              );
              return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                profiles: [],
                fromCache: true,
                error: 'No family profiles cached yet.',
              })
            );
          } catch (e: any) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: e.message || 'Unable to load family profiles. Check SafeBrowse connection and retry.',
                profiles: [],
              })
            );
          }
          return;
        }

        if (pathname === '/api/pair' && req.method === 'POST') {
          const existingConfig = await this.configMgr.loadDeviceConfig();
          if (existingConfig) {
            const auth = await checkManagementAuth();
            if (!auth.authorized) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: auth.reason || 'SafeBrowse Parent PIN authentication required.' }));
              return;
            }
          }

          const isAdmin = await this.configMgr.isAdministrator();
          if (!isAdmin) {
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
              const backendUrl = data.backendUrl || ConfigManager.DEFAULT_PILOT_URL;

              if (!code) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Pairing code is required.' }));
                return;
              }

              const claimRes = await fetch(`${backendUrl}/api/devices/claim`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-windows-protocol-version': String(CURRENT_WINDOWS_PROTOCOL_VERSION),
                },
                body: JSON.stringify({
                  code,
                  deviceName,
                  platform: 'windows',
                  agentVersion: WINDOWS_AGENT_VERSION,
                  windowsProtocolVersion: CURRENT_WINDOWS_PROTOCOL_VERSION,
                }),
              });

              if (!claimRes.ok) {
                const errData: any = await claimRes.json().catch(() => ({ error: 'Invalid pairing code' }));
                const status = claimRes.status;
                let userFriendlyError = errData.error || 'Server rejected pairing code';
                if (status === 400 || status === 404) {
                  userFriendlyError =
                    'The pairing code is invalid or has expired. Please generate a new code from the Parent Dashboard.';
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

              const newConfig: DeviceConfig = {
                deviceId: dev.id,
                deviceToken: dev.deviceToken,
                childId: dev.childId,
                parentId: dev.parentId,
                deviceName: dev.name || deviceName,
                backendUrl,
                pairedAt: new Date().toISOString(),
              };

              await this.configMgr.saveDeviceConfig(newConfig);
              await this.configMgr.hardenMachineDirectories();

              try {
                if (dev.deviceToken) {
                  await this.accountMgr.fetchFamilyProfilesWithResilience(backendUrl, dev.id, dev.deviceToken);
                }
              } catch {}

              // Signal SafeBrowse service to start or reload if on Windows
              if (process.platform === 'win32') {
                try {
                  await safeExecAsync('sc.exe start SafeBrowseChildService', { windowsHide: true });
                } catch {}
              }

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  success: true,
                  device: {
                    deviceId: dev.id,
                    deviceName: dev.name || deviceName,
                    childId: dev.childId,
                  },
                  familyProfiles: claimData.familyProfiles || [],
                })
              );
            } catch (e: any) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: sanitizeParentErrorMessage(e.message) }));
            }
          });
          return;
        }

        if ((pathname === '/api/launch-pair' || pathname === '/api/launch-attach') && req.method === 'POST') {
          const config = await this.configMgr.loadSanitizedConfig();
          if (config) {
            const auth = await checkManagementAuth();
            if (!auth.authorized) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: auth.reason || 'SafeBrowse Parent PIN authentication required.' }));
              return;
            }
          }

          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', async () => {
            try {
              let parsedBody: any = {};
              try {
                parsedBody = JSON.parse(body || '{}');
              } catch {}

              const safeCode = String(parsedBody.code || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
              const safeName = String(parsedBody.deviceName || 'Family Laptop').replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 50);
              if (!safeCode) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Pairing code is required.' }));
                return;
              }

              const dispatch = await dispatchInteractiveAction('ATTACH_DEVICE', {
                code: safeCode,
                deviceName: safeName || 'Family Laptop',
              });
              if (!dispatch.sent) {
                const isCancelled = dispatch.status === 'UAC_CANCELLED';
                const statusCode = isCancelled ? 403 : (dispatch.status === 'TIMEOUT' ? 504 : 503);
                res.writeHead(statusCode, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  error: dispatch.error || (isCancelled ? 'Administrator approval was cancelled. No changes were made.' : 'SafeBrowse could not start secure Windows approval. Please close and reopen SafeBrowse and try again.'),
                  status: dispatch.status,
                  reason: dispatch.reason,
                  requestId: dispatch.requestId,
                }));
                return;
              }

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: true,
                message: 'Windows administrator approval prompt requested in the active desktop session.',
                requestId: dispatch.requestId,
              }));
            } catch (e: any) {
              const msg = (e.stderr || e.message || '').toString();
              const isCancelled = msg.includes('canceled by the user') || msg.includes('1223');
              res.writeHead(isCancelled ? 403 : 500, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: isCancelled
                    ? 'Administrator approval was cancelled. No changes were made.'
                    : sanitizeParentErrorMessage(e.message),
                })
              );
            }
          });
          return;
        }

        if ((pathname === '/api/reconfigure' || pathname === '/api/launch-reconfigure') && req.method === 'POST') {
          const auth = await checkManagementAuth();
          if (!auth.authorized) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: auth.reason || 'SafeBrowse Parent PIN authentication required.' }));
            return;
          }

          try {
            const dispatch = await dispatchInteractiveAction('CONFIGURE_ACCOUNTS');
            if (!dispatch.sent) {
              const isCancelled = dispatch.status === 'UAC_CANCELLED';
              const statusCode = isCancelled ? 403 : (dispatch.status === 'TIMEOUT' ? 504 : 503);
              res.writeHead(statusCode, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error: dispatch.error || (isCancelled ? 'Administrator approval was cancelled. No changes were made.' : 'SafeBrowse could not start secure Windows approval. Please close and reopen SafeBrowse and try again.'),
                status: dispatch.status,
                reason: dispatch.reason,
                requestId: dispatch.requestId,
              }));
              return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              message: 'Administrator approval requested in the active Windows desktop session.',
              requestId: dispatch.requestId,
            }));
          } catch (e: any) {
            const msg = (e.stderr || e.message || '').toString();
            const isCancelled = msg.includes('canceled by the user') || msg.includes('1223');
            res.writeHead(isCancelled ? 403 : 500, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: isCancelled
                  ? 'Administrator approval was cancelled. No changes were made.'
                  : sanitizeParentErrorMessage(e.message),
              })
            );
          }
          return;
        }

        if (pathname === '/api/launch-pin-setup' && req.method === 'POST') {
          const config = await this.configMgr.loadSanitizedConfig();
          const isPinSet = await this.pinMgr.isPinSet();

          if (!config) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Device is not paired.' }));
            return;
          }

          if (isPinSet) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Parent PIN is already configured.' }));
            return;
          }

          try {
            const dispatch = await dispatchInteractiveAction('SETUP_PIN');
            if (!dispatch.sent) {
              const isCancelled = dispatch.status === 'UAC_CANCELLED';
              const statusCode = isCancelled ? 403 : (dispatch.status === 'TIMEOUT' ? 504 : 503);
              res.writeHead(statusCode, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error: dispatch.error || (isCancelled ? 'Administrator approval was cancelled. No changes were made.' : 'SafeBrowse could not start secure Windows approval. Please close and reopen SafeBrowse and try again.'),
                status: dispatch.status,
                reason: dispatch.reason,
                requestId: dispatch.requestId,
              }));
              return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              message: 'Administrator approval requested for Parent PIN setup in the active Windows desktop session.',
              requestId: dispatch.requestId,
            }));
          } catch (e: any) {
            const msg = (e.stderr || e.message || '').toString();
            const isCancelled = msg.includes('canceled by the user') || msg.includes('1223');
            res.writeHead(isCancelled ? 403 : 500, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: isCancelled
                  ? 'Administrator approval was cancelled. No changes were made.'
                  : sanitizeParentErrorMessage(e.message),
              })
            );
          }
          return;
        }

        if (pathname === '/api/mappings' && req.method === 'POST') {
          const auth = await checkManagementAuth();
          if (!auth.authorized) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: auth.reason || 'SafeBrowse Parent PIN authentication required.' }));
            return;
          }

          const isAdmin = await this.configMgr.isAdministrator();
          if (!isAdmin && process.platform === 'win32') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'Administrator approval is required to change account protection. Use Reconfigure Accounts.',
              })
            );
            return;
          }

          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', async () => {
            try {
              const data = JSON.parse(body);
              const mappings: WindowsProfileMapping[] = Array.isArray(data.mappings) ? data.mappings : [];
              const config = await this.configMgr.loadSanitizedConfig();
              const deviceId = config?.deviceId || 'dev-local';
              const deviceName = config?.deviceName || 'Family Laptop';

              await this.accountMgr.saveProfileMappingsTransaction(mappings, deviceId, deviceName, {
                isElevated: true,
              });

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
            } catch (e: any) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: e.message }));
            }
          });
          return;
        }

        // Endpoint: POST /api/open-dashboard
        if (pathname === '/api/open-dashboard' && req.method === 'POST') {
          try {
            const config = await this.configMgr.loadSanitizedConfig();
            const dashUrl = config?.backendUrl || 'https://safebrowse.porwal.online';
            // Return the validated dashboard URL to the interactive GUI.
            // The browser must be opened by the logged-in user's frontend, not Session 0.
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, url: dashUrl }));
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: sanitizeParentErrorMessage(e.message) }));
          }
          return;
        }

        // Endpoint: GET /api/check-protection
        if (pathname === '/api/check-protection' && req.method === 'GET') {
          try {
            let status: any = null;
            try {
              status = await evaluateSystemStatus();
              this.cachedSystemStatus = status;
              this.lastSystemStatusTime = Date.now();
            } catch {}
            const activeSession = await this.accountMgr.getActiveConsoleSession();
            const activePolicy = await this.accountMgr.resolveUserPolicy(activeSession.sid, activeSession.username);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                success: true,
                status,
                activeSession,
                activePolicy,
              })
            );
          } catch (e: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: sanitizeParentErrorMessage(e.message) }));
          }
          return;
        }

        // Endpoint: POST /api/disconnect and POST /api/finish-disconnect (Transaction-safe complete teardown - P0-10)
        if ((pathname === '/api/disconnect' || pathname === '/api/finish-disconnect') && req.method === 'POST') {
          // Phase A: Preflight
          const auth = await checkManagementAuth();
          if (!auth.authorized) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: auth.reason || 'SafeBrowse Parent PIN authentication required to disconnect this computer.' }));
            return;
          }

          const isAdmin = await this.configMgr.isAdministrator();
          if (!isAdmin && (process.platform === 'win32' || this.configMgr.getPlatform() === 'win32')) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Administrator elevation required to disconnect this computer.' }));
            return;
          }

          let secureConfig: any = null;
          try {
            secureConfig = await this.configMgr.loadDeviceConfig();
          } catch {}

          // Phase B: Local Safety Restoration
          try {
            // 1. Stop reconciliation loop and restore original / DHCP DNS
            await this.networkMgr.restoreOriginalDns({ stopReconciliation: true });

            // 2. Clear Windows DNS client cache
            await this.networkMgr.flushDnsCache();

            // 3. Verify no active physical adapter remains trapped at 127.0.0.1
            const inspection = await this.networkMgr.inspectCurrentEnforcement();
            if (inspection && inspection.isProtected) {
              throw new Error('Local network restoration did not complete safely: active adapter(s) remain enforced at 127.0.0.1. Disconnect aborted.');
            }
          } catch (restoreErr: any) {
            logServiceMessage('ERROR', `[GuiServer] Failed local DNS restoration during disconnect: ${restoreErr.stack || restoreErr.message}`);
            // Phase B failed: ABORT destructive cleanup, keep PIN and credentials intact, do NOT unpair cloud!
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                success: false,
                error: sanitizeParentErrorMessage(restoreErr.message) || "SafeBrowse could not safely restore this computer's network settings. No device settings were removed. Please try again.",
              })
            );
            return;
          }

          // Phase C: Local Disconnect (only after Phase B succeeded)
          try {
            // 1. Delete device credentials (DPAPI)
            await this.configMgr.deleteDeviceConfig();

            // 2. Clear profile mappings & session caches
            await this.accountMgr.clearProfileMappings();

            // 3. Clear Parent PIN verifier & invalidate session
            await this.pinMgr.clearPin();
          } catch (localCleanupErr: any) {
            logServiceMessage('ERROR', `[GuiServer] Warning during local credential cleanup: ${localCleanupErr.message}`);
          }

          // Phase D: Cloud Unpair (after local computer is safe)
          if (secureConfig && secureConfig.deviceId && secureConfig.backendUrl) {
            try {
              const unpairUrl = `${secureConfig.backendUrl}/api/devices/${secureConfig.deviceId}/unpair`;
              const ctrl = new AbortController();
              const timer = setTimeout(() => ctrl.abort(), 4000);
              const unpairResp = await fetch(unpairUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-device-id': secureConfig.deviceId,
                  'x-device-token': secureConfig.deviceToken,
                },
                body: JSON.stringify({
                  deviceId: secureConfig.deviceId,
                  deviceToken: secureConfig.deviceToken,
                }),
                signal: ctrl.signal,
              });
              clearTimeout(timer);
              if (!unpairResp.ok) {
                throw new Error(`Cloud unpair request returned HTTP ${unpairResp.status}`);
              }
              logServiceMessage('INFO', `[GuiServer] Successfully notified cloud of device unpair (${secureConfig.deviceId}).`);
            } catch (cloudErr: any) {
              logServiceMessage('WARN', `[GuiServer] Cloud unpair notification note: ${cloudErr.message}`);
              // Cloud offline: persist pending revoke record for later retry, but do NOT revert local disconnect!
              try {
                const pendingFile = path.join(this.configMgr.getSecureDir(), 'pending-cloud-revoke.json');
                fs.writeFileSync(pendingFile, JSON.stringify({
                  deviceId: secureConfig.deviceId,
                  deviceToken: secureConfig.deviceToken,
                  backendUrl: secureConfig.backendUrl,
                  timestamp: new Date().toISOString(),
                }), 'utf8');
              } catch {}
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: true,
              disconnected: true,
              dnsRestored: true,
            })
          );
          return;
        }

        // Serve Application HTML/UI
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.renderHtml());
      });

      this.server.listen(port, '127.0.0.1', () => {
        const addr = this.server?.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        this.port = actualPort;
        sessionMonitor.onSessionChange(() => {
          this.pinMgr.invalidateSession();
        });
        logServiceMessage('INFO', `[SafeBrowse GUI] Application server running on http://127.0.0.1:${actualPort}`);
        resolve(actualPort);
      });

      this.server.on('error', (err: any) => {
        reject(err);
      });
    });
  }

  public async launchWindow(): Promise<void> {
    const url = `http://127.0.0.1:${this.port}`;

    if (process.platform === 'win32') {
      const edgeCandidates = [
        path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ].filter(Boolean);
      const edgePath = edgeCandidates.find((candidate) => fs.existsSync(candidate));
      const localAppData = process.env.LOCALAPPDATA || os.tmpdir();
      const userDataDir = path.join(localAppData, 'SafeBrowse', 'gui-edge-profile');

      if (edgePath) {
        try {
          await safeExecFileAsync(
            edgePath,
            [`--app=${url}`, '--start-maximized', `--user-data-dir=${userDataDir}`],
            { windowsHide: true }
          );
          return;
        } catch {}
      }

      try {
        // Attempt to launch Microsoft Edge in standalone desktop application mode maximized
        const cmd = `start msedge.exe --app="${url}" --start-maximized --user-data-dir="%LOCALAPPDATA%\\SafeBrowse\\gui-edge-profile"`;
        await safeExecAsync(cmd, { windowsHide: true });
        return;
      } catch (e) {
        // Fallback to standard Windows shell execution maximized
        try {
          await safeExecAsync(`start "" /max "${url}"`, { windowsHide: true });
          return;
        } catch {}
      }

      // Fallback without a visible cmd.exe window.
      try {
        await safeExecFileAsync(
          'rundll32.exe',
          ['url.dll,FileProtocolHandler', url],
          { windowsHide: true }
        );
        return;
      } catch {}
    } else {
      try {
        await safeExecAsync(`xdg-open "${url}" || open "${url}"`);
      } catch {}
    }
  }

  public stop(): void {
    this.pinMgr.invalidateSession();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private renderHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SafeBrowse Family Protection</title>
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
      padding: 14px;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: flex-start;
    }
    .container {
      max-width: 1080px;
      width: 100%;
      background: var(--card-bg);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 20px;
      padding: 24px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(20px);
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .sync-spinner {
      width: 20px;
      height: 20px;
      border: 2px solid rgba(255, 255, 255, 0.2);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      display: inline-block;
      vertical-align: middle;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 16px;
    }
    .brand-icon {
      width: 40px;
      height: 40px;
      background: linear-gradient(135deg, #2563eb, #1e40af);
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      box-shadow: 0 10px 20px -5px rgba(37, 99, 235, 0.5);
    }
    h1 { font-size: 22px; font-weight: 800; margin: 0; letter-spacing: -0.5px; }
    .subtitle { color: var(--text-muted); font-size: 12px; margin-top: 4px; }
    .screen { display: none; }
    .screen.active { display: block; animation: fadeIn 0.25s ease-out; }
    .startup-loader {
      min-height: 420px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      gap: 16px;
    }
    .spinner {
      width: 44px;
      height: 44px;
      border: 4px solid rgba(148, 163, 184, 0.22);
      border-top-color: #60a5fa;
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }
    .loading-title { font-size: 18px; font-weight: 800; }
    .loading-copy { color: var(--text-muted); font-size: 14px; max-width: 520px; line-height: 1.5; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

    /* Button styles */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 11px 18px;
      min-height: 40px;
      font-size: 13px;
      font-weight: 700;
      border-radius: 14px;
      border: none;
      cursor: pointer;
      transition: all 0.2s ease;
      text-decoration: none;
    }
    .btn-primary {
      background: linear-gradient(135deg, var(--accent), var(--accent-hover));
      color: white;
      box-shadow: 0 10px 20px -5px rgba(37, 99, 235, 0.4);
    }
    .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 15px 25px -5px rgba(37, 99, 235, 0.5); }
    .btn-secondary {
      background: #1e293b;
      color: var(--text);
      border: 1px solid #334155;
    }
    .btn-secondary:hover { background: #334155; }
    .button-row { display: flex; gap: 10px; margin-top: 16px; }

    /* Inputs */
    .input-group { margin-bottom: 20px; text-align: left; }
    label { display: block; font-size: 13px; font-weight: 700; color: #cbd5e1; margin-bottom: 8px; }
    input[type="text"], select {
      width: 100%;
      padding: 14px 18px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 14px;
      color: white;
      font-size: 14px;
      font-family: inherit;
      outline: none;
      transition: border-color 0.2s;
    }
    input[type="text"]:focus, select:focus { border-color: var(--accent); }

    /* Table styles for Shared Laptop */
    .account-table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0 6px;
      margin: 10px 0;
    }
    .account-row {
      background: #0f172a;
      border-radius: 14px;
      transition: all 0.2s;
    }
    .account-row td {
      padding: 10px 12px;
      border-top: 1px solid #1e293b;
      border-bottom: 1px solid #1e293b;
    }
    .account-row td:first-child { border-left: 1px solid #1e293b; border-top-left-radius: 14px; border-bottom-left-radius: 14px; }
    .account-row td:last-child { border-right: 1px solid #1e293b; border-top-right-radius: 14px; border-bottom-right-radius: 14px; }
    .user-pill { font-weight: 800; font-size: 15px; color: #ffffff; display: flex; align-items: center; gap: 8px; }
    .badge-current { font-size: 10px; font-weight: 800; background: #0369a1; color: #bae6fd; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; }
    .sid-text { font-size: 11px; color: #64748b; font-family: monospace; }

    /* Status cards */
    .status-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin: 14px 0;
    }
    .status-card {
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 14px;
      padding: 12px 14px;
      text-align: left;
    }
    .status-label { font-size: 12px; color: var(--text-muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
    .status-val { font-size: 14px; font-weight: 800; margin-top: 6px; }
    .status-sub { font-size: 12px; color: #64748b; margin-top: 4px; }

    .tag-protected { color: var(--success); }
    .tag-bypass { color: var(--warning); }
    .tag-danger { color: var(--danger); }

    .badge-role {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .badge-child {
      background: rgba(59, 130, 246, 0.2);
      color: #93c5fd;
      border: 1px solid rgba(59, 130, 246, 0.4);
    }
    .badge-parent {
      background: rgba(16, 185, 129, 0.2);
      color: #6ee7b7;
      border: 1px solid rgba(16, 185, 129, 0.4);
    }
    .badge-unassigned {
      background: rgba(148, 163, 184, 0.2);
      color: #cbd5e1;
      border: 1px solid rgba(148, 163, 184, 0.4);
    }

    .alert {
      padding: 14px 18px;
      border-radius: 14px;
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 20px;
      display: none;
    }
    .alert-error { background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #fca5a5; }
    .alert-success { background: rgba(34, 197, 94, 0.15); border: 1px solid rgba(34, 197, 94, 0.3); color: #86efac; }
    .accounts-scroll {
      max-height: 180px;
      overflow: auto;
      padding-right: 4px;
      scrollbar-width: thin;
    }
    .pin-setup-banner {
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      padding: 10px 12px;
      margin-bottom: 12px;
      border: 1px solid rgba(245, 158, 11, 0.45);
      border-radius: 12px;
      background: rgba(245, 158, 11, 0.12);
      text-align: left;
    }
    .pin-setup-copy { min-width: 0; }
    .pin-setup-title { font-size: 13px; font-weight: 800; color: #fde68a; }
    .pin-setup-text { font-size: 12px; color: #cbd5e1; margin-top: 2px; line-height: 1.35; }
    @media (max-width: 900px) {
      .status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-height: 800px) {
      body { padding: 8px; }
      .container { padding: 18px 20px; border-radius: 16px; }
      .brand { margin-bottom: 10px; }
      .brand-icon { width: 36px; height: 36px; }
      h1 { font-size: 20px; }
      .subtitle { font-size: 11px; }
      .status-grid { margin: 10px 0; gap: 8px; }
      .status-card { padding: 9px 11px; }
      .account-row td { padding: 8px 10px; }
      .button-row { margin-top: 12px; gap: 8px; }
      .btn { padding: 9px 14px; min-height: 38px; font-size: 12px; }
      .accounts-scroll { max-height: 145px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand">
      <div class="brand-icon">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          <path d="M9 12l2 2 4-4"/>
        </svg>
      </div>
      <div>
        <h1>SafeBrowse Family Protection</h1>
        <div class="subtitle">Shared Laptop Parental Control & Protection Setup</div>
      </div>
    </div>

    <div id="alertBox" class="alert"></div>

    <!-- INITIAL AUTHORITATIVE STATE CHECK -->
    <div id="screenLoading" class="screen active">
      <div class="startup-loader">
        <div id="loadingSpinner" class="spinner" aria-hidden="true"></div>
        <div id="loadingTitle" class="loading-title">Checking SafeBrowse protection...</div>
        <div id="loadingCopy" class="loading-copy">Please wait while SafeBrowse verifies this computer's connection, account mappings and protection status.</div>
        <div id="loadingActions" class="button-row" style="margin-top: 24px; display: none; justify-content: center; gap: 12px;">
          <button class="btn btn-primary" onclick="initStartupCheck()">Retry Connection</button>
          <button class="btn btn-secondary" onclick="checkProtectionDiagnostics()">Check Diagnostics</button>
        </div>
      </div>
    </div>

    <!-- SCREEN 1: WELCOME (shown only after an authoritative unpaired result) -->
    <div id="screenWelcome" class="screen">
      <h2 style="font-size: 22px; font-weight: 800; margin: 0 0 12px 0;">Protect children using this Windows computer</h2>
      <p style="color: var(--text-muted); font-size: 15px; line-height: 1.6; margin-bottom: 28px;">
        SafeBrowse protects children on shared laptops without affecting parents or unmanaged accounts.
        Easily select which Windows accounts belong to children, and apply individualized web safety policies.
      </p>

      <div style="background: rgba(37, 99, 235, 0.1); border: 1px solid rgba(37, 99, 235, 0.25); border-radius: 16px; padding: 20px; margin-bottom: 28px; text-align: left;">
        <div style="font-size: 14px; font-weight: 800; color: #93c5fd; margin-bottom: 8px;">Key Capabilities:</div>
        <ul style="margin: 0; padding-left: 20px; color: #cbd5e1; font-size: 13px; line-height: 1.6;">
          <li><strong>Shared Laptop Support:</strong> Distinct child policies for each account (e.g. Manjari vs Rahul).</li>
          <li><strong>Parent Freedom:</strong> Parent accounts (e.g. acer) enjoy zero filtering with transparent bypass.</li>
          <li><strong>Fast User Switching:</strong> Instant policy transitions and automatic DNS cache flushing.</li>
        </ul>
      </div>

      <div class="button-row">
        <button class="btn btn-primary" onclick="handleGetStarted()">Connect This Computer</button>
        <button class="btn btn-secondary" onclick="checkStatusAndNavigate()">View Protection Status</button>
      </div>
    </div>

    <!-- SCREEN 2: PAIR FAMILY -->
    <div id="screenPair" class="screen">
      <h2 style="font-size: 22px; font-weight: 800; margin: 0 0 8px 0;">Connect Computer to Family</h2>
      <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 24px;">
        Obtain an 8-character pairing code from the SafeBrowse Parent Portal (<a href="https://safebrowse.porwal.online" target="_blank" style="color: #60a5fa;">safebrowse.porwal.online</a>) under <strong>Add Device</strong>. Attaching this device requires Administrator approval.
      </p>

      <div class="input-group">
        <label for="pairingCode">Pairing Code</label>
        <input type="text" id="pairingCode" placeholder="K8X9-M2W7" style="letter-spacing: 2px; font-weight: 700; text-transform: uppercase;">
      </div>

      <div class="input-group">
        <label for="deviceName">Computer Name</label>
        <input type="text" id="deviceName" value="Family Laptop">
      </div>

      <div class="button-row">
        <button class="btn btn-primary" id="btnPair" onclick="launchElevatedPair()">Connect Computer</button>
        <button class="btn btn-secondary" onclick="showScreen('screenWelcome')">Back</button>
      </div>
    </div>

    <!-- SCREEN 3: SHARED LAPTOP ACCOUNTS -->
    <div id="screenAccounts" class="screen">
      <h2 style="font-size: 22px; font-weight: 800; margin: 0 0 8px 0;">Who uses this computer?</h2>
      <p style="color: var(--text-muted); font-size: 14px; margin-bottom: 20px;">
        SafeBrowse detected these Windows accounts. Choose which profile to apply to each account. Parent accounts can remain unmanaged with zero restrictions.
      </p>

      <div id="profilesBanner" style="display:none; margin-bottom: 16px; padding: 12px 16px; border-radius: 12px; font-size: 13px;"></div>
      <div id="accountsLoading" style="display:none; text-align: center; padding: 30px; color: var(--text-muted); font-size: 14px;">Loading family profiles...</div>

      <table class="account-table">
        <thead>
          <tr style="color: var(--text-muted); font-size: 12px; font-weight: 700; text-transform: uppercase; text-align: left;">
            <th style="padding: 10px 16px;">Windows Account</th>
            <th style="padding: 10px 16px;">Account Role</th>
            <th style="padding: 10px 16px;">Protect As (Child Profile)</th>
            <th style="padding: 10px 16px;">Protection</th>
          </tr>
        </thead>
        <tbody id="accountsBody">
          <!-- Populated dynamically -->
        </tbody>
      </table>

      <div class="button-row">
        <button class="btn btn-primary" id="btnSaveMappings" onclick="saveMappings()">Save Settings & Protect Laptop</button>
        <button class="btn btn-secondary" onclick="showScreen('screenStatus')">Skip to Status</button>
        <button class="btn btn-secondary" id="btnRetryProfiles" onclick="loadAccountsScreen()" style="display:none;">Retry</button>
      </div>
    </div>

    <!-- SCREEN 4: PROTECTION STATUS -->
    <div id="screenStatus" class="screen" style="position:relative;">
      <div id="statusLoading" style="display:none; margin-bottom:20px; padding:18px; border:1px solid rgba(59,130,246,0.35); border-radius:16px; background:rgba(59,130,246,0.10); align-items:center; gap:14px;">
        <div class="spinner" style="width:30px; height:30px; flex:0 0 auto;" aria-hidden="true"></div>
        <div>
          <div style="font-weight:800; color:#dbeafe;">Refreshing protection status...</div>
          <div style="font-size:12px; color:#94a3b8; margin-top:3px;">Please wait. SafeBrowse is checking the active account, mappings and protection service.</div>
        </div>
      </div>
      <h2 style="font-size: 19px; font-weight: 800; margin: 0 0 4px 0;">Protection Status</h2>
      <p style="color: var(--text-muted); font-size: 12px; margin: 0 0 12px 0;">
        Live protection, account and device status.
      </p>

      <div id="pinSetupBanner" class="pin-setup-banner">
        <div class="pin-setup-copy">
          <div class="pin-setup-title">Parent PIN setup required</div>
          <div class="pin-setup-text">Create a 6–8 digit Parent PIN before changing SafeBrowse settings.</div>
        </div>
        <button class="btn btn-primary" id="btnSetupPin" onclick="launchParentPinSetup()">Set Up Parent PIN</button>
      </div>

      <div id="syncBanner" style="display:none; background: rgba(37, 99, 235, 0.15); border: 1px solid rgba(37, 99, 235, 0.35); border-radius: 16px; padding: 14px 18px; margin-bottom: 20px; text-align: left;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <div class="sync-spinner" style="width: 18px; height: 18px; border: 2px solid rgba(147, 197, 253, 0.3); border-top-color: #93c5fd; border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
          <div style="font-size: 13px; font-weight: 700; color: #bfdbfe;" id="syncBannerText">
            Connected — Syncing protection settings...
          </div>
        </div>
      </div>

      <div id="multiSessionBanner" style="display:none; background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.4); border-radius: 16px; padding: 18px; margin-bottom: 24px; text-align: left;">
        <div style="display: flex; align-items: flex-start; gap: 12px;">
          <span style="font-size: 20px;">⚠️</span>
          <div>
            <div style="font-weight: 800; color: #fde68a; font-size: 14px; margin-bottom: 4px;">Protection State: Attention Required</div>
            <div style="color: #cbd5e1; font-size: 13px; line-height: 1.5;" id="multiSessionText">
              Multiple Windows users are currently signed in. For reliable SafeBrowse protection on this Pilot version, sign out other Windows users before switching accounts.
            </div>
          </div>
        </div>
      </div>

      <div id="attentionRecoveryCard" style="display:none; background: rgba(180, 83, 9, 0.2); border: 1px solid rgba(245, 158, 11, 0.5); border-radius: 12px; padding: 16px; margin-bottom: 16px; text-align: left;">
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;">
          <div style="display: flex; align-items: flex-start; gap: 12px; max-width: 600px;">
            <span style="font-size: 22px;">⚠️</span>
            <div>
              <div style="font-weight: 800; color: #fde68a; font-size: 14px; margin-bottom: 4px;">This computer needs attention</div>
              <div id="attentionRecoveryMsg" style="color: #fed7aa; font-size: 13px; line-height: 1.4;">
                This computer was disconnected or its device registration was removed in the SafeBrowse cloud. Protection is currently inactive.
              </div>
            </div>
          </div>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-primary" onclick="reconnectComputer()" style="padding: 8px 14px; font-size: 13px;">Reconnect Computer</button>
            <button class="btn btn-secondary" onclick="openDisconnectModal(true)" style="padding: 8px 14px; font-size: 13px; border-color: rgba(239, 68, 68, 0.4); color: #fca5a5;">Finish Disconnect</button>
          </div>
        </div>
      </div>

      <div class="status-grid">
        <div class="status-card">
          <div class="status-label">Active Windows User</div>
          <div class="status-val" id="statUser">Checking account...</div>
          <div class="status-sub" id="statUserSid">Checking account...</div>
        </div>

        <div class="status-card">
          <div class="status-label">Protection Service</div>
          <div class="status-val" id="statService">Running</div>
          <div class="status-sub" id="statServiceSub">SafeBrowseChildService</div>
        </div>

        <div class="status-card">
          <div class="status-label">Web Protection</div>
          <div class="status-val" id="statDns">Checking...</div>
          <div class="status-sub" id="statDnsSub">DNS Filtering</div>
        </div>

        <div class="status-card">
          <div class="status-label">Cloud Connection</div>
          <div class="status-val" id="statCloud">Connected</div>
          <div class="status-sub" id="statCloudSub">Family cloud sync</div>
        </div>

        <div class="status-card">
          <div class="status-label">Parent Lock</div>
          <div class="status-val" id="statPin">Checking...</div>
          <div class="status-sub" id="statPinSub">Management protection</div>
        </div>

        <div class="status-card">
          <div class="status-label">Device Registration</div>
          <div class="status-val" id="statDevice">Family Laptop</div>
          <div class="status-sub" id="statDeviceId">Registered with family</div>
        </div>
      </div>

      <div style="margin-top: 12px; text-align: left;">
        <div style="font-size: 13px; font-weight: 700; color: #cbd5e1; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;">
          Configured Laptop Accounts & Protection
        </div>
        <div class="accounts-scroll">
        <table class="account-table">
          <thead>
            <tr style="color: var(--text-muted); font-size: 12px; font-weight: 700; text-transform: uppercase; text-align: left;">
              <th style="padding: 10px 16px;">Windows Account</th>
              <th style="padding: 10px 16px;">Account Role</th>
              <th style="padding: 10px 16px;">Assigned Profile</th>
              <th style="padding: 10px 16px;">Protection</th>
            </tr>
          </thead>
          <tbody id="statusAccountsBody">
            <!-- Populated dynamically -->
          </tbody>
        </table>
        </div>
      </div>

      <div class="button-row" style="flex-wrap: wrap;">
        <button class="btn btn-primary" onclick="openParentDashboard()">🌐 Open Parent Dashboard</button>
        <button class="btn btn-secondary" id="btnReconfigure" onclick="launchElevatedReconfigure()">👥 Change Computer Users</button>
        <button class="btn btn-secondary" onclick="checkProtectionDiagnostics()">🩺 Check Protection</button>
        <button class="btn btn-secondary" style="border-color: rgba(239, 68, 68, 0.4); color: #fca5a5;" onclick="confirmDisconnect()">Disconnect Device</button>
      </div>
    </div>

    <!-- PARENT PIN UNLOCK MODAL -->
    <div id="pinModal" style="display:none; position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 9999; align-items: center; justify-content: center; backdrop-filter: blur(8px);">
      <div style="background: #111827; border: 1px solid #374151; border-radius: 20px; padding: 28px; max-width: 380px; width: 90%; text-align: center; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5);">
        <div style="font-size: 32px; margin-bottom: 12px;">🔒</div>
        <h3 style="margin: 0 0 8px 0; font-size: 18px; font-weight: 800; color: #fff;">Parent Lock</h3>
        <p style="font-size: 13px; color: #94a3b8; margin-bottom: 20px;">Enter your SafeBrowse Parent PIN to unlock settings.</p>
        <div style="margin-bottom: 10px;">
          <input type="password" id="modalPinInput" maxlength="8" inputmode="numeric" placeholder="••••••" style="width: 100%; padding: 12px 16px; background: #0f172a; border: 1px solid #374151; border-radius: 12px; font-size: 20px; text-align: center; color: #fff; letter-spacing: 4px; outline: none;" onkeydown="if(event.key==='Enter') submitPinModal()">
        </div>
        <div id="pinErrorText" style="display:none; color:#fca5a5; font-size:12px; font-weight:700; line-height:1.4; margin:0 0 14px 0;"></div>
        <div style="display: flex; gap: 10px;">
          <button class="btn btn-primary" id="btnPinUnlock" style="flex: 1;" onclick="submitPinModal()">Unlock</button>
          <button class="btn btn-secondary" style="flex: 1;" onclick="closePinModal()">Cancel</button>
        </div>
      </div>
    </div>

    <!-- DISCONNECT CONFIRMATION MODAL (P0-10) -->
    <div id="disconnectModal" style="display:none; position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 9999; align-items: center; justify-content: center; backdrop-filter: blur(8px);">
      <div style="background: #111827; border: 1px solid #374151; border-radius: 20px; padding: 28px; max-width: 440px; width: 90%; text-align: left; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5);">
        <div style="font-size: 28px; margin-bottom: 12px;">⚠️</div>
        <h3 style="margin: 0 0 8px 0; font-size: 18px; font-weight: 800; color: #fff;">Disconnect this computer?</h3>
        <p style="font-size: 13px; color: #94a3b8; line-height: 1.5; margin-bottom: 20px;">
          SafeBrowse protection will be removed from this computer. Your family account and child profiles will remain available on other devices.
        </p>

        <div id="disconnectProgressBox" style="display:none; margin: 16px 0; text-align: center;">
          <div class="sync-spinner" style="margin: 0 auto 10px auto; width: 28px; height: 28px; border: 3px solid rgba(147, 197, 253, 0.3); border-top-color: #3b82f6; border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
          <div id="disconnectProgressText" style="font-size: 13px; font-weight: 700; color: #93c5fd;">Restoring network settings…</div>
        </div>

        <div id="disconnectErrorBox" style="display:none; background: rgba(220, 38, 38, 0.15); border: 1px solid rgba(220, 38, 38, 0.4); border-radius: 12px; padding: 12px; margin-bottom: 16px; color: #fca5a5; font-size: 12px; line-height: 1.4;"></div>

        <div id="disconnectModalButtons" style="display: flex; gap: 10px; margin-top: 20px;">
          <button class="btn btn-secondary" id="btnCancelDisconnect" style="flex: 1;" onclick="closeDisconnectModal()">Cancel</button>
          <button class="btn btn-danger" id="btnConfirmDisconnect" style="flex: 1.2; background: #dc2626; color: white;" onclick="executeDisconnect()">Disconnect Computer</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    let managementSessionToken = null;
    let appState = {
      isPaired: false,
      config: null,
      accounts: [],
      familyProfiles: [],
      mappings: [],
      pinConfigured: false,
      managementUnlocked: false
    };

    function ensureManagementUnlocked() {
      return new Promise((resolve) => {
        if (!appState.pinConfigured) {
          launchParentPinSetup();
          return resolve(false);
        }
        if (managementSessionToken) {
          return resolve(true);
        }
        const modal = document.getElementById('pinModal');
        const input = document.getElementById('modalPinInput');
        if (!modal || !input) return resolve(false);
        input.value = '';
        const pinError = document.getElementById('pinErrorText');
        if (pinError) {
          pinError.style.display = 'none';
          pinError.innerText = '';
        }
        const unlockBtn = document.getElementById('btnPinUnlock');
        if (unlockBtn) {
          unlockBtn.disabled = false;
          unlockBtn.innerText = 'Unlock';
        }
        modal.style.display = 'flex';
        input.focus();
        window._pinResolver = resolve;
      });
    }

    async function submitPinModal() {
      const input = document.getElementById('modalPinInput');
      const pin = (input?.value || '').trim();
      if (!pin) return;
      try {
        const res = await fetch('/api/verify-pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin })
        });
        const data = await res.json();
        if (res.ok && data.success && data.sessionToken) {
          managementSessionToken = data.sessionToken;
          appState.managementUnlocked = true;
          document.getElementById('pinModal').style.display = 'none';
          showAlert('Parent Mode unlocked for 5 minutes.');
          if (window._pinResolver) window._pinResolver(true);
          loadStatusScreen(true);
        } else {
          const pinError = document.getElementById('pinErrorText');
          const message = data.error || 'Incorrect SafeBrowse Parent PIN.';
          if (pinError) {
            pinError.innerText = message;
            pinError.style.display = 'block';
          }
          input.value = '';
          input.focus();

          if (data.locked && data.retryAfterMs) {
            const unlockBtn = document.getElementById('btnPinUnlock');
            const retrySeconds = Math.max(1, Math.ceil(data.retryAfterMs / 1000));
            if (unlockBtn) {
              unlockBtn.disabled = true;
              unlockBtn.innerText = 'Locked (' + retrySeconds + 's)';
              let remaining = retrySeconds;
              const timer = setInterval(() => {
                remaining -= 1;
                if (remaining <= 0) {
                  clearInterval(timer);
                  unlockBtn.disabled = false;
                  unlockBtn.innerText = 'Unlock';
                  if (pinError) {
                    pinError.innerText = 'You can try the Parent PIN again.';
                  }
                } else {
                  unlockBtn.innerText = 'Locked (' + remaining + 's)';
                }
              }, 1000);
            }
          }
        }
      } catch (err) {
        const pinError = document.getElementById('pinErrorText');
        if (pinError) {
          pinError.innerText = 'Error verifying PIN: ' + err.message;
          pinError.style.display = 'block';
        }
      }
    }

    function closePinModal() {
      document.getElementById('pinModal').style.display = 'none';
      if (window._pinResolver) window._pinResolver(false);
    }

    function sanitizeParentErrorMessageClient(raw) {
      if (!raw) return 'An unexpected error occurred. Please try again.';
      const str = String(raw);
      if (
        str.includes('CLIXML') ||
        str.includes('Set-DnsClientServerAddress') ||
        str.includes('Get-DnsClientServerAddress') ||
        str.includes('MSFT_') ||
        str.includes('InterfaceIndex') ||
        str.includes('PowerShell') ||
        str.includes('powershell') ||
        str.includes('pwsh') ||
        str.includes('At line:') ||
        str.includes('DNS read-back') ||
        str.includes('trapped at 127') ||
        str.includes('Program Files') ||
        str.includes('packages/agent-windows') ||
        str.includes('UserHelper') ||
        str.includes('Session 0') ||
        str.includes('WTS') ||
        str.includes('Win32Exception') ||
        str.includes('1223') ||
        str.includes('NO_CONNECTED_HELPER') ||
        str.includes('HELPER_DISCONNECTED') ||
        str.includes('PIPE_SECURITY') ||
        str.includes('Pipe')
      ) {
        const lower = str.toLowerCase();
        if (lower.includes('1223') || lower.includes('cancel')) {
          return 'Administrator approval was cancelled. No changes were made.';
        }
        if (
          lower.includes('userhelper') ||
          lower.includes('helper') ||
          lower.includes('session 0') ||
          lower.includes('wts') ||
          lower.includes('pipe') ||
          lower.includes('ipc')
        ) {
          return 'SafeBrowse could not start secure Windows approval. Please close and reopen SafeBrowse and try again.';
        }
        return "SafeBrowse could not safely restore this computer's network settings. No device settings were removed. Please try again.";
      }
      return str;
    }

    function showAlert(msg, isError = false) {
      const b = document.getElementById('alertBox');
      b.className = 'alert ' + (isError ? 'alert-error' : 'alert-success');
      b.innerText = isError ? sanitizeParentErrorMessageClient(msg) : msg;
      b.style.display = 'block';
      setTimeout(() => { b.style.display = 'none'; }, 6000);
    }

    function showScreen(id) {
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      document.getElementById(id).classList.add('active');
      if (id === 'screenStatus') loadStatusScreen();
      if (id === 'screenAccounts') loadAccountsScreen();
    }

    let pollInterval = null;

    async function handleGetStarted() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        if (data.isPaired || data.pairingStatus === 'CONNECTED' || data.pairingStatus === 'CONNECTED_LOCAL' || data.pairingStatus === 'SYNCING') {
          appState.isPaired = true;
          try { localStorage.setItem('sb_paired', '1'); } catch {}
          showScreen('screenStatus');
        } else {
          showScreen('screenPair');
        }
      } catch (e) {
        showScreen('screenPair');
      }
    }

    async function launchParentPinSetup() {
      const btn = document.getElementById('btnSetupPin');
      if (btn) {
        btn.disabled = true;
        btn.innerText = 'Preparing secure Windows approval...';
      }
      showAlert('Approve the Windows administrator prompt to create your SafeBrowse Parent PIN.', false);

      const promptTimer = setTimeout(() => {
        if (btn && btn.disabled) btn.innerText = 'Waiting for administrator approval...';
      }, 1000);

      try {
        const res = await fetch('/api/launch-pin-setup', { method: 'POST' });
        clearTimeout(promptTimer);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          showAlert(data.error || 'Unable to open Parent PIN setup.', true);
          return;
        }

        showAlert('Windows administrator approval granted. Creating Parent PIN...', false);

        if (pollInterval) clearInterval(pollInterval);
        let attempts = 0;
        pollInterval = setInterval(async () => {
          attempts++;
          try {
            const statusRes = await fetch('/api/status', { cache: 'no-store' });
            const status = await statusRes.json();
            if (status.pinConfigured) {
              clearInterval(pollInterval);
              pollInterval = null;
              appState.pinConfigured = true;
              showAlert('Parent PIN configured. Protected settings are now secured.');
              await loadStatusScreen(true);
              return;
            }
          } catch {}
          if (attempts >= 80) {
            clearInterval(pollInterval);
            pollInterval = null;
          }
        }, 1500);
      } catch (e) {
        clearTimeout(promptTimer);
        showAlert('Unable to start Parent PIN setup: ' + sanitizeParentErrorMessageClient(e.message), true);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerText = 'Set Up Parent PIN';
        }
      }
    }

    async function launchElevatedReconfigure() {
      const unlocked = await ensureManagementUnlocked();
      if (!unlocked) return;

      const btn = document.getElementById('btnReconfigure');
      if (btn) {
        btn.disabled = true;
        btn.innerText = 'Preparing secure Windows approval...';
      }
      showAlert('Approve the Windows administrator prompt. SafeBrowse will open account settings and refresh this screen after Save.', false);

      const promptTimer = setTimeout(() => {
        if (btn && btn.disabled) btn.innerText = 'Waiting for administrator approval...';
      }, 1000);

      try {
        const res = await fetch('/api/reconfigure', {
          method: 'POST',
          headers: { ...(managementSessionToken ? { 'x-management-session': managementSessionToken } : {}) }
        });
        clearTimeout(promptTimer);
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          showAlert('Windows administrator approval granted. Account settings opened.', false);
          if (pollInterval) clearInterval(pollInterval);
          let attempts = 0;
          pollInterval = setInterval(async () => {
            attempts++;
            await loadStatusScreen(true);
            if (attempts > 90) {
              clearInterval(pollInterval);
              pollInterval = null;
            }
          }, 2000);
        } else {
          showAlert(data.error || 'Failed to launch elevated configuration.', true);
        }
      } catch (e) {
        clearTimeout(promptTimer);
        showAlert('Error launching configuration: ' + sanitizeParentErrorMessageClient(e.message), true);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerText = 'Change Computer Users';
        }
      }
    }

    async function checkStatusAndNavigate() {
      showScreen('screenStatus');
    }

    async function launchElevatedPair() {
      const code = (document.getElementById('pairingCode')?.value || '').trim();
      const deviceName = (document.getElementById('deviceName')?.value || '').trim();
      const btn = document.getElementById('btnPair');

      if (btn) {
        btn.disabled = true;
        btn.innerText = 'Preparing secure Windows approval...';
      }
      showAlert('Approve the Windows administrator prompt to attach this device.', false);

      const promptTimer = setTimeout(() => {
        if (btn && btn.disabled) btn.innerText = 'Waiting for administrator approval...';
      }, 1000);

      try {
        const res = await fetch('/api/launch-pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, deviceName })
        });
        clearTimeout(promptTimer);
        const data = await res.json().catch(() => ({}));

        if (res.ok && data.success) {
          showAlert('Windows administrator approval granted. SafeBrowse is pairing this device...', false);
          if (pollInterval) clearInterval(pollInterval);
          let attempts = 0;
          pollInterval = setInterval(async () => {
            attempts++;
            try {
              const sRes = await fetch('/api/status');
              const sData = await sRes.json();
              if (sData.isPaired) {
                clearInterval(pollInterval);
                pollInterval = null;
                appState.isPaired = true;
                showAlert('Device attached successfully! Welcome to SafeBrowse.');
                setTimeout(() => showScreen('screenStatus'), 800);
              }
            } catch {}
            if (attempts > 90) {
              clearInterval(pollInterval);
              pollInterval = null;
            }
          }, 2000);
        } else {
          showAlert(data.error || 'Administrator approval is required to attach this device.', true);
        }
      } catch (e) {
        clearTimeout(promptTimer);
        showAlert('Error requesting administrator setup: ' + sanitizeParentErrorMessageClient(e.message), true);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerText = 'Attach Device';
        }
      }
    }

    async function submitPairing() {
      return launchElevatedPair();
    }

    async function loadAccountsScreen() {
      const banner = document.getElementById('profilesBanner');
      const loading = document.getElementById('accountsLoading');
      const table = document.querySelector('.account-table');
      const saveBtn = document.getElementById('btnSaveMappings');
      const retryBtn = document.getElementById('btnRetryProfiles');

      if (banner) banner.style.display = 'none';
      if (retryBtn) retryBtn.style.display = 'none';
      if (loading) loading.style.display = 'block';
      if (table) table.style.display = 'none';
      if (saveBtn) saveBtn.disabled = true;

      try {
        const [accRes, profRes, statRes] = await Promise.all([
          fetch('/api/accounts').then(r => r.json()).catch(() => ({ accounts: [] })),
          fetch('/api/family-profiles').then(r => r.json()).catch(err => ({ error: err.message, profiles: [] })),
          fetch('/api/status').then(r => r.json()).catch(() => ({}))
        ]);

        appState.accounts = accRes.accounts || [];
        appState.mappings = statRes.mappings || [];

        if (profRes.error && (!profRes.profiles || profRes.profiles.length === 0)) {
          // Cloud fetch failed and no cache available
          appState.familyProfiles = [];
          if (banner) {
            banner.style.display = 'flex';
            banner.style.alignItems = 'center';
            banner.style.justifyContent = 'space-between';
            banner.style.background = 'rgba(239, 68, 68, 0.15)';
            banner.style.border = '1px solid rgba(239, 68, 68, 0.3)';
            banner.style.color = '#fca5a5';
            banner.innerHTML = '<span>⚠️ Unable to load family profiles. Check SafeBrowse connection and retry.</span>';
          }
          if (retryBtn) retryBtn.style.display = 'inline-block';
        } else {
          appState.familyProfiles = profRes.profiles || [];
          if (profRes.fromCache && banner) {
            banner.style.display = 'block';
            banner.style.background = 'rgba(59, 130, 246, 0.15)';
            banner.style.border = '1px solid rgba(59, 130, 246, 0.3)';
            banner.style.color = '#93c5fd';
            banner.innerText = 'ℹ Using previously synchronized family profiles.';
          }
        }

        renderAccountsTable();
      } catch (e) {
        showAlert('Failed to load accounts: ' + e.message, true);
      } finally {
        if (loading) loading.style.display = 'none';
        if (table) table.style.display = 'table';
        if (saveBtn) saveBtn.disabled = false;
      }
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function renderAccountsTable() {
      const tbody = document.getElementById('accountsBody');
      tbody.innerHTML = '';

      if (appState.accounts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px; color:#64748b;">No interactive accounts detected.</td></tr>';
        return;
      }

      appState.accounts.forEach((acc, idx) => {
        const existing = appState.mappings.find(m =>
          (acc.sid && m.windowsSid && m.windowsSid.toUpperCase() === acc.sid.toUpperCase()) ||
          (m.windowsUsername && acc.name && m.windowsUsername.toLowerCase() === acc.name.toLowerCase())
        );
        const isMapped = Boolean(existing);
        const role = isMapped ? (existing.accountType || (existing.childId ? 'CHILD' : 'PARENT')) : (acc.accountType || 'NOT_ASSIGNED');
        const isChild = role === 'CHILD';
        const isParent = role === 'PARENT';
        const selectedChildId = (isChild && existing && existing.enabled) ? (existing.childId || '') : (isChild && acc.childId ? acc.childId : '');

        const tr = document.createElement('tr');
        tr.className = 'account-row';

        let optionsHtml = '';
        if (!isMapped && role === 'NOT_ASSIGNED') {
          optionsHtml += '<option value="__UNASSIGNED__" selected disabled>Not Assigned (Choose role below)</option>';
        }
        optionsHtml += '<option value="" ' + (isParent ? 'selected' : '') + '>Parent Account (Unmanaged / Protection OFF)</option>';
        appState.familyProfiles.forEach(p => {
          const isSelected = selectedChildId === p.id ? 'selected' : '';
          optionsHtml += '<option value="' + p.id + '" ' + isSelected + '>Child: ' + escapeHtml(p.name) + ' (Protected)</option>';
        });

        const isProtected = Boolean(selectedChildId);
        const isCurrent = Boolean(acc.isCurrentConsoleUser);

        let roleBadgeClass = 'badge-unassigned';
        let roleBadgeText = 'NOT ASSIGNED';
        if (isChild) {
          roleBadgeClass = 'badge-child';
          roleBadgeText = 'CHILD ACCOUNT';
        } else if (isParent) {
          roleBadgeClass = 'badge-parent';
          roleBadgeText = 'PARENT ACCOUNT';
        }

        tr.innerHTML =
          '<td>' +
            '<div class="user-pill">' +
              escapeHtml(acc.name) +
              (isCurrent ? ' <span class="badge-current">ACTIVE USER</span>' : '') +
            '</div>' +
            '<div class="sid-text" style="color: #64748b; font-size: 11px;">' +
              (isCurrent ? 'Active Console Account' : 'Standard Windows Account') +
            '</div>' +
          '</td>' +
          '<td>' +
            '<span id="roleBadge_' + idx + '" class="badge-role ' + roleBadgeClass + '">' + roleBadgeText + '</span>' +
          '</td>' +
          '<td>' +
            '<select id="sel_' + idx + '" onchange="updateRowProtection(' + idx + ')">' +
              optionsHtml +
            '</select>' +
          '</td>' +
          '<td>' +
            '<span id="tag_' + idx + '" class="' + (isProtected ? 'tag-protected' : 'tag-bypass') + '" style="font-weight:800; font-size:13px;">' +
              (isProtected ? '● PROTECTED' : '○ BYPASSED') +
            '</span>' +
          '</td>';

        tbody.appendChild(tr);
      });
    }

    function updateRowProtection(idx) {
      const sel = document.getElementById('sel_' + idx);
      const tag = document.getElementById('tag_' + idx);
      const roleBadge = document.getElementById('roleBadge_' + idx);
      const val = sel ? sel.value : '';

      if (roleBadge) {
        if (val === '__UNASSIGNED__') {
          roleBadge.className = 'badge-role badge-unassigned';
          roleBadge.innerText = 'NOT ASSIGNED';
        } else if (val === '') {
          roleBadge.className = 'badge-role badge-parent';
          roleBadge.innerText = 'PARENT ACCOUNT';
        } else {
          roleBadge.className = 'badge-role badge-child';
          roleBadge.innerText = 'CHILD ACCOUNT';
        }
      }

      const isProtected = Boolean(val && val !== '__UNASSIGNED__');
      if (tag) {
        tag.className = isProtected ? 'tag-protected' : 'tag-bypass';
        tag.innerText = isProtected ? '● PROTECTED' : '○ BYPASSED';
      }
    }

    async function saveMappings() {
      const unlocked = await ensureManagementUnlocked();
      if (!unlocked) return;

      const saveBtn = document.getElementById('btnSaveMappings');
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerText = 'Saving settings...';
      }

      const mappings = [];
      appState.accounts.forEach((acc, idx) => {
        const sel = document.getElementById('sel_' + idx);
        const val = sel ? sel.value : '';
        if (val === '__UNASSIGNED__') return;
        const childId = val ? val : null;
        const profile = appState.familyProfiles.find(p => p.id === childId);
        const accountType = childId ? 'CHILD' : 'PARENT';

        mappings.push({
          windowsSid: acc.sid,
          windowsUsername: acc.name,
          childId: childId,
          childName: profile ? profile.name : null,
          enabled: Boolean(childId),
          accountType: accountType,
        });
      });

      try {
        const res = await fetch('/api/mappings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(managementSessionToken ? { 'x-management-session': managementSessionToken } : {})
          },
          body: JSON.stringify({ mappings })
        });
        const data = await res.json().catch(() => ({}));

        if (res.ok && data.success) {
          showAlert('Shared laptop settings saved successfully!');
          setTimeout(() => showScreen('screenStatus'), 800);
        } else if (res.status === 403) {
          showAlert(data.error || 'Administrator approval is required to change account protection.', true);
        } else {
          showAlert(data.error || 'Failed to save settings.', true);
        }
      } catch (e) {
        showAlert('Network error: ' + e.message, true);
      } finally {
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.innerText = 'Save Settings & Protect Laptop';
        }
      }
    }

    async function loadStatusScreen(silent = false) {
      const statusLoading = document.getElementById('statusLoading');
      const statusScreen = document.getElementById('screenStatus');
      if (!silent) {
        if (statusLoading) statusLoading.style.display = 'flex';
        if (statusScreen) {
          statusScreen.querySelectorAll('button').forEach(btn => btn.disabled = true);
        }
        const su = document.getElementById('statUser');
        if (su) su.innerText = 'Checking account...';
        const sus = document.getElementById('statUserSid');
        if (sus) sus.innerText = 'Checking account...';
      }

      try {
        const [statRes, accRes] = await Promise.all([
          fetch('/api/status', {
            headers: { ...(managementSessionToken ? { 'x-management-session': managementSessionToken } : {}) }
          }).then(r => r.json()).catch(() => ({})),
          fetch('/api/accounts').then(r => r.json()).catch(() => ({ accounts: [] }))
        ]);

        const data = statRes;
        const accounts = accRes.accounts || [];
        appState.mappings = data.mappings || [];
        appState.isPaired = Boolean(data.isPaired);
        appState.pinConfigured = Boolean(data.pinConfigured);
        appState.managementUnlocked = Boolean(data.managementUnlocked);

        const pinBanner = document.getElementById('pinSetupBanner');
        const pinRequired = Boolean(data.parentPinSetupRequired || (data.isPaired && !data.pinConfigured));
        if (pinBanner) pinBanner.style.display = pinRequired ? 'flex' : 'none';

        const user = data.activeSession?.username || 'System Console';
        const role = data.activeSession?.accountType || (data.activeSession?.isManaged ? 'CHILD' : 'NOT_ASSIGNED');
        const isChild = role === 'CHILD';
        const isParent = role === 'PARENT';
        const isNotAssigned = role === 'NOT_ASSIGNED';

        let roleBadgeClass = 'badge-unassigned';
        let roleBadgeText = 'NOT ASSIGNED';
        let roleText = 'Not Assigned';
        let protectionText = 'Unmanaged';

        if (isChild) {
          roleBadgeClass = 'badge-child';
          roleBadgeText = 'CHILD ACCOUNT';
          roleText = 'Child Account';
          protectionText = data.activeSession?.isManaged ? 'Protection Active' : 'Protection Bypassed';
        } else if (isParent) {
          roleBadgeClass = 'badge-parent';
          roleBadgeText = 'PARENT ACCOUNT';
          roleText = 'Parent Account';
          protectionText = 'Parent / Unmanaged';
        }

        function formatFriendlyAccount(raw) {
          if (!raw) return 'Windows User';
          const s = String(raw);
          const slashIdx = Math.max(s.lastIndexOf(String.fromCharCode(92)), s.lastIndexOf('/'));
          return slashIdx === -1 ? s : s.substring(slashIdx + 1);
        }
        const friendlyUser = formatFriendlyAccount(user);

        // 1. Active Windows User Card
        const statUserEl = document.getElementById('statUser');
        if (statUserEl) {
          statUserEl.innerHTML =
            '<span style="vertical-align: middle;">' + escapeHtml(friendlyUser) + '</span> ' +
            '<span class="badge-role ' + roleBadgeClass + '" style="vertical-align: middle; margin-left: 6px;">' + roleBadgeText + '</span>';
        }

        const statUserSidEl = document.getElementById('statUserSid');
        if (statUserSidEl) {
          if (isParent) {
            statUserSidEl.innerText = friendlyUser + ' — Parent account — filtering bypassed';
          } else if (isChild) {
            statUserSidEl.innerText = friendlyUser + ' — Child account — ' + (data.activeSession?.isManaged ? 'Protection active' : 'Filtering bypassed');
          } else {
            statUserSidEl.innerText = friendlyUser + ' — Unassigned account';
          }
        }

        // 2. Protection Service Card
        const sys = data.systemStatus;
        const statServiceEl = document.getElementById('statService');
        const statServiceSubEl = document.getElementById('statServiceSub');
        if (statServiceEl) {
          statServiceEl.innerHTML = '<span style="color: #10b981; font-weight: 800;">● Running</span>';
        }
        if (statServiceSubEl) {
          statServiceSubEl.innerText = (sys && sys.serviceState) ? sys.serviceState : 'SafeBrowseChildService';
        }

        // 3. Web Protection Card
        const statDnsEl = document.getElementById('statDns');
        const statDnsSubEl = document.getElementById('statDnsSub');
        if (statDnsEl) {
          if (data.hasMultipleSessions) {
            statDnsEl.innerHTML = '<span style="color: #f59e0b; font-weight: 800;">⚠️ Attention Required</span>';
            if (statDnsSubEl) statDnsSubEl.innerText = 'Multiple Windows users signed in';
          } else if (isParent) {
            statDnsEl.innerHTML = '<span style="color: #94a3b8; font-weight: 700;">○ Filtering Bypassed</span>';
            if (statDnsSubEl) statDnsSubEl.innerText = 'Parent account (filtering bypassed)';
          } else if (sys && sys.dnsEnforced) {
            statDnsEl.innerHTML = '<span style="color: #10b981; font-weight: 800;">● Active</span>';
            if (statDnsSubEl) statDnsSubEl.innerText = 'SafeBrowse local DNS proxy active';
          } else if (sys && sys.dnsEnforced === false) {
            statDnsEl.innerHTML = '<span style="color: #ef4444; font-weight: 800;">⚠️ Inactive</span>';
            if (statDnsSubEl) statDnsSubEl.innerText = 'DNS protection not enforcing';
          } else {
            statDnsEl.innerText = 'Checking protection...';
            if (statDnsSubEl) statDnsSubEl.innerText = 'DNS Filtering';
          }
        }

        // 4. Cloud Connection Card
        const statCloudEl = document.getElementById('statCloud');
        const statCloudSubEl = document.getElementById('statCloudSub');
        if (statCloudEl) {
          if (data.cloudConnectionStatus === 'DEVICE_TOKEN_REVOKED') {
            statCloudEl.innerHTML = '<span style="color: #ef4444; font-weight: 800;">⚠️ Token Revoked</span>';
            if (statCloudSubEl) statCloudSubEl.innerText = 'Device unlinked in family cloud';
          } else if (data.cloudConnectionStatus === 'LOCAL_ONLY_STALE_STATE') {
            statCloudEl.innerHTML = '<span style="color: #f59e0b; font-weight: 800;">⚠️ Attention Required</span>';
            if (statCloudSubEl) statCloudSubEl.innerText = 'Registration needs reconnect';
          } else if (data.cloudConnectionStatus === 'CLOUD_TEMPORARILY_UNAVAILABLE') {
            statCloudEl.innerHTML = '<span style="color: #f59e0b; font-weight: 700;">Connection unavailable</span>';
            if (statCloudSubEl) statCloudSubEl.innerText = 'Cloud sync offline (local protection active)';
          } else if (data.pairingStatus === 'SYNCING') {
            statCloudEl.innerHTML = '<span style="color: #3b82f6; font-weight: 700;">Syncing</span>';
            if (statCloudSubEl) statCloudSubEl.innerText = 'Updating family settings...';
          } else {
            statCloudEl.innerHTML = '<span style="color: #10b981; font-weight: 800;">● Connected</span>';
            if (statCloudSubEl) statCloudSubEl.innerText = 'Family cloud sync active';
          }
        }

        // 5. Parent Lock Card
        const statPin = document.getElementById('statPin');
        const statPinSub = document.getElementById('statPinSub');
        if (statPin) {
          if (data.pinConfigured) {
            if (data.managementUnlocked) {
              statPin.innerHTML = '<span style="color: #10b981; font-weight: 700;">Configured • Unlocked</span>';
              if (statPinSub) statPinSub.innerText = 'Temporarily unlocked for management';
            } else {
              statPin.innerHTML = '<span>Configured • Locked</span>';
              if (statPinSub) statPinSub.innerText = 'Protected by Parent PIN';
            }
          } else {
            statPin.innerHTML = '<span style="color: #f59e0b; font-weight: 700;">Setup Required</span>';
            if (statPinSub) statPinSub.innerText = 'Set a 6–8 digit Parent PIN';
          }
        }

        // 6. Device Registration Card
        const statDeviceEl = document.getElementById('statDevice');
        const statDeviceIdEl = document.getElementById('statDeviceId');
        if (statDeviceEl) statDeviceEl.innerText = data.config ? data.config.deviceName : 'Family Laptop';
        if (statDeviceIdEl) statDeviceIdEl.innerText = data.isPaired ? 'Registered with family' : 'Run pairing setup';

        // Split State Recovery Card
        const recoveryCard = document.getElementById('attentionRecoveryCard');
        if (data.cloudConnectionStatus === 'DEVICE_TOKEN_REVOKED' || data.onboardingReason === 'DEVICE_REVOKED' || data.onboardingReason === 'DEVICE_NOT_FOUND') {
          if (recoveryCard) {
            recoveryCard.style.display = 'block';
            const msg = document.getElementById('attentionRecoveryMsg');
            if (msg) msg.innerText = "This computer's device registration was removed in the SafeBrowse cloud. Protection is currently inactive. Reconnect this computer or finish disconnecting.";
          }
        } else if (data.cloudConnectionStatus === 'LOCAL_ONLY_STALE_STATE') {
          if (recoveryCard) {
            recoveryCard.style.display = 'block';
            const msg = document.getElementById('attentionRecoveryMsg');
            if (msg) msg.innerText = "This computer has incomplete or unlinked protection settings. Reconnect this computer or finish disconnecting.";
          }
        } else {
          if (recoveryCard) recoveryCard.style.display = 'none';
        }

        const syncBanner = document.getElementById('syncBanner');
        if (syncBanner) {
          if (data.cloudConnectionStatus === 'CLOUD_TEMPORARILY_UNAVAILABLE' || data.pairingStatus === 'SYNCING') {
            syncBanner.style.display = 'block';
            const bannerText = document.getElementById('syncBannerText');
            if (bannerText) {
              bannerText.innerText =
                data.pairingStatus === 'SYNCING'
                  ? 'Connected — Syncing protection settings with cloud...'
                  : 'Connected (Local) — Cloud synchronization unavailable';
            }
          } else {
            syncBanner.style.display = 'none';
          }
        }

        if (data.hasMultipleSessions) {
          document.getElementById('multiSessionBanner').style.display = 'block';
          if (data.sessionWarning) {
            document.getElementById('multiSessionText').innerText = data.sessionWarning;
          }
        } else {
          document.getElementById('multiSessionBanner').style.display = 'none';
        }

        if (!sys || sys.dnsEnforced === undefined) {
          fetchAsyncDiagnostics();
        }

        // Render view-only status accounts table
        const tbody = document.getElementById('statusAccountsBody');
        if (tbody) {
          tbody.innerHTML = '';
          if (accounts.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:16px; color:#64748b;">No interactive human accounts detected.</td></tr>';
          } else {
            accounts.forEach((acc) => {
              const mapping = (data.mappings || []).find(m =>
                (acc.sid && m.windowsSid && m.windowsSid.toUpperCase() === acc.sid.toUpperCase()) ||
                (acc.name && m.windowsUsername && m.windowsUsername.toLowerCase() === acc.name.toLowerCase())
              );
              const role = acc.accountType || (mapping ? (mapping.accountType || (mapping.childId ? 'CHILD' : 'PARENT')) : 'NOT_ASSIGNED');
              const isChild = role === 'CHILD';
              const isParent = role === 'PARENT';
              const isManaged = Boolean(mapping && mapping.enabled && mapping.childId);

              let roleBadgeClass = 'badge-unassigned';
              let roleBadgeText = 'NOT ASSIGNED';
              if (isChild) {
                roleBadgeClass = 'badge-child';
                roleBadgeText = 'CHILD ACCOUNT';
              } else if (isParent) {
                roleBadgeClass = 'badge-parent';
                roleBadgeText = 'PARENT ACCOUNT';
              }

              let profileLabel = 'Not Assigned';
              if (isChild) {
                profileLabel = (mapping && mapping.childName ? mapping.childName : (acc.childName || 'Child Profile')) + ' (Child Profile)';
              } else if (isParent) {
                profileLabel = 'Parent / Unmanaged (Bypassed)';
              }

              const isProtected = isManaged;
              const isCurrent = Boolean(acc.isCurrentConsoleUser);
              const friendlyAccName = formatFriendlyAccount(acc.name);
              const hasDomain = String(acc.name).indexOf(String.fromCharCode(92)) !== -1;

              const tr = document.createElement('tr');
              tr.className = 'account-row';
              tr.innerHTML =
                '<td>' +
                  '<div class="user-pill">' +
                    escapeHtml(friendlyAccName) +
                    (isCurrent ? ' <span class="badge-current">ACTIVE USER</span>' : '') +
                  '</div>' +
                  (hasDomain ? '<div class="sid-text" style="color: #64748b; font-size: 11px;">' + escapeHtml(acc.name) + '</div>' : '') +
                  '<div class="sid-text">' +
                    (isCurrent ? 'Active Console Account' : 'Standard Windows Account') +
                  '</div>' +
                '</td>' +
                '<td>' +
                  '<span class="badge-role ' + roleBadgeClass + '">' + roleBadgeText + '</span>' +
                '</td>' +
                '<td style="color: #cbd5e1; font-weight: 600; font-size: 13px;">' +
                  escapeHtml(profileLabel) +
                '</td>' +
                '<td>' +
                  '<span class="' + (isProtected ? 'tag-protected' : 'tag-bypass') + '" style="font-weight:800; font-size:13px;">' +
                    (isProtected ? '● PROTECTED' : '○ BYPASSED') +
                  '</span>' +
                '</td>';
              tbody.appendChild(tr);
            });
          }
        }
      } catch (e) {
        if (!silent) showAlert('Failed to refresh status: ' + e.message, true);
      } finally {
        if (!silent) {
          if (statusLoading) statusLoading.style.display = 'none';
          if (statusScreen) {
            statusScreen.querySelectorAll('button').forEach(btn => btn.disabled = false);
          }
        }
      }
    }

    async function openParentDashboard() {
      try {
        const res = await fetch('/api/open-dashboard', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        window.open(data.url || 'https://safebrowse.porwal.online', '_blank', 'noopener');
      } catch {
        window.open('https://safebrowse.porwal.online', '_blank', 'noopener');
      }
    }

    async function fetchAsyncDiagnostics() {
      try {
        const res = await fetch('/api/check-protection');
        if (res.ok) {
          const data = await res.json();
          const sys = data.status;
          if (sys && sys.dnsEnforced !== undefined) {
            const el = document.getElementById('statDns');
            const sub = document.getElementById('statDnsSub');
            if (el) {
              if (sys.dnsEnforced) {
                el.innerHTML = '<span style="color: #10b981; font-weight: 800;">● Active</span>';
                if (sub) sub.innerText = 'SafeBrowse local DNS proxy active';
              } else {
                el.innerHTML = '<span style="color: #ef4444; font-weight: 800;">⚠️ Inactive</span>';
                if (sub) sub.innerText = 'DNS protection not enforcing';
              }
            }
          }
        }
      } catch {}
    }

    async function checkProtectionDiagnostics() {
      showAlert('Running SafeBrowse protection diagnostics...', false);
      try {
        const res = await fetch('/api/check-protection');
        const data = await res.json();
        if (data.success) {
          const sys = data.status || {};
          const isManaged = data.activePolicy?.isManaged;
          const msg = 'Protection Check: ' +
            (sys.dnsEnforced ? 'DNS Filter Active ✓ | ' : 'DNS Inactive ✗ | ') +
            'Session: ' + (isManaged ? 'Protected (' + (data.activePolicy.childName || 'Child') + ')' : 'Parent Unrestricted');
          showAlert(msg, !sys.dnsEnforced);
        } else {
          showAlert('Diagnostic check failed: ' + data.error, true);
        }
      } catch (e) {
        showAlert('Diagnostic check error: ' + e.message, true);
      }
    }

    function openDisconnectModal(isFinishDisconnect = false) {
      window._isFinishDisconnect = isFinishDisconnect;
      const modal = document.getElementById('disconnectModal');
      const progressBox = document.getElementById('disconnectProgressBox');
      const errorBox = document.getElementById('disconnectErrorBox');
      const buttons = document.getElementById('disconnectModalButtons');
      const btnCancel = document.getElementById('btnCancelDisconnect');
      const btnConfirm = document.getElementById('btnConfirmDisconnect');

      if (progressBox) progressBox.style.display = 'none';
      if (errorBox) { errorBox.style.display = 'none'; errorBox.innerText = ''; }
      if (buttons) buttons.style.display = 'flex';
      if (btnCancel) btnCancel.disabled = false;
      if (btnConfirm) btnConfirm.disabled = false;
      if (modal) modal.style.display = 'flex';
    }

    function closeDisconnectModal() {
      const modal = document.getElementById('disconnectModal');
      if (modal) modal.style.display = 'none';
    }

    async function executeDisconnect() {
      const btnCancel = document.getElementById('btnCancelDisconnect');
      const btnConfirm = document.getElementById('btnConfirmDisconnect');
      const progressBox = document.getElementById('disconnectProgressBox');
      const progressText = document.getElementById('disconnectProgressText');
      const errorBox = document.getElementById('disconnectErrorBox');

      if (btnCancel) btnCancel.disabled = true;
      if (btnConfirm) btnConfirm.disabled = true;
      if (errorBox) errorBox.style.display = 'none';
      if (progressBox) progressBox.style.display = 'block';
      if (progressText) progressText.innerText = 'Restoring network settings…';

      try {
        const endpoint = window._isFinishDisconnect ? '/api/finish-disconnect' : '/api/disconnect';
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { ...(managementSessionToken ? { 'x-management-session': managementSessionToken } : {}) }
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          if (progressText) progressText.innerText = 'Removing protection…';
          await new Promise(r => setTimeout(r, 300));
          if (progressText) progressText.innerText = 'Disconnecting from family…';
          await new Promise(r => setTimeout(r, 300));
          if (progressText) {
            progressText.innerHTML = '<span style="color:#10b981; font-weight:800;">✓ Computer disconnected successfully</span>';
          }
          managementSessionToken = null;
          try { localStorage.removeItem('sb_paired'); } catch {}
          setTimeout(() => {
            closeDisconnectModal();
            showScreen('screenConnect');
          }, 1000);
        } else {
          const rawErr = (data && data.error) ? data.error : "SafeBrowse could not safely restore this computer's network settings. No device settings were removed. Please try again.";
          const friendlyErr = sanitizeParentErrorMessageClient(rawErr);
          if (errorBox) {
            errorBox.innerText = friendlyErr;
            errorBox.style.display = 'block';
          }
          if (progressBox) progressBox.style.display = 'none';
          if (btnCancel) btnCancel.disabled = false;
          if (btnConfirm) btnConfirm.disabled = false;
        }
      } catch (e) {
        if (errorBox) {
          errorBox.innerText = "SafeBrowse could not safely restore this computer's network settings. No device settings were removed. Please try again.";
          errorBox.style.display = 'block';
        }
        if (progressBox) progressBox.style.display = 'none';
        if (btnCancel) btnCancel.disabled = false;
        if (btnConfirm) btnConfirm.disabled = false;
      }
    }

    async function confirmDisconnect() {
      const unlocked = await ensureManagementUnlocked();
      if (!unlocked) return;
      openDisconnectModal(false);
    }

    function reconnectComputer() {
      launchPairing();
    }

    // Resolve authoritative device state before exposing any pairing action.
    // A paired laptop must never flash the "Connect This Computer" screen while status loads.
    async function initStartupCheck() {
      showScreen('screenLoading');
      const loadingSpinner = document.getElementById('loadingSpinner');
      const loadingTitle = document.getElementById('loadingTitle');
      const loadingCopy = document.getElementById('loadingCopy');
      const loadingActions = document.getElementById('loadingActions');

      if (loadingSpinner) loadingSpinner.style.display = 'block';
      if (loadingActions) loadingActions.style.display = 'none';

      const wasPairedLocally = (function() {
        try { return localStorage.getItem('sb_paired') === '1'; } catch { return false; }
      })();

      if (wasPairedLocally) {
        if (loadingTitle) loadingTitle.textContent = "Checking protection settings...";
        if (loadingCopy) loadingCopy.textContent = "Verifying active protection, user session and policy enforcement...";
      } else {
        if (loadingTitle) loadingTitle.textContent = "Checking SafeBrowse protection...";
        if (loadingCopy) loadingCopy.textContent = "Please wait while SafeBrowse verifies this computer's connection, account mappings and protection status.";
      }

      // 1. Instant service availability check via dedicated lightweight /api/health endpoint (P0-8)
      let serviceAlive = false;
      for (let h = 0; h < 3; h++) {
        try {
          const hCtrl = new AbortController();
          const hTimeout = setTimeout(() => hCtrl.abort(), 2000);
          const hRes = await fetch('/api/health', { cache: 'no-store', signal: hCtrl.signal });
          clearTimeout(hTimeout);
          if (hRes.ok) {
            serviceAlive = true;
            break;
          }
        } catch {}
        if (!serviceAlive && h < 2) {
          await new Promise(r => setTimeout(r, 300));
        }
      }

      // 2. Fast Path: If service is alive and device was known to be paired, immediately show status screen!
      // Diagnostics run asynchronously and will not block opening the UI or flash Connect Computer.
      if (serviceAlive && wasPairedLocally) {
        appState.isPaired = true;
        showScreen('screenStatus');
        loadStatusScreen(true);
        return;
      }

      let authoritativeUnpairedResponses = 0;

      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 4000);
          const res = await fetch('/api/status', { cache: 'no-store', signal: controller.signal });
          clearTimeout(timeoutId);

          if (res.ok) {
            const data = await res.json();
            const isPaired = Boolean(data.isPaired || data.pairingStatus === 'CONNECTED' || data.pairingStatus === 'CONNECTED_LOCAL' || data.pairingStatus === 'SYNCING');
            appState.isPaired = isPaired;
            appState.pinConfigured = Boolean(data.pinConfigured);

            if (isPaired) {
              try { localStorage.setItem('sb_paired', '1'); } catch {}
              showScreen('screenStatus');
              return;
            }

            authoritativeUnpairedResponses += 1;
            if (authoritativeUnpairedResponses >= 2 && !wasPairedLocally) {
              try { localStorage.removeItem('sb_paired'); } catch {}
              showScreen('screenWelcome');
              return;
            }
          }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      if (wasPairedLocally || serviceAlive) {
        appState.isPaired = true;
        showScreen('screenStatus');
        return;
      }

      // Indeterminate startup failure: display recovery actions
      if (loadingSpinner) loadingSpinner.style.display = 'none';
      if (loadingTitle) loadingTitle.textContent = "Connection Check Indeterminate";
      if (loadingCopy) {
        loadingCopy.textContent = "SafeBrowse could not confirm this computer's status yet. Check that SafeBrowseChildService is running and click Retry.";
      }
      if (loadingActions) loadingActions.style.display = 'flex';
    }

    window.addEventListener('DOMContentLoaded', async () => {
      await initStartupCheck();
    });

    // Background watcher for elevated pairing completion
    setInterval(async () => {
      if (!appState.isPaired) {
        try {
          const res = await fetch('/api/status');
          const data = await res.json();
          if (data && (data.isPaired || data.pairingStatus === 'CONNECTED' || data.pairingStatus === 'CONNECTED_LOCAL' || data.pairingStatus === 'SYNCING')) {
            appState.isPaired = true;
            try { localStorage.setItem('sb_paired', '1'); } catch {}
            showAlert('Device attached successfully! Welcome to SafeBrowse.');
            showScreen('screenStatus');
          }
        } catch {}
      }
    }, 3000);
  </script>
</body>
</html>`;
  }
}

export const guiServer = new GuiServer();
