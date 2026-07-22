import { existsSync, unlinkSync } from "fs";
import { t } from "../i18n/index.js";
import {
  getServicePlatform,
  getServiceStatus,
  getServicePaths,
  installService,
  restartService,
  setRestrictiveFilePermissions,
  stopService,
  uninstallService,
} from "../platform/service-manager.js";
import { getActiveProfile, profileConfigPath, profileDisplayName } from "../config/profile.js";
import { pairCommandForProfile } from "./profile-hints.js";

export function isInstalled(): boolean {
  return getServiceStatus().installed;
}

export function installCommand(): void {
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
  } else if (platform === "linux") {
    console.log(t("install.serviceFileWritten", servicePaths.linuxServicePath));
    console.log(t("install.startManually", "systemctl --user daemon-reload && systemctl --user enable --now clawconnect-agent.service"));
    console.log(t("install.startManually", `bash "${servicePaths.linuxNohupStartScriptPath}"`));
  } else if (platform === "windows") {
    const taskName = getServiceStatus().serviceName;
    console.log(t("install.startManually", `schtasks /run /tn "${taskName}"`));
  }
}

export function restartCommand(): void {
  if (isActiveMobileChatProcess()) {
    console.error(
      "[clawconnect] Refusing to restart the host service from the active mobile chat process. "
      + "The ASR configuration reloads automatically; run a service restart only from an independent host terminal.",
    );
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
  console.log(t("install.restartFailed", platformName(platform)));
}

export function isActiveMobileChatProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.CLAWCONNECT_CHAT_SESSION_KEY?.trim()
    || env.CLAWCONNECT_SOURCE_RUN_ID?.trim(),
  );
}

export function uninstallCommand(): void {
  const platform = getServicePlatform();
  if (platform === "unsupported") {
    console.log(t("install.unsupported", process.platform));
    return;
  }
  const changed = uninstallService();
  if (changed) {
    console.log(t("install.stoppedAndRemoved", platformName(platform)));
  } else {
    console.log(t("install.noService"));
  }
}

export function stopCommand(): void {
  const platform = getServicePlatform();
  if (platform === "unsupported") {
    console.log(t("install.unsupported", process.platform));
    return;
  }
  const changed = stopService();
  if (changed) {
    console.log(t("install.stopped", platformName(platform)));
  } else {
    console.log(t("install.noService"));
  }
}

export function resetCommand(): void {
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
    } catch (err) {
      console.error(t("install.removeConfigFailed"), err);
    }
  } else {
    console.log(t("install.noConfig"));
  }

  console.log(t("install.resetCompleteWithCommand", pairCommandForProfile(getActiveProfile())));
}

function servicePathsProfile(): string | undefined {
  const profile = getServicePaths().profile;
  return profile === "default" ? undefined : profile;
}

function platformName(platform: ReturnType<typeof getServicePlatform>): string {
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
