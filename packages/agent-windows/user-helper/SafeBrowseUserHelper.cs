using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace SafeBrowse.UserHelper
{
    /// <summary>
    /// SafeBrowse Non-Elevated User-Session Helper.
    /// Runs silently inside the interactive Windows user desktop session.
    /// Receives block-page presentation events from SafeBrowseChildService via Named Pipe
    /// and launches the local block page using the user's DEFAULT browser via Windows Shell.
    /// </summary>
    public static class Program
    {
        private static volatile bool _stopping = false;
        private const string PipeName = "SafeBrowseBlockPipe";
        private const int ExpectedPort = 8880;

        [STAThread]
        public static void Main(string[] args)
        {
            // 1. Single Instance Check per Windows user session
            bool createdNew;
            string mutexName = "Local\\SafeBrowseUserHelper_" + Environment.UserName;
            using (Mutex mutex = new Mutex(true, mutexName, out createdNew))
            {
                if (!createdNew)
                {
                    return; // Another instance is already running for this user
                }

                // 2. Handle System Logoff / Shutdown
                Microsoft.Win32.SystemEvents.SessionEnding += (s, e) => { _stopping = true; };

                // 3. Named Pipe Connection & Reconnect Loop
                while (!_stopping)
                {
                    try
                    {
                        using (NamedPipeClientStream pipeClient = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.Asynchronous))
                        {
                            pipeClient.Connect(3000);

                            using (StreamReader reader = new StreamReader(pipeClient, Encoding.UTF8))
                            using (StreamWriter writer = new StreamWriter(pipeClient, Encoding.UTF8) { AutoFlush = true })
                            {
                                // Send registration handshake
                                string reg = string.Format(
                                    "{{\"type\":\"REGISTER_HELPER\",\"version\":\"1.0.4-validation\",\"accountName\":\"{0}\",\"pid\":{1}}}\n",
                                    EscapeJson(Environment.UserName),
                                    Process.GetCurrentProcess().Id
                                );
                                writer.Write(reg);

                                string line;
                                while (!_stopping && (line = reader.ReadLine()) != null)
                                {
                                    ProcessMessage(line);
                                }
                            }
                        }
                    }
                    catch
                    {
                        // SCM service not yet running, restarting, or disconnected; retry with backoff
                        if (!_stopping)
                        {
                            Thread.Sleep(2500);
                        }
                    }
                }
            }
        }

        private static void ProcessMessage(string rawMessage)
        {
            if (string.IsNullOrWhiteSpace(rawMessage) || rawMessage.Length > 8192)
            {
                return;
            }

            try
            {
                // Simple regex-based JSON extraction for BCL standalone compatibility
                Match typeMatch = Regex.Match(rawMessage, "\"type\"\\s*:\\s*\"([^\"]+)\"");
                if (!typeMatch.Success || typeMatch.Groups[1].Value != "PRESENT_BLOCK")
                {
                    return;
                }

                Match urlMatch = Regex.Match(rawMessage, "\"url\"\\s*:\\s*\"([^\"]+)\"");
                if (!urlMatch.Success)
                {
                    return;
                }

                string blockUrl = UnescapeJson(urlMatch.Groups[1].Value);

                if (IsValidBlockUrl(blockUrl))
                {
                    LaunchDefaultBrowser(blockUrl);
                }
            }
            catch
            {
                // Discard invalid messages safely
            }
        }

        public static bool IsValidBlockUrl(string rawUrl)
        {
            if (string.IsNullOrWhiteSpace(rawUrl) || rawUrl.Length > 2048)
            {
                return false;
            }

            string lower = rawUrl.Trim().ToLowerInvariant();
            if (lower.StartsWith("javascript:") ||
                lower.StartsWith("file:") ||
                lower.StartsWith("data:") ||
                lower.StartsWith("vbscript:") ||
                lower.StartsWith("powershell:"))
            {
                return false;
            }

            Uri uri;
            if (!Uri.TryCreate(rawUrl, UriKind.Absolute, out uri))
            {
                return false;
            }

            if (uri.Scheme != "http")
            {
                return false;
            }

            if (uri.Host != "127.0.0.1" && uri.Host != "localhost")
            {
                return false;
            }

            if (uri.Port != ExpectedPort)
            {
                return false;
            }

            if (!uri.AbsolutePath.StartsWith("/blocked"))
            {
                return false;
            }

            return true;
        }

        private static void LaunchDefaultBrowser(string url)
        {
            try
            {
                // Uses Windows shell default URL association (ShellExecuteEx)
                // Opens in current interactive user's default browser (Edge, Chrome, Firefox, etc.)
                ProcessStartInfo psi = new ProcessStartInfo(url)
                {
                    UseShellExecute = true
                };
                Process.Start(psi);
            }
            catch
            {
                try
                {
                    // Fallback to cmd.exe start
                    ProcessStartInfo fallback = new ProcessStartInfo("cmd.exe", "/c start \"\" \"" + url + "\"")
                    {
                        CreateNoWindow = true,
                        UseShellExecute = false
                    };
                    Process.Start(fallback);
                }
                catch { }
            }
        }

        private static string EscapeJson(string str)
        {
            if (str == null) return "";
            return str.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

        private static string UnescapeJson(string str)
        {
            if (str == null) return "";
            return str.Replace("\\\"", "\"").Replace("\\\\", "\\");
        }
    }
}
