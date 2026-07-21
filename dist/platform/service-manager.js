import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { detectPlatform, ensureLogDir, getProfileErrorLogPath, getProfileLogPath, getProgramArgs, LINUX_NOHUP_PID_PATH, LINUX_NOHUP_START_SCRIPT_PATH, LINUX_SERVICE_PATH, run, } from "./service-manager-common.js";
import { getActiveProfile, normalizeProfileName, profileDisplayName } from "../config/profile.js";
import { getLinuxServiceStatus, installLinuxService, restartLinuxService, stopLinuxService, uninstallLinuxService, } from "./service-manager-linux.js";
import { getWindowsServiceStatus, installWindowsService, restartWindowsService, stopWindowsService, uninstallWindowsService, } from "./service-manager-windows.js";
export { buildWindowsDirAclGrants, buildWindowsFileAclGrant, setRestrictiveDirPermissions, setRestrictiveFilePermissions, } from "./service-manager-common.js";
const MAC_LABEL = "com.openclaw.clawconnect.agent";
const MAC_LABEL_OLD = "com.rethinkingstudio.clawpilot";
const MAC_PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
const MAC_PLIST_PATH = join(MAC_PLIST_DIR, `${MAC_LABEL}.plist`);
const MAC_PLIST_PATH_OLD = join(MAC_PLIST_DIR, `${MAC_LABEL_OLD}.plist`);
function macLabel(profile) {
    const normalized = normalizeProfileName(profile ?? getActiveProfile());
    return normalized ? `${MAC_LABEL}.${normalized}` : MAC_LABEL;
}
function macPlistPath(profile) {
    return join(MAC_PLIST_DIR, `${macLabel(profile)}.plist`);
}
function installMacService(profile) {
    const resolvedProfile = normalizeProfileName(profile ?? getActiveProfile());
    const label = macLabel(profile);
    const plistPath = macPlistPath(profile);
    const logPath = getProfileLogPath(profile);
    const errorLogPath = getProfileErrorLogPath(profile);
    const argsXml = getProgramArgs(resolvedProfile).map((arg) => `    <string>${arg}</string>`).join("\n");
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${errorLogPath}</string>
</dict>
</plist>`;
    mkdirSync(MAC_PLIST_DIR, { recursive: true });
    ensureLogDir(profile);
    try {
        run(`launchctl unload -w "${plistPath}"`);
    }
    catch {
        // Ignore if not loaded.
    }
    writeFileSync(plistPath, plistContent, "utf-8");
    try {
        run(`launchctl load -w "${plistPath}"`, "inherit");
        return true;
    }
    catch {
        return false;
    }
}
function uninstallMacArtifacts(profile) {
    let changed = false;
    const resolvedProfile = normalizeProfileName(profile ?? getActiveProfile());
    const label = macLabel(profile);
    const plistPath = macPlistPath(profile);
    try {
        run(`launchctl unload -w "${plistPath}"`);
        changed = true;
    }
    catch {
        // ignore
    }
    if (existsSync(plistPath)) {
        unlinkSync(plistPath);
        changed = true;
    }
    if (!resolvedProfile) {
        try {
            run(`launchctl unload -w "${MAC_PLIST_PATH_OLD}"`);
            changed = true;
        }
        catch {
            // ignore
        }
        if (existsSync(MAC_PLIST_PATH_OLD)) {
            unlinkSync(MAC_PLIST_PATH_OLD);
            changed = true;
        }
    }
    else {
        try {
            run(`launchctl remove ${label}`);
            changed = true;
        }
        catch {
            // ignore
        }
    }
    return changed;
}
function restartMacService(profile) {
    return installMacService(profile);
}
export function getServicePlatform() {
    return detectPlatform();
}
export function installService(profile) {
    switch (detectPlatform()) {
        case "macos":
            return installMacService(profile);
        case "linux":
            return installLinuxService();
        case "windows":
            return installWindowsService(profile);
        default:
            return false;
    }
}
export function restartService(profile) {
    switch (detectPlatform()) {
        case "macos":
            return restartMacService(profile);
        case "linux":
            return restartLinuxService();
        case "windows":
            return restartWindowsService(profile);
        default:
            return false;
    }
}
export function stopService(profile) {
    switch (detectPlatform()) {
        case "macos":
            return uninstallMacArtifacts(profile);
        case "linux":
            return stopLinuxService();
        case "windows":
            return stopWindowsService(profile);
        default:
            return false;
    }
}
export function uninstallService(profile) {
    switch (detectPlatform()) {
        case "macos":
            return uninstallMacArtifacts(profile);
        case "linux":
            return uninstallLinuxService();
        case "windows":
            return uninstallWindowsService(profile);
        default:
            return false;
    }
}
export function getServiceStatus(profile) {
    const resolvedProfile = normalizeProfileName(profile ?? getActiveProfile());
    const platform = detectPlatform();
    if (platform === "macos") {
        const label = macLabel(resolvedProfile);
        const plistPath = macPlistPath(resolvedProfile);
        let running = false;
        try {
            run(`launchctl list ${label}`);
            running = true;
        }
        catch {
            running = false;
        }
        return {
            platform,
            installed: existsSync(plistPath),
            running,
            serviceName: label,
            manager: "launchd",
            servicePath: plistPath,
            logPath: getProfileLogPath(resolvedProfile),
            startHint: `launchctl start ${label}`,
        };
    }
    if (platform === "linux") {
        return getLinuxServiceStatus();
    }
    if (platform === "windows") {
        return getWindowsServiceStatus(resolvedProfile);
    }
    return {
        platform,
        installed: false,
        running: false,
        serviceName: "",
        manager: "unsupported",
        logPath: getProfileLogPath(resolvedProfile),
    };
}
export function getServicePaths(profile) {
    const resolvedProfile = normalizeProfileName(profile ?? getActiveProfile());
    return {
        profile: profileDisplayName(resolvedProfile),
        logPath: getProfileLogPath(resolvedProfile),
        errorLogPath: getProfileErrorLogPath(resolvedProfile),
        macPlistPath: macPlistPath(resolvedProfile),
        linuxServicePath: LINUX_SERVICE_PATH,
        linuxNohupPidPath: LINUX_NOHUP_PID_PATH,
        linuxNohupStartScriptPath: LINUX_NOHUP_START_SCRIPT_PATH,
        windowsServicePath: "",
    };
}
export const servicePaths = getServicePaths();
//# sourceMappingURL=service-manager.js.map