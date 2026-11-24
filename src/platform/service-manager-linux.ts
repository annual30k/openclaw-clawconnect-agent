import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";

import { getActiveProfile, normalizeProfileName } from "../config/profile.js";
import {
  buildLinuxNohupStartScript,
  buildLinuxSystemdUnit,
  defaultIsPidRunning,
  posixShellEscape,
  readLinuxNohupPid,
  removeLinuxNohupPidFile,
  stopLinuxProfileProcesses,
  type LinuxProcessControlDeps,
  type LinuxServicePaths,
} from "./linux-service-process.js";
import {
  commandExists,
  getLinuxNohupPidPath,
  getLinuxNohupStartScriptPath,
  getLinuxServiceName,
  getLinuxServicePath,
  getProfileErrorLogPath,
  getProfileLogDir,
  getProfileLogPath,
  getProgramArgs,
  run,
  type ServiceStatus,
} from "./service-manager-common.js";

export {
  buildLinuxNohupStartScript,
  buildLinuxSystemdUnit,
  findLinuxProfileAgentPids,
  formatSystemdExecArg,
  isMatchingLinuxAgentRunArgv,
  parseProcCmdline,
  stopLinuxProfileProcesses,
  type LinuxProcessControlDeps,
  type LinuxServicePaths,
  type LinuxSystemdUnitConfig,
} from "./linux-service-process.js";

export interface LinuxServiceDeps extends LinuxProcessControlDeps {
  paths?: Partial<LinuxServicePaths>;
  programArgs?: readonly string[];
  canUseSystemd?: boolean;
  runCommand?: (command: string, stdio?: "pipe" | "inherit") => Buffer | string;
}

export function getLinuxServicePaths(
  profile?: string,
  overrides: Partial<LinuxServicePaths> = {},
): LinuxServicePaths {
  const resolvedProfile = normalizeProfileName(overrides.profile ?? profile ?? getActiveProfile());
  return {
    profile: resolvedProfile,
    serviceName: overrides.serviceName ?? getLinuxServiceName(resolvedProfile),
    servicePath: overrides.servicePath ?? getLinuxServicePath(resolvedProfile),
    pidPath: overrides.pidPath ?? getLinuxNohupPidPath(resolvedProfile),
    startScriptPath: overrides.startScriptPath ?? getLinuxNohupStartScriptPath(resolvedProfile),
    workingDirectory: overrides.workingDirectory ?? getProfileLogDir(resolvedProfile),
    logPath: overrides.logPath ?? getProfileLogPath(resolvedProfile),
    errorLogPath: overrides.errorLogPath ?? getProfileErrorLogPath(resolvedProfile),
  };
}

function runLinuxCommand(
  command: string,
  stdio: "pipe" | "inherit" = "pipe",
  deps: LinuxServiceDeps = {},
): Buffer | string {
  return (deps.runCommand ?? run)(command, stdio);
}

function canUseSystemdUser(deps: LinuxServiceDeps = {}): boolean {
  if (deps.canUseSystemd !== undefined) {
    return deps.canUseSystemd;
  }
  if (!deps.runCommand && !commandExists("systemctl")) {
    return false;
  }
  try {
    runLinuxCommand("systemctl --user show-environment", "pipe", deps);
    return true;
  } catch {
    return false;
  }
}

function isSystemdActive(paths: LinuxServicePaths, deps: LinuxServiceDeps = {}): boolean {
  if (!canUseSystemdUser(deps)) return false;
  try {
    runLinuxCommand(`systemctl --user is-active --quiet ${paths.serviceName}`, "pipe", deps);
    return true;
  } catch {
    return false;
  }
}

function getNohupStartCommand(paths: LinuxServicePaths): string {
  return `bash ${posixShellEscape(paths.startScriptPath)}`;
}

function writeLinuxNohupStartScript(paths: LinuxServicePaths, deps: LinuxServiceDeps): void {
  const programArgs = deps.programArgs ?? getProgramArgs(paths.profile);
  const script = buildLinuxNohupStartScript(paths, programArgs);
  writeFileSync(paths.startScriptPath, script, { encoding: "utf-8", mode: 0o755 });
}

