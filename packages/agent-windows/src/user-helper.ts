import * as net from 'net';
import * as os from 'os';
import { spawn } from 'child_process';
import {
  getDefaultPipePath,
  validateBlockUrl,
  BlockPresentationMessage,
  HelperRegisterMessage,
} from './block-ipc';
import { WINDOWS_AGENT_VERSION } from './sync-client';

export type BrowserLaunchHandler = (url: string) => Promise<boolean> | boolean;

export class SafeBrowseUserSessionHelper {
  private pipePath: string;
  private accountName: string;
  private socket: net.Socket | null = null;
  private isRunning: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private browserLauncher: BrowserLaunchHandler;
  private onBlockReceivedCallback?: (msg: BlockPresentationMessage) => void;
  private expectedPort: number = 8880;
  private sessionId?: number;

  constructor(
    pipePath: string = getDefaultPipePath(),
    accountName?: string,
    browserLauncher?: BrowserLaunchHandler,
    sessionId?: number
  ) {
    this.pipePath = pipePath;
    this.accountName = accountName || process.env.USERNAME || process.env.USER || os.userInfo().username || 'User';
    this.browserLauncher = browserLauncher || this.defaultLaunchBrowser.bind(this);
    this.sessionId = sessionId;
  }

  public setSessionId(id: number): void {
    this.sessionId = id;
  }

  public getSessionId(): number | undefined {
    return this.sessionId;
  }

  public setBrowserLauncherForTesting(launcher: BrowserLaunchHandler): void {
    this.browserLauncher = launcher;
  }

  public setOnBlockReceived(callback: (msg: BlockPresentationMessage) => void): void {
    this.onBlockReceivedCallback = callback;
  }

  public setExpectedPort(port: number): void {
    this.expectedPort = port;
  }

  public isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.connect();
  }

  private connect(): void {
    if (!this.isRunning) return;

    this.socket = net.connect(this.pipePath, () => {
      // Send Registration Handshake
      const registerPayload: HelperRegisterMessage = {
        type: 'REGISTER_HELPER',
        version: WINDOWS_AGENT_VERSION,
        accountName: this.accountName,
        pid: process.pid,
        sessionId: this.sessionId,
      };

      try {
        this.socket?.write(JSON.stringify(registerPayload) + '\n');
      } catch {}
    });

    let buffer = '';
    this.socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 16384) {
        this.socket?.destroy();
        return;
      }

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.handleMessage(trimmed);
      }
    });

    this.socket.on('close', () => {
      this.socket = null;
      this.scheduleReconnect();
    });

    this.socket.on('error', () => {
      // SCM service not yet ready or restarting; silent retry
      if (this.socket) {
        this.socket.destroy();
        this.socket = null;
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.isRunning || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'PRESENT_BLOCK') {
        const blockMsg = msg as BlockPresentationMessage;

        // Strict URL Validation against localhost port 8880
        const validation = validateBlockUrl(blockMsg.url, this.expectedPort);
        if (!validation.valid) {
          console.warn(`[SafeBrowse UserHelper] Rejected untrusted block URL: ${validation.reason}`);
          return;
        }

        if (this.onBlockReceivedCallback) {
          this.onBlockReceivedCallback(blockMsg);
        }

        this.browserLauncher(blockMsg.url);
      }
    } catch {
      // Ignore invalid JSON
    }
  }

  /**
   * Opens the block landing page using the interactive user session's DEFAULT browser.
   * Uses Windows shell URL association (cmd.exe /c start "" "<url>").
   * Never hardcodes msedge.exe, chrome.exe, or firefox.exe.
   */
  private defaultLaunchBrowser(url: string): boolean {
    if (process.platform === 'win32') {
      try {
        const child = spawn('cmd.exe', ['/c', 'start', '', url], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        return true;
      } catch (err: any) {
        console.error(`[SafeBrowse UserHelper] Failed to launch default browser: ${err.message}`);
        return false;
      }
    }
    return true;
  }

  public stop(): Promise<void> {
    this.isRunning = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    return new Promise((resolve) => {
      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.end(() => {
          this.socket?.destroy();
          this.socket = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
