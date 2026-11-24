import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { normalizeProfileName } from "../config/profile.js";
import { resolveServiceEntryPath } from "./service-manager-common.js";

export const LINUX_STOP_POLL_INTERVAL_MS = 50;
export const LINUX_SIGTERM_TIMEOUT_MS = 3_000;
export const LINUX_SIGKILL_TIMEOUT_MS = 2_000;

export interface LinuxServicePaths {
  profile?: string;
  serviceName: string;
  servicePath: string;
  pidPath: string;
  startScriptPath: string;
  workingDirectory: string;
  logPath: string;
  errorLogPath: string;
}

export interface LinuxSystemdUnitConfig {
  profile?: string;
  programArgs: readonly string[];
  workingDirectory: string;
  stdoutLogPath: string;
  stderrLogPath: string;
}

export interface LinuxProcessControlDeps {
  procRoot?: string;
  currentPid?: number;
  currentUid?: number;
  entryScriptPath?: string;
  isPidRunning?: (pid: number) => boolean;
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  sleepSync?: (ms: number) => void;
  sigtermTimeoutMs?: number;
  sigkillTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface StopLinuxProcessesResult {
  changed: boolean;
  allExited: boolean;
}

export function defaultLinuxSleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function defaultIsPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "EPERM";
  }
}

function defaultKillPid(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

/**
 * POSIX 单引号转义（专供 Linux bash 启动脚本使用，不随测试宿主机平台变化）。
 */
export function posixShellEscape(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function assertSingleLineSystemdValue(label: string, value: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`Linux systemd ${label} must not contain line breaks or NUL bytes`);
  }
}

function escapeSystemdSpecifier(value: string): string {
  return value.replace(/%/g, "%%");
}

/**
 * systemd `ExecStart=` 使用自身的分词、C 风格反转义与 `$` 变量展开规则，而不是 POSIX shell。
 * 普通绝对路径保持无引号；含空白、引号或反斜杠的参数使用双引号并转义 `%` 与 `$`。
 */
export function formatSystemdExecArg(arg: string): string {
  assertSingleLineSystemdValue("ExecStart argument", arg);
  if (arg.length === 0 || /[\s"'\\]/.test(arg)) {
    const escaped = arg
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/%/g, "%%")
      .replace(/\$/g, "$$$$");
    return `"${escaped}"`;
  }
  return arg.replace(/%/g, "%%").replace(/\$/g, "$$$$");
}

/**
 * 生成 `systemd --user` unit 内容。
 * `WorkingDirectory=` 与 `StandardOutput=append:` 直接接收路径，不能使用 shell 单引号包裹，
 * 否则 systemd 会因路径不以 `/` 开头而拒绝加载（`bad unit file setting`）。
 */
export function buildLinuxSystemdUnit(config: LinuxSystemdUnitConfig): string {
  if (config.programArgs.length === 0) {
    throw new Error("Linux systemd ExecStart requires at least one program argument");
  }
  const profileLabel = config.profile ?? "default";
  assertSingleLineSystemdValue("profile", profileLabel);
  assertSingleLineSystemdValue("WorkingDirectory", config.workingDirectory);
  assertSingleLineSystemdValue("StandardOutput", config.stdoutLogPath);
  assertSingleLineSystemdValue("StandardError", config.stderrLogPath);

  const execStart = config.programArgs.map(formatSystemdExecArg).join(" ");
  return `[Unit]
Description=ClawConnect host agent (${escapeSystemdSpecifier(profileLabel)})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=5
WorkingDirectory=${escapeSystemdSpecifier(config.workingDirectory)}
StandardOutput=append:${escapeSystemdSpecifier(config.stdoutLogPath)}
StandardError=append:${escapeSystemdSpecifier(config.stderrLogPath)}

[Install]
WantedBy=default.target
`;
}

