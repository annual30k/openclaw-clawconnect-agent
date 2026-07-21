import { existsSync, unlinkSync } from "fs";
import { t } from "../i18n/index.js";
import { getServicePlatform, getServiceStatus, getServicePaths, installService, restartService, setRestrictiveFilePermissions, stopService, uninstallService, } from "../platform/service-manager.js";
import { getActiveProfile, profileConfigPath, profileDisplayName } from "../config/profile.js";
import { pairCommandForProfile } from "./profile-hints.js";
export function isInstalled() {
    return getServiceStatus().installed;
}
export function installCommand() {
    const platform = getServicePlatform();
    if (platform === "unsupported") {
        console.log(t("install.unsupported", process.platform));
        console.log(t("install.runForeground"));
        return;
    }
    const started = installService();
    if (started) {
        const service = getServiceStatus();
        console.log(`Profile: ${profileDisplayName(servicePathsProfile())}`);
        console.log(t("install.serviceStarted", service.manager));
        return;
    }
    const servicePaths = getServicePaths();
    console.log(t("install.installFailed", platformName(platform)));
    if (platform === "macos") {
        console.log(t("install.serviceFileWritten", servicePaths.macPlistPath));
        console.log(t("install.startManually", `launchctl load -w "${servicePaths.macPlistPath}"`));
    }
    else if (platform === "linux") {
        console.log(t("install.serviceFileWritten", servicePaths.linuxServicePath));
        console.log(t("install.startManually", "systemctl --user daemon-reload && systemctl --user enable --now clawconnect-agent.service"));
        console.log(t("install.startManually", `bash "${servicePaths.linuxNohupStartScriptPath}"`));
    }
    else if (platform === "windows") {
        const taskName = getServiceStatus().serviceName;
        console.log(t("install.startManually", `schtasks /run /tn "${taskName}"`));
    }
}
export function restartCommand() {
    console.log(t("install.restarting"));
    const platform = getServicePlatform();
    if (platform === "unsupported") {
        console.log(t("install.unsupported", process.platform));
        return;
    }
    if (restartService()) {
        console.log(t("install.serviceRestarted", platformName(platform)));
        return;
    }
    console.log(t("install.restartFailed", platformName(platform)));
}
export function uninstallCommand() {
    const platform = getServicePlatform();
    if (platform === "unsupported") {
        console.log(t("install.unsupported", process.platform));
        return;
    }
    const changed = uninstallService();
    if (changed) {
        console.log(t("install.stoppedAndRemoved", platformName(platform)));
    }
    else {
        console.log(t("install.noService"));
    }
}
export function stopCommand() {
    const platform = getServicePlatform();
    if (platform === "unsupported") {
        console.log(t("install.unsupported", process.platform));
        return;
    }
    const changed = stopService();
    if (changed) {
        console.log(t("install.stopped", platformName(platform)));
    }
    else {
        console.log(t("install.noService"));
    }
}
export function resetCommand() {
    stopCommand();
    const configPath = profileConfigPath();
    if (existsSync(configPath)) {
        try {
            if (process.platform === "win32") {
                // Older Windows installs granted read/write but not delete.
                // Repair the ACL before removing the file so reset can self-heal.
                setRestrictiveFilePermissions(configPath);
            }
            unlinkSync(configPath);
            console.log(t("install.configRemoved", configPath));
        }
        catch (err) {
            console.error(t("install.removeConfigFailed"), err);
        }
    }
    else {
        console.log(t("install.noConfig"));
    }
    console.log(t("install.resetCompleteWithCommand", pairCommandForProfile(getActiveProfile())));
}
function servicePathsProfile() {
    const profile = getServicePaths().profile;
    return profile === "default" ? undefined : profile;
}
function platformName(platform) {
    switch (platform) {
        case "macos":
            return "launchd";
        case "linux":
            return "systemd/nohup";
        case "windows":
            return "Windows Task Scheduler";
        default:
            return process.platform;
    }
}
//# sourceMappingURL=install.js.map