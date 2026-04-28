import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import {
  ensureLogDir,
  ERROR_LOG_PATH,
  getProgramArgs,
  LOG_PATH,
} from "./service-manager-common.js";
import type { ServiceStatus } from "./service-manager-common.js";

export const TASK_NAME = "ClawConnectAgent";

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

/**
 * Build a command-line string suitable for Windows CommandLineToArgvW
 * (used by CreateProcess when schtasks later runs the task).
 *
 * - Args containing spaces or tabs are double-quoted.
 * - A literal `"` inside an arg is escaped as `\"` per Windows convention.
 * - Backslashes before a `"` are doubled to prevent them from being
 *   interpreted as escaping the quote character.
 */
function buildWindowsCommandLine(args: string[]): string {
  return args
    .map((arg) => {
      if (/[ \t"]/.test(arg)) {
        // Proper CommandLineToArgvW quoting:
        //   1. backslashes before a " must be doubled
        //   2. each " becomes \"
        //   3. wrap the result in quotes
        let result = "";
        for (let i = 0; i < arg.length; i++) {
          let backslashCount = 0;
          while (i < arg.length && arg[i] === "\\") {
            backslashCount++;
            i++;
          }
          if (i >= arg.length) {
            // All backslashes at end: double them before the closing quote
            result += "\\".repeat(backslashCount * 2);
          } else if (arg[i] === '"') {
            // Backslashes before a quote: double + add escape quote
            result += "\\".repeat(backslashCount * 2 + 1);
            result += '"';
          } else {
            // Normal character: backslashes are literal
            result += "\\".repeat(backslashCount);
            result += arg[i];
          }
        }
        return `"${result}"`;
      }
      return arg;
    })
    .join(" ");
}

/**
 * Kill any running node processes that are executing this specific script.
 * Uses execFileSync to bypass cmd.exe, avoiding CMD quote-mangling.
 * Returns true if any processes were killed.
 */
function killWindowsProcess(): boolean {
  const scriptPath = process.argv[1];
  if (!scriptPath) return false;

  const currentPid = process.pid;

  try {
    const psScript =
      `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match [regex]::Escape($env:CLAW_SCRIPT_PATH) } | Select-Object -ExpandProperty ProcessId`;
    const output = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", psScript],
      { stdio: "pipe", env: { ...process.env, CLAW_SCRIPT_PATH: scriptPath } }
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

export function installWindowsService(): boolean {
  const args = getProgramArgs();

  try {
    ensureLogDir();

    // ── Attempt 1: PowerShell ScheduledTasks module ──────────────────────
    // Supports RestartOnFailure (crash recovery) and full settings control.
    // Available on Windows 10 / Server 2016+.
    try {
      const execPath = args[0];
      const execArgs = args.slice(1);

      // We use 'powershell -WindowStyle Hidden' to launch node without a visible console window.
      // This is the most reliable native way to run a background console app on login.
      // Stdout/stderr are redirected to log files, matching the behavior of the
      // Linux (systemd/nohup) and macOS (launchd) service managers.
      const innerCmd = buildWindowsPowerShellBootstrap(
        `& ${qps(execPath)} ${execArgs.map((a) => qps(a)).join(" ")} >> ${qps(LOG_PATH)} 2>> ${qps(ERROR_LOG_PATH)}`
      );

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
        `Register-ScheduledTask -TaskName ${qps(TASK_NAME)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
      ].join("\n");

      execFileSync("powershell", ["-NoProfile", "-Command", psScript], { stdio: "pipe" });
      execFileSync("schtasks", ["/run", "/tn", TASK_NAME], { stdio: "pipe" });
      return true;
    } catch (err) {
      // Fall through to basic schtasks below
    }

    // ── Attempt 2: Basic schtasks (no crash recovery) ────────────────────
    const cmdLine = buildWindowsCommandLine(args);
    // Wrap in powershell -WindowStyle Hidden so no console window pops up at login.
    // schtasks stores /tr as-is; CreateProcess parses it with CommandLineToArgvW.
    // The inner command is passed as a single argument to -Command via double quotes
    // escaped as \" per CommandLineToArgvW convention.
    // Stdout/stderr are redirected to log files via PowerShell >> / 2>> operators.
    const escLogPath = LOG_PATH.replace(/'/g, "''");
    const escErrPath = ERROR_LOG_PATH.replace(/'/g, "''");
    const fallbackInner = buildWindowsPowerShellBootstrap(
      `${cmdLine} >> '${escLogPath}' 2>> '${escErrPath}'`
    );
    const fallbackTr = `powershell.exe -WindowStyle Hidden -Command "${fallbackInner.replace(/"/g, '\\"')}"`;

    execFileSync(
      "schtasks",
      ["/create", "/tn", TASK_NAME, "/tr", fallbackTr, "/sc", "onlogon", "/f"],
      { stdio: "pipe" }
    );
    execFileSync("schtasks", ["/run", "/tn", TASK_NAME], { stdio: "pipe" });
    return true;
  } catch (err) {
    console.error("[clawconnect] Failed to install Windows task:", err);
    return false;
  }
}

export function uninstallWindowsService(): boolean {
  try {
    let changed = false;
    try {
      execFileSync("schtasks", ["/delete", "/tn", TASK_NAME, "/f"], { stdio: "pipe" });
      changed = true;
    } catch {
      // task might not exist
    }

    if (killWindowsProcess()) {
      changed = true;
    }
    return changed;
  } catch (err) {
    console.error("[clawconnect] Failed to uninstall Windows task:", err);
    return false;
  }
}

export function restartWindowsService(): boolean {
  // Try to stop the task first
  try {
    execFileSync("schtasks", ["/end", "/tn", TASK_NAME], { stdio: "pipe" });
  } catch {
    // ignore if not running
  }

  killWindowsProcess();

  try {
    execFileSync("schtasks", ["/run", "/tn", TASK_NAME], { stdio: "pipe" });
    return true;
  } catch {
    // If the task doesn't exist, install it
    return installWindowsService();
  }
}

export function stopWindowsService(): boolean {
  try {
    execFileSync("schtasks", ["/end", "/tn", TASK_NAME], { stdio: "pipe" });
  } catch {
    // ignore if not running
  }
  return killWindowsProcess();
}

export function getWindowsServiceStatus(): ServiceStatus {
  let installed = false;
  try {
    execFileSync("schtasks", ["/query", "/tn", TASK_NAME], { stdio: "pipe" });
    installed = true;
  } catch {
    installed = false;
  }

  let running = false;
  if (installed) {
    try {
      const scriptPath = process.argv[1];
      if (scriptPath) {
        const psScript =
          `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match [regex]::Escape($env:CLAW_SCRIPT_PATH) } | Select-Object -ExpandProperty ProcessId`;
        const output = execFileSync(
          "powershell",
          ["-NoProfile", "-Command", psScript],
          { stdio: "pipe", env: { ...process.env, CLAW_SCRIPT_PATH: scriptPath } }
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
    serviceName: TASK_NAME,
    manager: "Windows Task Scheduler",
    logPath: LOG_PATH,
    startHint: `schtasks /run /tn "${TASK_NAME}"`,
  };
}
