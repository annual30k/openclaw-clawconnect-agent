import { execFileSync } from "child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  ensureLogDir,
  getProfileErrorLogPath,
  getProfileLogDir,
  getProfileLogPath,
  getProgramArgs,
} from "./service-manager-common.js";
import type { ServiceStatus } from "./service-manager-common.js";
import { getActiveProfile, normalizeProfileName } from "../config/profile.js";
import { decodeTextBuffer } from "./text-file-decoder.js";
import {
  buildWindowsServiceHostConfig,
  buildWindowsServiceHostSource,
  WINDOWS_HOST_GRANT_LOGON_RIGHT_FLAG,
} from "./windows-service-host-source.js";
import { removeLegacyWindowsStartup } from "./windows-service-legacy-startup.js";
import {
  isProcessTimeoutError,
  killWindowsProcess,
  reportWindowsQueryTimeout,
  WINDOWS_READ_ONLY_QUERY_TIMEOUT_MS,
} from "./windows-process-control.js";
import type { WindowsQueryTimeoutReporter } from "./windows-process-control.js";
import {
  windowsServiceHostConfigPath,
  windowsServiceHostExePath,
  windowsServiceHostSourcePath,
  windowsServiceName,
  windowsServiceRunnerPath,
} from "./windows-service-paths.js";

export { windowsServiceName } from "./windows-service-paths.js";
export {
  buildWindowsProcessQueryScript,
  WINDOWS_READ_ONLY_QUERY_TIMEOUT_MS,
} from "./windows-process-control.js";

export const WINDOWS_SERVICE_STATE_POLL_INTERVAL_MS = 500;
export const WINDOWS_SERVICE_STATE_TIMEOUT_MS = 30_000;
/** 失败后第 1、2 次 5 秒重启，之后 60 秒；24 小时无失败则清零计数。 */
export const WINDOWS_SERVICE_FAILURE_ACTIONS = "restart/5000/restart/5000/restart/60000";
export const WINDOWS_SERVICE_FAILURE_RESET_SECONDS = 86_400;

export type WindowsServiceState = "running" | "stopped" | "pending" | "missing" | "unknown";

export interface WindowsServiceDeps {
  execFileSyncImpl?: typeof execFileSync;
  onQueryTimeout?: WindowsQueryTimeoutReporter;
  sleepSync?: (ms: number) => void;
  /** 测试用：覆盖 csc.exe 路径解析。 */
  cscPath?: string;
  /** 测试用：替换"结束 Agent 进程"的动作，避免单测去执行 Windows 命令。 */
  killProcess?: (profile: string | undefined) => boolean;
  /** 测试用：替换"编译服务宿主 exe"的动作，避免单测写入真实主目录。 */
  compileHost?: (profile: string | undefined) => void;
  /** 测试用：替换"写服务宿主配置"的动作，避免单测写入真实主目录。 */
  writeConfig?: (profile: string | undefined) => void;
  /** 测试用：覆盖服务账户，避免依赖运行测试的机器的 USERNAME / USERDOMAIN。 */
  account?: string;
}

function defaultSleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

export function buildWindowsServiceStateScript(): string {
  return `[string](Get-Service -Name $env:CLAW_SERVICE_NAME -ErrorAction Stop).Status`;
}

/** 服务账户：域/计算机名\用户名。服务必须以当前用户运行，才能读写其目录下的配置、日志与本机网关。 */
export function windowsServiceAccount(env: NodeJS.ProcessEnv = process.env): string {
  const user = env.USERNAME?.trim();
  const domain = (env.USERDOMAIN ?? env.COMPUTERNAME)?.trim();
  if (!user || !domain) {
    throw new Error("Cannot determine the current Windows account (USERNAME / USERDOMAIN are not set)");
  }
  return `${domain}\\${user}`;
}

/**
 * 创建服务并设置当前用户凭据。密码只经 Read-Host -AsSecureString 在 PowerShell 进程内流转，
 * 不进入命令行参数，也不经过 Node。创建前先校验密码，避免注册一个永远以 1069 启动失败的服务。
 */