export function buildLinuxNohupStartScript(
  paths: LinuxServicePaths,
  programArgs: readonly string[],
): string {
  const args = programArgs.map(posixShellEscape).join(" ");
  return `#!/usr/bin/env bash
set -euo pipefail

mkdir -p ${posixShellEscape(paths.workingDirectory)}
cd ${posixShellEscape(paths.workingDirectory)}
if [ -f ${posixShellEscape(paths.pidPath)} ]; then
  pid="$(cat ${posixShellEscape(paths.pidPath)} 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "clawconnect is already running (pid=$pid)"
    exit 0
  fi
fi

nohup ${args} >> ${posixShellEscape(paths.logPath)} 2>> ${posixShellEscape(paths.errorLogPath)} < /dev/null &
echo $! > ${posixShellEscape(paths.pidPath)}
echo "clawconnect started in nohup mode (pid=$(cat ${posixShellEscape(paths.pidPath)}))"
`;
}

export function readLinuxNohupPid(paths: Pick<LinuxServicePaths, "pidPath">): number | null {
  if (!existsSync(paths.pidPath)) return null;
  try {
    const raw = readFileSync(paths.pidPath, "utf-8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function removeLinuxNohupPidFile(paths: Pick<LinuxServicePaths, "pidPath">): void {
  if (existsSync(paths.pidPath)) {
    unlinkSync(paths.pidPath);
  }
}

export function parseProcCmdline(raw: Buffer | string): string[] {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  const trimmed = text.replace(/\0+$/, "");
  return trimmed.length === 0 ? [] : trimmed.split("\0");
}

function isClawConnectScriptToken(token: string, normalizedEntryScript?: string): boolean {
  const normalized = token.replace(/\\/g, "/");
  if (normalizedEntryScript && normalized === normalizedEntryScript) {
    return true;
  }
  if (/(?:^|\/)clawconnect(?:\.(?:js|mjs|cjs|ts))?$/i.test(normalized)) {
    return true;
  }
  return /(?:^|\/)clawconnect-agent\/(?:dist|src)\/index\.(?:js|mjs|ts)$/i.test(normalized);
}

/**
 * 精确匹配指定 profile 的 `clawconnect run` 后台进程参数，避免误杀其他 profile 或一次性 CLI 命令。
 */
export function isMatchingLinuxAgentRunArgv(
  argv: readonly string[],
  profile?: string,
  entryScriptPath?: string,
): boolean {
  if (argv.length < 2) return false;
  const normalizedEntry = entryScriptPath ? resolveServiceEntryPath(entryScriptPath).replace(/\\/g, "/") : undefined;
  const scriptIndex = argv.findIndex((token) => isClawConnectScriptToken(token, normalizedEntry));
  if (scriptIndex < 0) return false;

  let subcommand: string | undefined;
  let foundProfile: string | undefined;
  for (let index = scriptIndex + 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--profile" || token === "-p") {
      foundProfile = argv[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith("--profile=")) {
      foundProfile = token.slice("--profile=".length);
      continue;
    }
    if (token.startsWith("-p=")) {
      foundProfile = token.slice("-p=".length);
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    if (subcommand === undefined) {
      subcommand = token;
    }
  }

  if (subcommand !== "run") return false;
  return normalizeProfileName(foundProfile) === normalizeProfileName(profile);
}

function readProcArgv(procRoot: string, pid: number): string[] | undefined {
  try {
    return parseProcCmdline(readFileSync(join(procRoot, String(pid), "cmdline")));
  } catch {
    return undefined;
  }
}

export function findLinuxProfileAgentPids(
  paths: Pick<LinuxServicePaths, "profile" | "pidPath">,
  deps: LinuxProcessControlDeps = {},
): number[] {
  const procRoot = deps.procRoot ?? "/proc";
  const currentPid = deps.currentPid ?? process.pid;
  const currentUid = deps.currentUid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  const entryScriptPath = deps.entryScriptPath ?? process.argv[1];
  const normalizedEntry = entryScriptPath ? resolveServiceEntryPath(entryScriptPath).replace(/\\/g, "/") : undefined;
  const isPidRunning = deps.isPidRunning ?? defaultIsPidRunning;

  const matched = new Set<number>();
  const hasProc = existsSync(procRoot);

  const nohupPid = readLinuxNohupPid(paths);
  if (nohupPid != null && nohupPid !== currentPid && isPidRunning(nohupPid)) {
    if (!hasProc) {
      matched.add(nohupPid);
    } else {
      const argv = readProcArgv(procRoot, nohupPid);
      // 若 /proc 可读，必须确认该 PID 仍是 ClawConnect 进程，防止系统重启后复用的无关 PID 被误杀。
      if (argv && argv.some((token) => isClawConnectScriptToken(token, normalizedEntry))) {
        matched.add(nohupPid);
      }
    }
  }

  if (hasProc) {
    let entries: string[] = [];
    try {
      entries = readdirSync(procRoot);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === currentPid || matched.has(pid)) continue;
      if (currentUid !== undefined) {
        try {
          if (statSync(join(procRoot, entry)).uid !== currentUid) continue;
        } catch {
          continue;
        }
      }
      const argv = readProcArgv(procRoot, pid);
      if (argv && isMatchingLinuxAgentRunArgv(argv, paths.profile, entryScriptPath) && isPidRunning(pid)) {
        matched.add(pid);
      }
    }
  }

  return [...matched].sort((left, right) => left - right);
}

function waitForPidsExit(
  pids: readonly number[],
  timeoutMs: number,
  pollIntervalMs: number,
  isPidRunning: (pid: number) => boolean,
  sleepSync: (ms: number) => void,
): number[] {
  let remaining = pids.filter((pid) => isPidRunning(pid));
  let elapsed = 0;
  while (remaining.length > 0 && elapsed < timeoutMs) {
    const step = Math.min(pollIntervalMs, timeoutMs - elapsed);
    sleepSync(step);
    elapsed += step;
    remaining = remaining.filter((pid) => isPidRunning(pid));
  }
  return remaining;
}

/**
 * 停止指定 profile 的所有 Linux 后台/遗留 Agent 进程并等待其真正退出，
 * 确保 `reset` 紧接着清理 `reliable-outbox-v1` 时锁持有进程已释放，且重装服务不会遗留旧凭证实例。
 */
export function stopLinuxProfileProcesses(
  paths: Pick<LinuxServicePaths, "profile" | "pidPath">,
  deps: LinuxProcessControlDeps = {},
): StopLinuxProcessesResult {
  const isPidRunning = deps.isPidRunning ?? defaultIsPidRunning;
  const killPid = deps.killPid ?? defaultKillPid;
  const sleepSync = deps.sleepSync ?? defaultLinuxSleepSync;
  const sigtermTimeoutMs = deps.sigtermTimeoutMs ?? LINUX_SIGTERM_TIMEOUT_MS;
  const sigkillTimeoutMs = deps.sigkillTimeoutMs ?? LINUX_SIGKILL_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? LINUX_STOP_POLL_INTERVAL_MS;

  const hadPidFile = existsSync(paths.pidPath);
  const nohupPid = readLinuxNohupPid(paths);
  const targetPids = findLinuxProfileAgentPids(paths, deps);

  for (const pid of targetPids) {
    try {
      killPid(pid, "SIGTERM");
    } catch {
      // 进程可能刚退出，由下面的存活轮询统一确认。
    }
  }

  let remaining = targetPids.length > 0
    ? waitForPidsExit(targetPids, sigtermTimeoutMs, pollIntervalMs, isPidRunning, sleepSync)
    : [];

  if (remaining.length > 0) {
    for (const pid of remaining) {
      try {
        killPid(pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
    remaining = waitForPidsExit(remaining, sigkillTimeoutMs, pollIntervalMs, isPidRunning, sleepSync);
  }

  if (hadPidFile && (nohupPid == null || !remaining.includes(nohupPid))) {
    removeLinuxNohupPidFile(paths);
  }

  if (remaining.length > 0) {
    console.error(`[clawconnect] Linux agent process (${remaining.join(", ")}) did not exit after SIGKILL.`);
  }

  return {
    changed: targetPids.length > 0 || hadPidFile,
    allExited: remaining.length === 0,
  };
}
