import { existsSync, readdirSync, rmdirSync, statSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const CLAWCONNECT_HOME = join(homedir(), ".clawconnect");
export const PROFILE_ENV = "CLAWCONNECT_PROFILE";

export function normalizeProfileName(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed === "default") {
    return undefined;
  }
  const normalized = trimmed.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || undefined;
}

export function setActiveProfile(profile: string | undefined): void {
  const normalized = normalizeProfileName(profile);
  if (normalized) {
    process.env[PROFILE_ENV] = normalized;
  } else {
    delete process.env[PROFILE_ENV];
  }
}

export function getActiveProfile(): string | undefined {
  return normalizeProfileName(process.env[PROFILE_ENV]);
}

export function profileDisplayName(profile: string | undefined): string {
  return normalizeProfileName(profile) ?? "default";
}

export function profileRoot(profile: string | undefined = getActiveProfile()): string {
  const normalized = normalizeProfileName(profile);
  return normalized ? join(CLAWCONNECT_HOME, "profiles", normalized) : CLAWCONNECT_HOME;
}

export function profileConfigPath(profile: string | undefined = getActiveProfile()): string {
  return join(profileRoot(profile), "config.json");
}

export function profileLogPath(profile: string | undefined = getActiveProfile()): string {
  return join(profileRoot(profile), "clawconnect.log");
}

export function profileErrorLogPath(profile: string | undefined = getActiveProfile()): string {
  return join(profileRoot(profile), "clawconnect-error.log");
}

export function clearProfileLogs(profile: string | undefined = getActiveProfile()): void {
  const logPath = profileLogPath(profile);
  const errorLogPath = profileErrorLogPath(profile);
  try {
    if (existsSync(logPath)) unlinkSync(logPath);
  } catch { /* ignore */ }
  try {
    if (existsSync(errorLogPath)) unlinkSync(errorLogPath);
  } catch { /* ignore */ }
}

export function removeEmptyProfileDir(profile: string | undefined = getActiveProfile()): boolean {
  const normalized = normalizeProfileName(profile);
  if (!normalized) {
    return false;
  }
  const dir = profileRoot(normalized);
  try {
    if (!existsSync(dir)) return false;
    if (readdirSync(dir).length > 0) return false;
    rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

export function listNamedProfileDirs(): string[] {
  const names = new Set<string>();
  const profilesDir = join(CLAWCONNECT_HOME, "profiles");
  try {
    for (const entry of readdirSync(profilesDir)) {
      const normalized = normalizeProfileName(entry);
      if (!normalized) {
        continue;
      }
      try {
        if (statSync(join(profilesDir, entry)).isDirectory()) {
          names.add(normalized);
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

export function listProfileNames(): string[] {
  const names = new Set<string>();
  try {
    if (statSync(profileConfigPath(undefined)).isFile()) {
      names.add("default");
    }
  } catch {
    // ignore
  }

  const profilesDir = join(CLAWCONNECT_HOME, "profiles");
  try {
    for (const entry of readdirSync(profilesDir)) {
      const normalized = normalizeProfileName(entry);
      if (!normalized) {
        continue;
      }
      try {
        if (statSync(profileConfigPath(normalized)).isFile()) {
          names.add(normalized);
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  return [...names].sort((left, right) => {
    if (left === "default") return -1;
    if (right === "default") return 1;
    return left.localeCompare(right);
  });
}
