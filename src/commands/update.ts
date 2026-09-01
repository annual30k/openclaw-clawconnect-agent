import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { dirname, extname, join } from "path";
import { fileURLToPath } from "url";
import { t } from "../i18n/index.js";
import { getServiceStatus } from "../platform/service-manager.js";
import type { ServiceStatus } from "../platform/service-manager.js";
import { listProfileNames } from "../config/profile.js";

export const CLAWCONNECT_PACKAGE_NAME = "clawconnect-agent";
export const CLAWCONNECT_COMMAND_NAME = "clawconnect";

export type InstalledServiceProfile = {
  profile: string;
  manager: string;
};

export function installedServiceProfilesForUpdate(
  profileNames: readonly string[] = listProfileNames(),
  statusForProfile: (profile?: string) => Pick<ServiceStatus, "installed" | "manager"> = getServiceStatus,
): InstalledServiceProfile[] {
  const candidates = profileNames.length > 0 ? profileNames : ["default"];
  const installed: InstalledServiceProfile[] = [];
  for (const profile of candidates) {
    const normalizedProfile = profile === "default" ? undefined : profile;
    const status = statusForProfile(normalizedProfile);
    if (status.installed) {
      installed.push({ profile, manager: status.manager });
    }
  }
  return installed;
}

export function buildWindowsCommandLine(args: string[]): string {
  return args
    .map((arg) => {
      if (/[ \t"]/.test(arg)) {
        let result = "";
        for (let i = 0; i < arg.length; i += 1) {
          let backslashCount = 0;
          while (i < arg.length && arg[i] === "\\") {
            backslashCount += 1;
            i += 1;
          }
          if (i >= arg.length) {
            result += "\\".repeat(backslashCount * 2);
          } else if (arg[i] === '"') {
            result += "\\".repeat(backslashCount * 2 + 1);
            result += '"';
          } else {
            result += "\\".repeat(backslashCount);
            result += arg[i];
          }
        }
        return `"${result}"`;
      }
      return arg;
    })
    .join(" ");
}

export function deriveWindowsNodeModuleCliEntry(
  commandPath: string,
  packageName: string,
  relativeEntryPath: string,
): string | null {
  const candidate = join(dirname(commandPath), "node_modules", packageName, relativeEntryPath);
  return existsSync(candidate) ? candidate : null;
}

export function buildSelfUpdateArgs(versionTag = "latest"): string[] {
  return ["install", "-g", `${CLAWCONNECT_PACKAGE_NAME}@${versionTag}`];
}

export function isGlobalNpmInstall(moduleUrl: string): boolean {
  const filePath = fileURLToPath(moduleUrl).replace(/\\/g, "/");
  return filePath.includes(`/node_modules/${CLAWCONNECT_PACKAGE_NAME}/`);
}

export function parseResolvedCommandPath(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[0] ?? null;
}

export function parseVersionOutput(output: string): string | null {
  const line = output
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  return line ?? null;
}

function runWindowsCommand(commandPath: string, args: string[], stdio: "pipe" | "inherit"): Buffer {
  const commandLine = buildWindowsCommandLine([commandPath, ...args]);
  return execFileSync(
    "cmd.exe",
    ["/d", "/s", "/c", commandLine],
    { stdio, windowsHide: true },
  );
}

function resolveActiveCommandPath(commandName: string): string | null {
  try {
    const output = process.platform === "win32"
      ? execFileSync("where.exe", [commandName], { stdio: "pipe", windowsHide: true }).toString()
      : execFileSync("which", [commandName], { stdio: "pipe" }).toString();
    return parseResolvedCommandPath(output);
  } catch {
    return null;
  }
}

function runCommandPath(
  commandPath: string,
  args: string[],
  stdio: "pipe" | "inherit",
  windowsPackageName?: string,
  windowsRelativeEntryPath?: string,
): Buffer {
  if (process.platform === "win32" && extname(commandPath).toLowerCase() !== ".exe") {
    if (windowsPackageName && windowsRelativeEntryPath) {
      const cliEntry = deriveWindowsNodeModuleCliEntry(commandPath, windowsPackageName, windowsRelativeEntryPath);
      if (cliEntry) {
        return execFileSync(process.execPath, [cliEntry, ...args], {
          stdio,
          windowsHide: true,
        });
      }
    }
    return runWindowsCommand(commandPath, args, stdio);
  }

  return execFileSync(commandPath, args, {
    stdio,
    windowsHide: true,
  });
}

export function resolveActiveClawconnectPath(): string | null {
  return resolveActiveCommandPath(CLAWCONNECT_COMMAND_NAME);
}

export function readCliVersionFromPath(commandPath: string): string | null {
  try {
    const output = runCommandPath(
      commandPath,
      ["--version"],
      "pipe",
      CLAWCONNECT_PACKAGE_NAME,
      join("dist", "index.js"),
    ).toString();
    return parseVersionOutput(output);
  } catch {
    return null;
  }
}

export function getLatestPublishedVersion(): string | null {
  try {
    const npmPath = resolveActiveCommandPath("npm") ?? (process.platform === "win32" ? "npm.cmd" : "npm");
    const output = runCommandPath(
      npmPath,
      ["view", CLAWCONNECT_PACKAGE_NAME, "version"],
      "pipe",
      "npm",
      join("bin", "npm-cli.js"),
    ).toString();
    return parseVersionOutput(output);
  } catch {
    return null;
  }
}

export function updateCommand(moduleUrl: string): void {
  // Capture every installed profile before npm replaces the active package.
  // Named Windows services are independent tasks; checking only the default
  // profile leaves them running an old absolute dist/index.js after update.
  const installedServices = installedServiceProfilesForUpdate();
  const activePathBefore = resolveActiveClawconnectPath();
  const activeVersionBefore = activePathBefore ? readCliVersionFromPath(activePathBefore) : null;
  const latestVersion = getLatestPublishedVersion();
  const targetVersion = latestVersion ?? "latest";

  if (!isGlobalNpmInstall(moduleUrl)) {
    console.log(t("update.localInstallWarning"));
  }

  if (activePathBefore) {
    console.log(t("update.activePath", activePathBefore));
  }
  if (activeVersionBefore) {
    console.log(t("update.currentVersion", activeVersionBefore));
  }
  if (latestVersion) {
    console.log(t("update.targetVersion", latestVersion));
  }

  console.log(t("update.starting", `${CLAWCONNECT_PACKAGE_NAME}@${targetVersion}`));

  try {
    const npmPath = resolveActiveCommandPath("npm") ?? (process.platform === "win32" ? "npm.cmd" : "npm");
    runCommandPath(
      npmPath,
      buildSelfUpdateArgs(targetVersion),
      "inherit",
      "npm",
      join("bin", "npm-cli.js"),
    );
  } catch (err) {
    console.error(t("update.failed", CLAWCONNECT_PACKAGE_NAME));
    console.error(t("update.manualHint", `npm install -g ${CLAWCONNECT_PACKAGE_NAME}@latest`));
    throw err;
  }

  const activePathAfter = resolveActiveClawconnectPath();
  const activeVersionAfter = activePathAfter ? readCliVersionFromPath(activePathAfter) : null;

  if (!activePathAfter || !activeVersionAfter) {
    console.error(t("update.verifyFailed"));
    console.error(t("update.manualHint", `${CLAWCONNECT_COMMAND_NAME} --version`));
    throw new Error("Unable to verify the active clawconnect installation after update.");
  }

  console.log(t("update.activePath", activePathAfter));
  console.log(t("update.currentVersion", activeVersionAfter));

  if (latestVersion && activeVersionAfter !== latestVersion) {
    console.error(t("update.versionMismatch", latestVersion, activeVersionAfter));
    console.error(t("update.pathMismatchHint", activePathAfter));
    console.error(t("update.manualHint", process.platform === "win32" ? "where.exe clawconnect" : "which clawconnect"));
    throw new Error(`Expected active clawconnect version ${latestVersion}, got ${activeVersionAfter}.`);
  }

  console.log(t("update.updated", `${CLAWCONNECT_PACKAGE_NAME}@${activeVersionAfter}`));

  if (installedServices.length > 0) {
    for (const service of installedServices) {
      console.log(t("update.reinstallingService"));
      try {
        runCommandPath(
          activePathAfter,
          ["install", "--profile", service.profile],
          "inherit",
          CLAWCONNECT_PACKAGE_NAME,
          join("dist", "index.js"),
        );
        console.log(t("update.serviceReinstalled", `${service.manager} (${service.profile})`));
      } catch {
        console.log(t("update.serviceReinstallFailed", `${service.manager} (${service.profile})`));
        try {
          runCommandPath(
            activePathAfter,
            ["restart", "--profile", service.profile],
            "inherit",
            CLAWCONNECT_PACKAGE_NAME,
            join("dist", "index.js"),
          );
          console.log(t("update.serviceRestarted", `${service.manager} (${service.profile})`));
        } catch {
          console.log(t("update.serviceRestartFailed", `${service.manager} (${service.profile})`));
          console.log(t("update.manualHint", `clawconnect install --profile ${service.profile}`));
        }
      }
    }
    return;
  }

  console.log(t("update.noServiceRestartNeeded"));
}