function writeSystemdServiceUnit(paths: LinuxServicePaths, deps: LinuxServiceDeps): void {
  mkdirSync(dirname(paths.servicePath), { recursive: true });
  mkdirSync(paths.workingDirectory, { recursive: true });
  const programArgs = deps.programArgs ?? getProgramArgs(paths.profile);
  const serviceContent = buildLinuxSystemdUnit({
    profile: paths.profile,
    programArgs,
    workingDirectory: paths.workingDirectory,
    stdoutLogPath: paths.logPath,
    stderrLogPath: paths.errorLogPath,
  });
  writeFileSync(paths.servicePath, serviceContent, "utf-8");
}

function installLinuxServiceSystemd(paths: LinuxServicePaths, deps: LinuxServiceDeps): boolean {
  writeSystemdServiceUnit(paths, deps);
  runLinuxCommand("systemctl --user daemon-reload", "inherit", deps);
  try {
    runLinuxCommand(`systemctl --user reset-failed ${paths.serviceName}`, "pipe", deps);
  } catch {
    // ignore
  }
  try {
    // 若服务已在运行，先停止旧实例再启用启动，确保重新配对后的新凭据与新入口立即生效。
    runLinuxCommand(`systemctl --user stop ${paths.serviceName}`, "pipe", deps);
  } catch {
    // ignore when not yet loaded
  }
  const stopped = stopLinuxProfileProcesses(paths, deps);
  if (!stopped.allExited) {
    return false;
  }
  if (existsSync(paths.startScriptPath)) {
    unlinkSync(paths.startScriptPath);
  }
  runLinuxCommand(`systemctl --user enable --now ${paths.serviceName}`, "inherit", deps);
  return true;
}

function installLinuxServiceNohup(paths: LinuxServicePaths, deps: LinuxServiceDeps): boolean {
  // 先结束旧的 nohup / 遗留进程并等待退出，防止新配对后继续沿用旧进程内存中的过期凭据。
  const stopped = stopLinuxProfileProcesses(paths, deps);
  if (!stopped.allExited) {
    return false;
  }
  mkdirSync(paths.workingDirectory, { recursive: true });
  writeLinuxNohupStartScript(paths, deps);
  runLinuxCommand(`sh -lc ${posixShellEscape(getNohupStartCommand(paths))}`, "inherit", deps);
  const pid = readLinuxNohupPid(paths);
  const isPidRunning = deps.isPidRunning ?? defaultIsPidRunning;
  return pid != null && isPidRunning(pid);
}

export function installLinuxService(profile?: string, deps: LinuxServiceDeps = {}): boolean {
  const paths = getLinuxServicePaths(profile, deps.paths);
  if (canUseSystemdUser(deps)) {
    try {
      if (installLinuxServiceSystemd(paths, deps)) {
        return true;
      }
    } catch {
      if (existsSync(paths.servicePath) && !isSystemdActive(paths, deps)) {
        try {
          unlinkSync(paths.servicePath);
          runLinuxCommand("systemctl --user daemon-reload", "pipe", deps);
        } catch {
          // ignore cleanup failure before fallback
        }
      }
    }
  }

  try {
    return installLinuxServiceNohup(paths, deps);
  } catch {
    return false;
  }
}

