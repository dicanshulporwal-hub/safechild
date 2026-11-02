import {
  exec,
  execFile,
  spawn,
  execSync,
  ExecOptions,
  ExecFileOptions,
  SpawnOptions,
  ExecSyncOptions,
  ChildProcess,
} from 'child_process';

/**
 * Standard execution options ensuring Windows child processes do not create
 * or flash a visible console window (cmd.exe, powershell.exe, conhost.exe, ipconfig.exe).
 */
export const HIDDEN_WINDOW_OPTIONS = {
  windowsHide: true,
} as const;

/**
 * Executes a file asynchronously with windowsHide: true guaranteed by default.
 */
export async function safeExecFileAsync(
  file: string,
  args?: readonly string[] | null,
  options?: ExecFileOptions
): Promise<{ stdout: string; stderr: string }> {
  const mergedOptions: ExecFileOptions = {
    encoding: 'utf8',
    ...HIDDEN_WINDOW_OPTIONS,
    ...(options || {}),
  };
  return new Promise((resolve, reject) => {
    execFile(file, (args || []) as string[], mergedOptions as any, (err, stdout, stderr) => {
      if (err) {
        (err as any).stdout = stdout?.toString() || '';
        (err as any).stderr = stderr?.toString() || '';
        return reject(err);
      }
      resolve({
        stdout: stdout?.toString() || '',
        stderr: stderr?.toString() || '',
      });
    });
  });
}

/**
 * Executes a command line asynchronously with windowsHide: true guaranteed by default.
 */
export async function safeExecAsync(
  command: string,
  options?: ExecOptions
): Promise<{ stdout: string; stderr: string }> {
  const mergedOptions: ExecOptions = {
    encoding: 'utf8',
    ...HIDDEN_WINDOW_OPTIONS,
    ...(options || {}),
  };
  return new Promise((resolve, reject) => {
    exec(command, mergedOptions as any, (err, stdout, stderr) => {
      if (err) {
        (err as any).stdout = stdout?.toString() || '';
        (err as any).stderr = stderr?.toString() || '';
        return reject(err);
      }
      resolve({
        stdout: stdout?.toString() || '',
        stderr: stderr?.toString() || '',
      });
    });
  });
}

/**
 * Spawns a child process with windowsHide: true guaranteed by default.
 */
export function safeSpawn(
  command: string,
  args?: readonly string[],
  options?: SpawnOptions
): ChildProcess {
  const mergedOptions: SpawnOptions = {
    ...HIDDEN_WINDOW_OPTIONS,
    ...(options || {}),
  };
  return spawn(command, args || [], mergedOptions);
}

/**
 * Executes a command synchronously with windowsHide: true guaranteed by default.
 */
export function safeExecSync(
  command: string,
  options?: ExecSyncOptions
): Buffer | string {
  const mergedOptions: ExecSyncOptions = {
    ...HIDDEN_WINDOW_OPTIONS,
    ...(options || {}),
  };
  return execSync(command, mergedOptions);
}
