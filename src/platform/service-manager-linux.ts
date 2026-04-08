import {
  commandExists,
  ensureLogDir,
  ERROR_LOG_PATH,
  getProgramArgs,
  LINUX_NOHUP_PID_PATH,
  LINUX_NOHUP_START_SCRIPT_PATH,
  LINUX_SERVICE_NAME,
  LINUX_SERVICE_PATH,
  LINUX_SYSTEMD_USER_DIR,
  LOG_DIR,
  LOG_PATH,
  run,
  shellEscape,
  type ServiceStatus,
} from "./service-manager-common.js";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";

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

function readNohupPid(): number | null {
  if (!existsSync(LINUX_NOHUP_PID_PATH)) return null;
  try {
    const raw = readFileSync(LINUX_NOHUP_PID_PATH, "utf-8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function removeNohupPidFile(): void {
  if (existsSync(LINUX_NOHUP_PID_PATH)) {
    unlinkSync(LINUX_NOHUP_PID_PATH);
  }
}

function getNohupStartCommand(): string {
  return `bash ${shellEscape(LINUX_NOHUP_START_SCRIPT_PATH)}`;
}

function writeLinuxNohupStartScript(): void {
  const args = getProgramArgs().map(shellEscape).join(" ");
  const script = `#!/usr/bin/env bash
set -euo pipefail

mkdir -p ${shellEscape(LOG_DIR)}
if [ -f ${shellEscape(LINUX_NOHUP_PID_PATH)} ]; then
  pid="$(cat ${shellEscape(LINUX_NOHUP_PID_PATH)} 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "clawconnect is already running (pid=$pid)"
    exit 0
  fi
fi

nohup ${args} >> ${shellEscape(LOG_PATH)} 2>> ${shellEscape(ERROR_LOG_PATH)} < /dev/null &
echo $! > ${shellEscape(LINUX_NOHUP_PID_PATH)}
echo "clawconnect started in nohup mode (pid=$(cat ${shellEscape(LINUX_NOHUP_PID_PATH)}))"
`;
  writeFileSync(LINUX_NOHUP_START_SCRIPT_PATH, script, { encoding: "utf-8", mode: 0o755 });
}

function installLinuxServiceSystemd(): boolean {
  mkdirSync(LINUX_SYSTEMD_USER_DIR, { recursive: true });
  ensureLogDir();

  const args = getProgramArgs().map(shellEscape).join(" ");
  const serviceContent = `[Unit]
Description=ClawConnect host agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${args}
Restart=always
RestartSec=5
WorkingDirectory=${shellEscape(process.cwd())}
StandardOutput=append:${LOG_PATH}
StandardError=append:${ERROR_LOG_PATH}

[Install]
WantedBy=default.target
`;

  writeFileSync(LINUX_SERVICE_PATH, serviceContent, "utf-8");
  run("systemctl --user daemon-reload", "inherit");
  run(`systemctl --user enable --now ${LINUX_SERVICE_NAME}`, "inherit");
  return true;
}

function installLinuxServiceNohup(): boolean {
  ensureLogDir();
  writeLinuxNohupStartScript();
  run(`sh -lc ${shellEscape(getNohupStartCommand())}`, "inherit");
  const pid = readNohupPid();
  return pid != null && isPidRunning(pid);
}

export function installLinuxService(): boolean {
  if (canUseSystemdUser()) {
    try {
      return installLinuxServiceSystemd();
    } catch {
      // Fall back to nohup below.
    }
  }

  try {
    return installLinuxServiceNohup();
  } catch {
    return false;
  }
}

function uninstallLinuxArtifacts(removeFile: boolean): boolean {
  let changed = false;

  if (canUseSystemdUser()) {
    try {
      run(`systemctl --user stop ${LINUX_SERVICE_NAME}`);
      changed = true;
    } catch {
      // ignore
    }
    try {
      run(`systemctl --user disable ${LINUX_SERVICE_NAME}`);
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

  const nohupPid = readNohupPid();
  if (nohupPid != null) {
    try {
      process.kill(nohupPid, "SIGTERM");
      changed = true;
    } catch {
      // ignore
    }
    removeNohupPidFile();
    changed = true;
  }

  if (removeFile && existsSync(LINUX_SERVICE_PATH)) {
    unlinkSync(LINUX_SERVICE_PATH);
    changed = true;
  }
  if (removeFile && existsSync(LINUX_NOHUP_START_SCRIPT_PATH)) {
    unlinkSync(LINUX_NOHUP_START_SCRIPT_PATH);
    changed = true;
  }

  return changed;
}

export function stopLinuxService(): boolean {
  return uninstallLinuxArtifacts(false);
}

export function uninstallLinuxService(): boolean {
  return uninstallLinuxArtifacts(true);
}

export function restartLinuxService(): boolean {
  if (canUseSystemdUser() && existsSync(LINUX_SERVICE_PATH)) {
    try {
      run("systemctl --user daemon-reload", "inherit");
      run(`systemctl --user restart ${LINUX_SERVICE_NAME}`, "inherit");
      return true;
    } catch {
      // Fall back to nohup restart below.
    }
  }

  uninstallLinuxArtifacts(false);
  try {
    return installLinuxServiceNohup();
  } catch {
    return false;
  }
}

export function getLinuxServiceStatus(): ServiceStatus {
  const buildNohupStatus = (installed: boolean, running: boolean): ServiceStatus => ({
    platform: "linux",
    installed,
    running,
    serviceName: "clawconnect (nohup)",
    manager: "nohup",
    servicePath: existsSync(LINUX_NOHUP_START_SCRIPT_PATH) ? LINUX_NOHUP_START_SCRIPT_PATH : undefined,
    logPath: LOG_PATH,
    startHint: getNohupStartCommand(),
  });
  const isSystemdActive = (): boolean => {
    if (!canUseSystemdUser()) return false;
    try {
      run(`systemctl --user is-active --quiet ${LINUX_SERVICE_NAME}`);
      return true;
    } catch {
      return false;
    }
  };

  const pid = readNohupPid();
  const hasNohupArtifacts = pid != null || existsSync(LINUX_NOHUP_START_SCRIPT_PATH);
  const running = pid != null && isPidRunning(pid);
  if (!running && pid != null) {
    removeNohupPidFile();
  }

  if (running || (hasNohupArtifacts && !canUseSystemdUser())) {
    return buildNohupStatus(hasNohupArtifacts, running);
  }

  const hasSystemdServiceFile = existsSync(LINUX_SERVICE_PATH);
  if (hasSystemdServiceFile) {
    return {
      platform: "linux",
      installed: true,
      running: isSystemdActive(),
      serviceName: LINUX_SERVICE_NAME,
      manager: "systemd",
      servicePath: LINUX_SERVICE_PATH,
      logPath: LOG_PATH,
      startHint: `systemctl --user start ${LINUX_SERVICE_NAME}`,
    };
  }

  return buildNohupStatus(hasNohupArtifacts, running);
}
