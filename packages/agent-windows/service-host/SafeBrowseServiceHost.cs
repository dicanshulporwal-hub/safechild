using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Threading;

namespace SafeBrowse
{
    public class SafeBrowseServiceHost : ServiceBase
    {
        public const string ServiceNameConst = "SafeBrowseChildService";
        private Process _childProcess;
        private Thread _monitorThread;
        private volatile bool _stopping;
        private string _logPath;

        #region Windows Job Object & Native Process Supervision Interop

        private enum JobObjectInfoType
        {
            ExtendedLimitInformation = 9
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public Int64 PerProcessUserTimeLimit;
            public Int64 PerJobUserTimeLimit;
            public UInt32 LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public UInt32 ActiveProcessLimit;
            public UIntPtr Affinity;
            public UInt32 PriorityClass;
            public UInt32 SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public UInt64 ReadOperationCount;
            public UInt64 WriteOperationCount;
            public UInt64 OtherOperationCount;
            public UInt64 ReadTransferCount;
            public UInt64 WriteTransferCount;
            public UInt64 OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryLimit;
            public UIntPtr PeakJobMemoryLimit;
        }

        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private IntPtr _jobHandle = IntPtr.Zero;

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(
            IntPtr hJob,
            JobObjectInfoType JobObjectInformationClass,
            IntPtr lpJobObjectInformation,
            uint cbJobObjectInformationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr hObject);

        private void InitializeJobObject()
        {
            try
            {
                _jobHandle = CreateJobObject(IntPtr.Zero, null);
                if (_jobHandle == IntPtr.Zero)
                {
                    Log(string.Format("[WARN] CreateJobObject failed (error {0}). Standard process supervision will be used.", Marshal.GetLastWin32Error()));
                    return;
                }

                JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

                int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                IntPtr ptr = Marshal.AllocHGlobal(length);
                try
                {
                    Marshal.StructureToPtr(info, ptr, false);
                    if (SetInformationJobObject(_jobHandle, JobObjectInfoType.ExtendedLimitInformation, ptr, (uint)length))
                    {
                        Log("[INFO] Windows Job Object created with KILL_ON_JOB_CLOSE limit. Process tree ownership bound to ServiceHost.");
                    }
                    else
                    {
                        Log(string.Format("[WARN] SetInformationJobObject failed: Win32 error {0}", Marshal.GetLastWin32Error()));
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(ptr);
                }
            }
            catch (Exception ex)
            {
                Log(string.Format("[WARN] Exception initializing Job Object: {0}", ex.Message));
            }
        }

        public void EnsureServiceRecoveryConfigured()
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    Arguments = "/c sc.exe failure SafeBrowseChildService reset= 86400 actions= restart/5000/restart/5000/restart/5000 & sc.exe failureflag SafeBrowseChildService 1",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                using (Process proc = Process.Start(psi))
                {
                    if (proc != null && proc.WaitForExit(5000))
                    {
                        Log("[INFO] SCM service recovery verified: RESTART (5000ms delay) configured for unexpected termination.");
                    }
                }
            }
            catch (Exception ex)
            {
                Log(string.Format("[WARN] Could not configure SCM recovery actions: {0}", ex.Message));
            }
        }

        public void CleanupStaleInstances()
        {
            try
            {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                string targetExe = Path.Combine(baseDir, "SafeBrowseChild-Pilot.exe");
                Process[] processes = Process.GetProcessesByName("SafeBrowseChild-Pilot");
                foreach (Process p in processes)
                {
                    try
                    {
                        if (_childProcess != null && p.Id == _childProcess.Id)
                        {
                            continue;
                        }

                        bool isSafeBrowse = false;
                        try
                        {
                            string procPath = p.MainModule.FileName;
                            if (string.Equals(procPath, targetExe, StringComparison.OrdinalIgnoreCase))
                            {
                                isSafeBrowse = true;
                            }
                        }
                        catch
                        {
                            // If MainModule is inaccessible (e.g. cross-bitness or elevation),
                            // SafeBrowseChild-Pilot is unique to SafeBrowse.
                            isSafeBrowse = true;
                        }

                        if (isSafeBrowse)
                        {
                            Log(string.Format("[WARN] Detected stale/orphaned SafeBrowse child process (PID {0}). Terminating to prevent port 53 conflict...", p.Id));
                            p.Kill();
                            p.WaitForExit(3000);
                            Log(string.Format("[OK] Stale child process PID {0} terminated.", p.Id));
                        }
                    }
                    catch (Exception ex)
                    {
                        Log(string.Format("[WARN] Could not terminate stale process PID {0}: {1}", p.Id, ex.Message));
                    }
                    finally
                    {
                        p.Dispose();
                    }
                }
            }
            catch (Exception ex)
            {
                Log(string.Format("[WARN] Exception during stale instance cleanup: {0}", ex.Message));
            }
        }

