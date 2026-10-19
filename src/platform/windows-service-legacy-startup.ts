import { execFileSync } from "child_process";
import { listProfileNames, normalizeProfileName } from "../config/profile.js";
import {
  isProcessTimeoutError,
  killWindowsProcess,
  reportWindowsQueryTimeout,
  WINDOWS_READ_ONLY_QUERY_TIMEOUT_MS,
} from "./windows-process-control.js";
import type { WindowsQueryTimeoutReporter } from "./windows-process-control.js";
import { WINDOWS_SERVICE_BASE_NAME, windowsServiceName } from "./windows-service-paths.js";

export const LEGACY_WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

type ExecFileSyncImpl = typeof execFileSync;

export interface LegacyWindowsStartupOptions {
  execFileSyncImpl?: ExecFileSyncImpl;
  onQueryTimeout?: WindowsQueryTimeoutReporter;
  /** 测试用：默认 profile 是否已配置。未提供时读取磁盘上的 profile 列表。 */
  defaultProfileConfigured?: boolean;
  /** 测试用：替换"结束遗留 Agent 进程"的动作。 */
  stopLegacyProcess?: (profile: string | undefined) => void;
}

interface LegacyProbe {
  taskExists: boolean;
  runEntryExists: boolean;
  timedOut: boolean;
}

function probeLegacyEntries(
  name: string,
  execFileSyncImpl: ExecFileSyncImpl,
  onQueryTimeout: WindowsQueryTimeoutReporter,
): LegacyProbe {
  const probe: LegacyProbe = { taskExists: false, runEntryExists: false, timedOut: false };
  const run = (command: string, args: string[], label: string): boolean => {
    try {
      execFileSyncImpl(command, args, {
        stdio: "pipe",
        windowsHide: true,
        timeout: WINDOWS_READ_ONLY_QUERY_TIMEOUT_MS,
      });
      return true;
    } catch (error) {
      if (isProcessTimeoutError(error)) {
        probe.timedOut = true;
        onQueryTimeout(label);
      }
      return false;
    }
  };
  probe.taskExists = run("schtasks", ["/query", "/tn", name], "scheduled task");
  probe.runEntryExists = run("reg.exe", ["query", LEGACY_WINDOWS_RUN_KEY, "/v", name], "startup registry");
  return probe;
}

function removeLegacyEntries(name: string, probe: LegacyProbe, execFileSyncImpl: ExecFileSyncImpl): boolean {
  let removed = true;
  if (probe.taskExists) {
    try {
      execFileSyncImpl("schtasks", ["/end", "/tn", name], { stdio: "pipe", windowsHide: true });
    } catch {
      // 任务可能处于未运行状态。
    }
    try {
      execFileSyncImpl("schtasks", ["/delete", "/tn", name, "/f"], { stdio: "pipe", windowsHide: true });
    } catch {
      removed = false;
    }
  }
  if (probe.runEntryExists) {
    try {
      execFileSyncImpl("reg.exe", ["delete", LEGACY_WINDOWS_RUN_KEY, "/v", name, "/f"], {
        stdio: "pipe",
        windowsHide: true,
      });
    } catch {
      removed = false;
    }
  }
  return removed;
}

/**
 * 迁移到 Windows 服务后清理旧的"计划任务 / HKCU Run"自启动项。
 *
 * 必须清理干净：旧项下次登录会再拉起一个 Agent，与服务托管的实例同时连 Relay，
 * Relay 会让后连的顶掉先连的，两边互相抢占，表现为网关反复掉线。
 *
 * 清理对象：
 * 1. 该 profile 自己的同名任务与 Run 项（默认 profile 为无后缀名称）；
 * 2. 具名 profile 且磁盘上没有已配置的 default profile 时，再清理遗留的无后缀名称。
 *    存在 default profile 时，无后缀名称归 default 所有，必须保留。
 *
 * 任一项查询超时或删除失败都返回 false，调用方应中止安装而不是带着遗留项继续。
 */
export function removeLegacyWindowsStartup(
  profile?: string,
  options: LegacyWindowsStartupOptions = {},
): boolean {
  const resolvedProfile = normalizeProfileName(profile);
  const execFileSyncImpl = options.execFileSyncImpl ?? execFileSync;
  const onQueryTimeout = options.onQueryTimeout ?? reportWindowsQueryTimeout;
  const stopLegacyProcess = options.stopLegacyProcess ?? ((target) => { killWindowsProcess(target); });

  const names = [windowsServiceName(resolvedProfile)];
  if (resolvedProfile) {
    const defaultProfileConfigured = options.defaultProfileConfigured
      ?? listProfileNames().includes("default");
    if (!defaultProfileConfigured) {
      names.push(WINDOWS_SERVICE_BASE_NAME);
    }
  }

  let migrated = true;
  for (const name of names) {
    const probe = probeLegacyEntries(name, execFileSyncImpl, onQueryTimeout);
    if (probe.timedOut) {
      return false;
    }
    if (!probe.taskExists && !probe.runEntryExists) {
      continue;
    }
    if (!removeLegacyEntries(name, probe, execFileSyncImpl)) {
      migrated = false;
    }
    // 无后缀名称对应没有 --profile 的 Agent 进程；具名名称对应该 profile 的进程。
    stopLegacyProcess(name === WINDOWS_SERVICE_BASE_NAME ? undefined : resolvedProfile);
  }
  return migrated;
}
