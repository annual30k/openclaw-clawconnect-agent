import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  detectPlatform,
  ensureLogDir,
  ERROR_LOG_PATH,
  getProgramArgs,
  LINUX_NOHUP_PID_PATH,
  LINUX_NOHUP_START_SCRIPT_PATH,
  LINUX_SERVICE_PATH,
  LOG_PATH,
  run,
} from "./service-manager-common.js";
import {
  getLinuxServiceStatus,
  installLinuxService,
  restartLinuxService,
  stopLinuxService,
  uninstallLinuxService,
} from "./service-manager-linux.js";
import type { ServicePlatform, ServiceStatus } from "./service-manager-common.js";

export type { ServicePlatform, ServiceStatus } from "./service-manager-common.js";

const MAC_LABEL = "com.openclaw.clawconnect.agent";
const MAC_LABEL_OLD = "com.rethinkingstudio.clawpilot";
const MAC_PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
const MAC_PLIST_PATH = join(MAC_PLIST_DIR, `${MAC_LABEL}.plist`);
const MAC_PLIST_PATH_OLD = join(MAC_PLIST_DIR, `${MAC_LABEL_OLD}.plist`);

function installMacService(): boolean {
  const argsXml = getProgramArgs().map((arg) => `    <string>${arg}</string>`).join("\n");
  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${ERROR_LOG_PATH}</string>
</dict>
</plist>`;

  mkdirSync(MAC_PLIST_DIR, { recursive: true });
  ensureLogDir();

  try {
    run(`launchctl unload -w "${MAC_PLIST_PATH}"`);
  } catch {
    // Ignore if not loaded.
  }

  writeFileSync(MAC_PLIST_PATH, plistContent, "utf-8");

  try {
    run(`launchctl load -w "${MAC_PLIST_PATH}"`, "inherit");
    return true;
  } catch {
    return false;
  }
}

function uninstallMacArtifacts(): boolean {
  let changed = false;
  try {
    run(`launchctl unload -w "${MAC_PLIST_PATH}"`);
    changed = true;
  } catch {
    // ignore
  }
  if (existsSync(MAC_PLIST_PATH)) {
    unlinkSync(MAC_PLIST_PATH);
    changed = true;
  }
  try {
    run(`launchctl unload -w "${MAC_PLIST_PATH_OLD}"`);
    changed = true;
  } catch {
    // ignore
  }
  if (existsSync(MAC_PLIST_PATH_OLD)) {
    unlinkSync(MAC_PLIST_PATH_OLD);
    changed = true;
  }
  return changed;
}

function restartMacService(): boolean {
  return installMacService();
}

export function getServicePlatform(): ServicePlatform {
  return detectPlatform();
}

export function installService(): boolean {
  switch (detectPlatform()) {
    case "macos":
      return installMacService();
    case "linux":
      return installLinuxService();
    default:
      return false;
  }
}

export function restartService(): boolean {
  switch (detectPlatform()) {
    case "macos":
      return restartMacService();
    case "linux":
      return restartLinuxService();
    default:
      return false;
  }
}

export function stopService(): boolean {
  switch (detectPlatform()) {
    case "macos":
      return uninstallMacArtifacts();
    case "linux":
      return stopLinuxService();
    default:
      return false;
  }
}

export function uninstallService(): boolean {
  switch (detectPlatform()) {
    case "macos":
      return uninstallMacArtifacts();
    case "linux":
      return uninstallLinuxService();
    default:
      return false;
  }
}

export function getServiceStatus(): ServiceStatus {
  const platform = detectPlatform();

  if (platform === "macos") {
    let running = false;
    try {
      run(`launchctl list ${MAC_LABEL}`);
      running = true;
    } catch {
      running = false;
    }
    return {
      platform,
      installed: existsSync(MAC_PLIST_PATH),
      running,
      serviceName: MAC_LABEL,
      manager: "launchd",
      servicePath: MAC_PLIST_PATH,
      logPath: LOG_PATH,
      startHint: `launchctl start ${MAC_LABEL}`,
    };
  }

  if (platform === "linux") {
    return getLinuxServiceStatus();
  }

  return {
    platform,
    installed: false,
    running: false,
    serviceName: "",
    manager: "unsupported",
    logPath: LOG_PATH,
  };
}

export const servicePaths = {
  logPath: LOG_PATH,
  errorLogPath: ERROR_LOG_PATH,
  macPlistPath: MAC_PLIST_PATH,
  linuxServicePath: LINUX_SERVICE_PATH,
  linuxNohupPidPath: LINUX_NOHUP_PID_PATH,
  linuxNohupStartScriptPath: LINUX_NOHUP_START_SCRIPT_PATH,
};
