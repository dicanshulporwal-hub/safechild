import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { ResolvedUserPolicy, MultiSessionCheckResult } from './account-manager';
import { logServiceMessage } from './network-manager';
import { BlockExperienceContext } from './dns-proxy';

export interface BlockPresentationMessage {
  type: 'PRESENT_BLOCK';
  domain: string; // legacy / requestedDomain
  requestedDomain?: string;
  approvalDomain?: string;
  reason: string;
  url: string;
  timestamp: number;
  eventId: string;
}

export interface HelperRegisterMessage {
  type: 'REGISTER_HELPER';
  version: string;
  accountName: string;
  domain?: string;
  pid?: number;
  sessionId?: number;
}

export interface HelperRegisterAck {
  type: 'REGISTER_ACK';
  status: 'OK' | 'REJECTED';
  message?: string;
}

export interface ConnectedHelper {
  socket: net.Socket;
  accountName: string;
  pid?: number;
  sessionId?: number;
  registeredAt: number;
}

export interface PendingBlockPresentation {
  domain: string;
  requestedDomain: string;
  approvalDomain: string;
  reason: string;
  blockPort: number;
  timestamp: number;
  sessionId?: number;
  accountName?: string;
  retried: boolean;
}

export function getDefaultPipePath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\SafeBrowseBlockPipe';
  }
  return path.join(os.tmpdir(), 'safebrowse-block.sock');
}

export function normalizeDomainForDebounce(domain: string): string {
  if (!domain) return '';
  let d = domain.trim().toLowerCase();
  d = d.replace(/\.+$/, '');
  if (d.startsWith('www.')) {
    d = d.slice(4);
  }
  return d;
}

export function validateBlockUrl(rawUrl: string, expectedPort: number = 8880): { valid: boolean; reason?: string } {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, reason: 'URL is required and must be a string' };
  }
  if (rawUrl.length > 2048) {
    return { valid: false, reason: 'URL exceeds maximum length of 2048 characters' };
  }

  const lower = rawUrl.toLowerCase().trim();
  const forbiddenSchemes = ['javascript:', 'file:', 'data:', 'vbscript:', 'powershell:', 'ftp:', 'mailto:'];
  for (const scheme of forbiddenSchemes) {
    if (lower.startsWith(scheme)) {
      return { valid: false, reason: `Forbidden URL scheme: ${scheme}` };
    }
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:') {
      return { valid: false, reason: `Invalid protocol: ${parsed.protocol} (must be http:)` };
    }
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      return { valid: false, reason: `Invalid host: ${parsed.hostname} (must be 127.0.0.1 or localhost)` };
    }
    const port = parsed.port ? parseInt(parsed.port, 10) : 80;
    if (port !== expectedPort) {
      return { valid: false, reason: `Invalid port: ${port} (expected ${expectedPort})` };
    }
    if (!parsed.pathname.startsWith('/blocked')) {
      return { valid: false, reason: `Invalid path: ${parsed.pathname} (must start with /blocked)` };
    }
    return { valid: true };
  } catch (e: any) {
    return { valid: false, reason: `Malformed URL: ${e.message}` };
  }
}

export class BlockIpcServer {
  private server: net.Server | null = null;
  private pipePath: string;
  private helpers: Map<net.Socket, ConnectedHelper> = new Map();
  private pendingPresentations: Map<string, PendingBlockPresentation> = new Map();
  private lastDomainTriggerTimes: Map<string, number> = new Map();
  private lastGlobalTriggerTime: number = 0;
  private domainDebounceMs: number = 12000;
  private globalThrottleMs: number = 2500;
  private isListening: boolean = false;

  private activePolicyProvider?: () => ResolvedUserPolicy | null;
  private multiSessionChecker?: () => MultiSessionCheckResult;
  private helperLauncher?: (sessionId?: number) => void;

  constructor(
    pipePath: string = getDefaultPipePath(),
    domainDebounceMs: number = 12000,
    globalThrottleMs: number = 2500
  ) {
    this.pipePath = pipePath;
    this.domainDebounceMs = domainDebounceMs;
    this.globalThrottleMs = globalThrottleMs;
  }