function uninstallLinuxArtifacts(
  paths: LinuxServicePaths,
  removeFile: boolean,
  deps: LinuxServiceDeps = {},
): boolean {
  let changed = false;
  if (canUseSystemdUser(deps)) {
    try {
      runLinuxCommand(`systemctl --user stop ${paths.serviceName}`, "pipe", deps);
      changed = true;
    } catch {
      // ignore
    }
    try {
      runLinuxCommand(`systemctl --user disable ${paths.serviceName}`, "pipe", deps);
      changed = true;
    } catch {
      // ignore
    }
    try {
      runLinuxCommand(`systemctl --user reset-failed ${paths.serviceName}`, "pipe", deps);
    } catch {
      // ignore
    }
    try {
      runLinuxCommand("systemctl --user daemon-reload", "pipe", deps);
    } catch {
      // ignore
    }
  }

  const stopped = stopLinuxProfileProcesses(paths, deps);
  if (stopped.changed) {
    changed = true;
  }

  if (removeFile && existsSync(paths.servicePath)) {
    unlinkSync(paths.servicePath);
    changed = true;
    if (canUseSystemdUser(deps)) {
      try {
        runLinuxCommand("systemctl --user daemon-reload", "pipe", deps);
      } catch {
        // ignore
      }
    }
  }
  if (removeFile && existsSync(paths.startScriptPath)) {
    unlinkSync(paths.startScriptPath);
    changed = true;
  }
  return changed;
}

export function stopLinuxService(profile?: string, deps: LinuxServiceDeps = {}): boolean {
  return uninstallLinuxArtifacts(getLinuxServicePaths(profile, deps.paths), false, deps);
}

export function uninstallLinuxService(profile?: string, deps: LinuxServiceDeps = {}): boolean {
  return uninstallLinuxArtifacts(getLinuxServicePaths(profile, deps.paths), true, deps);
}

export function restartLinuxService(profile?: string, deps: LinuxServiceDeps = {}): boolean {
  const paths = getLinuxServicePaths(profile, deps.paths);
  if (canUseSystemdUser(deps) && existsSync(paths.servicePath)) {
    try {
      writeSystemdServiceUnit(paths, deps);
      runLinuxCommand("systemctl --user daemon-reload", "inherit", deps);
      try {
        runLinuxCommand(`systemctl --user reset-failed ${paths.serviceName}`, "pipe", deps);
      } catch {
        // ignore
      }
      try {
        runLinuxCommand(`systemctl --user stop ${paths.serviceName}`, "pipe", deps);
      } catch {
        // ignore
      }
      const stopped = stopLinuxProfileProcesses(paths, deps);
      if (!stopped.allExited) {
        return false;
      }
      runLinuxCommand(`systemctl --user start ${paths.serviceName}`, "inherit", deps);
      return true;
    } catch {
      // Fall back to nohup restart below.
    }
  }

  uninstallLinuxArtifacts(paths, false, deps);
  try {
    return installLinuxServiceNohup(paths, deps);
  } catch {
    return false;
  }
}

export function getLinuxServiceStatus(profile?: string, deps: LinuxServiceDeps = {}): ServiceStatus {
  const paths = getLinuxServicePaths(profile, deps.paths);
  const isPidRunning = deps.isPidRunning ?? defaultIsPidRunning;
  const buildNohupStatus = (installed: boolean, running: boolean): ServiceStatus => ({
    platform: "linux",
    installed,
    running,
    serviceName: `${paths.serviceName} (nohup)`,
    manager: "nohup",
    servicePath: existsSync(paths.startScriptPath) ? paths.startScriptPath : undefined,
    logPath: paths.logPath,
    startHint: getNohupStartCommand(paths),
  });

  const pid = readLinuxNohupPid(paths);
  const hasNohupArtifacts = pid != null || existsSync(paths.startScriptPath);
  const running = pid != null && isPidRunning(pid);
  if (!running && pid != null) removeLinuxNohupPidFile(paths);

  if (running || (hasNohupArtifacts && !canUseSystemdUser(deps))) {
    return buildNohupStatus(hasNohupArtifacts, running);
  }

  if (existsSync(paths.servicePath)) {
    return {
      platform: "linux",
      installed: true,
      running: isSystemdActive(paths, deps),
      serviceName: paths.serviceName,
      manager: "systemd",
      servicePath: paths.servicePath,
      logPath: paths.logPath,
      startHint: `systemctl --user start ${paths.serviceName}`,
    };
  }
  return buildNohupStatus(hasNohupArtifacts, running);
}
