using System;
using System.Diagnostics;
using System.IO;
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
            _monitorThread = new Thread(WorkerLoop)
            {
                IsBackground = true,
                Name = "SafeBrowseServiceMonitor"
            };
            _monitorThread.Start();
            Log("SafeBrowse Service Host started successfully.");
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

            // 3. Await monitor thread completion
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
            int restartCount = 0;
            DateTime lastStartTime = DateTime.UtcNow;

            while (!_stopping)
            {
                try
                {
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

                    Log(string.Format("Launching child process: {0} service", targetExe));
                    lastStartTime = DateTime.UtcNow;
                    _childProcess = Process.Start(psi);

                    if (_childProcess != null)
                    {
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