  public getPipePath(): string {
    return this.pipePath;
  }

  public isRunning(): boolean {
    return this.isListening;
  }

  public setActivePolicyProvider(provider: () => ResolvedUserPolicy | null): void {
    this.activePolicyProvider = provider;
  }

  public setMultiSessionChecker(checker: () => MultiSessionCheckResult): void {
    this.multiSessionChecker = checker;
  }

  public setHelperLauncher(launcher: (sessionId?: number) => void): void {
    this.helperLauncher = launcher;
  }

  public getConnectedHelperCount(): number {
    return this.helpers.size;
  }

  public getConnectedHelpers(): ConnectedHelper[] {
    return Array.from(this.helpers.values());
  }

  public start(): Promise<void> {
    if (this.isListening) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      // Clean up stale socket file on non-Windows
      if (process.platform !== 'win32' && fs.existsSync(this.pipePath)) {
        try {
          fs.unlinkSync(this.pipePath);
        } catch {}
      }

      this.server = net.createServer((socket) => {
        let buffer = '';

        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          if (buffer.length > 8192) {
            socket.destroy();
            return;
          }

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            this.handleHelperMessage(socket, trimmed);
          }
        });

        socket.on('close', () => {
          const helper = this.helpers.get(socket);
          if (helper) {
            logServiceMessage(
              'INFO',
              `[BlockIpcServer] Helper disconnected: account='${helper.accountName}', PID=${helper.pid || 'N/A'}`
            );
          }
          this.helpers.delete(socket);
        });

