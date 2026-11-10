using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Threading;
using System.Windows.Forms;

// Standard Win32 VERSIONINFO metadata embedded into PE binary header
[assembly: AssemblyTitle("SafeBrowse Family Protection")]
[assembly: AssemblyDescription("SafeBrowse Family Protection GUI Host")]
[assembly: AssemblyConfiguration("")]
[assembly: AssemblyCompany("SafeBrowse")]
[assembly: AssemblyProduct("SafeBrowse Family Protection")]
[assembly: AssemblyCopyright("Copyright © 2026 SafeBrowse. All rights reserved.")]
[assembly: AssemblyTrademark("SafeBrowse")]
[assembly: AssemblyCulture("")]
[assembly: ComVisible(false)]
[assembly: Guid("6F2A93B4-C5D6-7E8F-9012-3456789ABCDE")]
[assembly: AssemblyVersion("1.0.4.13")]
[assembly: AssemblyFileVersion("1.0.4.13")]
[assembly: AssemblyInformationalVersion("1.0.4.13")]

namespace SafeBrowse.GuiLauncher
{
    public enum ServiceState
    {
        GuiServerReady,
        ServiceStarting,
        ServiceUnavailable
    }

    /// <summary>
    /// Conventional Windows GUI Host Application for SafeBrowse Family Protection.
    /// Standard Windows Forms architecture (/target:winexe) with complete PE metadata.
    /// Uses lightweight /api/health probe on localhost:8885 to verify GUI readiness
    /// without blocking on full system/network diagnostics. Zero hidden process spawning.
    /// </summary>
    public static class Program
    {
        public const string GuiUrl = "http://127.0.0.1:8885";
        public const string HealthEndpoint = "http://127.0.0.1:8885/api/health";
        public const string StatusEndpoint = "http://127.0.0.1:8885/api/health"; // Dedicated lightweight health check
        public const string ServiceName = "SafeBrowseChildService";

        [STAThread]
        public static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // 1. Per-user mutex to avoid concurrent launch races
            bool createdNew;
            string mutexName = "Local\\SafeBrowseGuiLauncherMutex_" + Environment.UserName;
            using (Mutex mutex = new Mutex(true, mutexName, out createdNew))
            {
                if (!createdNew)
                {
                    // Existing instance active or launching. First verify /api/health.
                    // If healthy: open/focus GUI. If starting: show connecting UI.
                    if (IsServerResponding(HealthEndpoint, 2000))
                    {
                        LaunchBrowserWindow(GuiUrl);
                        return;
                    }
                    Application.Run(new SafeBrowseConnectingForm());
                    return;
                }

                // 2. Fast Path: If SafeBrowseChildService is already serving localhost:8885 /api/health, open browser immediately
                if (IsServerResponding(HealthEndpoint, 2000))
                {
                    LaunchBrowserWindow(GuiUrl);
                    return;
                }

                // 3. Service Verification: Ensure SafeBrowseChildService is running
                EnsureServiceRunning();

                // Poll boundedly (up to 3 seconds) for lightweight /api/health readiness
                bool serverReady = false;
                for (int i = 0; i < 15; i++)
                {
                    Thread.Sleep(200);
                    if (IsServerResponding(HealthEndpoint, 1500))
                    {
                        serverReady = true;
                        break;
                    }
                }

                if (serverReady)
                {
                    LaunchBrowserWindow(GuiUrl);
                    return;
                }

                // 4. Standalone Fallback / Diagnostics: Display native Windows Form window
                Application.Run(new SafeBrowseConnectingForm());
            }
        }

        public static bool IsServerResponding(string endpoint, int timeoutMs = 2000)
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(endpoint);
                request.Method = "GET";
                request.Timeout = timeoutMs;
                request.ReadWriteTimeout = timeoutMs;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    return response.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        public static ServiceState QueryServiceState()
        {
            if (IsServerResponding(HealthEndpoint, 2000))
            {
                return ServiceState.GuiServerReady;
            }

            try
            {
                using (ServiceController sc = new ServiceController(ServiceName))
                {
                    if (sc.Status == ServiceControllerStatus.Running || sc.Status == ServiceControllerStatus.StartPending)
                    {
                        return ServiceState.ServiceStarting;
                    }
                }
            }
            catch { }

            try
            {
                if (Process.GetProcessesByName("SafeBrowseChild-Pilot").Length > 0 ||
                    Process.GetProcessesByName("SafeBrowseServiceHost").Length > 0)
                {
                    return ServiceState.ServiceStarting;
                }
            }
            catch { }

            return ServiceState.ServiceUnavailable;
        }

