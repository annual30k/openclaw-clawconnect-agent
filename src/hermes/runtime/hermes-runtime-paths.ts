import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveConfiguredPath } from "../../openclaw/runtime/openclaw-paths.js";

export interface HermesPathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  systemHome?: string;
  exists?: (path: string) => boolean;
  readShebang?: (path: string) => string | undefined;
}

export function getHermesBinCandidates(options: HermesPathOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const systemHome = options.systemHome ?? homedir();
  const hermesHome = resolveHermesHomeDir(options);
  if (platform === "win32") {
    return [
      join(hermesHome, "hermes-agent", "venv", "Scripts", "hermes.exe"),
      join(hermesHome, "hermes-agent", "venv", "Scripts", "hermes.cmd"),
      join(hermesHome, "hermes-agent", "venv", "Scripts", "hermes.ps1"),
      join(hermesHome, "bin", "hermes.cmd"),
      join(hermesHome, "bin", "hermes.ps1"),
      join(systemHome, ".local", "bin", "hermes.exe"),
      join(systemHome, ".local", "bin", "hermes.cmd"),
    ];
  }
  return [
    join(hermesHome, "hermes-agent", "venv", "bin", "hermes"),
    join(hermesHome, "bin", "hermes"),
    join(systemHome, ".local", "bin", "hermes"),
  ];
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
  const systemHome = options.systemHome ?? homedir();
  const exists = options.exists ?? existsSync;
  const explicit = env.HERMES_PYTHON?.trim();
  if (explicit) {
    return resolveConfiguredPath(explicit, systemHome);
  }

  const hermesHome = resolveHermesHomeDir(options);
  const venvRoots = [
    join(hermesHome, "hermes-agent", "venv"),
    join(systemHome, ".local", "share", "uv", "tools", "hermes-agent"),
    join(systemHome, ".local", "pipx", "venvs", "hermes-agent"),
  ];
  const candidates = venvRoots.flatMap((venvRoot) => pythonCandidatesInVenv(venvRoot, platform));
  const venvPython = candidates.find(exists);
  if (venvPython) {
    return venvPython;
  }

  const explicitHermesBin = env.HERMES_BIN?.trim()
    ? resolveConfiguredPath(env.HERMES_BIN.trim(), systemHome)
    : undefined;
  const cliCandidates = [
    ...(explicitHermesBin ? [explicitHermesBin] : []),
    ...getHermesBinCandidates({ ...options, env, platform, systemHome, exists }),
  ];
  for (const cliPath of cliCandidates) {
    if (!exists(cliPath)) {
      continue;
    }
    const shebangPython = readPythonShebangInterpreter(cliPath, options.readShebang);
    if (shebangPython && exists(shebangPython)) {
      return shebangPython;
    }
  }

  return platform === "win32" ? "python" : "python3";
}

function pythonCandidatesInVenv(venvRoot: string, platform: NodeJS.Platform): string[] {
  return platform === "win32"
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
}

function readPythonShebangInterpreter(
  filePath: string,
  readShebang?: (path: string) => string | undefined,
): string | undefined {
  const line = readShebang ? readShebang(filePath) : readFirstLineFromFile(filePath);
  if (!line || !line.startsWith("#!")) {
    return undefined;
  }
  const tokens = line.slice(2).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return undefined;
  }
  const first = tokens[0]!;
  const firstBase = pathBaseName(first).toLowerCase();
  const candidate = firstBase === "env" || firstBase === "env.exe"
    ? tokens.slice(1).find((token) => !token.startsWith("-"))
    : first;
  if (!candidate || !isAbsoluteInterpreterPath(candidate) || !isPythonInterpreterBasename(pathBaseName(candidate))) {
    return undefined;
  }
  return candidate;
}

function readFirstLineFromFile(filePath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(256);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) {
      return undefined;
    }
    const head = buffer.subarray(0, bytesRead).toString("utf8");
    const newlineIndex = head.search(/\r?\n/);
    return (newlineIndex >= 0 ? head.slice(0, newlineIndex) : head).trim();
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close error on read-only probe descriptor.
      }
    }
  }
}

function pathBaseName(targetPath: string): string {
  const parts = targetPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function isAbsoluteInterpreterPath(targetPath: string): boolean {
  return targetPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(targetPath);
}

function isPythonInterpreterBasename(base: string): boolean {
  return /^python(\d+(?:\.\d+)*)?(\.exe)?$/i.test(base);
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
