using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;

namespace SafeBrowse.GuiLauncher
{
    /// <summary>
    /// Windowless GUI Launcher for SafeBrowse Family Protection.
    /// Built with /target:winexe so Windows does not allocate a console/conhost window.
    /// Starts SafeBrowseChild-Pilot.exe with CreateNoWindow = true to prevent CMD window flashes.
    /// Reuses already-running GUI server instances cleanly without duplicate processes.
    /// </summary>
    public static class Program
    {
        private const string GuiUrl = "http://127.0.0.1:8885";
        private const string StatusEndpoint = "http://127.0.0.1:8885/api/status";

        [STAThread]
        public static void Main(string[] args)
        {
            // 1. Per-user launcher mutex to prevent concurrent launch races
            bool createdNew;
            string mutexName = "Local\\SafeBrowseGuiLauncherMutex_" + Environment.UserName;
            using (Mutex mutex = new Mutex(true, mutexName, out createdNew))
            {
                if (!createdNew)
                {
                    // Another launcher instance is actively initializing. Wait briefly for it.
                    Thread.Sleep(1000);
                    return;
                }

                // 2. Check if SafeBrowse GUI server is already running and responding
                if (IsServerResponding(StatusEndpoint))
                {
                    LaunchBrowser(GuiUrl);
                    return;
                }

                // 3. Locate the SafeBrowse single-executable binary
                string targetExe = FindChildExecutable();
                if (string.IsNullOrEmpty(targetExe) || !File.Exists(targetExe))
                {
                    // Fallback to attempting browser open in case server starts shortly
                    LaunchBrowser(GuiUrl);
                    return;
                }

                // 4. Launch SafeBrowseChild-Pilot.exe gui silently with NO console window
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = targetExe,
                    Arguments = "gui",
                    WorkingDirectory = Path.GetDirectoryName(targetExe),
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };

                try
                {
                    Process proc = Process.Start(psi);
                    if (proc != null)
                    {
                        // Wait up to 3 seconds for the GUI server to initialize and launch the window
                        for (int i = 0; i < 15; i++)
                        {
                            Thread.Sleep(200);
                            if (proc.HasExited)
                            {
                                break;
                            }
                            if (IsServerResponding(StatusEndpoint))
                            {
                                break;
                            }
                        }
                    }
                }
                catch
                {
                    // If process start fails, attempt direct browser launch as last resort
                    LaunchBrowser(GuiUrl);
                }
            }
        }

        private static bool IsServerResponding(string endpoint)
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(endpoint);
                request.Method = "GET";
                request.Timeout = 800;
                request.ReadWriteTimeout = 800;
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

        private static string FindChildExecutable()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string candidate = Path.Combine(baseDir, "SafeBrowseChild-Pilot.exe");
            if (File.Exists(candidate))
            {
                return candidate;
            }

            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            candidate = Path.Combine(programFiles, "SafeBrowse", "SafeBrowseChild-Pilot.exe");
            if (File.Exists(candidate))
            {
                return candidate;
            }

            candidate = Path.Combine(Directory.GetCurrentDirectory(), "SafeBrowseChild-Pilot.exe");
            if (File.Exists(candidate))
            {
                return candidate;
            }

            return null;
        }

        private static void LaunchBrowser(string url)
        {
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
                            UseShellExecute = true
                        };
                        Process.Start(psi);
                        return;
                    }
                    catch { }
                }
            }

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
}
