import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import {
  ensureLogDir,
  getProfileErrorLogPath,
  getProfileLogPath,
  getProgramArgs,
  resolveServiceEntryPath,
} from "./service-manager-common.js";
import type { ServiceStatus } from "./service-manager-common.js";
import { getActiveProfile, normalizeProfileName } from "../config/profile.js";
import { decodeTextBuffer } from "./text-file-decoder.js";

export const TASK_NAME = "ClawConnectAgent";

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

/**
 * Kill any running node processes that are executing this specific script.
 * Uses execFileSync to bypass cmd.exe, avoiding CMD quote-mangling.
 * Returns true if any processes were killed.
 */
export function buildWindowsProcessQueryScript(profile?: string): string {
  const profileFilter = normalizeProfileName(profile)
    ? `($_.CommandLine -match ('(?:^|\\s)--profile(?:\\s+|=)' + [regex]::Escape($env:CLAW_PROFILE_NAME) + '(?:\\s|$)'))`
    : `($_.CommandLine -notmatch '(?:^|\\s)--profile(?:\\s|=)')`;
  return `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match [regex]::Escape($env:CLAW_SCRIPT_PATH) -and ${profileFilter} } | Select-Object -ExpandProperty ProcessId`;
}

function windowsProcessQueryEnv(profile?: string): NodeJS.ProcessEnv {
  const scriptPath = process.argv[1];
  return {
    ...process.env,
    CLAW_SCRIPT_PATH: scriptPath ? resolveServiceEntryPath(scriptPath) : "",
    CLAW_PROFILE_NAME: normalizeProfileName(profile) ?? "",
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
      { stdio: "pipe", env: windowsProcessQueryEnv(profile) }
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
  const logPath = getProfileLogPath(resolvedProfile);
  const errorLogPath = getProfileErrorLogPath(resolvedProfile);
  const args = getProgramArgs(resolvedProfile);

  try {
    ensureLogDir(resolvedProfile);
    try {
      execFileSync("schtasks", ["/end", "/tn", taskName], { stdio: "pipe" });
    } catch {
      // First install or already stopped.
    }
    killWindowsProcess(resolvedProfile);
    // 旧版 PowerShell 可能创建 UTF-16LE 日志；转换后再以 UTF-8 追加，避免一个文件混合两种编码。
    normalizeWindowsServiceLogEncoding(logPath);
    normalizeWindowsServiceLogEncoding(errorLogPath);

    // ── Attempt 1: PowerShell ScheduledTasks module ──────────────────────
    // Supports RestartOnFailure (crash recovery) and full settings control.
    // Available on Windows 10 / Server 2016+.
    try {
      // We use 'powershell -WindowStyle Hidden' to launch node without a visible console window.
      // This is the most reliable native way to run a background console app on login.
      // Stdout/stderr are redirected to log files, matching the behavior of the
      // Linux (systemd/nohup) and macOS (launchd) service managers.
      const innerCmd = buildWindowsServiceProcessCommand(args, logPath, errorLogPath);

      // The -Argument value uses a PowerShell double-quote string ("" → literal ")
      // so that single quotes from qps() inside it are preserved literally.
      // Escape any `$` or `` ` `` in the paths to prevent PowerShell variable expansion.
      const escapedInner = innerCmd.replace(/`/g, "``").replace(/\$/g, "`$");
      const quotedArg = `"-WindowStyle Hidden -Command ""${escapedInner}"""`;

      const psScript = [
        `$action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quotedArg}`,
        `$trigger  = New-ScheduledTaskTrigger -AtLogon`,
        `$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest`,
        `$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`,
        `Register-ScheduledTask -TaskName ${qps(taskName)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
      ].join("\n");

      execFileSync("powershell", ["-NoProfile", "-Command", psScript], { stdio: "pipe" });
      execFileSync("schtasks", ["/run", "/tn", taskName], { stdio: "pipe" });
      return true;
    } catch (err) {
      // Fall through to basic schtasks below
    }

    // ── Attempt 2: Basic schtasks (no crash recovery) ────────────────────
    // Wrap in powershell -WindowStyle Hidden so no console window pops up at login.
    // schtasks stores /tr as-is; CreateProcess parses it with CommandLineToArgvW.
    // The inner command is passed as a single argument to -Command via double quotes
    // escaped as \" per CommandLineToArgvW convention.
    // Stdout/stderr are redirected to log files via PowerShell >> / 2>> operators.
    const fallbackInner = buildWindowsServiceProcessCommand(args, logPath, errorLogPath);
    const fallbackTr = `powershell.exe -WindowStyle Hidden -Command "${fallbackInner.replace(/"/g, '\\"')}"`;

    execFileSync(
      "schtasks",
      ["/create", "/tn", taskName, "/tr", fallbackTr, "/sc", "onlogon", "/f"],
      { stdio: "pipe" }
    );
    execFileSync("schtasks", ["/run", "/tn", taskName], { stdio: "pipe" });
    return true;
  } catch (err) {
    console.error("[clawconnect] Failed to install Windows task:", err);
    return false;
  }
}

export function uninstallWindowsService(profile?: string): boolean {
  const resolvedProfile = normalizeProfileName(profile ?? getActiveProfile());
  const taskName = windowsTaskName(resolvedProfile);
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

export function getWindowsServiceStatus(profile?: string): ServiceStatus {
  const resolvedProfile = normalizeProfileName(profile ?? getActiveProfile());
  const taskName = windowsTaskName(resolvedProfile);
  const logPath = getProfileLogPath(resolvedProfile);
  let installed = false;
  try {
    execFileSync("schtasks", ["/query", "/tn", taskName], { stdio: "pipe" });
    installed = true;
  } catch {
    installed = false;
  }

  let running = false;
  if (installed) {
    try {
      const scriptPath = process.argv[1];
      if (scriptPath) {
        const psScript = buildWindowsProcessQueryScript(resolvedProfile);
        const output = execFileSync(
          "powershell",
          ["-NoProfile", "-Command", psScript],
          { stdio: "pipe", env: windowsProcessQueryEnv(resolvedProfile) }
        )
          .toString()
          .trim();
        running = /\d+/.test(output);
      }
    } catch {
      // ignore
    }
  }

  return {
    platform: "windows",
    installed,
    running,
    serviceName: taskName,
    manager: "Windows Task Scheduler",
    logPath,
    startHint: `schtasks /run /tn "${taskName}"`,
  };
}
