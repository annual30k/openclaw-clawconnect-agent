import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveConfiguredPath } from "../../openclaw/runtime/openclaw-paths.js";

export interface HermesPathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  systemHome?: string;
  exists?: (path: string) => boolean;
}

export function resolveHermesHomeDir(options: HermesPathOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const systemHome = options.systemHome ?? homedir();
  const exists = options.exists ?? existsSync;
  const explicit = env.HERMES_HOME?.trim();
  if (explicit) {
    return resolveConfiguredPath(explicit, systemHome);
  }

  const legacyHome = join(systemHome, ".hermes");
  if (platform !== "win32") {
    return legacyHome;
  }

  // Hermes 原生 Windows 安装器把代码和数据放在 %LOCALAPPDATA%\hermes；
  // 旧版、WSL 或手工安装仍可能使用 %USERPROFILE%\.hermes。
  const localAppData = env.LOCALAPPDATA?.trim();
  const nativeHome = localAppData ? join(localAppData, "hermes") : undefined;
  if (nativeHome && exists(nativeHome)) {
    return nativeHome;
  }
  if (exists(legacyHome)) {
    return legacyHome;
  }
  return nativeHome ?? legacyHome;
}

export function resolveHermesPythonBin(options: HermesPathOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const explicit = env.HERMES_PYTHON?.trim();
  if (explicit) {
    return resolveConfiguredPath(explicit, options.systemHome ?? homedir());
  }

  const hermesHome = resolveHermesHomeDir(options);
  const venvRoot = join(hermesHome, "hermes-agent", "venv");
  const candidates = platform === "win32"
    ? [
        join(venvRoot, "Scripts", "python.exe"),
        join(venvRoot, "Scripts", "python"),
        join(venvRoot, "bin", "python"),
      ]
    : [
        join(venvRoot, "bin", "python"),
        join(venvRoot, "bin", "python3"),
        join(venvRoot, "Scripts", "python.exe"),
        join(venvRoot, "Scripts", "python"),
      ];
  return candidates.find(exists) ?? (platform === "win32" ? "python" : "python3");
}

export function resolveHermesStateDbPath(options: HermesPathOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const explicit = env.CLAWCONNECT_HERMES_STATE_DB?.trim();
  if (explicit) {
    return resolveConfiguredPath(explicit, options.systemHome ?? homedir());
  }
  // HERMES_BIN is the test/diagnostic CLI replacement contract. Unless the
  // state DB is explicitly supplied, do not accidentally consume a real user DB.
  if (env.HERMES_BIN?.trim()) {
    return undefined;
  }
  return join(resolveHermesHomeDir(options), "state.db");
}
