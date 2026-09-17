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
            Log("SafeBrowse Service Host stop requested.");
            _stopping = true;
            StopChildProcess();
            if (_monitorThread != null && _monitorThread.IsAlive)
            {
                _monitorThread.Join(5000);
            }
            Log("SafeBrowse Service Host stopped.");
        }

        protected override void OnShutdown()
        {
            OnStop();
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
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = "taskkill",
                        Arguments = string.Format("/PID {0} /T /F", _childProcess.Id),
                        CreateNoWindow = true,
                        UseShellExecute = false
                    })?.WaitForExit(3000);

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