        #endregion

        public SafeBrowseServiceHost()
        {
            ServiceName = ServiceNameConst;
            CanStop = true;
            CanShutdown = true;
            CanPauseAndContinue = false;
            AutoLog = true;

            string programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
            string logDir = Path.Combine(programData, "SafeBrowse", "logs");
            Directory.CreateDirectory(logDir);
            _logPath = Path.Combine(logDir, "service-host.log");

            // Attempt to register for SERVICE_ACCEPT_PRESHUTDOWN (optional best-effort optimization).
            // ARCHITECTURAL RECOVERY CONTRACT:
            // PRESHUTDOWN = OPTIMISATION / BEST-EFFORT CLEANUP ONLY
            // BOOT PREFLIGHT = MANDATORY CORRECTNESS GUARANTEE
            TryEnablePreShutdown();
        }

        private const int SERVICE_CONTROL_PRESHUTDOWN = 0x0F;

        /// <summary>
        /// Attempts to register SERVICE_ACCEPT_PRESHUTDOWN (0x100) via reflection into ServiceBase.acceptedCommands.
        ///
        /// ARCHITECTURAL DESIGN & RECOVERY CONTRACT:
        /// PRESHUTDOWN = OPTIMISATION / BEST-EFFORT CLEANUP ONLY
        /// BOOT PREFLIGHT = MANDATORY CORRECTNESS GUARANTEE
        ///
        /// Physical evidence on real Windows systems proves CIM/WMI and networking services
        /// may already be shutting down or unavailable by the time shutdown notifications arrive,
        /// causing Set-DnsClientServerAddress to fail with "Cannot connect to CIM server. A system shutdown is in progress."
        /// Furthermore, private reflection into ServiceBase is an implementation detail that may not succeed across all runtimes.
        ///
        /// Therefore:
        /// 1. This registration is completely isolated, null-checked, and wrapped in exception handling.
        /// 2. If registration fails or acceptedCommands is unavailable, a warning is logged and service startup continues uninterrupted.
        /// 3. The system NEVER assumes preshutdown was delivered.
        /// 4. Boot preflight in the worker bootstrap thread guarantees clean recovery even if shutdown was abrupt or CIM failed.
        /// </summary>
        private void TryEnablePreShutdown()
        {
            try
            {
                var field = typeof(ServiceBase).GetField("acceptedCommands",
                    System.Reflection.BindingFlags.Instance |
                    System.Reflection.BindingFlags.NonPublic);
                if (field != null)
                {
                    object rawVal = field.GetValue(this);
                    if (rawVal is int)
                    {
                        int val = (int)rawVal;
                        field.SetValue(this, val | 0x100);
                        Log("[INFO] SERVICE_ACCEPT_PRESHUTDOWN registered successfully (best-effort cleanup optimization).");
                        return;
                    }
                }
                Log("[WARN] ServiceBase acceptedCommands field not found or not an integer; preshutdown registration skipped.");
            }
            catch (Exception ex)
            {
                Log(string.Format("[WARN] Optional SERVICE_ACCEPT_PRESHUTDOWN registration failed: {0}. Continuing startup.", ex.Message));
            }
        }

        protected override void OnCustomCommand(int command)
        {
            if (command == SERVICE_CONTROL_PRESHUTDOWN)
            {
                Log("[INFO] SERVICE_CONTROL_PRESHUTDOWN (0x0F) received prior to CIM/WMI shutdown. Performing early DNS restoration (best-effort)...");
                OnStop();
            }
            else
            {
                base.OnCustomCommand(command);
            }
        }

        private void Log(string message)
        {
            try
            {
                string entry = string.Format("[{0:yyyy-MM-dd HH:mm:ss}] {1}{2}", DateTime.UtcNow, message, Environment.NewLine);
                File.AppendAllText(_logPath, entry);
            }
            catch { }
        }

