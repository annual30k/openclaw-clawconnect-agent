import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { t } from "../i18n/index.js";
import { getServicePlatform, getServiceStatus, installService, restartService, stopService, uninstallService, servicePaths, } from "../platform/service-manager.js";
export function isInstalled() {
    const platform = getServicePlatform();
    if (platform === "macos")
        return existsSync(servicePaths.macPlistPath);
    if (platform === "linux") {
        return existsSync(servicePaths.linuxServicePath) || existsSync(servicePaths.linuxNohupStartScriptPath);
    }
    return false;
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
        console.log(t("install.serviceStarted", service.manager));
        return;
    }
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
    const configPath = join(homedir(), ".clawconnect", "config.json");
    if (existsSync(configPath)) {
        try {
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
    console.log(t("install.resetComplete"));
}
function platformName(platform) {
    switch (platform) {
        case "macos":
            return "launchd";
        case "linux":
            return "systemd/nohup";
        default:
            return process.platform;
    }
}
//# sourceMappingURL=install.js.map