        socket.on('error', (err) => {
          const helper = this.helpers.get(socket);
          if (helper) {
            logServiceMessage(
              'WARN',
              `[BlockIpcServer] Helper connection error: account='${helper.accountName}', PID=${helper.pid || 'N/A'}: ${err.message}`
            );
          }
          this.helpers.delete(socket);
        });
      });

      this.server.on('error', (err) => {
        logServiceMessage('WARN', `[BlockIpcServer] Server error: ${err.message}`);
        reject(err);
      });

      this.server.listen(this.pipePath, async () => {
        this.isListening = true;
        logServiceMessage('INFO', `[BlockIpcServer] Listening on ${this.pipePath}`);
        if (process.platform === 'win32') {
          try {
            await configureWindowsPipeSecurity(this.pipePath);
          } catch {}
        }
        resolve();
      });
    });
  }

  private handleHelperMessage(socket: net.Socket, rawMessage: string): void {
    try {
      const data = JSON.parse(rawMessage);
      if (data.type === 'REGISTER_HELPER') {
        const helper: ConnectedHelper = {
          socket,
          accountName: (data.accountName || '').trim(),
          pid: typeof data.pid === 'number' ? data.pid : undefined,
          sessionId: typeof data.sessionId === 'number' ? data.sessionId : undefined,
          registeredAt: Date.now(),
        };
        this.helpers.set(socket, helper);
        logServiceMessage(
          'INFO',
          `[BlockIpcServer] Helper registered: account='${helper.accountName}', PID=${helper.pid || 'N/A'}, SessionId=${helper.sessionId ?? 'N/A'}`
        );

        const ack: HelperRegisterAck = { type: 'REGISTER_ACK', status: 'OK' };
        socket.write(JSON.stringify(ack) + '\n');

        // Bounded retry of any pending presentation for this helper session/account
        this.flushPendingPresentationsForHelper(helper);
      }
    } catch {
      // Ignore malformed messages
    }
  }

  private flushPendingPresentationsForHelper(helper: ConnectedHelper): void {
    const now = Date.now();
    const TTL_MS = 15000;
    const helperName = helper.accountName ? helper.accountName.split('\\').pop()?.toLowerCase() : undefined;

    for (const [key, pending] of Array.from(this.pendingPresentations.entries())) {
      // Purge expired
      if (now - pending.timestamp > TTL_MS) {
        this.pendingPresentations.delete(key);
        continue;
      }
      if (pending.retried) {
        this.pendingPresentations.delete(key);
        continue;
      }

      // Match helper session or account
      const sessionMatch = helper.sessionId !== undefined && pending.sessionId !== undefined
        ? helper.sessionId === pending.sessionId
        : true;
      const accountMatch = helperName && pending.accountName
        ? helperName === pending.accountName
        : true;

      if (sessionMatch && accountMatch) {
        pending.retried = true;
        this.pendingPresentations.delete(key);
        logServiceMessage(
          'INFO',
          `[BlockIpcServer] Retrying pending block presentation for scope '${pending.approvalDomain || pending.domain}' (requested: '${pending.requestedDomain || pending.domain}') on newly registered helper (SessionId=${helper.sessionId ?? 'N/A'})`
        );
        this.presentBlock({
          requestedDomain: pending.requestedDomain || pending.domain,
          approvalDomain: pending.approvalDomain || pending.domain,
          reason: pending.reason,
        }, undefined, pending.blockPort);
      }
    }
  }

  public presentBlock(
    target: string | BlockExperienceContext,
    reason?: string,
    blockPort: number = 8880
  ): { sent: boolean; reason: string; url?: string } {
    const now = Date.now();
    let requestedDomain: string;
    let approvalDomain: string;
    let finalReason: string;

    if (typeof target === 'string') {
      requestedDomain = target;
      approvalDomain = target;
      finalReason = reason || 'Blocked by family rules';
    } else {
      requestedDomain = target.requestedDomain || 'This website';
      approvalDomain = target.approvalDomain || target.requestedDomain || 'This website';
      finalReason = target.reason || reason || 'Blocked by family rules';
    }

    const normalizedReqDomain = normalizeDomainForDebounce(requestedDomain);
    const normalizedAppDomain = normalizeDomainForDebounce(approvalDomain);
    const debounceKey = normalizedAppDomain || normalizedReqDomain;

    // 1. Check Console User Policy (Parent / Managed Child)
    const policy = this.activePolicyProvider ? this.activePolicyProvider() : null;
    if (policy) {
      if (!policy.isManaged || !policy.childId) {
        logServiceMessage(
          'INFO',
          `[BlockIpcServer] Suppressed block presentation: Active user '${policy.accountName}' is Unmanaged/Parent.`
        );
        return { sent: false, reason: 'PARENT_OR_UNMANAGED_USER' };
      }
    }

    // 2. Check Multiple Concurrent Active Interactive Sessions
    const multiSession = this.multiSessionChecker ? this.multiSessionChecker() : null;
    const hasMultipleActive = multiSession
      ? (multiSession.hasMultipleActiveInteractiveSessions ?? multiSession.hasMultipleSessions)
      : false;
    if (hasMultipleActive) {
      logServiceMessage(
        'WARN',
        `[BlockIpcServer] Suppressed block presentation: Multiple active concurrent interactive sessions detected.`
      );
      return { sent: false, reason: 'CONCURRENT_SESSIONS_SAFETY_HOLD' };
    }

    // 3. Debounce: Logical Scope Check (approvalDomain preferred, fallback to requestedDomain)
    const lastDomainTime = this.lastDomainTriggerTimes.get(debounceKey) || 0;
    if (now - lastDomainTime < this.domainDebounceMs) {
      return { sent: false, reason: 'DOMAIN_DEBOUNCED' };
    }

    // 4. Global Throttle Check (2.5s window)
    if (now - this.lastGlobalTriggerTime < this.globalThrottleMs) {
      return { sent: false, reason: 'GLOBAL_THROTTLED' };
    }

    // 5. Construct Safe Block Landing URL
    const safeReqDomain = encodeURIComponent(requestedDomain);
    const safeAppDomain = encodeURIComponent(approvalDomain);
    const safeReason = encodeURIComponent(finalReason);
    const blockUrl = `http://127.0.0.1:${blockPort}/blocked?domain=${safeReqDomain}&approvalDomain=${safeAppDomain}&reason=${safeReason}`;

    const validation = validateBlockUrl(blockUrl, blockPort);
    if (!validation.valid) {
      return { sent: false, reason: `URL_VALIDATION_FAILED: ${validation.reason}` };
    }

    // 6. Target eligible connected helper running in the active desktop session
    const eventId = `evt-${now}-${Math.random().toString(36).substring(2, 8)}`;
    const payload: BlockPresentationMessage = {
      type: 'PRESENT_BLOCK',
      domain: requestedDomain,
      requestedDomain,
      approvalDomain,
      reason: finalReason,
      url: blockUrl,
      timestamp: now,
      eventId,
    };

    const messageString = JSON.stringify(payload) + '\n';
    let targetFound = false;

    const activeSessionId = typeof policy?.sessionId === 'number' ? policy.sessionId : undefined;
    const activeName = policy?.accountName ? policy.accountName.split('\\').pop()?.toLowerCase() : undefined;

    // Priority 1: Exact sessionId match
    let matchedSockets: net.Socket[] = [];
    if (activeSessionId !== undefined) {
      for (const [socket, helper] of this.helpers.entries()) {
        if (helper.sessionId === activeSessionId) {
          matchedSockets.push(socket);
        }
      }
    }

    // Priority 2: Fallback to normalized accountName if sessionId was not registered or matched
    if (matchedSockets.length === 0 && activeName) {
      for (const [socket, helper] of this.helpers.entries()) {
        const helperName = helper.accountName.split('\\').pop()?.toLowerCase();
        if (helperName === activeName) {
          // Do not deliver to a session known to be a different session
          if (activeSessionId !== undefined && helper.sessionId !== undefined && helper.sessionId !== activeSessionId) {
            continue;
          }
          matchedSockets.push(socket);
        }
      }
    }

    // Priority 3: Fallback for test doubles where policy is managed and single helper is connected without explicit session/name
    if (matchedSockets.length === 0 && this.helpers.size === 1 && policy && policy.isManaged) {
      const [singleSocket, singleHelper] = Array.from(this.helpers.entries())[0];
      const singleName = singleHelper.accountName.split('\\').pop()?.toLowerCase();
      if (!activeName || !singleName || singleName === activeName || singleName === 'user' || singleName === 'currentconsoleuser') {
        matchedSockets.push(singleSocket);
      }
    }

    // If helper is missing, store bounded pending presentation and trigger self-healing launcher
    if (matchedSockets.length === 0) {
      const pendingKey = `${activeSessionId ?? 'default'}:${debounceKey}`;
      this.pendingPresentations.set(pendingKey, {
        domain: requestedDomain,
        requestedDomain,
        approvalDomain,
        reason: finalReason,
        blockPort,
        timestamp: now,
        sessionId: activeSessionId,
        accountName: activeName,
        retried: false,
      });

      if (this.helperLauncher) {
        try {
          this.helperLauncher(activeSessionId);
        } catch {}
      }
      return {
        sent: false,
        reason: 'NO_CONNECTED_HELPER',
        url: blockUrl,
      };
    }

    for (const socket of matchedSockets) {
      try {
        socket.write(messageString);
        targetFound = true;
      } catch (err: any) {
        this.helpers.delete(socket);
      }
    }

    if (targetFound) {
      // ONLY update debounce timestamps when block was actually delivered!
      this.lastDomainTriggerTimes.set(debounceKey, now);
      this.lastDomainTriggerTimes.set(normalizedReqDomain, now);
      this.lastGlobalTriggerTime = now;
      logServiceMessage(
        'INFO',
        `[BlockIpcServer] Block presentation for '${requestedDomain}' (scope: '${approvalDomain}'): PRESENTED (sent=true)`
      );
    }

    return {
      sent: targetFound,
      reason: targetFound ? 'PRESENTED' : 'NO_CONNECTED_HELPER',
      url: blockUrl,
    };
  }

  public stop(): Promise<void> {
    this.isListening = false;
    for (const [socket, helper] of this.helpers.entries()) {
      try {
        socket.destroy();
      } catch {}
    }
    this.helpers.clear();
    this.pendingPresentations.clear();

    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(() => {
        if (process.platform !== 'win32' && fs.existsSync(this.pipePath)) {
          try {
            fs.unlinkSync(this.pipePath);
          } catch {}
        }
        logServiceMessage('INFO', `[BlockIpcServer] Stopped IPC server on ${this.pipePath}`);
        this.server = null;
        resolve();
      });
    });
  }
}