export function buildWindowsServiceCreateScript(): string {
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$secure = Read-Host -Prompt ('Windows password for ' + $env:CLAW_SERVICE_ACCOUNT) -AsSecureString`,
    `if ($secure.Length -eq 0) { throw 'A Windows service cannot log on with an empty password.' }`,
    `$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)`,
    `try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }`,
    `Add-Type -AssemblyName System.DirectoryServices.AccountManagement`,
    `$contextType = if ($env:USERDOMAIN -eq $env:COMPUTERNAME) { 'Machine' } else { 'Domain' }`,
    `$context = New-Object System.DirectoryServices.AccountManagement.PrincipalContext($contextType)`,
    `if (-not $context.ValidateCredentials($env:USERNAME, $plain)) { throw 'The Windows password is incorrect.' }`,
    `$plain = $null`,
    `$credential = New-Object System.Management.Automation.PSCredential($env:CLAW_SERVICE_ACCOUNT, $secure)`,
    `New-Service -Name $env:CLAW_SERVICE_NAME -BinaryPathName $env:CLAW_SERVICE_BINPATH -DisplayName $env:CLAW_SERVICE_NAME -Description 'ClawConnect host agent' -StartupType Automatic -Credential $credential | Out-Null`,
  ].join("\n");
}

/** SCM 启动宿主时传入的参数：服务名 + 宿主配置路径。 */
export function buildWindowsServiceBinaryPath(hostExePath: string, serviceName: string, configPath: string): string {
  return `"${hostExePath}" "${serviceName}" "${configPath}"`;
}

export function resolveWindowsCscPath(
  fileExists: (path: string) => boolean = existsSync,
  windowsDir: string = process.env.windir ?? process.env.SystemRoot ?? "C:\\Windows",
): string | undefined {
  const candidates = [
    join(windowsDir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(windowsDir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  return candidates.find((candidate) => fileExists(candidate));
}

export function buildWindowsServiceHostCompileArgs(sourcePath: string, outputPath: string): string[] {
  return [
    "/nologo",
    "/target:exe",
    "/optimize+",
    `/out:${outputPath}`,
    "/reference:System.ServiceProcess.dll",
    sourcePath,
  ];
}

export function isWindowsElevated(execFileSyncImpl: typeof execFileSync = execFileSync): boolean {
  try {
    // fltmc 只有提权后的进程才能成功执行，比解析 whoami 输出更不依赖系统语言。
    execFileSyncImpl("fltmc", [], { stdio: "pipe", windowsHide: true, timeout: WINDOWS_READ_ONLY_QUERY_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

function requireElevation(action: string, profile: string | undefined, deps: WindowsServiceDeps): boolean {
  if (isWindowsElevated(deps.execFileSyncImpl)) {
    return true;
  }
  const profileArg = profile ? ` --profile ${profile}` : "";
  console.error(
    `[clawconnect] ${action} a Windows service requires an elevated terminal. `
    + `Open PowerShell with "Run as administrator" and run: clawconnect install${profileArg}`,
  );
  return false;
}

export function queryWindowsServiceState(
  serviceName: string,
  deps: WindowsServiceDeps = {},
): WindowsServiceState {
  const execFileSyncImpl = deps.execFileSyncImpl ?? execFileSync;
  try {
    const output = execFileSyncImpl(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", buildWindowsServiceStateScript()],
      {
        stdio: "pipe",
        env: { ...process.env, CLAW_SERVICE_NAME: serviceName },
        timeout: WINDOWS_READ_ONLY_QUERY_TIMEOUT_MS,
        windowsHide: true,
      },
    ).toString().trim().toLowerCase();
    if (output === "running") return "running";
    if (output === "stopped") return "stopped";
    if (output.endsWith("pending") || output === "paused") return "pending";
    return "unknown";
  } catch (error) {
    if (isProcessTimeoutError(error)) {
      (deps.onQueryTimeout ?? reportWindowsQueryTimeout)("service state");
      return "unknown";
    }
    // Get-Service 找不到服务会以非零退出码结束。
    return "missing";
  }
}

function waitForServiceState(
  serviceName: string,
  wanted: WindowsServiceState,
  deps: WindowsServiceDeps,
): boolean {
  const sleep = deps.sleepSync ?? defaultSleepSync;
  const attempts = Math.ceil(WINDOWS_SERVICE_STATE_TIMEOUT_MS / WINDOWS_SERVICE_STATE_POLL_INTERVAL_MS);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (queryWindowsServiceState(serviceName, deps) === wanted) {
      return true;
    }
    sleep(WINDOWS_SERVICE_STATE_POLL_INTERVAL_MS);
  }
  return false;
}

function runServiceControl(args: string[], deps: WindowsServiceDeps): void {
  (deps.execFileSyncImpl ?? execFileSync)("sc.exe", args, { stdio: "pipe", windowsHide: true });
}

function stopServiceAndWait(serviceName: string, deps: WindowsServiceDeps): boolean {
  const state = queryWindowsServiceState(serviceName, deps);
  if (state === "missing" || state === "stopped") {
    return true;
  }
  try {
    runServiceControl(["stop", serviceName], deps);
  } catch {
    // 已处于停止中等状态时 sc stop 会报错，以下面的等待结果为准。
  }
  return waitForServiceState(serviceName, "stopped", deps);
}

function writeServiceHostConfig(profile: string | undefined, deps: WindowsServiceDeps = {}): void {
  if (deps.writeConfig) {
    deps.writeConfig(profile);
    return;
  }
  const logPath = getProfileLogPath(profile);
  const errorLogPath = getProfileErrorLogPath(profile);
  ensureLogDir(profile);
  // 旧版 PowerShell 重定向写出的是 UTF-16 日志；宿主按原始 UTF-8 字节追加，先归一化避免混合编码。
  normalizeWindowsServiceLogEncoding(logPath);
  normalizeWindowsServiceLogEncoding(errorLogPath);
  const [executablePath, ...executableArgs] = getProgramArgs(profile);
  const configPath = windowsServiceHostConfigPath(profile);
  writeFileSync(
    configPath,
    buildWindowsServiceHostConfig({
      executablePath,
      executableArgs,
      workingDirectory: getProfileLogDir(profile),
      stdoutLogPath: logPath,
      stderrLogPath: errorLogPath,
    }),
    "utf8",
  );
}

function compileServiceHost(profile: string | undefined, deps: WindowsServiceDeps): void {
  if (deps.compileHost) {
    deps.compileHost(profile);
    return;
  }
  const cscPath = deps.cscPath ?? resolveWindowsCscPath();
  if (!cscPath) {
    throw new Error("The .NET Framework 4 C# compiler (csc.exe) was not found; it is required to build the service host");
  }
  const sourcePath = windowsServiceHostSourcePath(profile);
  writeFileSync(sourcePath, buildWindowsServiceHostSource(), "utf8");
  try {
    (deps.execFileSyncImpl ?? execFileSync)(
      cscPath,
      buildWindowsServiceHostCompileArgs(sourcePath, windowsServiceHostExePath(profile)),
      { stdio: "pipe", windowsHide: true },
    );
  } catch (error) {
    const output = (error as { stdout?: Buffer }).stdout?.toString().trim();
    throw new Error(`Failed to compile the Windows service host${output ? `:\n${output}` : ""}`);
  }
}

function createService(profile: string | undefined, serviceName: string, deps: WindowsServiceDeps): void {
  const execFileSyncImpl = deps.execFileSyncImpl ?? execFileSync;
  const account = deps.account ?? windowsServiceAccount();
  const hostExePath = windowsServiceHostExePath(profile);
  execFileSyncImpl(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", buildWindowsServiceCreateScript()],
    {
      // 继承 stdio：密码提示必须直接出现在用户的终端里。
      stdio: "inherit",
      env: {
        ...process.env,
        CLAW_SERVICE_NAME: serviceName,
        CLAW_SERVICE_BINPATH: buildWindowsServiceBinaryPath(hostExePath, serviceName, windowsServiceHostConfigPath(profile)),
        CLAW_SERVICE_ACCOUNT: account,
      },
    },
  );
  execFileSyncImpl(hostExePath, [WINDOWS_HOST_GRANT_LOGON_RIGHT_FLAG, account], { stdio: "pipe", windowsHide: true });
  runServiceControl([
    "failure", serviceName,
    "reset=", String(WINDOWS_SERVICE_FAILURE_RESET_SECONDS),
    "actions=", WINDOWS_SERVICE_FAILURE_ACTIONS,
  ], deps);
  // 宿主进程以非零码退出也算失败，同样触发上面的自动重启。
  runServiceControl(["failureflag", serviceName, "1"], deps);
}

function startServiceAndWait(serviceName: string, deps: WindowsServiceDeps): boolean {
  try {
    runServiceControl(["start", serviceName], deps);
  } catch (error) {
    const detail = (error as { stdout?: Buffer }).stdout?.toString().trim();
    console.error(`[clawconnect] Failed to start Windows service ${serviceName}${detail ? `: ${detail}` : ""}`);
    return false;
  }
  if (!waitForServiceState(serviceName, "running", deps)) {
    console.error(`[clawconnect] Windows service ${serviceName} did not reach the running state.`);
    return false;
  }
  return true;
}

export function installWindowsService(profile?: string, deps: WindowsServiceDeps = {}): boolean {
  const resolvedProfile = normalizeProfileName(profile ?? getActiveProfile());
  const serviceName = windowsServiceName(resolvedProfile);
  if (!requireElevation("Installing", resolvedProfile, deps)) {
    return false;
  }

  try {
    // 先清理旧计划任务 / Run 项并结束遗留 Agent：否则下次登录会多出一个实例与服务抢占 Relay 会话。
    if (!removeLegacyWindowsStartup(resolvedProfile, {
      execFileSyncImpl: deps.execFileSyncImpl,
      onQueryTimeout: deps.onQueryTimeout,
      stopLegacyProcess: deps.killProcess ? (target) => { deps.killProcess?.(target); } : undefined,
    })) {
      throw new Error(`Unable to remove the legacy Windows startup entry ${serviceName}`);
    }
    if (!stopServiceAndWait(serviceName, deps)) {
      throw new Error(`Windows service ${serviceName} did not stop; cannot replace its host executable`);
    }
    (deps.killProcess ?? killWindowsProcess)(resolvedProfile);

    compileServiceHost(resolvedProfile, deps);
    writeServiceHostConfig(resolvedProfile, deps);
    // 已存在的服务保留原账户与凭据，更新/重装不需要再次输入密码。
    if (queryWindowsServiceState(serviceName, deps) === "missing") {
      createService(resolvedProfile, serviceName, deps);
    }
    return startServiceAndWait(serviceName, deps);
  } catch (err) {
    console.error("[clawconnect] Failed to install Windows service:", err instanceof Error ? err.message : err);
    return false;
  }
}

export function restartWindowsService(profile?: string, deps: WindowsServiceDeps = {}): boolean {
  const resolvedProfile = normalizeProfileName(profile ?? getActiveProfile());
  const serviceName = windowsServiceName(resolvedProfile);
  if (queryWindowsServiceState(serviceName, deps) === "missing") {
    return installWindowsService(resolvedProfile, deps);
  }
  if (!requireElevation("Restarting", resolvedProfile, deps)) {
    return false;
  }
  try {
    if (!stopServiceAndWait(serviceName, deps)) {
      throw new Error(`Windows service ${serviceName} did not stop`);
    }
    // npm install -g 可能改变 Node 或全局包路径；重启必须刷新宿主配置，不能继续执行旧入口。
    writeServiceHostConfig(resolvedProfile, deps);
    return startServiceAndWait(serviceName, deps);
  } catch (err) {
    console.error("[clawconnect] Failed to restart Windows service:", err instanceof Error ? err.message : err);
    return false;
  }
}

export function stopWindowsService(profile?: string, deps: WindowsServiceDeps = {}): boolean {
  const resolvedProfile = normalizeProfileName(profile ?? getActiveProfile());
  const serviceName = windowsServiceName(resolvedProfile);
  const state = queryWindowsServiceState(serviceName, deps);
  let changed = false;
  if (state === "running" || state === "pending") {
    if (!requireElevation("Stopping", resolvedProfile, deps)) {
      return false;
    }
    changed = stopServiceAndWait(serviceName, deps);
  }
  // 前台手动启动的 Agent 不归服务管，stop 也要一并结束。
  return (deps.killProcess ?? killWindowsProcess)(resolvedProfile) || changed;
}

export function uninstallWindowsService(profile?: string, deps: WindowsServiceDeps = {}): boolean {
  const resolvedProfile = normalizeProfileName(profile ?? getActiveProfile());
  const serviceName = windowsServiceName(resolvedProfile);
  const state = queryWindowsServiceState(serviceName, deps);
  if (state !== "missing" && !requireElevation("Removing", resolvedProfile, deps)) {
    return false;
  }
  try {
    let changed = false;
    if (state !== "missing") {
      if (!stopServiceAndWait(serviceName, deps)) {
        throw new Error(`Windows service ${serviceName} did not stop`);
      }
      runServiceControl(["delete", serviceName], deps);
      changed = true;
    }
    if ((deps.killProcess ?? killWindowsProcess)(resolvedProfile)) {
      changed = true;
    }
    for (const path of [
      windowsServiceHostExePath(resolvedProfile),
      windowsServiceHostSourcePath(resolvedProfile),
      windowsServiceHostConfigPath(resolvedProfile),
      windowsServiceRunnerPath(resolvedProfile),
    ]) {
      if (existsSync(path)) {
        rmSync(path, { force: true });
        changed = true;
      }
    }
    return changed;
  } catch (err) {
    console.error("[clawconnect] Failed to uninstall Windows service:", err instanceof Error ? err.message : err);
    return false;
  }
}

export function getWindowsServiceStatus(
  profile?: string,
  deps: WindowsServiceDeps = {},
): ServiceStatus {
  const resolvedProfile = normalizeProfileName(profile ?? getActiveProfile());
  const serviceName = windowsServiceName(resolvedProfile);
  const state = queryWindowsServiceState(serviceName, deps);
  return {
    platform: "windows",
    installed: state !== "missing",
    running: state === "running",
    serviceName,
    manager: "Windows Service",
    servicePath: windowsServiceHostExePath(resolvedProfile),
    logPath: getProfileLogPath(resolvedProfile),
    startHint: `sc.exe start "${serviceName}"`,
  };
}
