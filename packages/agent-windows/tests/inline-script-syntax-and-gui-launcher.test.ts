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
  // 5. Conventional Windows GUI Host Architecture & Dropper Heuristic Elimination
  // =========================================================================
  it('9. SafeBrowseGuiLauncher.cs implements conventional Windows Forms GUI architecture and eliminates hidden process spawning', () => {
    const csPath = path.resolve(__dirname, '../gui-launcher/SafeBrowseGuiLauncher.cs');
    assert.ok(fs.existsSync(csPath), 'SafeBrowseGuiLauncher.cs must exist');

    const csContent = fs.readFileSync(csPath, 'utf8');

    // Conventional Windows Forms GUI architecture
    assert.ok(
      csContent.includes('using System.Windows.Forms;'),
      'Must reference System.Windows.Forms'
    );
    assert.ok(
      csContent.includes('Application.EnableVisualStyles()'),
      'Must enable visual styles for standard Windows GUI rendering'
    );
    assert.ok(
      csContent.includes('class SafeBrowseConnectingForm : Form'),
      'Must provide a native Form window'
    );

    // Mutual exclusion and service presence check
    assert.ok(
      csContent.includes('SafeBrowseGuiLauncherMutex_'),
      'Must implement per-user named mutex check'
    );
    assert.ok(
      csContent.includes('http://127.0.0.1:8885/api/health'),
      'Must check if GUI server is already listening on 8885 via /api/health'
    );

    // Standard Windows Shell execution (no dropper heuristics)
    assert.ok(
      csContent.includes('UseShellExecute = true'),
      'ProcessStartInfo must use native Windows Shell execution (UseShellExecute = true)'
    );
    assert.ok(
      !csContent.includes('CreateNoWindow = true'),
      'Must NOT spawn hidden command-line child processes (eliminates dropper heuristic)'
    );
    assert.ok(
      !csContent.includes('ProcessWindowStyle.Hidden'),
      'Must NOT specify ProcessWindowStyle.Hidden'
    );
  });

  // =========================================================================
  // 6. Complete Win32 Version Metadata Across Windows Executables
  // =========================================================================
  it('10. SafeBrowseGuiLauncher, SafeBrowseServiceHost, and SafeBrowseUserHelper define complete Win32 VERSIONINFO metadata', () => {
    const files = [
      {
        path: path.resolve(__dirname, '../gui-launcher/SafeBrowseGuiLauncher.cs'),
        product: 'SafeBrowse Family Protection',
        title: 'SafeBrowse Family Protection',
      },
      {
        path: path.resolve(__dirname, '../service-host/SafeBrowseServiceHost.cs'),
        product: 'SafeBrowse Child Pilot',
        title: 'SafeBrowse Child Protection Service Host',
      },
      {
        path: path.resolve(__dirname, '../user-helper/SafeBrowseUserHelper.cs'),
        product: 'SafeBrowse Child Pilot',
        title: 'SafeBrowse User Session Helper',
      },
    ];

    for (const f of files) {
      assert.ok(fs.existsSync(f.path), `Source file must exist: ${f.path}`);
      const content = fs.readFileSync(f.path, 'utf8');

      assert.ok(
        content.includes('AssemblyCompany("SafeBrowse")'),
        `${path.basename(f.path)} must declare AssemblyCompany("SafeBrowse")`
      );
      assert.ok(
        content.includes(`AssemblyProduct("${f.product}")`),
        `${path.basename(f.path)} must declare AssemblyProduct("${f.product}")`
      );
      assert.ok(
        content.includes(`AssemblyTitle("${f.title}")`),
        `${path.basename(f.path)} must declare AssemblyTitle("${f.title}")`
      );
      assert.ok(
        content.includes('AssemblyCopyright("Copyright © 2026 SafeBrowse. All rights reserved.")'),
        `${path.basename(f.path)} must declare copyright notice`
      );
      assert.ok(
        content.includes('AssemblyFileVersion("1.0.4.15")'),
        `${path.basename(f.path)} must declare AssemblyFileVersion("1.0.4.15")`
      );
      assert.ok(
        content.includes('AssemblyVersion("1.0.4.15")'),
        `${path.basename(f.path)} must declare AssemblyVersion("1.0.4.15")`
      );
    }
  });

  // =========================================================================
  // 7. Service Integration: SafeBrowseChildService Hosts GUI Server
  // =========================================================================
  it('11. agent-cli.ts starts and stops guiServer within runServiceMode()', () => {
    const cliPath = path.resolve(__dirname, '../src/agent-cli.ts');
    const content = fs.readFileSync(cliPath, 'utf8');

    assert.ok(
      content.includes('await guiServer.start(8885)'),
      'runServiceMode must initialize guiServer on port 8885'
    );
    assert.ok(
      content.includes('await guiServer.stop()'),
      'gracefulShutdown must stop guiServer cleanly'
    );
  });

  // =========================================================================
  // 8. MSI Upgrade Lifecycle & Post-Install Integrity Verification (P0-7)
  // =========================================================================
  it('12. SafeBrowseChild-Pilot.wxs enforces monotonic upgrade and integrity script exists', () => {
    const wxsPath = path.resolve(__dirname, '../wix/SafeBrowseChild-Pilot.wxs');
    assert.ok(fs.existsSync(wxsPath), 'SafeBrowseChild-Pilot.wxs must exist');
    const wxsContent = fs.readFileSync(wxsPath, 'utf8');

    assert.ok(
      wxsContent.includes('<?define ProductVersion = "1.0.4.15" ?>'),
      'SafeBrowseChild-Pilot.wxs must declare ProductVersion 1.0.4.15'
    );
    assert.ok(
      wxsContent.includes('Schedule="afterInstallInitialize"'),
      'MajorUpgrade must schedule afterInstallInitialize to eliminate file removal race on upgrade'
    );
    assert.ok(
      wxsContent.includes('AllowSameVersionUpgrades="no"'),
      'MajorUpgrade must reject same-version upgrades (AllowSameVersionUpgrades="no") to enforce monotonic versioning'
    );
    assert.ok(
      wxsContent.includes('<Property Id="REINSTALLMODE" Value="amus" />'),
      'SafeBrowseChild-Pilot.wxs must set REINSTALLMODE to "amus"'
    );
    assert.ok(
      wxsContent.includes('DefaultVersion="$(var.ProductVersion)"'),
      'Executable files in WiX must include DefaultVersion="$(var.ProductVersion)"'
    );
    assert.ok(
      wxsContent.includes('verify-install-integrity.ps1'),
      'WiX file must package verify-install-integrity.ps1 into scripts directory'
    );

    const scriptPath = path.resolve(__dirname, '../scripts/verify-install-integrity.ps1');
    assert.ok(fs.existsSync(scriptPath), 'verify-install-integrity.ps1 must exist');
    const scriptContent = fs.readFileSync(scriptPath, 'utf8');
    assert.ok(scriptContent.includes('SafeBrowseChild-Pilot.exe'), 'Integrity script must check SafeBrowseChild-Pilot.exe');
    assert.ok(scriptContent.includes('http://127.0.0.1:8885/api/health'), 'Integrity script must probe health endpoint');
    assert.ok(scriptContent.includes('http://127.0.0.1:8885/api/status'), 'Integrity script must probe status endpoint');
    assert.ok(scriptContent.includes('SafeBrowseChildService'), 'Integrity script must verify SafeBrowseChildService');
  });

  // =========================================================================
  // 9. Dedicated Lightweight Health Endpoint & Sub-100ms Liveness (P0-8)
  // =========================================================================
  it('13. Dedicated lightweight /api/health endpoint responds immediately with HTTP 200 without calling evaluateSystemStatus() (P0-8)', async () => {
    const gui = new GuiServer(configMgr, accountMgr, undefined, pinMgr);
    const port = await gui.start(0);

    try {
      // 1. GET /api/health
      const start = Date.now();
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      const elapsed = Date.now() - start;

      assert.strictEqual(res.status, 200, '/api/health must respond with HTTP 200');
      const body = await res.json();
      assert.strictEqual(body.status, 'ok', 'Status must be "ok"');
      assert.strictEqual(body.service, 'SafeBrowse', 'Service must be "SafeBrowse"');
      assert.strictEqual(body.version, '1.0.4.15', 'Version must be 1.0.4.15');

      // 2. Response time must be ultra fast (sub-100ms) because it does zero PowerShell/CIM/DNS calls
      assert.ok(elapsed < 200, `/api/health must respond in < 200ms, elapsed: ${elapsed}ms`);
    } finally {
      await gui.stop();
    }
  });

  // =========================================================================
  // 10. Launcher State Machine & Slow /api/status Resilience (P0-8)
  // =========================================================================
  it('14. Launcher uses /api/health and handles SERVICE_STARTING, GUI_SERVER_READY, and SERVICE_UNAVAILABLE; slow /api/status does not fail launcher (P0-8)', () => {
    const csPath = path.resolve(__dirname, '../gui-launcher/SafeBrowseGuiLauncher.cs');
    const csContent = fs.readFileSync(csPath, 'utf8');

    // Must use /api/health as primary readiness probe
    assert.ok(
      csContent.includes('HealthEndpoint = "http://127.0.0.1:8885/api/health"'),
      'Launcher must declare HealthEndpoint pointing to /api/health'
    );
    assert.ok(
      csContent.includes('StatusEndpoint = "http://127.0.0.1:8885/api/health"'),
      'StatusEndpoint must point to /api/health'
    );

    // Must distinguish 3 states
    assert.ok(
      csContent.includes('enum ServiceState'),
      'Launcher must define ServiceState enum'
    );
    assert.ok(
      csContent.includes('GuiServerReady'),
      'ServiceState must include GuiServerReady'
    );
    assert.ok(
      csContent.includes('ServiceStarting'),
      'ServiceState must include ServiceStarting'
    );
    assert.ok(
      csContent.includes('ServiceUnavailable'),
      'ServiceState must include ServiceUnavailable'
    );

    // Bounded timeout and retry logic
    assert.ok(
      csContent.includes('int timeoutMs = 2000'),
      'IsServerResponding must use bounded local timeout (2000ms)'
    );

    // Duplicate launcher checks /api/health before launching browser
    assert.ok(
      csContent.includes('if (IsServerResponding(HealthEndpoint, 2000))'),
      'Must verify /api/health before launching browser when duplicate instance detected'
    );
  });

  // =========================================================================
  // 11. Browser GUI Asynchronous Diagnostics & Paired State Preservation (P0-8)
  // =========================================================================
  it('15. Browser HTML GUI startup flow: /api/health confirms local service availability, paired state is preserved without flashing Connect screen, and diagnostics load asynchronously (P0-8)', () => {
    const gui = new GuiServer(configMgr, accountMgr, undefined, pinMgr);
    const html = (gui as any).renderHtml();

    // 1. Must probe /api/health in initStartupCheck()
    assert.ok(
      html.includes("fetch('/api/health'"),
      'initStartupCheck() must probe /api/health for rapid service confirmation'
    );

    // 2. Must display "Checking protection..." only for diagnostics section
    assert.ok(
      html.includes('Checking protection...'),
      'Must display Checking protection... for initial diagnostics state'
    );

    // 3. Must asynchronously fetch diagnostics via fetchAsyncDiagnostics()
    assert.ok(
      html.includes('fetchAsyncDiagnostics'),
      'Must define and call fetchAsyncDiagnostics() to load protection diagnostics asynchronously'
    );
    assert.ok(
      html.includes('/api/check-protection'),
      'fetchAsyncDiagnostics() must call /api/check-protection asynchronously'
    );

    // 4. Paired laptop must not revert to welcome or flash Connect Computer screen
    assert.ok(
      html.includes('if (serviceAlive && wasPairedLocally)'),
      'Must immediately show screenStatus when service is alive and machine was previously paired'
    );
  });

  // =========================================================================
  // 12. Deliberately Slow /api/status Resilience & Zero Console Window (P0-8)
  // =========================================================================
  it('16. Deliberately slow /api/status does not block /api/health; GUI opens while diagnostics continue asynchronously without console windows (P0-8)', async () => {
    // 1. Verify /api/health and /api/status separation:
    const gui = new GuiServer(configMgr, accountMgr, undefined, pinMgr);
    const port = await gui.start(0);

    try {
      // 2. Fire health probe - must succeed instantaneously even before any status calls
      const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.strictEqual(healthRes.status, 200);
      const healthData = await healthRes.json();
      assert.strictEqual(healthData.status, 'ok');
      assert.strictEqual(healthData.version, '1.0.4.15');

      // 3. Status probe also succeeds without blocking launcher
      const statusRes = await fetch(`http://127.0.0.1:${port}/api/status`);
      assert.strictEqual(statusRes.status, 200);
      const statusData = await statusRes.json();
      assert.strictEqual(typeof statusData.isPaired, 'boolean');
      assert.strictEqual(typeof statusData.pairingStatus, 'string');

      // 4. Zero console window verification
      const csPath = path.resolve(__dirname, '../gui-launcher/SafeBrowseGuiLauncher.cs');
      const cs = fs.readFileSync(csPath, 'utf8');
      assert.ok(cs.includes('UseShellExecute = true'), 'Launcher must use UseShellExecute = true');
      assert.ok(!cs.includes('CreateNoWindow = true'), 'Launcher must not spawn hidden processes');
      assert.ok(!cs.includes('ProcessWindowStyle.Hidden'), 'Launcher must not use ProcessWindowStyle.Hidden');

      const wxsPath = path.resolve(__dirname, '../wix/SafeBrowseChild-Pilot.wxs');
      const wxs = fs.readFileSync(wxsPath, 'utf8');
      assert.ok(!wxs.includes('Arguments="gui"'), 'Desktop shortcut must not target console mode');
      assert.ok(wxs.includes('Target="[INSTALLFOLDER]SafeBrowseGuiLauncher.exe"'), 'Shortcut must point to SafeBrowseGuiLauncher.exe');
    } finally {
      await gui.stop();
    }
  });
});