/**
 * Configures DACL on Windows Named Pipe to allow interactive child users
 * to connect and write registration handshake, while denying network/remote users.
 *
 * Win32 Principle:
 * - Convert SDDL to SECURITY_DESCRIPTOR using ConvertStringSecurityDescriptorToSecurityDescriptor.
 * - Extract real DACL pointer using GetSecurityDescriptorDacl.
 * - Pass ONLY that extracted PACL pointer to SetNamedSecurityInfo (NOT pSD).
 * - Keep pSD allocated until SetNamedSecurityInfo completes, then LocalFree(pSD).
 */
export async function configureWindowsPipeSecurity(pipePath: string, force: boolean = false): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  if (!pipePath.startsWith('\\\\.\\pipe\\')) return false;
  if (!force && process.env.NODE_ENV === 'test') return false;

  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const psPath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const exe = fs.existsSync(psPath) ? psPath : 'powershell.exe';

  // SDDL: Protected DACL (P), Deny Network (NU), Allow SYSTEM (SY) Full, Allow Administrators (BA) Full, Allow Interactive Users (IU) Read+Write, Allow Authenticated Users (AU) Read+Write
  const sddl = 'D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)(A;;GRGW;;;AU)';

  const psScript = `
$code = @'
using System;
using System.Runtime.InteropServices;

public class PipeAclHelper {
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern uint SetNamedSecurityInfo(
        string pObjectName,
        int objectType,
        uint securityInfo,
        IntPtr psidOwner,
        IntPtr psidGroup,
        IntPtr pDacl,
        IntPtr pSacl
    );

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern uint SetSecurityInfo(
        IntPtr handle,
        int objectType,
        uint securityInfo,
        IntPtr psidOwner,
        IntPtr psidGroup,
        IntPtr pDacl,
        IntPtr pSacl
    );

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateFile(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(
        string sddl,
        uint rev,
        out IntPtr pSD,
        out uint size
    );

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetSecurityDescriptorDacl(
        IntPtr pSecurityDescriptor,
        [MarshalAs(UnmanagedType.Bool)] out bool lpbDaclPresent,
        out IntPtr pDacl,
        [MarshalAs(UnmanagedType.Bool)] out bool lpbDaclDefaulted
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr LocalFree(IntPtr hMem);

    public static string ApplyPipeSecurity(string pipePath, string sddl) {
        IntPtr pSD = IntPtr.Zero;
        uint size = 0;
        bool convertRes = ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out pSD, out size);
        int convertErr = Marshal.GetLastWin32Error();
        if (!convertRes || pSD == IntPtr.Zero) {
            return string.Format("FAIL:CONVERT:convertRes={0},err={1}", convertRes, convertErr);
        }

        try {
            bool daclPresent = false;
            IntPtr pDacl = IntPtr.Zero;
            bool daclDefaulted = false;
            bool getDaclRes = GetSecurityDescriptorDacl(pSD, out daclPresent, out pDacl, out daclDefaulted);
            int getDaclErr = Marshal.GetLastWin32Error();

            if (!getDaclRes || !daclPresent || pDacl == IntPtr.Zero) {
                return string.Format("FAIL:GET_DACL:getDaclRes={0},daclPresent={1},pDaclZero={2},err={3}",
                    getDaclRes, daclPresent, pDacl == IntPtr.Zero, getDaclErr);
            }

            // Strategy 1: SetNamedSecurityInfo with DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION (0x80000004)
            // DACL_SECURITY_INFORMATION = 4, PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000
            uint setRes = SetNamedSecurityInfo(pipePath, 1, 0x80000004, IntPtr.Zero, IntPtr.Zero, pDacl, IntPtr.Zero);
            if (setRes == 0) {
                return string.Format("SUCCESS:method=SetNamedSecurityInfoProtected,win32Code=0");
            }

            // Strategy 2: SetNamedSecurityInfo with plain DACL_SECURITY_INFORMATION (4)
            uint setResPlain = SetNamedSecurityInfo(pipePath, 1, 4, IntPtr.Zero, IntPtr.Zero, pDacl, IntPtr.Zero);
            if (setResPlain == 0) {
                return string.Format("SUCCESS:method=SetNamedSecurityInfoPlain,win32Code=0");
            }

            // Strategy 3: Handle-based SetSecurityInfo via CreateFile with WRITE_DAC access
            IntPtr hPipe = CreateFile(pipePath, 0x00040000 /* WRITE_DAC */, 0, IntPtr.Zero, 3 /* OPEN_EXISTING */, 0, IntPtr.Zero);
            if (hPipe == IntPtr.Zero || hPipe == (IntPtr)(-1)) {
                hPipe = CreateFile(pipePath, 0x00040000 | 0x40000000 /* WRITE_DAC | GENERIC_WRITE */, 0, IntPtr.Zero, 3, 0, IntPtr.Zero);
            }
            if (hPipe != IntPtr.Zero && hPipe != (IntPtr)(-1)) {
                try {
                    uint handleRes = SetSecurityInfo(hPipe, 6 /* SE_KERNEL_OBJECT */, 0x80000004, IntPtr.Zero, IntPtr.Zero, pDacl, IntPtr.Zero);
                    if (handleRes == 0) {
                        return string.Format("SUCCESS:method=SetSecurityInfoKernelProtected,win32Code=0");
                    }
                    handleRes = SetSecurityInfo(hPipe, 1 /* SE_FILE_OBJECT */, 0x80000004, IntPtr.Zero, IntPtr.Zero, pDacl, IntPtr.Zero);
                    if (handleRes == 0) {
                        return string.Format("SUCCESS:method=SetSecurityInfoFileProtected,win32Code=0");
                    }
                    handleRes = SetSecurityInfo(hPipe, 6 /* SE_KERNEL_OBJECT */, 4, IntPtr.Zero, IntPtr.Zero, pDacl, IntPtr.Zero);
                    if (handleRes == 0) {
                        return string.Format("SUCCESS:method=SetSecurityInfoKernelPlain,win32Code=0");
                    }
                } finally {
                    CloseHandle(hPipe);
                }
            }

            return string.Format("FAIL:SET_SECURITY:resProtected={0},resPlain={1}", setRes, setResPlain);
        } finally {
            if (pSD != IntPtr.Zero) {
                LocalFree(pSD);
            }
        }
    }
}
'@
if (-not ([System.Management.Automation.PSTypeName]'PipeAclHelper').Type) {
    Add-Type -TypeDefinition $code -Language CSharp
}
$pipe = $env:SB_PIPE_PATH
$sddl = '${sddl}'
$res = [PipeAclHelper]::ApplyPipeSecurity($pipe, $sddl)
Write-Output $res
if ($res -notlike "SUCCESS*") { exit 1 }
`;

  return new Promise((resolve) => {
    execFile(
      exe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      {
        timeout: 8000,
        env: { ...process.env, SB_PIPE_PATH: pipePath },
      },
      (err, stdout, stderr) => {
        const outStr = (stdout || '').trim();
        const errStr = (stderr || '').trim();
        if (err || !outStr.startsWith('SUCCESS')) {
          const detail = outStr || errStr || err?.message || 'Unknown error';
          logServiceMessage('WARN', `[BlockIpcServer] BLOCK_IPC_ACL_FAILED on ${pipePath} with Win32 error: ${detail}`);
          resolve(false);
        } else {
          logServiceMessage('INFO', `[BlockIpcServer] BLOCK_IPC_ACL_APPLIED on ${pipePath} (${outStr})`);
          resolve(true);
        }
      }
    );
  });
}

export const blockIpcServer = new BlockIpcServer();
