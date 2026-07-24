import { execFileSync } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import {
  ensureLogDir,
  getProfileErrorLogPath,
  getProfileLogDir,
  getProfileLogPath,
  getProgramArgs,
  resolveServiceEntryPath,
  setRestrictiveFilePermissions,
} from "./service-manager-common.js";
import type { ServiceStatus } from "./service-manager-common.js";
import { getActiveProfile, normalizeProfileName } from "../config/profile.js";
import { decodeTextBuffer } from "./text-file-decoder.js";

export const TASK_NAME = "ClawConnectAgent";
export const WINDOWS_SERVICE_RUNNER_NAME = "clawconnect-service.ps1";
export const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const WINDOWS_READ_ONLY_QUERY_TIMEOUT_MS = 5_000;

export interface WindowsServiceStatusProbeOptions {
  execFileSyncImpl?: typeof execFileSync;
  onQueryTimeout?: (probe: string) => void;
  scriptPath?: string;
}

type WindowsQueryTimeoutReporter = (probe: string) => void;

export function windowsTaskName(profile?: string): string {
  const normalized = normalizeProfileName(profile);
  return normalized ? `${TASK_NAME}-${normalized}` : TASK_NAME;
}

function qps(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildWindowsPowerShellBootstrap(command: string): string {
  return [
    // Native process stdout is UTF-8; teach PowerShell to decode it correctly
    // and keep redirection writes in UTF-8 so log readers see stable text.
    `$utf8NoBom = [System.Text.UTF8Encoding]::new($false)`,
    `[Console]::InputEncoding = $utf8NoBom`,
    `[Console]::OutputEncoding = $utf8NoBom`,
    `$OutputEncoding = $utf8NoBom`,
    `$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'`,
    command,
  ].join("; ");
}

export function normalizeWindowsServiceLogEncoding(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  const decoded = decodeTextBuffer(readFileSync(path));
  if (decoded.encoding !== "utf8") {
    writeFileSync(path, decoded.text, "utf8");
  }
}

export function buildWindowsServiceProcessCommand(
  args: string[],
  logPath: string,
  errorLogPath: string,
): string {
  const [execPath, ...execArgs] = args;
  if (!execPath) {
    throw new Error("Windows service executable is required");
  }
  return buildWindowsPowerShellBootstrap(
    `& ${qps(execPath)} ${execArgs.map((arg) => qps(arg)).join(" ")} >> ${qps(logPath)} 2>> ${qps(errorLogPath)}`,
  );
}

export function windowsServiceRunnerPath(profile?: string): string {
  return join(getProfileLogDir(profile), WINDOWS_SERVICE_RUNNER_NAME);
}

export function buildWindowsServiceTaskCommand(runnerPath: string): string {
  return `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${runnerPath}"`;
}

export function buildWindowsStartupRegistryArgs(
  taskName: string,
  taskCommand: string,
): string[] {
  return [
    "add",
    WINDOWS_RUN_KEY,
    "/v",
    taskName,
    "/t",
    "REG_SZ",
    "/d",
    taskCommand,
    "/f",
  ];
}

function removeWindowsStartupEntry(taskName: string): boolean {
  try {
    execFileSync("reg.exe", ["delete", WINDOWS_RUN_KEY, "/v", taskName, "/f"], {
      stdio: "pipe",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function hasWindowsStartupEntry(
  taskName: string,
  execFileSyncImpl: typeof execFileSync = execFileSync,
  onQueryTimeout: WindowsQueryTimeoutReporter = reportWindowsQueryTimeout,
): boolean {
  try {
    execFileSyncImpl("reg.exe", ["query", WINDOWS_RUN_KEY, "/v", taskName], {
      stdio: "pipe",
      windowsHide: true,
      timeout: WINDOWS_READ_ONLY_QUERY_TIMEOUT_MS,
    });
    return true;
  } catch (error) {
    if (isProcessTimeoutError(error)) {
      onQueryTimeout("startup registry");
    }
    return false;
  }
}

function hasWindowsScheduledTask(
  taskName: string,
  execFileSyncImpl: typeof execFileSync = execFileSync,
  onQueryTimeout: WindowsQueryTimeoutReporter = reportWindowsQueryTimeout,
): boolean {
  try {
    execFileSyncImpl("schtasks", ["/query", "/tn", taskName], {
      stdio: "pipe",
      windowsHide: true,
      timeout: WINDOWS_READ_ONLY_QUERY_TIMEOUT_MS,
    });
    return true;
  } catch (error) {
    if (isProcessTimeoutError(error)) {
      onQueryTimeout("scheduled task");
    }
    return false;
  }
}

export function buildWindowsScheduledTaskStateScript(): string {
  return `[string](Get-ScheduledTask -TaskName $env:CLAW_TASK_NAME -ErrorAction Stop).State`;
}

function isWindowsScheduledTaskRunning(
  taskName: string,
  execFileSyncImpl: typeof execFileSync = execFileSync,
  onQueryTimeout: WindowsQueryTimeoutReporter = reportWindowsQueryTimeout,
): boolean {
  try {
    const output = execFileSyncImpl(
      "powershell",
      ["-NoProfile", "-Command", buildWindowsScheduledTaskStateScript()],
      {
        stdio: "pipe",
        env: { ...process.env, CLAW_TASK_NAME: taskName },
        timeout: WINDOWS_READ_ONLY_QUERY_TIMEOUT_MS,
        windowsHide: true,
      },
    )
      .toString()
      .trim();
    return /^running$/i.test(output);
  } catch (error) {
    if (isProcessTimeoutError(error)) {
      onQueryTimeout("scheduled task state");
    }
    return false;
  }
}

function isProcessTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as NodeJS.ErrnoException & { killed?: boolean };
  return candidate.code === "ETIMEDOUT" || candidate.killed === true;
}

function reportWindowsQueryTimeout(probe: string): void {
  console.error(
    `[clawconnect] Windows ${probe} query timed out after ${WINDOWS_READ_ONLY_QUERY_TIMEOUT_MS}ms; continuing with an unknown result.`,
  );
}

export function buildWindowsDetachedRunnerStartScript(): string {
  return [
    `$runnerArgument = '"' + $env:CLAW_RUNNER_PATH + '"'`,
    `$process = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $runnerArgument) -PassThru`,
    `[string]$process.Id`,
  ].join("; ");
}

function startWindowsRunner(runnerPath: string): boolean {
  try {
    // Node 的 detached spawn 在部分普通用户/远控会话中会无错误返回、但子进程随即消失。
    // 由 Windows PowerShell 的 Start-Process 创建独立隐藏进程，并要求返回真实 PID 后才算启动成功。
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", buildWindowsDetachedRunnerStartScript()],
      {
        stdio: "pipe",
        env: { ...process.env, CLAW_RUNNER_PATH: runnerPath },
        timeout: WINDOWS_READ_ONLY_QUERY_TIMEOUT_MS,
        windowsHide: true,
      },
    ).toString().trim();
    return /^\d+$/.test(output);
  } catch (error) {
    console.error("[clawconnect] Failed to start Windows service runner:", error);
    return false;
  }
}

function startScheduledTaskOrRunner(taskName: string, runnerPath: string): void {
  try {
    execFileSync("schtasks", ["/run", "/tn", taskName], { stdio: "pipe" });
  } catch {
    startWindowsRunner(runnerPath);
  }
}

function installWindowsStartupEntry(
  taskName: string,
  taskCommand: string,
  runnerPath: string,
): void {
  execFileSync("reg.exe", buildWindowsStartupRegistryArgs(taskName, taskCommand), {
    stdio: "pipe",
    windowsHide: true,
  });
  if (!startWindowsRunner(runnerPath)) {
    throw new Error("Windows startup entry was created, but its service runner did not start");
  }
}

export function writeWindowsServiceRunner(
  profile: string | undefined,
  args: string[],
  logPath: string,
  errorLogPath: string,
): string {
  const runnerPath = windowsServiceRunnerPath(profile);
  const script = `${buildWindowsServiceProcessCommand(args, logPath, errorLogPath)}\r\n`;
  // Windows PowerShell 5.1 treats UTF-8 files without a BOM as the active ANSI
  // code page. Keep the BOM so user names and install paths remain intact.
  const utf8WithBom = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(script, "utf8"),
  ]);
  writeFileSync(runnerPath, utf8WithBom);
  setRestrictiveFilePermissions(runnerPath);
  return runnerPath;
}

function refreshWindowsServiceRunner(profile?: string): string {
  const resolvedProfile = normalizeProfileName(profile ?? getActiveProfile());
  const logPath = getProfileLogPath(resolvedProfile);
  const errorLogPath = getProfileErrorLogPath(resolvedProfile);
  ensureLogDir(resolvedProfile);
  // 升级 npm 包后 runner 必须改用当前 Node/CLI 绝对路径；同时先归一化旧版 PowerShell 日志编码。
  normalizeWindowsServiceLogEncoding(logPath);
  normalizeWindowsServiceLogEncoding(errorLogPath);
  return writeWindowsServiceRunner(
    resolvedProfile,
    getProgramArgs(resolvedProfile),
    logPath,
    errorLogPath,
  );
}

/**
 * Kill any running node processes that are executing this specific script.
 * Uses execFileSync to bypass cmd.exe, avoiding CMD quote-mangling.
 * Returns true if any processes were killed.
 */
export function buildWindowsProcessQueryScript(profile?: string): string {
  const normalizedProfile = normalizeProfileName(profile);
  const profileFilter = normalizedProfile
    ? `($_.CommandLine -match ('(?:^|\\s)--profile(?:\\s+|=)' + [regex]::Escape($env:CLAW_PROFILE_NAME) + '(?:\\s|$)') -or $_.CommandLine -match [regex]::Escape($env:CLAW_RUNNER_PATH))`
    : `($_.CommandLine -notmatch '(?:^|\\s)--profile(?:\\s|=)')`;
  return `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -OperationTimeoutSec 3 | Where-Object { ($_.CommandLine -match 'clawconnect' -or $_.CommandLine -match [regex]::Escape($env:CLAW_SCRIPT_PATH) -or $_.CommandLine -match [regex]::Escape($env:CLAW_RUNNER_PATH)) -and ${profileFilter} } | Select-Object -ExpandProperty ProcessId`;
}

function windowsProcessQueryEnv(
  profile?: string,
  scriptPath = process.argv[1],
): NodeJS.ProcessEnv {
  const normalizedProfile = normalizeProfileName(profile);
  return {
    ...process.env,
    CLAW_SCRIPT_PATH: scriptPath ? resolveServiceEntryPath(scriptPath) : "",
    CLAW_RUNNER_PATH: windowsServiceRunnerPath(normalizedProfile),
    CLAW_PROFILE_NAME: normalizedProfile ?? "",
  };
}

function killWindowsProcess(profile?: string): boolean {
  const scriptPath = process.argv[1];
  if (!scriptPath) return false;

  const currentPid = process.pid;

  try {
    const psScript = buildWindowsProcessQueryScript(profile);
    const output = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", psScript],
      {
        stdio: "pipe",
        env: windowsProcessQueryEnv(profile),
        timeout: WINDOWS_READ_ONLY_QUERY_TIMEOUT_MS,
        windowsHide: true,
      }
    )
      .toString()
      .trim();

    const pids = output
      .split(/\r?\n/)
      .map((p) => p.trim())
      .filter((p) => /\d+/.test(p) && Number(p) !== currentPid);
    if (pids.length === 0) return false;

    // Step 1: graceful shutdown — taskkill without /F sends WM_CLOSE.
    // For console/background Node.js processes this is best-effort only.
    for (const pid of pids) {
      try {
        execFileSync("taskkill", ["/PID", String(pid)], { stdio: "pipe" });
      } catch {
        // ignore — will fall back to /F below
      }
    }

    // Step 2: give processes a brief window to flush / clean up
    try {
      execFileSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Seconds 3"], { stdio: "pipe" });
    } catch {
      // ignore
    }

    // Step 3: force-kill anything still alive
    for (const pid of pids) {
      try {
        execFileSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "pipe" });
      } catch {
        // ignore — probably already exited gracefully
      }
    }
    return true;
  } catch (err) {
    console.error("[clawconnect] Failed to kill Windows process:", err);
    return false;
  }
}

