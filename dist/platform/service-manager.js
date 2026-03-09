import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
const MAC_LABEL = "com.openclaw.clawconnect.agent";
const MAC_LABEL_OLD = "com.rethinkingstudio.clawpilot";
const MAC_PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
const MAC_PLIST_PATH = join(MAC_PLIST_DIR, `${MAC_LABEL}.plist`);
const MAC_PLIST_PATH_OLD = join(MAC_PLIST_DIR, `${MAC_LABEL_OLD}.plist`);
const LINUX_SERVICE_NAME = "clawconnect-agent.service";
const LINUX_SYSTEMD_USER_DIR = join(homedir(), ".config", "systemd", "user");
const LINUX_SERVICE_PATH = join(LINUX_SYSTEMD_USER_DIR, LINUX_SERVICE_NAME);
const LOG_DIR = join(homedir(), ".clawconnect");
const LOG_PATH = join(LOG_DIR, "clawconnect.log");
const ERROR_LOG_PATH = join(LOG_DIR, "clawconnect-error.log");
const LINUX_NOHUP_PID_PATH = join(LOG_DIR, "clawconnect.pid");
const LINUX_NOHUP_START_SCRIPT_PATH = join(LOG_DIR, "clawconnect-start.sh");
function detectPlatform() {
    if (process.platform === "darwin")
        return "macos";
    if (process.platform === "linux")
        return "linux";
    return "unsupported";
}
function shellEscape(arg) {
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}
function run(command, stdio = "pipe") {
    execSync(command, { stdio });
}
function commandExists(command) {
    try {
        run(`command -v ${command}`, "pipe");
        return true;
    }
    catch {
        return false;
    }
}
function getProgramArgs() {
    const nodeBin = process.execPath;
    const scriptPath = process.argv[1];
    return nodeBin === scriptPath ? [scriptPath, "run"] : [nodeBin, scriptPath, "run"];
}
function ensureLogDir() {
    mkdirSync(LOG_DIR, { recursive: true });
}
function canUseSystemdUser() {
    if (!commandExists("systemctl"))
        return false;
    try {
        run("systemctl --user show-environment", "pipe");
        return true;
    }
    catch {
        return false;
    }
}
function isPidRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function readNohupPid() {
    if (!existsSync(LINUX_NOHUP_PID_PATH))
        return null;
    try {
        const raw = readFileSync(LINUX_NOHUP_PID_PATH, "utf-8").trim();
        const pid = Number(raw);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    }
    catch {
        return null;
    }
}
function removeNohupPidFile() {
    if (existsSync(LINUX_NOHUP_PID_PATH)) {
        unlinkSync(LINUX_NOHUP_PID_PATH);
    }
}
function getNohupStartCommand() {
    return `bash ${shellEscape(LINUX_NOHUP_START_SCRIPT_PATH)}`;
}
function writeLinuxNohupStartScript() {
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
function installMacService() {
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
    }
    catch {
        // Ignore if not loaded.
    }
    writeFileSync(MAC_PLIST_PATH, plistContent, "utf-8");
    try {
        run(`launchctl load -w "${MAC_PLIST_PATH}"`, "inherit");
        return true;
    }
    catch {
        return false;
    }
}
function installLinuxServiceSystemd() {
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
function installLinuxServiceNohup() {
    ensureLogDir();
    writeLinuxNohupStartScript();
    run(`sh -lc ${shellEscape(getNohupStartCommand())}`, "inherit");
    const pid = readNohupPid();
    return pid != null && isPidRunning(pid);
}
function installLinuxService() {
    if (canUseSystemdUser()) {
        try {
            return installLinuxServiceSystemd();
        }
        catch {
            // Fall back to nohup below.
        }
    }
    try {
        return installLinuxServiceNohup();
    }
    catch {
        return false;
    }
}
function uninstallMacArtifacts() {
    let changed = false;
    try {
        run(`launchctl unload -w "${MAC_PLIST_PATH}"`);
        changed = true;
    }
    catch {
        // ignore
    }
    if (existsSync(MAC_PLIST_PATH)) {
        unlinkSync(MAC_PLIST_PATH);
        changed = true;
    }
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
    return changed;
}
function uninstallLinuxArtifacts(removeFile) {
    let changed = false;
    if (canUseSystemdUser()) {
        try {
            run(`systemctl --user stop ${LINUX_SERVICE_NAME}`);
            changed = true;
        }
        catch {
            // ignore
        }
        try {
            run(`systemctl --user disable ${LINUX_SERVICE_NAME}`);
            changed = true;
        }
        catch {
            // ignore
        }
        try {
            run("systemctl --user daemon-reload");
        }
        catch {
            // ignore
        }
    }
    const nohupPid = readNohupPid();
    if (nohupPid != null) {
        try {
            process.kill(nohupPid, "SIGTERM");
            changed = true;
        }
        catch {
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
function restartMacService() {
    return installMacService();
}
function restartLinuxService() {
    if (canUseSystemdUser() && existsSync(LINUX_SERVICE_PATH)) {
        try {
            run("systemctl --user daemon-reload", "inherit");
            run(`systemctl --user restart ${LINUX_SERVICE_NAME}`, "inherit");
            return true;
        }
        catch {
            // Fall back to nohup restart below.
        }
    }
    uninstallLinuxArtifacts(false);
    try {
        return installLinuxServiceNohup();
    }
    catch {
        return false;
    }
}
export function getServicePlatform() {
    return detectPlatform();
}
export function installService() {
    switch (detectPlatform()) {
        case "macos":
            return installMacService();
        case "linux":
            return installLinuxService();
        default:
            return false;
    }
}
export function restartService() {
    switch (detectPlatform()) {
        case "macos":
            return restartMacService();
        case "linux":
            return restartLinuxService();
        default:
            return false;
    }
}
export function stopService() {
    switch (detectPlatform()) {
        case "macos":
            return uninstallMacArtifacts();
        case "linux":
            return uninstallLinuxArtifacts(false);
        default:
            return false;
    }
}
export function uninstallService() {
    switch (detectPlatform()) {
        case "macos":
            return uninstallMacArtifacts();
        case "linux":
            return uninstallLinuxArtifacts(true);
        default:
            return false;
    }
}
export function getServiceStatus() {
    const platform = detectPlatform();
    if (platform === "macos") {
        let running = false;
        try {
            run(`launchctl list ${MAC_LABEL}`);
            running = true;
        }
        catch {
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
        const pid = readNohupPid();
        const hasNohupArtifacts = pid != null || existsSync(LINUX_NOHUP_START_SCRIPT_PATH);
        const running = pid != null && isPidRunning(pid);
        if (!running && pid != null) {
            removeNohupPidFile();
        }
        if (running || (hasNohupArtifacts && !canUseSystemdUser())) {
            return {
                platform,
                installed: hasNohupArtifacts,
                running,
                serviceName: "clawconnect (nohup)",
                manager: "nohup",
                servicePath: existsSync(LINUX_NOHUP_START_SCRIPT_PATH) ? LINUX_NOHUP_START_SCRIPT_PATH : undefined,
                logPath: LOG_PATH,
                startHint: getNohupStartCommand(),
            };
        }
        const hasSystemdServiceFile = existsSync(LINUX_SERVICE_PATH);
        if (hasSystemdServiceFile) {
            let systemdRunning = false;
            if (canUseSystemdUser()) {
                try {
                    run(`systemctl --user is-active --quiet ${LINUX_SERVICE_NAME}`);
                    systemdRunning = true;
                }
                catch {
                    systemdRunning = false;
                }
            }
            return {
                platform,
                installed: true,
                running: systemdRunning,
                serviceName: LINUX_SERVICE_NAME,
                manager: "systemd",
                servicePath: LINUX_SERVICE_PATH,
                logPath: LOG_PATH,
                startHint: `systemctl --user start ${LINUX_SERVICE_NAME}`,
            };
        }
        return {
            platform,
            installed: hasNohupArtifacts,
            running,
            serviceName: "clawconnect (nohup)",
            manager: "nohup",
            servicePath: existsSync(LINUX_NOHUP_START_SCRIPT_PATH) ? LINUX_NOHUP_START_SCRIPT_PATH : undefined,
            logPath: LOG_PATH,
            startHint: getNohupStartCommand(),
        };
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
//# sourceMappingURL=service-manager.js.map