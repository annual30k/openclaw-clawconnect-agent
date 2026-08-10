import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";

import { getActiveProfile, normalizeProfileName } from "../config/profile.js";
import {
  commandExists,
  ensureLogDir,
  getLinuxNohupPidPath,
  getLinuxNohupStartScriptPath,
  getLinuxServiceName,
  getLinuxServicePath,
  getProfileErrorLogPath,
  getProfileLogDir,
  getProfileLogPath,
  getProgramArgs,
  LINUX_SYSTEMD_USER_DIR,
  run,
  shellEscape,
  type ServiceStatus,
} from "./service-manager-common.js";

type LinuxServicePaths = {
  profile?: string;
  serviceName: string;
  servicePath: string;
  pidPath: string;
  startScriptPath: string;
  workingDirectory: string;
  logPath: string;
  errorLogPath: string;
};

export function getLinuxServicePaths(profile?: string): LinuxServicePaths {
  const resolvedProfile = normalizeProfileName(profile ?? getActiveProfile());
  return {
    profile: resolvedProfile,
    serviceName: getLinuxServiceName(resolvedProfile),
    servicePath: getLinuxServicePath(resolvedProfile),
    pidPath: getLinuxNohupPidPath(resolvedProfile),
    startScriptPath: getLinuxNohupStartScriptPath(resolvedProfile),
    workingDirectory: getProfileLogDir(resolvedProfile),
    logPath: getProfileLogPath(resolvedProfile),
    errorLogPath: getProfileErrorLogPath(resolvedProfile),
  };
}