export function installWindowsService(profile?: string): boolean {
  const resolvedProfile = normalizeProfileName(profile ?? getActiveProfile());
  const taskName = windowsTaskName(resolvedProfile);

  try {
    try {
      execFileSync("schtasks", ["/end", "/tn", taskName], { stdio: "pipe" });
    } catch {
      // First install or already stopped.
    }
    killWindowsProcess(resolvedProfile);

    // Keep the scheduled task command short. schtasks limits /tr to 261
    // characters, while NVM/npm paths plus UTF-8 bootstrap and log redirects
    // can easily exceed it when embedded inline.
    const runnerPath = refreshWindowsServiceRunner(resolvedProfile);
    const taskCommand = buildWindowsServiceTaskCommand(runnerPath);
    const taskArguments = taskCommand.slice("powershell.exe ".length);

    // ── Attempt 1: PowerShell ScheduledTasks module ──────────────────────
    // Supports RestartOnFailure (crash recovery) and full settings control.
    // Available on Windows 10 / Server 2016+.
    try {
      // We use 'powershell -WindowStyle Hidden' to launch node without a visible console window.
      // This is the most reliable native way to run a background console app on login.
      // Stdout/stderr are redirected to log files, matching the behavior of the
      // Linux (systemd/nohup) and macOS (launchd) service managers.
      const psScript = [
        `$action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${qps(taskArguments)}`,
        `$trigger  = New-ScheduledTaskTrigger -AtLogon`,
        `$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited`,
        `$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`,
        `Register-ScheduledTask -TaskName ${qps(taskName)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
      ].join("\n");

      execFileSync("powershell", ["-NoProfile", "-Command", psScript], { stdio: "pipe" });
      removeWindowsStartupEntry(taskName);
      startScheduledTaskOrRunner(taskName, runnerPath);
      return true;
    } catch {
      // Fall through to basic schtasks below
    }

    // ── Attempt 2: Basic schtasks (no crash recovery) ────────────────────
    try {
      execFileSync(
        "schtasks",
        [
          "/create",
          "/tn",
          taskName,
          "/tr",
          taskCommand,
          "/sc",
          "onlogon",
          "/rl",
          "LIMITED",
          "/f",
        ],
        { stdio: "pipe" },
      );
      removeWindowsStartupEntry(taskName);
      startScheduledTaskOrRunner(taskName, runnerPath);
      return true;
    } catch {
      // Some Windows policies reserve Task Scheduler registration for
      // administrators. HKCU Run is a per-user startup mechanism and does not
      // require elevation.
    }

    // An older task can be readable but not replaceable by the current
    // unelevated shell. Keep that login trigger instead of installing a second
    // autostart path, and launch the newly written runner immediately.
    if (hasWindowsScheduledTask(taskName)) {
      removeWindowsStartupEntry(taskName);
      startScheduledTaskOrRunner(taskName, runnerPath);
      return true;
    }

    installWindowsStartupEntry(taskName, taskCommand, runnerPath);
    return true;
  } catch (err) {
    console.error("[clawconnect] Failed to install Windows background startup:", err);
    return false;
  }
}

export function uninstallWindowsService(profile?: string): boolean {
  const resolvedProfile = normalizeProfileName(profile ?? getActiveProfile());
  const taskName = windowsTaskName(resolvedProfile);
  const runnerPath = windowsServiceRunnerPath(resolvedProfile);
  try {
    let changed = false;
    try {
      execFileSync("schtasks", ["/delete", "/tn", taskName, "/f"], { stdio: "pipe" });
      changed = true;
    } catch {
      // task might not exist
    }

    if (killWindowsProcess(resolvedProfile)) {
      changed = true;
    }
    if (removeWindowsStartupEntry(taskName)) {
      changed = true;
    }
    try {
      unlinkSync(runnerPath);
      changed = true;
    } catch {
      // runner might not exist
    }
    return changed;
  } catch (err) {
    console.error("[clawconnect] Failed to uninstall Windows task:", err);
    return false;
  }
}

export function restartWindowsService(profile?: string): boolean {
  const resolvedProfile = normalizeProfileName(profile ?? getActiveProfile());
  const taskName = windowsTaskName(resolvedProfile);
  // Try to stop the task first
  try {
    execFileSync("schtasks", ["/end", "/tn", taskName], { stdio: "pipe" });
  } catch {
    // ignore if not running
  }

  killWindowsProcess(resolvedProfile);

  let runnerPath: string;
  try {
    // `npm install -g` 可能改变 Node 或全局包路径；普通 restart 也必须刷新 runner，不能继续执行旧版本入口。
    runnerPath = refreshWindowsServiceRunner(resolvedProfile);
  } catch (error) {
    console.error("[clawconnect] Failed to refresh Windows service runner:", error);
    return false;
  }

  if (hasWindowsStartupEntry(taskName)) {
    return startWindowsRunner(runnerPath);
  }

  try {
    execFileSync("schtasks", ["/run", "/tn", taskName], { stdio: "pipe" });
    return true;
  } catch {
    // If the task doesn't exist, install it
    return installWindowsService(resolvedProfile);
  }
}

export function stopWindowsService(profile?: string): boolean {
  const resolvedProfile = normalizeProfileName(profile ?? getActiveProfile());
  const taskName = windowsTaskName(resolvedProfile);
  try {
    execFileSync("schtasks", ["/end", "/tn", taskName], { stdio: "pipe" });
  } catch {
    // ignore if not running
  }
  return killWindowsProcess(resolvedProfile);
}

export function getWindowsServiceStatus(
  profile?: string,
  options: WindowsServiceStatusProbeOptions = {},
): ServiceStatus {
  const resolvedProfile = normalizeProfileName(profile ?? getActiveProfile());
  const taskName = windowsTaskName(resolvedProfile);
  const logPath = getProfileLogPath(resolvedProfile);
  const execFileSyncImpl = options.execFileSyncImpl ?? execFileSync;
  const onQueryTimeout = options.onQueryTimeout ?? reportWindowsQueryTimeout;
  const installedViaTask = hasWindowsScheduledTask(taskName, execFileSyncImpl, onQueryTimeout);
  const installedViaStartup = hasWindowsStartupEntry(taskName, execFileSyncImpl, onQueryTimeout);
  const installed = installedViaTask || installedViaStartup;

  // Task Scheduler already tracks the blocking PowerShell runner. Prefer that
  // state over Win32_Process.CommandLine, which can be blank under Windows
  // privacy/UAC policies even for processes owned by the current user.
  let running = installedViaTask
    && isWindowsScheduledTaskRunning(taskName, execFileSyncImpl, onQueryTimeout);
  if (installed && !running) {
    try {
      const scriptPath = options.scriptPath ?? process.argv[1];
      if (scriptPath) {
        const psScript = buildWindowsProcessQueryScript(resolvedProfile);
        const output = execFileSyncImpl(
          "powershell",
          ["-NoProfile", "-Command", psScript],
          {
            stdio: "pipe",
            env: windowsProcessQueryEnv(resolvedProfile, scriptPath),
            timeout: WINDOWS_READ_ONLY_QUERY_TIMEOUT_MS,
            windowsHide: true,
          }
        )
          .toString()
          .trim();
        running = /\d+/.test(output);
      }
    } catch (error) {
      if (isProcessTimeoutError(error)) {
        onQueryTimeout("running process");
      }
    }
  }

  return {
    platform: "windows",
    installed,
    running,
    serviceName: taskName,
    manager: installedViaTask ? "Windows Task Scheduler" : "Windows Startup",
    servicePath: windowsServiceRunnerPath(resolvedProfile),
    logPath,
    startHint: installedViaTask
      ? `schtasks /run /tn "${taskName}"`
      : buildWindowsServiceTaskCommand(windowsServiceRunnerPath(resolvedProfile)),
  };
}
