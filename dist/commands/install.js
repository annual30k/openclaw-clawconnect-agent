import { existsSync, unlinkSync } from "fs";
import { dirname } from "path";
import { t } from "../i18n/index.js";
import { getServicePlatform, getServiceStatus, getServicePaths, installService, restartService, setRestrictiveFilePermissions, stopService, uninstallService, } from "../platform/service-manager.js";
import { clearProfileLogs, getActiveProfile, listNamedProfileDirs, listProfileNames, profileConfigPath, profileDisplayName, profileErrorLogPath, profileLogPath, removeEmptyProfileDir, setActiveProfile, } from "../config/profile.js";
import { pruneRegistrationBackups } from "../config/config-backups.js";
import { pairCommandForProfile, resetCommandForProfile } from "./profile-hints.js";
import { clearReliableRelayOutboxStorage } from "../core/relay/reliable-relay-outbox-store.js";
import { configExists, readConfig } from "../config/config.js";
import { ensureHermesApiServer } from "../hermes/runtime/hermes-api-bootstrap.js";
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
    const activeProfile = getActiveProfile();
    if (!configExists(activeProfile)) {
        process.exitCode = 1;
        console.error(t("install.profileNotPaired", profileDisplayName(activeProfile), pairCommandForProfile(activeProfile)));
        return;
    }
    if (readConfig().gatewayType === "hermes") {
        const apiSetup = ensureHermesApiServer();
        if (apiSetup === "configured") {
            console.log("Hermes API Server enabled for synchronized text streaming.");
        }
        else if (apiSetup === "explicit-local") {
            console.log("Hermes local CLI mode explicitly selected; assistant text deltas are unavailable.");
        }
    }
    const started = installService();
    if (started) {
        const service = getServiceStatus();
        console.log(`Profile: ${profileDisplayName(servicePathsProfile())}`);
        console.log(t("install.serviceStarted", service.manager));
        return;
    }
    const servicePaths = getServicePaths();
    // 失败必须体现在退出码上：`clawconnect update` 依赖它判断服务是否真的重装成功。
    process.exitCode = 1;
    console.log(t("install.installFailed", platformName(platform)));
    if (platform === "macos") {
        console.log(t("install.serviceFileWritten", servicePaths.macPlistPath));
        console.log(t("install.startManually", `launchctl load -w "${servicePaths.macPlistPath}"`));
    }
    else if (platform === "linux") {
        console.log(t("install.serviceFileWritten", servicePaths.linuxServicePath));
        console.log(t("install.startManually", `systemctl --user daemon-reload && systemctl --user enable --now ${servicePaths.linuxServiceName}`));
        console.log(t("install.startManually", `sh "${servicePaths.linuxNohupStartScriptPath}"`));
    }
    else if (platform === "windows") {
        console.log(t("install.startManually", getServiceStatus().startHint ?? ""));
    }
}
export function restartCommand() {
    if (isActiveMobileChatProcess()) {
        console.error("[clawconnect] Refusing to restart the host service from the active mobile chat process. "
            + "The ASR configuration reloads automatically; run a service restart only from an independent host terminal.");
        process.exitCode = 1;
        return;
    }
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
    process.exitCode = 1;
    console.log(t("install.restartFailed", platformName(platform)));
}
export function isActiveMobileChatProcess(env = process.env) {
    return Boolean(env.CLAWCONNECT_CHAT_SESSION_KEY?.trim()
        || env.CLAWCONNECT_SOURCE_RUN_ID?.trim());
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
export function listResettableProfiles() {
    const names = new Set();
    const defaultHasState = configExists(undefined)
        || getServiceStatus(undefined).installed
        || existsSync(profileLogPath(undefined))
        || existsSync(profileErrorLogPath(undefined));
    if (defaultHasState) {
        names.add("default");
    }
    for (const name of listProfileNames()) {
        names.add(name);
    }
    for (const name of listNamedProfileDirs()) {
        names.add(name);
    }
    for (const builtin of ["openclaw", "hermes"]) {
        if (getServiceStatus(builtin).installed) {
            names.add(builtin);
        }
    }
    return [...names].sort((left, right) => {
        if (left === "default")
            return -1;
        if (right === "default")
            return 1;
        return left.localeCompare(right);
    });
}
export function resetCommand(deps = {}) {
    const activeProfile = getActiveProfile();
    const isInstalled = deps.isServiceInstalled ?? ((targetProfile) => getServiceStatus(targetProfile).installed);
    const wasInstalled = isInstalled(activeProfile);
    (deps.uninstall ?? uninstallCommand)();
    if (wasInstalled && isInstalled(activeProfile)) {
        process.exitCode = 1;
        console.error(t("install.resetServiceRemovalFailed", resetCommandForProfile(activeProfile)));
        return;
    }
    const configPath = profileConfigPath(activeProfile);
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
    try {
        pruneRegistrationBackups(dirname(configPath), 0);
    }
    catch (err) {
        console.error("[clawconnect] Failed to remove registration backups:", err);
    }
    clearProfileLogs(activeProfile);
    try {
        clearReliableRelayOutboxStorage(activeProfile);
    }
    catch (err) {
        console.error("[clawconnect] Failed to clear reliable delivery state:", err);
    }
    removeEmptyProfileDir(activeProfile);
    console.log(t("install.resetCompleteWithCommand", pairCommandForProfile(activeProfile)));
}
export function resetAllCommand() {
    const profiles = listResettableProfiles();
    if (profiles.length === 0) {
        console.log(t("install.noResettableProfiles"));
        return;
    }
    const previousProfile = getActiveProfile();
    try {
        profiles.forEach((profile, index) => {
            if (index > 0)
                console.log("");
            console.log(`── Resetting profile: ${profile} ──`);
            setActiveProfile(profile === "default" ? undefined : profile);
            resetCommand();
        });
    }
    finally {
        setActiveProfile(previousProfile);
    }
}
export function uninstallAllCommand() {
    const profiles = listResettableProfiles().filter((profile) => getServiceStatus(profile === "default" ? undefined : profile).installed);
    if (profiles.length === 0) {
        console.log(t("install.noService"));
        return;
    }
    const previousProfile = getActiveProfile();
    try {
        profiles.forEach((profile, index) => {
            if (index > 0)
                console.log("");
            console.log(`── Uninstalling profile service: ${profile} ──`);
            setActiveProfile(profile === "default" ? undefined : profile);
            uninstallCommand();
        });
    }
    finally {
        setActiveProfile(previousProfile);
    }
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
            return "Windows Service";
        default:
            return process.platform;
    }
}
//# sourceMappingURL=install.js.map