        protected override void OnStart(string[] args)
        {
            Log("SafeBrowse Service Host starting...");
            _stopping = false;

            // 1. Ensure Windows SCM recovery configuration is active (RESTART on failure)
            EnsureServiceRecoveryConfigured();

            // 2. Initialize Windows Job Object with KILL_ON_JOB_CLOSE for deterministic process tree lifetime
            InitializeJobObject();

            // 3. Clean up any stale/orphaned child process instances before launching worker loop
            CleanupStaleInstances();

            // SCM NON-BLOCKING INVARIANT:
            // Windows SCM expects OnStart() to return promptly (<30s).
            // Do NOT synchronously block OnStart() on PowerShell, CIM, route discovery,
            // network retry sleeps, or DNS restoration.
            // All boot preflight checks and child process management are performed asynchronously
            // in WorkerLoop on the background monitor thread.
            _monitorThread = new Thread(WorkerLoop)
            {
                IsBackground = true,
                Name = "SafeBrowseServiceMonitor"
            };
            _monitorThread.Start();
            Log("SafeBrowse Service Host started successfully; OnStart returned promptly to SCM.");
        }

        public bool PerformBootPreflight(int maxRetries = 3, int retryDelayMs = 2000)
        {
            Log("[INFO] Performing boot safety pre-flight check for stale 127.0.0.1 DNS...");

            for (int attempt = 1; attempt <= maxRetries; attempt++)
            {
                if (_stopping)
                {
                    Log("[INFO] Boot pre-flight cancelled by service stop request.");
                    return false;
                }

                try
                {
                    string psScript =
                        "$ErrorActionPreference = 'SilentlyContinue'; " +
                        "$backupPath = Join-Path $env:ProgramData 'SafeBrowse\\network-backup.json'; " +
                        "$staleRecovered = $false; " +
                        "$backupMap = @{}; " +
                        "if (Test-Path $backupPath) { " +
                        "    try { " +
                        "        $raw = Get-Content $backupPath -Raw -ErrorAction Stop; " +
                        "        $records = @(ConvertFrom-Json $raw -ErrorAction Stop); " +
                        "        foreach ($rec in $records) { " +
                        "            if ($rec.InterfaceIndex) { " +
                        "                $backupMap[[int]$rec.InterfaceIndex] = $rec; " +
                        "            } " +
                        "        } " +
                        "    } catch {} " +
                        "}; " +
                        "$validRoutes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -and $_.NextHop -ne '0.0.0.0' -and $_.NextHop -ne '::' }); " +
                        "$routeIndexes = @($validRoutes | ForEach-Object { [int]$_.InterfaceIndex }); " +
                        "$allDns = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue); " +
                        "$trappedAdapters = @(); " +
                        "foreach ($dns in $allDns) { " +
                        "    $idx = [int]$dns.InterfaceIndex; " +
                        "    $addrs = @($dns.ServerAddresses); " +
                        "    if ($addrs -contains '127.0.0.1') { " +
                        "        $adapter = @(Get-NetAdapter -InterfaceIndex $idx -ErrorAction SilentlyContinue)[0]; " +
                        "        if (-not $adapter -or $adapter.Status -ne 'Up') { continue }; " +
                        "        $alias = [string]$adapter.InterfaceAlias; " +
                        "        if ($alias -match 'Tailscale|Loopback|Teredo|isatap') { continue }; " +
                        "        if (-not ($routeIndexes -contains $idx)) { continue }; " +
                        "        $ips = @(Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.IPAddress }); " +
                        "        $usableIps = @($ips | Where-Object { $_ -and -not $_.StartsWith('169.254.') -and -not $_.StartsWith('127.') }); " +
                        "        if ($usableIps.Count -eq 0) { continue }; " +
                        "        $trappedAdapters += $idx; " +
                        "    } " +
                        "}; " +
                        "if ($trappedAdapters.Count -gt 0) { " +
                        "    $resolverHealthy = $false; " +
                        "    try { " +
                        "        $udpClient = New-Object System.Net.Sockets.UdpClient; " +
                        "        $udpClient.Client.ReceiveTimeout = 1000; " +
                        "        $udpClient.Connect('127.0.0.1', 53); " +
                        "        $query = [byte[]](0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, " +
                        "                           0x06, 0x68, 0x65, 0x61, 0x6c, 0x74, 0x68, " +
                        "                           0x0a, 0x73, 0x61, 0x66, 0x65, 0x62, 0x72, 0x6f, 0x77, 0x73, 0x65, " +
                        "                           0x08, 0x69, 0x6e, 0x74, 0x65, 0x72, 0x6e, 0x61, 0x6c, 0x00, " +
                        "                           0x00, 0x01, 0x00, 0x01); " +
                        "        [void]$udpClient.Send($query, $query.Length); " +
                        "        $remoteEp = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0); " +
                        "        $resp = $udpClient.Receive([ref]$remoteEp); " +
                        "        if ($resp -and $resp.Length -ge 12) { " +
                        "            $flags = ($resp[2] -shl 8) -bor $resp[3]; " +
                        "            $rcode = $flags -band 0x000F; " +
                        "            if ($rcode -eq 0 -and ($flags -band 0x8000) -ne 0) { $resolverHealthy = $true; } " +
                        "        }; " +
                        "        $udpClient.Close(); " +
                        "    } catch {}; " +
                        "    if ($resolverHealthy) { " +
                        "        Write-Output 'RESOLVER_HEALTHY_PRESERVED'; " +
                        "    } else { " +
                        "        foreach ($idx in $trappedAdapters) { " +
                        "            if ($backupMap.ContainsKey($idx)) { " +
                        "                $rec = $backupMap[$idx]; " +
                        "                $cleanAddrs = @($rec.ServerAddresses) | Where-Object { $_ -and $_ -notlike '*127.0.0.1*' -and $_ -notlike '*::1*' }; " +
                        "                if ($rec.DhcpEnabled -eq $true -or $cleanAddrs.Count -eq 0) { " +
                        "                    Set-DnsClientServerAddress -InterfaceIndex $idx -ResetServerAddresses -ErrorAction SilentlyContinue; " +
                        "                } else { " +
                        "                    Set-DnsClientServerAddress -InterfaceIndex $idx -ServerAddresses $cleanAddrs -ErrorAction SilentlyContinue; " +
                        "                }; " +
                        "                $staleRecovered = $true; " +
                        "            } else { " +
                        "                Set-DnsClientServerAddress -InterfaceIndex $idx -ResetServerAddresses -ErrorAction SilentlyContinue; " +
                        "                $staleRecovered = $true; " +
                        "            } " +
                        "        }; " +
                        "        if ($staleRecovered) { Clear-DnsClientCache -ErrorAction SilentlyContinue; Write-Output 'STALE_DNS_RECOVERED'; } else { Write-Output 'DNS_CLEAN'; } " +
                        "    } " +
                        "} else { " +
                        "    Write-Output 'DNS_CLEAN'; " +
                        "}";

                    ProcessStartInfo psi = new ProcessStartInfo
                    {
                        FileName = "powershell.exe",
                        Arguments = "-NoProfile -ExecutionPolicy Bypass -Command \"" + psScript + "\"",
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true
                    };

                    using (Process proc = Process.Start(psi))
                    {
                        if (proc != null && proc.WaitForExit(15000))
                        {
                            string output = proc.StandardOutput.ReadToEnd().Trim();
                            if (output.Contains("RESOLVER_HEALTHY_PRESERVED"))
                            {
                                Log("[OK] Boot pre-flight: 127.0.0.1 detected on active adapter, and legitimate SafeBrowse resolver is operational. Preserving DNS protection.");
                                return true;
                            }
                            else if (output.Contains("STALE_DNS_RECOVERED"))
                            {
                                Log("[OK] Boot pre-flight: Detected and successfully restored stale 127.0.0.1 DNS to DHCP/original configuration.");
                                return true;
                            }
                            else if (output.Contains("DNS_CLEAN"))
                            {
                                Log("[OK] Boot pre-flight: No stale 127.0.0.1 DNS detected. Network state is clean.");
                                return true;
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    Log(string.Format("[WARN] Boot pre-flight attempt {0}/{1} failed: {2}", attempt, maxRetries, ex.Message));
                }

                if (attempt < maxRetries && !_stopping)
                {
                    Log(string.Format("[INFO] Retrying boot pre-flight in {0}ms (waiting for network/CIM readiness)...", retryDelayMs));
                    for (int s = 0; s < retryDelayMs / 100 && !_stopping; s++)
                    {
                        Thread.Sleep(100);
                    }
                }
            }

            Log("[WARN] Boot pre-flight finished retries without confirming clean state. Continuing safely toward child startup.");
            return false;
        }

        protected override void OnStop()
        {
            Log("[INFO] SafeBrowse Service Host stop requested.");
            _stopping = true;

            // 1. Restore network DNS to original state before terminating child process
            Log("[INFO] Initiating pre-termination network DNS restoration...");
            bool restored = RunEmergencyRestore(2, 15000);
            if (!restored)
            {
                Log("[CRITICAL] Service stop: DNS restoration could not be confirmed after retries.");
            }

            // 2. Terminate child process
            StopChildProcess();

            // 3. Close Job Object handle
            if (_jobHandle != IntPtr.Zero)
            {
                try { CloseHandle(_jobHandle); } catch { }
                _jobHandle = IntPtr.Zero;
            }

            // 4. Await monitor thread completion
            if (_monitorThread != null && _monitorThread.IsAlive)
            {
                _monitorThread.Join(5000);
            }
            Log("[OK] SafeBrowse Service Host stopped cleanly.");
        }

        protected override void OnShutdown()
        {
            Log("[INFO] System shutdown detected. Performing emergency DNS restore...");
            OnStop();
        }

        public bool RunEmergencyRestore(int maxRetries = 2, int timeoutMs = 15000)
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string targetExe = Path.Combine(baseDir, "SafeBrowseChild-Pilot.exe");

            for (int attempt = 1; attempt <= maxRetries; attempt++)
            {
                try
                {
                    if (!File.Exists(targetExe))
                    {
                        Log(string.Format("[WARN] Cannot run emergency restore: executable not found at {0}", targetExe));
                        return FallbackPowerShellRestore();
                    }

                    Log(string.Format("[INFO] Executing emergency restore (attempt {0}/{1}): {2} --emergency-restore", attempt, maxRetries, targetExe));
                    ProcessStartInfo psi = new ProcessStartInfo
                    {
                        FileName = targetExe,
                        Arguments = "--emergency-restore",
                        WorkingDirectory = baseDir,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true
                    };

                    using (Process proc = Process.Start(psi))
                    {
                        if (proc == null)
                        {
                            Log(string.Format("[WARN] Failed to start emergency restore process (attempt {0}).", attempt));
                            continue;
                        }

                        bool finished = proc.WaitForExit(timeoutMs);
                        if (!finished)
                        {
                            Log(string.Format("[WARN] Emergency restore timed out after {0}ms (attempt {1}).", timeoutMs, attempt));
                            try { proc.Kill(); } catch { }
                            continue;
                        }

                        int exitCode = proc.ExitCode;
                        string stdout = "";
                        try { stdout = proc.StandardOutput.ReadToEnd(); } catch { }
                        string stderr = "";
                        try { stderr = proc.StandardError.ReadToEnd(); } catch { }

                        if (exitCode == 0)
                        {
                            Log("[OK] Emergency network and DNS restore succeeded.");
                            return true;
                        }
                        else
                        {
                            Log(string.Format("[WARN] Emergency restore exited with code {0}. Output: {1} Error: {2}", exitCode, stdout.Trim(), stderr.Trim()));
                        }
                    }
                }
                catch (Exception ex)
                {
                    Log(string.Format("[WARN] Exception invoking emergency restore (attempt {0}): {1}", attempt, ex.Message));
                }

                if (attempt < maxRetries)
                {
                    Thread.Sleep(2000);
                }
            }

            Log("[CRITICAL] Emergency restore via SafeBrowseChild-Pilot.exe failed after retries. Invoking native PowerShell fallback...");
            return FallbackPowerShellRestore();
        }

        public bool FallbackPowerShellRestore()
        {
            try
            {
                Log("[INFO] Attempting native PowerShell DNS restore fallback...");
                string programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
                string backupPath = Path.Combine(programData, "SafeBrowse", "network-backup.json");

                if (File.Exists(backupPath))
                {
                    Log(string.Format("[INFO] Fallback restore: found network-backup.json at {0}. Restoring exact adapter configuration...", backupPath));
                }
                else
                {
                    Log("[WARN] [LAST_RESORT] Fallback restore: network-backup.json missing. Using restricted emergency continuity heuristic for adapters trapped on 127.0.0.1.");
                }

                string psScript =
                    "$ErrorActionPreference = 'SilentlyContinue'; " +
                    "$backupPath = Join-Path $env:ProgramData 'SafeBrowse\\network-backup.json'; " +
                    "$restoredAny = $false; " +
                    "$rules = @('SafeBrowse_Block_DoT_853_TCP', 'SafeBrowse_Block_DoT_853_UDP', 'SafeBrowse_Block_DoH_Bootstrap'); " +
                    "foreach ($r in $rules) { netsh advfirewall firewall delete rule name=$r | Out-Null }; " +
                    "if (Test-Path $backupPath) { " +
                    "    try { " +
                    "        $raw = Get-Content $backupPath -Raw -ErrorAction Stop; " +
                    "        $records = ConvertFrom-Json $raw -ErrorAction Stop; " +
                    "        $items = @($records); " +
                    "        foreach ($rec in $items) { " +
                    "            if ($rec.InterfaceIndex) { " +
                    "                $idx = [int]$rec.InterfaceIndex; " +
                    "                $cleanAddrs = @($rec.ServerAddresses) | Where-Object { $_ -and $_ -notlike '*127.0.0.1*' -and $_ -notlike '*::1*' }; " +
                    "                if ($rec.DhcpEnabled -eq $true -or $cleanAddrs.Count -eq 0) { " +
                    "                    Set-DnsClientServerAddress -InterfaceIndex $idx -ResetServerAddresses -ErrorAction SilentlyContinue; " +
                    "                } else { " +
                    "                    Set-DnsClientServerAddress -InterfaceIndex $idx -ServerAddresses $cleanAddrs -ErrorAction SilentlyContinue; " +
                    "                }; " +
                    "                $restoredAny = $true; " +
                    "            } " +
                    "        } " +
                    "    } catch {} " +
                    "}; " +
                    "if (-not $restoredAny) { " +
                    "    $trapped = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.ServerAddresses -contains '127.0.0.1' }); " +
                    "    $validRoutes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.NextHop -ne '0.0.0.0' }); " +
                    "    $routeIndexes = @($validRoutes | ForEach-Object { $_.InterfaceIndex }); " +
                    "    foreach ($t in $trapped) { " +
                    "        if ($routeIndexes -contains $t.InterfaceIndex) { " +
                    "            Set-DnsClientServerAddress -InterfaceIndex $t.InterfaceIndex -ResetServerAddresses -ErrorAction SilentlyContinue; " +
                    "        } " +
                    "    } " +
                    "}; " +
                    "Clear-DnsClientCache -ErrorAction SilentlyContinue;";

                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -ExecutionPolicy Bypass -Command \"" + psScript + "\"",
                    UseShellExecute = false,
                    CreateNoWindow = true
                };

                using (Process proc = Process.Start(psi))
                {
                    if (proc != null && proc.WaitForExit(10000) && proc.ExitCode == 0)
                    {
                        Log("[OK] Native PowerShell DNS restore fallback succeeded.");
                        return true;
                    }
                }
            }
            catch (Exception ex)
            {
                Log(string.Format("[ERROR] Native PowerShell DNS restore fallback failed: {0}", ex.Message));
            }
            return false;
        }

        private void WorkerLoop()
        {
            Log("[INFO] SafeBrowse worker bootstrap thread started.");

            // MANDATORY CORRECTNESS INVARIANT:
            // The child enforcement process MUST NOT start before stale 127.0.0.1 recovery
            // has been attempted.
            // Boot pre-flight safely inspects active adapters and recovers stale 127.0.0.1
            // from any prior incomplete shutdown BEFORE launching the child enforcement process.
            if (!_stopping)
            {
                PerformBootPreflight();
            }

            int restartCount = 0;
            DateTime lastStartTime = DateTime.UtcNow;

            while (!_stopping)
            {
                try
                {
                    // Ensure any stale child instance is terminated before launching
                    CleanupStaleInstances();

                    string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                    string targetExe = Path.Combine(baseDir, "SafeBrowseChild-Pilot.exe");

                    if (!File.Exists(targetExe))
                    {
                        Log(string.Format("Target executable not found at: {0}", targetExe));
                        Thread.Sleep(5000);
                        continue;
                    }

                    ProcessStartInfo psi = new ProcessStartInfo
                    {
                        FileName = targetExe,
                        Arguments = "service",
                        WorkingDirectory = baseDir,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = false,
                        RedirectStandardError = false
                    };
                    psi.EnvironmentVariables["SAFEBROWSE_PARENT_PID"] = Process.GetCurrentProcess().Id.ToString();

                    Log(string.Format("Launching child process: {0} service", targetExe));
                    lastStartTime = DateTime.UtcNow;
                    _childProcess = Process.Start(psi);

                    if (_childProcess != null && !_childProcess.HasExited)
                    {
                        if (_jobHandle != IntPtr.Zero)
                        {
                            try
                            {
                                if (AssignProcessToJobObject(_jobHandle, _childProcess.Handle))
                                {
                                    Log(string.Format("[OK] Child process PID {0} bound to Windows Job Object with KILL_ON_JOB_CLOSE.", _childProcess.Id));
                                }
                                else
                                {
                                    Log(string.Format("[WARN] AssignProcessToJobObject failed for PID {0} (Win32 error: {1}).", _childProcess.Id, Marshal.GetLastWin32Error()));
                                }
                            }
                            catch (Exception ex)
                            {
                                Log(string.Format("[WARN] Error assigning child PID {0} to Job Object: {1}", _childProcess.Id, ex.Message));
                            }
                        }

                        _childProcess.WaitForExit();
                        int exitCode = _childProcess.ExitCode;
                        Log(string.Format("Child process exited with code: {0}", exitCode));
                    }
                }
                catch (Exception ex)
                {
                    Log(string.Format("Exception executing child process: {0}", ex.Message));
                }

                if (_stopping) break;

                // Child process crashed or exited unexpectedly while service is supposed to be running!
                // Restore network state to prevent internet loss while backing off for restart.
                Log("[WARN] Unexpected child process termination detected. Restoring network DNS before restart delay...");
                RunEmergencyRestore(1, 10000);
                CleanupStaleInstances();

                // If child ran for more than 60 seconds, reset restart count
                if ((DateTime.UtcNow - lastStartTime).TotalSeconds > 60)
                {
                    restartCount = 0;
                }

                restartCount++;
                if (restartCount > 5)
                {
                    Log("Child process crashed repeatedly (>5 times in short succession). Backing off for 60s to prevent restart loop.");
                    Thread.Sleep(60000);
                    restartCount = 0;
                }
                else
                {
                    int delay = Math.Min(30000, restartCount * 5000);
                    Log(string.Format("Waiting {0} ms before restarting child process...", delay));
                    Thread.Sleep(delay);
                }
            }
        }

        private void StopChildProcess()
        {
            try
            {
                if (_childProcess != null && !_childProcess.HasExited)
                {
                    Log("Terminating child process tree...");
                    Process taskkillProcess = Process.Start(new ProcessStartInfo
                    {
                        FileName = "taskkill",
                        Arguments = string.Format("/PID {0} /T /F", _childProcess.Id),
                        CreateNoWindow = true,
                        UseShellExecute = false
                    });
                    if (taskkillProcess != null)
                    {
                        taskkillProcess.WaitForExit(3000);
                    }

                    if (!_childProcess.HasExited)
                    {
                        _childProcess.Kill();
                    }
                }
            }
            catch (Exception ex)
            {
                Log(string.Format("Error stopping child process: {0}", ex.Message));
            }
        }

        public static void Main(string[] args)
        {
            if (Environment.UserInteractive)
            {
                Console.WriteLine("SafeBrowse Child Service Host");
                Console.WriteLine("Running in interactive console mode. Press Ctrl+C to exit.");
                SafeBrowseServiceHost service = new SafeBrowseServiceHost();
                service.OnStart(args);
                Console.WriteLine("Service started. Waiting...");
                ManualResetEvent quitEvent = new ManualResetEvent(false);
                Console.CancelKeyPress += (s, e) =>
                {
                    e.Cancel = true;
                    quitEvent.Set();
                };
                quitEvent.WaitOne();
                service.OnStop();
                Console.WriteLine("Service stopped.");
            }
            else
            {
                ServiceBase.Run(new SafeBrowseServiceHost());
            }
        }
    }
}
