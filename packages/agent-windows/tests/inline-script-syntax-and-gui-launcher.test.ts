import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vm from 'vm';
import * as child_process from 'child_process';

process.env.NODE_ENV = 'test';

import { GuiServer } from '../src/gui-server';
import { ElevatedPairServer } from '../src/elevated-pair-server';
import { ElevatedConfigServer } from '../src/elevated-config-server';
import { ConfigManager } from '../src/config-manager';
import { WindowsAccountManager } from '../src/account-manager';
import { ParentPinManager } from '../src/parent-pin-manager';
import {
  safeExecAsync,
  safeExecFileAsync,
  safeSpawn,
  safeExecSync,
} from '../src/process-exec';

describe('SafeBrowse Windows Pilot — Inline Script Syntax & GUI Launcher Suite', () => {
  let tempDir: string;
  let configMgr: ConfigManager;
  let accountMgr: WindowsAccountManager;
  let pinMgr: ParentPinManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-gui-launcher-test-'));
    configMgr = new ConfigManager(tempDir);
    accountMgr = new WindowsAccountManager(tempDir);
    pinMgr = new ParentPinManager(configMgr);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // Helper to extract and validate all <script> blocks via Node vm.Script
  function validateAllInlineScripts(html: string, contextName: string): number {
    const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;
    let scriptCount = 0;
    while ((match = scriptRegex.exec(html)) !== null) {
      scriptCount++;
      const scriptCode = match[1];
      try {
        new vm.Script(scriptCode, { filename: `${contextName}-inline-script-${scriptCount}.js` });
      } catch (err: any) {
        assert.fail(
          `[FAIL] ${contextName} script #${scriptCount} failed vm.Script parsing: ${err.message}`
        );
      }
    }
    assert.ok(scriptCount > 0, `Expected at least one <script> block in ${contextName}`);
    return scriptCount;
  }

  // =========================================================================
  // 1. Mandatory CI Node vm.Script Validation
  // =========================================================================
  it('1. GuiServer.renderHtml() contains valid JavaScript with zero syntax errors', () => {
    const guiServer = new GuiServer(configMgr, accountMgr, {} as any, pinMgr);
    const html = (guiServer as any).renderHtml();
    const count = validateAllInlineScripts(html, 'GuiServer');
    assert.strictEqual(count, 1);
  });

  it('2. ElevatedPairServer.renderHtml() (setup-pairing) contains valid JavaScript with zero syntax errors', () => {
    const pairServer = new ElevatedPairServer(configMgr, accountMgr, {} as any, pinMgr, 'PAIRING');
    const html = (pairServer as any).renderHtml();
    const count = validateAllInlineScripts(html, 'ElevatedPairServer-setup-pairing');
    assert.strictEqual(count, 1);
  });

  it('3. ElevatedPairServer.renderPinBootstrapHtml() (bootstrap) contains valid JavaScript with zero syntax errors', () => {
    const pairServer = new ElevatedPairServer(configMgr, accountMgr, {} as any, pinMgr, 'PIN_BOOTSTRAP');
    const html = (pairServer as any).renderPinBootstrapHtml();
    const count = validateAllInlineScripts(html, 'ElevatedPairServer-bootstrap-pin');
    assert.strictEqual(count, 1);
  });

  it('4. ElevatedConfigServer.renderHtml() contains valid JavaScript with zero syntax errors', () => {
    const configServer = new ElevatedConfigServer(configMgr, accountMgr);
    const html = (configServer as any).renderHtml();
    const count = validateAllInlineScripts(html, 'ElevatedConfigServer');
    assert.strictEqual(count, 1);
  });

  // =========================================================================
  // 2. Bounded Startup State Machine & Loading UI
  // =========================================================================
  it('5. GuiServer HTML includes bounded startup state machine, retry UI, and diagnostics action', () => {
    const guiServer = new GuiServer(configMgr, accountMgr, {} as any, pinMgr);
    const html = (guiServer as any).renderHtml();

    // Verify elements for bounded startup
    assert.ok(html.includes('id="screenLoading"'), 'screenLoading screen must exist');
    assert.ok(html.includes('id="loadingSpinner"'), 'loadingSpinner element must exist');
    assert.ok(html.includes('id="loadingTitle"'), 'loadingTitle element must exist');
    assert.ok(html.includes('id="loadingCopy"'), 'loadingCopy element must exist');
    assert.ok(html.includes('id="loadingActions"'), 'loadingActions container must exist');
    assert.ok(html.includes('initStartupCheck()'), 'initStartupCheck function must be wired');
    assert.ok(html.includes('Retry Connection'), 'Retry Connection button must exist');
    assert.ok(html.includes('checkProtectionDiagnostics()'), 'Diagnostics button must be present');
  });

  it('6. Offline paired laptop displays "Connected (Local) — Cloud synchronization unavailable" and never reverts to unpaired', () => {
    const guiServer = new GuiServer(configMgr, accountMgr, {} as any, pinMgr);
    const html = (guiServer as any).renderHtml();

    assert.ok(
      html.includes('Connected (Local) — Cloud synchronization unavailable'),
      'Must display explicit local synchronization banner wording'
    );
    assert.ok(
      html.includes('wasPairedLocally'),
      'Startup logic must preserve locally paired state on offline laptops'
    );
  });

  // =========================================================================
  // 3. process-exec: Guaranteed Hidden Windows
  // =========================================================================
  it('7. process-exec enforces windowsHide: true even when caller passes windowsHide: false', async () => {
    // 1. Verify static precedence in process-exec.ts: ...HIDDEN_WINDOW_OPTIONS must come AFTER ...(options || {})
    const processExecPath = path.resolve(__dirname, '../src/process-exec.ts');
    const content = fs.readFileSync(processExecPath, 'utf8');
    const fnNames = ['safeExecFileAsync', 'safeExecAsync', 'safeSpawn', 'safeExecSync'];

    for (const fn of fnNames) {
      const fnIdx = content.indexOf(`export async function ${fn}`) !== -1
        ? content.indexOf(`export async function ${fn}`)
        : content.indexOf(`export function ${fn}`);
      assert.ok(fnIdx !== -1, `Function ${fn} must exist in process-exec.ts`);

      const fnBlock = content.slice(fnIdx, fnIdx + 400);
      const optIdx = fnBlock.indexOf('...(options || {})');
      const hideIdx = fnBlock.indexOf('...HIDDEN_WINDOW_OPTIONS');

      assert.ok(optIdx !== -1, `${fn} must spread caller options`);
      assert.ok(hideIdx !== -1, `${fn} must spread HIDDEN_WINDOW_OPTIONS`);
      assert.ok(
        hideIdx > optIdx,
        `${fn} must place HIDDEN_WINDOW_OPTIONS after caller options to prevent caller override`
      );
    }

    // 2. Functional invocation test with explicit windowsHide: false
    const resAsync = await safeExecAsync(`${process.execPath} -e "console.log('OK_ASYNC')"`, { windowsHide: false } as any);
    assert.strictEqual(resAsync.stdout.trim(), 'OK_ASYNC');

    const resFileAsync = await safeExecFileAsync(process.execPath, ['-e', 'console.log("OK_FILE_ASYNC")'], { windowsHide: false } as any);
    assert.strictEqual(resFileAsync.stdout.trim(), 'OK_FILE_ASYNC');

    const resSync = safeExecSync(`${process.execPath} -e "console.log('OK_SYNC')"`, { windowsHide: false } as any);
    assert.strictEqual(resSync.toString().trim(), 'OK_SYNC');

    const child = safeSpawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: false } as any);
    assert.ok(child.pid, 'safeSpawn must launch successfully');
  });

  // =========================================================================
  // 4. WiX Packaging & Shortcut Configuration
  // =========================================================================
  it('8. SafeBrowseChild-Pilot.wxs targets SafeBrowseGuiLauncher.exe without console arguments and eliminates auto-launch wizard on silent/upgrade installs', () => {
    const wxsPath = path.resolve(__dirname, '../wix/SafeBrowseChild-Pilot.wxs');
    assert.ok(fs.existsSync(wxsPath), 'SafeBrowseChild-Pilot.wxs must exist');

    const wxsContent = fs.readFileSync(wxsPath, 'utf8');

    // 1. GuiLauncher component defined
    assert.ok(
      wxsContent.includes('Id="GuiLauncherExecutable"'),
      'WXS must declare GuiLauncherExecutable component'
    );
    assert.ok(
      wxsContent.includes('Source="$(var.SourceDir)\\SafeBrowseGuiLauncher.exe"'),
      'WXS must reference SafeBrowseGuiLauncher.exe source'
    );
    assert.ok(
      wxsContent.includes('<ComponentRef Id="GuiLauncherExecutable" />'),
      'MainFeature must include GuiLauncherExecutable ComponentRef'
    );

    // 2. Start menu and desktop shortcuts target SafeBrowseGuiLauncher.exe
    assert.ok(
      wxsContent.includes('Id="StartMenuShortcut"'),
      'StartMenuShortcut must exist'
    );
    assert.ok(
      wxsContent.includes('Target="[INSTALLFOLDER]SafeBrowseGuiLauncher.exe"'),
      'Shortcuts must target SafeBrowseGuiLauncher.exe'
    );
    assert.ok(
      !wxsContent.includes('Arguments="gui"'),
      'Shortcuts must NOT pass Arguments="gui" to console binary'
    );

    // 3. LaunchFirstRunWizard removed from InstallExecuteSequence to protect silent installs / upgrades
    assert.ok(
      !wxsContent.includes('Action="LaunchFirstRunWizard"'),
      'LaunchFirstRunWizard must not be present in InstallExecuteSequence'
    );
  });

  // =========================================================================
  // 5. C# Windowless GUI Launcher Source Validation
  // =========================================================================
  it('9. SafeBrowseGuiLauncher.cs exists, implements mutex, checks responding server, and sets CreateNoWindow = true', () => {
    const csPath = path.resolve(__dirname, '../gui-launcher/SafeBrowseGuiLauncher.cs');
    assert.ok(fs.existsSync(csPath), 'SafeBrowseGuiLauncher.cs must exist');

    const csContent = fs.readFileSync(csPath, 'utf8');

    assert.ok(
      csContent.includes('SafeBrowseGuiLauncherMutex_'),
      'Must implement per-user named mutex check'
    );
    assert.ok(
      csContent.includes('http://127.0.0.1:8885/api/status'),
      'Must check if GUI server is already listening on 8885'
    );
    assert.ok(
      csContent.includes('CreateNoWindow = true'),
      'ProcessStartInfo must explicitly specify CreateNoWindow = true'
    );
    assert.ok(
      csContent.includes('UseShellExecute = false'),
      'ProcessStartInfo must explicitly specify UseShellExecute = false'
    );
    assert.ok(
      csContent.includes('ProcessWindowStyle.Hidden'),
      'ProcessStartInfo must explicitly specify ProcessWindowStyle.Hidden'
    );
  });
});
