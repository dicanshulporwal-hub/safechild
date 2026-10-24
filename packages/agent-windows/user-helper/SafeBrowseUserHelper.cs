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

        private static readonly object _logLock = new object();
        private static string _logFilePath = null;
        private static DateTime _lastErrorLogTime = DateTime.MinValue;
        private static string _lastErrorMessage = null;

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
                Microsoft.Win32.SystemEvents.SessionEnding += (s, e) => {
                    _stopping = true;
                    LogMessage("INFO", "Session ending notification received. Stopping helper.");
                };

                LogMessage("INFO", string.Format("SafeBrowseUserHelper starting. PID={0}, SessionId={1}, User={2}",
                    Process.GetCurrentProcess().Id,
                    Process.GetCurrentProcess().SessionId,
                    Environment.UserName));

                // 3. Named Pipe Connection & Reconnect Loop
                while (!_stopping)
                {
                    try
                    {
                        LogMessage("DEBUG", "Attempting connection to named pipe \\\\.\\pipe\\" + PipeName + "...");
                        using (NamedPipeClientStream pipeClient = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.Asynchronous))
                        {
                            pipeClient.Connect(3000);
                            LogMessage("INFO", "Connected to named pipe \\\\.\\pipe\\" + PipeName + ".");

                            using (StreamReader reader = new StreamReader(pipeClient, Encoding.UTF8))
                            using (StreamWriter writer = new StreamWriter(pipeClient, Encoding.UTF8) { AutoFlush = true })
                            {
                                // Send registration handshake
                                string reg = string.Format(
                                    "{{\"type\":\"REGISTER_HELPER\",\"version\":\"1.0.4-validation\",\"accountName\":\"{0}\",\"pid\":{1},\"sessionId\":{2}}}\n",
                                    EscapeJson(Environment.UserName),
                                    Process.GetCurrentProcess().Id,
                                    Process.GetCurrentProcess().SessionId
                                );
                                writer.Write(reg);
                                LogMessage("INFO", string.Format("Sent REGISTER_HELPER: accountName='{0}', PID={1}, SessionId={2}",
                                    Environment.UserName,
                                    Process.GetCurrentProcess().Id,
                                    Process.GetCurrentProcess().SessionId));

                                string line;
                                while (!_stopping && (line = reader.ReadLine()) != null)
                                {
                                    ProcessMessage(line);
                                }
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        // SCM service not yet running, restarting, or disconnected; retry with backoff
                        LogConnectionError(ex);
                        if (!_stopping)
                        {
                            LogMessage("DEBUG", "Reconnect attempt scheduled in 2500ms.");
                            Thread.Sleep(2500);
                        }
                    }
                }

                LogMessage("INFO", "SafeBrowseUserHelper exiting cleanly.");
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
                if (!typeMatch.Success)
                {
                    return;
                }

                string msgType = typeMatch.Groups[1].Value;
                if (msgType == "REGISTER_ACK")
                {
                    LogMessage("INFO", "REGISTER_ACK received. Helper successfully registered with BlockIpcServer.");
                    return;
                }

                if (msgType == "PRESENT_BLOCK")
                {
                    Match domainMatch = Regex.Match(rawMessage, "\"domain\"\\s*:\\s*\"([^\"]+)\"");
                    string domain = domainMatch.Success ? UnescapeJson(domainMatch.Groups[1].Value) : "unknown";
                    LogMessage("INFO", string.Format("PRESENT_BLOCK received for domain '{0}'. Launching default browser.", domain));

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
                    else
                    {
                        LogMessage("WARN", "Received invalid block URL. Suppressing launch.");
                    }
                }
            }
            catch (Exception ex)
            {
                LogMessage("WARN", string.Format("Error processing IPC message: {0}", ex.Message));
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
                LogMessage("INFO", "Launched default browser via Windows ShellExecuteEx.");
            }
            catch (Exception ex)
            {
                LogMessage("WARN", string.Format("Primary ShellExecuteEx launch failed: {0}. Attempting cmd fallback.", ex.Message));
                try
                {
                    // Fallback to cmd.exe start
                    ProcessStartInfo fallback = new ProcessStartInfo("cmd.exe", "/c start \"\" \"" + url + "\"")
                    {
                        CreateNoWindow = true,
                        UseShellExecute = false
                    };
                    Process.Start(fallback);
                    LogMessage("INFO", "Launched default browser via cmd.exe start fallback.");
                }
                catch (Exception fallbackEx)
                {
                    LogMessage("WARN", string.Format("cmd fallback launch failed: {0}", fallbackEx.Message));
                }
            }
        }

        private static string GetLogFilePath()
        {
            if (_logFilePath == null)
            {
                try
                {
                    string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                    string logDir = Path.Combine(localAppData, "SafeBrowse", "logs");
                    if (!Directory.Exists(logDir))
                    {
                        Directory.CreateDirectory(logDir);
                    }
                    _logFilePath = Path.Combine(logDir, "user-helper.log");
                }
                catch
                {
                    _logFilePath = Path.Combine(Path.GetTempPath(), "safebrowse-user-helper.log");
                }
            }
            return _logFilePath;
        }

        private static void LogMessage(string level, string message)
        {
            try
            {
                lock (_logLock)
                {
                    string path = GetLogFilePath();
                    // Rotate if log exceeds 1MB
                    if (File.Exists(path))
                    {
                        FileInfo fi = new FileInfo(path);
                        if (fi.Length > 1024 * 1024)
                        {
                            string oldPath = path + ".old";
                            if (File.Exists(oldPath)) File.Delete(oldPath);
                            File.Move(path, oldPath);
                        }
                    }
                    string entry = string.Format("[{0:yyyy-MM-dd HH:mm:ss.fff}] [{1}] {2}{3}",
                        DateTime.UtcNow, level, message, Environment.NewLine);
                    File.AppendAllText(path, entry, Encoding.UTF8);
                }
            }
            catch
            {
                // Diagnostic logging must never crash the helper or display UI errors to the child
            }
        }

        private static void LogConnectionError(Exception ex)
        {
            DateTime now = DateTime.UtcNow;
            string msg = string.Format("{0}: {1}", ex.GetType().Name, ex.Message);
            // Rate limit identical connection errors to once every 10 seconds
            if (msg != _lastErrorMessage || (now - _lastErrorLogTime).TotalSeconds >= 10)
            {
                _lastErrorMessage = msg;
                _lastErrorLogTime = now;
                LogMessage("WARN", string.Format("Named pipe connection failed: {0}", msg));
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