        public static void EnsureServiceRunning()
        {
            try
            {
                using (ServiceController sc = new ServiceController(ServiceName))
                {
                    if (sc.Status == ServiceControllerStatus.Stopped || sc.Status == ServiceControllerStatus.Paused)
                    {
                        sc.Start();
                        sc.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(3));
                    }
                }
            }
            catch
            {
                // SCM access may be restricted for non-admin users if service stopped; non-fatal
            }
        }

        public static void LaunchBrowserWindow(string url)
        {
            // Prefer Microsoft Edge in standalone desktop application mode
            string[] edgePaths = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe")
            };
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string userDataDir = Path.Combine(localAppData, "SafeBrowse", "gui-edge-profile");

            foreach (string path in edgePaths)
            {
                if (File.Exists(path))
                {
                    try
                    {
                        ProcessStartInfo psi = new ProcessStartInfo
                        {
                            FileName = path,
                            Arguments = string.Format("--app=\"{0}\" --start-maximized --user-data-dir=\"{1}\"", url, userDataDir),
                            UseShellExecute = true // Native Windows Shell execution: zero console window
                        };
                        Process.Start(psi);
                        return;
                    }
                    catch { }
                }
            }

            // Fallback: Default system browser via standard Windows Shell
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = url,
                    UseShellExecute = true
                };
                Process.Start(psi);
            }
            catch { }
        }
    }

    /// <summary>
    /// Native Windows Forms status window displayed when SafeBrowseChildService
    /// is initializing or requires user attention.
    /// Distinguishes SERVICE_STARTING, GUI_SERVER_READY, and SERVICE_UNAVAILABLE.
    /// </summary>
    public class SafeBrowseConnectingForm : Form
    {
        private Label _titleLabel;
        private Label _statusLabel;
        private ProgressBar _progressBar;
        private Button _btnRetry;
        private Button _btnClose;
        private System.Windows.Forms.Timer _pollTimer;
        private int _elapsedSeconds = 0;

        public SafeBrowseConnectingForm()
        {
            InitializeComponent();
        }

        private void InitializeComponent()
        {
            this.Text = "SafeBrowse Family Protection";
            this.Size = new Size(460, 220);
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.MaximizeBox = false;
            this.MinimizeBox = false;
            this.BackColor = Color.FromArgb(15, 23, 42); // Slate 900
            this.ForeColor = Color.White;

            _titleLabel = new Label
            {
                Text = "SafeBrowse Family Protection",
                Font = new Font("Segoe UI", 13, FontStyle.Bold),
                ForeColor = Color.FromArgb(248, 250, 252),
                Location = new Point(24, 20),
                AutoSize = true
            };

            _statusLabel = new Label
            {
                Text = "Connecting to SafeBrowse Child Protection Service...",
                Font = new Font("Segoe UI", 9.5f, FontStyle.Regular),
                ForeColor = Color.FromArgb(148, 163, 184), // Slate 400
                Location = new Point(24, 52),
                Size = new Size(400, 36)
            };

            _progressBar = new ProgressBar
            {
                Style = ProgressBarStyle.Marquee,
                MarqueeAnimationSpeed = 30,
                Location = new Point(24, 96),
                Size = new Size(396, 12)
            };

            _btnRetry = new Button
            {
                Text = "Retry Connection",
                Font = new Font("Segoe UI", 9, FontStyle.Regular),
                BackColor = Color.FromArgb(37, 99, 235), // Blue 600
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Location = new Point(200, 130),
                Size = new Size(130, 32),
                Cursor = Cursors.Hand
            };
            _btnRetry.FlatAppearance.BorderSize = 0;
            _btnRetry.Click += (s, e) => HandleRetry();

            _btnClose = new Button
            {
                Text = "Close",
                Font = new Font("Segoe UI", 9, FontStyle.Regular),
                BackColor = Color.FromArgb(51, 65, 85), // Slate 700
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Location = new Point(340, 130),
                Size = new Size(80, 32),
                Cursor = Cursors.Hand
            };
            _btnClose.FlatAppearance.BorderSize = 0;
            _btnClose.Click += (s, e) => this.Close();

            this.Controls.Add(_titleLabel);
            this.Controls.Add(_statusLabel);
            this.Controls.Add(_progressBar);
            this.Controls.Add(_btnRetry);
            this.Controls.Add(_btnClose);

            _pollTimer = new System.Windows.Forms.Timer { Interval = 1000 };
            _pollTimer.Tick += (s, e) => PollTick();
            _pollTimer.Start();
        }

        private void PollTick()
        {
            _elapsedSeconds++;
            ServiceState state = Program.QueryServiceState();

            if (state == ServiceState.GuiServerReady)
            {
                _pollTimer.Stop();
                Program.LaunchBrowserWindow(Program.GuiUrl);
                this.Close();
                return;
            }

            if (state == ServiceState.ServiceStarting)
            {
                _statusLabel.Text = "SafeBrowse Child Protection Service is starting up. Please wait...";
                _statusLabel.ForeColor = Color.FromArgb(148, 163, 184);
                _progressBar.Style = ProgressBarStyle.Marquee;
            }
            else if (_elapsedSeconds >= 10 && state == ServiceState.ServiceUnavailable)
            {
                _progressBar.Style = ProgressBarStyle.Blocks;
                _progressBar.Value = 0;
                _statusLabel.Text = "SafeBrowseChildService is not responding. Please check that SafeBrowseChildService is started, or restart your computer.";
                _statusLabel.ForeColor = Color.FromArgb(248, 113, 113); // Red 400
            }
        }

        private void HandleRetry()
        {
            _elapsedSeconds = 0;
            _progressBar.Style = ProgressBarStyle.Marquee;
            _statusLabel.Text = "Connecting to SafeBrowse Child Protection Service...";
            _statusLabel.ForeColor = Color.FromArgb(148, 163, 184);
            Program.EnsureServiceRunning();
            if (Program.IsServerResponding(Program.HealthEndpoint, 2000))
            {
                _pollTimer.Stop();
                Program.LaunchBrowserWindow(Program.GuiUrl);
                this.Close();
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (_pollTimer != null)
                {
                    _pollTimer.Stop();
                    _pollTimer.Dispose();
                }
            }
            base.Dispose(disposing);
        }
    }
}
