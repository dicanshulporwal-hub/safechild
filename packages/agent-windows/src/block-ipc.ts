import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { ResolvedUserPolicy, MultiSessionCheckResult } from './account-manager';
import { logServiceMessage } from './network-manager';

export interface BlockPresentationMessage {
  type: 'PRESENT_BLOCK';
  domain: string;
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
  registeredAt: number;
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
  private lastDomainTriggerTimes: Map<string, number> = new Map();
  private lastGlobalTriggerTime: number = 0;
  private domainDebounceMs: number = 12000;
  private globalThrottleMs: number = 2500;
  private isListening: boolean = false;

  private activePolicyProvider?: () => ResolvedUserPolicy | null;
  private multiSessionChecker?: () => MultiSessionCheckResult;

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
          pid: data.pid,
          registeredAt: Date.now(),
        };
        this.helpers.set(socket, helper);
        logServiceMessage(
          'INFO',
          `[BlockIpcServer] Helper registered: account='${helper.accountName}', PID=${helper.pid || 'N/A'}`
        );

        const ack: HelperRegisterAck = { type: 'REGISTER_ACK', status: 'OK' };
        socket.write(JSON.stringify(ack) + '\n');
      }
    } catch {
      // Ignore malformed messages
    }
  }

  public presentBlock(
    domain: string,
    reason: string,
    blockPort: number = 8880
  ): { sent: boolean; reason: string; url?: string } {
    const now = Date.now();
    const normalizedDomain = normalizeDomainForDebounce(domain);

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

    // 2. Check Multiple Concurrent Interactive Sessions
    const multiSession = this.multiSessionChecker ? this.multiSessionChecker() : null;
    if (multiSession && multiSession.hasMultipleSessions) {
      logServiceMessage(
        'WARN',
        `[BlockIpcServer] Suppressed block presentation: Multiple interactive sessions detected.`
      );
      return { sent: false, reason: 'CONCURRENT_SESSIONS_SAFETY_HOLD' };
    }

    // 3. Debounce: Normalized Domain Check (10-15s window, default 12s)
    const lastDomainTime = this.lastDomainTriggerTimes.get(normalizedDomain) || 0;
    if (now - lastDomainTime < this.domainDebounceMs) {
      return { sent: false, reason: 'DOMAIN_DEBOUNCED' };
    }

    // 4. Global Throttle Check (2.5s window)
    if (now - this.lastGlobalTriggerTime < this.globalThrottleMs) {
      return { sent: false, reason: 'GLOBAL_THROTTLED' };
    }

    // 5. Construct Safe Block Landing URL
    const safeDomain = encodeURIComponent(domain);
    const safeReason = encodeURIComponent(reason);
    const blockUrl = `http://127.0.0.1:${blockPort}/blocked?domain=${safeDomain}&reason=${safeReason}`;

    const validation = validateBlockUrl(blockUrl, blockPort);
    if (!validation.valid) {
      return { sent: false, reason: `URL_VALIDATION_FAILED: ${validation.reason}` };
    }

    // Update debounce timestamps
    this.lastDomainTriggerTimes.set(normalizedDomain, now);
    this.lastGlobalTriggerTime = now;

    // 6. Broadcast to eligible connected helper(s)
    const eventId = `evt-${now}-${Math.random().toString(36).substring(2, 8)}`;
    const payload: BlockPresentationMessage = {
      type: 'PRESENT_BLOCK',
      domain,
      reason,
      url: blockUrl,
      timestamp: now,
      eventId,
    };

    const messageString = JSON.stringify(payload) + '\n';
    let targetFound = false;

    for (const [socket, helper] of this.helpers.entries()) {
      if (policy && helper.accountName) {
        // Normalize usernames for comparison (strip domain prefixes e.g. LAPTOP\Rahul -> rahul)
        const activeName = policy.accountName.split('\\').pop()?.toLowerCase();
        const helperName = helper.accountName.split('\\').pop()?.toLowerCase();
        if (activeName && helperName && activeName !== helperName) {
          continue; // Do not deliver Child A's event to Child B or Parent
        }
      }

      try {
        socket.write(messageString);
        targetFound = true;
      } catch (err: any) {
        this.helpers.delete(socket);
      }
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
 */
export async function configureWindowsPipeSecurity(pipePath: string): Promise<void> {
  if (process.platform !== 'win32') return;
  if (!pipePath.startsWith('\\\\.\\pipe\\')) return;
  if (process.env.NODE_ENV === 'test') return;

  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const psPath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const exe = fs.existsSync(psPath) ? psPath : 'powershell.exe';

  // SDDL: Deny Network (NU), Allow SYSTEM (SY) Full, Allow Administrators (BA) Full, Allow Interactive Users (IU) Read+Write, Allow Authenticated Users (AU) Read+Write
  const psScript = `
$code = @'
using System;
using System.Runtime.InteropServices;
public class PipeAclHelper {
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern uint SetNamedSecurityInfo(
        string pObjectName, int objectType, uint securityInfo,
        IntPtr psidOwner, IntPtr psidGroup, IntPtr pDacl, IntPtr pSacl
    );
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(
        string sddl, uint rev, out IntPtr pSD, out uint size
    );
    [DllImport("kernel32.dll")]
    public static extern IntPtr LocalFree(IntPtr hMem);
}
'@
Add-Type -TypeDefinition $code -Language CSharp
$pSD = [IntPtr]::Zero; $size = 0
$sddl = "D:(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)(A;;GRGW;;;AU)"
if ([PipeAclHelper]::ConvertStringSecurityDescriptorToSecurityDescriptor($sddl, 1, [ref]$pSD, [ref]$size)) {
    $res = [PipeAclHelper]::SetNamedSecurityInfo("${pipePath}", 1, 4, [IntPtr]::Zero, [IntPtr]::Zero, $pSD, [IntPtr]::Zero)
    [PipeAclHelper]::LocalFree($pSD)
    if ($res -ne 0) { exit $res }
}
`;

  return new Promise((resolve) => {
    execFile(
      exe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { timeout: 5000 },
      (err) => {
        if (err) {
          logServiceMessage('WARN', `[BlockIpcServer] [WARN] Pipe ACL configuration note: ${err.message}`);
        } else {
          logServiceMessage('INFO', `[BlockIpcServer] Configured local pipe ACL for interactive user sessions on ${pipePath}`);
        }
        resolve();
      }
    );
  });
}

export const blockIpcServer = new BlockIpcServer();