function canUseSystemdUser(): boolean {
  if (!commandExists("systemctl")) return false;
  try {
    run("systemctl --user show-environment", "pipe");
    return true;
  } catch {
    return false;
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readNohupPid(paths: LinuxServicePaths): number | null {
  if (!existsSync(paths.pidPath)) return null;
  try {
    const raw = readFileSync(paths.pidPath, "utf-8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function removeNohupPidFile(paths: LinuxServicePaths): void {
  if (existsSync(paths.pidPath)) unlinkSync(paths.pidPath);
}

function getNohupStartCommand(paths: LinuxServicePaths): string {
  return `bash ${shellEscape(paths.startScriptPath)}`;
}

function writeLinuxNohupStartScript(paths: LinuxServicePaths): void {
  const args = getProgramArgs(paths.profile).map(shellEscape).join(" ");
  const script = `#!/usr/bin/env bash
set -euo pipefail

mkdir -p ${shellEscape(paths.workingDirectory)}
cd ${shellEscape(paths.workingDirectory)}
if [ -f ${shellEscape(paths.pidPath)} ]; then
  pid="$(cat ${shellEscape(paths.pidPath)} 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "clawconnect is already running (pid=$pid)"
    exit 0
  fi
fi

nohup ${args} >> ${shellEscape(paths.logPath)} 2>> ${shellEscape(paths.errorLogPath)} < /dev/null &
echo $! > ${shellEscape(paths.pidPath)}
echo "clawconnect started in nohup mode (pid=$(cat ${shellEscape(paths.pidPath)}))"
`;
  writeFileSync(paths.startScriptPath, script, { encoding: "utf-8", mode: 0o755 });
}

function installLinuxServiceSystemd(paths: LinuxServicePaths): boolean {
  mkdirSync(LINUX_SYSTEMD_USER_DIR, { recursive: true });
  ensureLogDir(paths.profile);

  const args = getProgramArgs(paths.profile).map(shellEscape).join(" ");
  const serviceContent = `[Unit]
Description=ClawConnect host agent (${paths.profile ?? "default"})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${args}
Restart=always
RestartSec=5
WorkingDirectory=${shellEscape(paths.workingDirectory)}
StandardOutput=append:${paths.logPath}
StandardError=append:${paths.errorLogPath}

[Install]
WantedBy=default.target
`;

  writeFileSync(paths.servicePath, serviceContent, "utf-8");
  run("systemctl --user daemon-reload", "inherit");
  run(`systemctl --user enable --now ${paths.serviceName}`, "inherit");
  return true;
}

function installLinuxServiceNohup(paths: LinuxServicePaths): boolean {
  ensureLogDir(paths.profile);
  writeLinuxNohupStartScript(paths);
  run(`sh -lc ${shellEscape(getNohupStartCommand(paths))}`, "inherit");
  const pid = readNohupPid(paths);
  return pid != null && isPidRunning(pid);
}

export function installLinuxService(profile?: string): boolean {
  const paths = getLinuxServicePaths(profile);
  if (canUseSystemdUser()) {
    try {
      return installLinuxServiceSystemd(paths);
    } catch {
      // Fall back to nohup below.
    }
  }

  try {
    return installLinuxServiceNohup(paths);
  } catch {
    return false;
  }
}

function uninstallLinuxArtifacts(paths: LinuxServicePaths, removeFile: boolean): boolean {
  let changed = false;
  if (canUseSystemdUser()) {
    try {
      run(`systemctl --user stop ${paths.serviceName}`);
      changed = true;
    } catch {
      // ignore
    }
    try {
      run(`systemctl --user disable ${paths.serviceName}`);
      changed = true;
    } catch {
      // ignore
    }
    try {
      run("systemctl --user daemon-reload");
    } catch {
      // ignore
    }
  }

  const nohupPid = readNohupPid(paths);
  if (nohupPid != null) {
    try {
      process.kill(nohupPid, "SIGTERM");
      changed = true;
    } catch {
      // ignore
    }
    removeNohupPidFile(paths);
    changed = true;
  }

  if (removeFile && existsSync(paths.servicePath)) {
    unlinkSync(paths.servicePath);
    changed = true;
  }
  if (removeFile && existsSync(paths.startScriptPath)) {
    unlinkSync(paths.startScriptPath);
    changed = true;
  }
  return changed;
}

export function stopLinuxService(profile?: string): boolean {
  return uninstallLinuxArtifacts(getLinuxServicePaths(profile), false);
}

export function uninstallLinuxService(profile?: string): boolean {
  return uninstallLinuxArtifacts(getLinuxServicePaths(profile), true);
}

export function restartLinuxService(profile?: string): boolean {
  const paths = getLinuxServicePaths(profile);
  if (canUseSystemdUser() && existsSync(paths.servicePath)) {
    try {
      run("systemctl --user daemon-reload", "inherit");
      run(`systemctl --user restart ${paths.serviceName}`, "inherit");
      return true;
    } catch {
      // Fall back to nohup restart below.
    }
  }

  uninstallLinuxArtifacts(paths, false);
  try {
    return installLinuxServiceNohup(paths);
  } catch {
    return false;
  }
}

export function getLinuxServiceStatus(profile?: string): ServiceStatus {
  const paths = getLinuxServicePaths(profile);
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
  const isSystemdActive = (): boolean => {
    if (!canUseSystemdUser()) return false;
    try {
      run(`systemctl --user is-active --quiet ${paths.serviceName}`);
      return true;
    } catch {
      return false;
    }
  };

  const pid = readNohupPid(paths);
  const hasNohupArtifacts = pid != null || existsSync(paths.startScriptPath);
  const running = pid != null && isPidRunning(pid);
  if (!running && pid != null) removeNohupPidFile(paths);

  if (running || (hasNohupArtifacts && !canUseSystemdUser())) {
    return buildNohupStatus(hasNohupArtifacts, running);
  }

  if (existsSync(paths.servicePath)) {
    return {
      platform: "linux",
      installed: true,
      running: isSystemdActive(),
      serviceName: paths.serviceName,
      manager: "systemd",
      servicePath: paths.servicePath,
      logPath: paths.logPath,
      startHint: `systemctl --user start ${paths.serviceName}`,
    };
  }
  return buildNohupStatus(hasNohupArtifacts, running);
}
