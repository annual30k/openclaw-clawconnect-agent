import { execFileSync } from "child_process";
import { resolveServiceEntryPath } from "./service-manager-common.js";
import { normalizeProfileName } from "../config/profile.js";
import { windowsServiceRunnerPath } from "./windows-service-paths.js";

export const WINDOWS_READ_ONLY_QUERY_TIMEOUT_MS = 5_000;

export type WindowsQueryTimeoutReporter = (probe: string) => void;

export function isProcessTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as NodeJS.ErrnoException & { killed?: boolean };
  return candidate.code === "ETIMEDOUT" || candidate.killed === true;
}

export function reportWindowsQueryTimeout(probe: string): void {
  console.error(
    `[clawconnect] Windows ${probe} query timed out after ${WINDOWS_READ_ONLY_QUERY_TIMEOUT_MS}ms; continuing with an unknown result.`,
  );
}

/**
 * 查询指定 profile 的 ClawConnect Agent 进程 PID。
 * 用 execFileSync 绕开 cmd.exe，避免 CMD 引号转义破坏命令行匹配。
 */
export function buildWindowsProcessQueryScript(profile?: string): string {
  const normalizedProfile = normalizeProfileName(profile);
  const profileFilter = normalizedProfile
    ? `($_.CommandLine -match ('(?:^|\\s)--profile(?:\\s+|=)' + [regex]::Escape($env:CLAW_PROFILE_NAME) + '(?:\\s|$)') -or $_.CommandLine -match [regex]::Escape($env:CLAW_RUNNER_PATH))`
    : `($_.CommandLine -notmatch '(?:^|\\s)--profile(?:\\s|=)')`;
  return `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -OperationTimeoutSec 3 | Where-Object { ($_.CommandLine -match 'clawconnect' -or $_.CommandLine -match [regex]::Escape($env:CLAW_SCRIPT_PATH) -or $_.CommandLine -match [regex]::Escape($env:CLAW_RUNNER_PATH)) -and ${profileFilter} } | Select-Object -ExpandProperty ProcessId`;
}

export function windowsProcessQueryEnv(
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

/**
 * 结束该 profile 仍在运行的 Agent 进程（旧计划任务遗留的、或手动前台启动的），
 * 防止它与服务托管的实例同时连接 Relay、互相顶替会话。
 * 返回是否确实结束了进程。
 */
export function killWindowsProcess(profile?: string): boolean {
  const scriptPath = process.argv[1];
  if (!scriptPath) return false;

  const currentPid = process.pid;

  try {
    const output = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", buildWindowsProcessQueryScript(profile)],
      {
        stdio: "pipe",
        env: windowsProcessQueryEnv(profile),
        timeout: WINDOWS_READ_ONLY_QUERY_TIMEOUT_MS,
        windowsHide: true,
      },
    )
      .toString()
      .trim();

    const pids = output
      .split(/\r?\n/)
      .map((p) => p.trim())
      .filter((p) => /\d+/.test(p) && Number(p) !== currentPid);
    if (pids.length === 0) return false;

    // 先温和结束，给进程一个收尾窗口；仍存活的再强杀。
    for (const pid of pids) {
      try {
        execFileSync("taskkill", ["/PID", String(pid)], { stdio: "pipe" });
      } catch {
        // 控制台/后台 Node 进程可能不响应 WM_CLOSE，后面会强杀。
      }
    }
    try {
      execFileSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Seconds 3"], { stdio: "pipe" });
    } catch {
      // 等待失败不影响后续强杀。
    }
    for (const pid of pids) {
      try {
        execFileSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "pipe" });
      } catch {
        // 多半已经正常退出。
      }
    }
    return true;
  } catch (err) {
    console.error("[clawconnect] Failed to kill Windows process:", err);
    return false;
  }
}
