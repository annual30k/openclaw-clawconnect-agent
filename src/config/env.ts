import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { setRestrictiveFilePermissions } from "../platform/service-manager-common.js";

export const DEFAULT_RELAY_SERVER_URL = "https://clawlinks.cn";
export const DEFAULT_GATEWAY_URL = "ws://localhost:18789";
export const AGENT_ENV_TEMPLATE = `# ClawConnect Agent environment configuration.
# Copy this file to ~/.clawconnect/.env for an installed agent.
# For local development from this package directory, copy it to .env.local.
#
# Precedence:
# 1. Shell environment variables
# 2. CLAWCONNECT_ENV_FILE, if set
# 3. ~/.clawconnect/.env
# 4. .env.local
# 5. .env
# 6. Built-in defaults
#
# Existing pairing credentials in ~/.clawconnect/config.json still control
# \`clawconnect run\`, \`status\`, and \`send-file\`. Use \`clawconnect pair --server\`
# or \`clawconnect reset\` when switching relay servers.

# Default relay used by \`clawconnect pair\` when --server is omitted.
CLAWCONNECT_RELAY_SERVER_URL=https://clawlinks.cn

# Optional: explicitly select another env file.
# Usually set this in your shell, not inside ~/.clawconnect/.env.
# CLAWCONNECT_ENV_FILE=/Users/you/.clawconnect/.env

# Optional: force the local OpenClaw Gateway websocket URL instead of reading
# OPENCLAW_CONFIG_PATH / OPENCLAW_STATE_DIR and falling back to ws://localhost:18789.
# CLAWCONNECT_GATEWAY_URL=ws://localhost:18789

# Optional: override only the OpenClaw Gateway port. The full URL above wins.
# OPENCLAW_GATEWAY_PORT=18789

# Optional: OpenClaw official path overrides. These support source, Homebrew,
# container-mounted, dedicated-service-user, and multi-gateway installations.
# OPENCLAW_HOME=/path/to/openclaw-user-home
# OPENCLAW_STATE_DIR=/path/to/openclaw-state
# OPENCLAW_CONFIG_PATH=/path/to/openclaw.json

# Optional: Gateway auth fallback.
# Prefer \`clawconnect set-token\` or the resolved OPENCLAW_CONFIG_PATH when possible.
# OPENCLAW_GATEWAY_TOKEN=
# OPENCLAW_GATEWAY_PASSWORD=

# Optional: host-side speech-to-text for ClawLink voice messages.
# Command must print the transcript to stdout. Available placeholders:
# {file}, {language}, {mimeType}
# CLAWCONNECT_ASR_COMMAND=/usr/local/bin/transcribe-audio {file} {language} {mimeType}
# OPENCLAW_ASR_COMMAND remains supported only as a legacy fallback.

# Optional: override how local maintenance commands find the OpenClaw CLI.
# OPENCLAW_BIN=/usr/local/bin/openclaw
# OPENCLAW_PACKAGE_BIN=/path/to/openclaw/package/dist/index.js
# OPENCLAW_INSTALL_DIR=/path/to/openclaw/source-or-package

# Optional: Hermes source/data/runtime overrides. Native Windows installs are
# auto-detected under %LOCALAPPDATA%\hermes; Unix/WSL defaults to ~/.hermes.
# HERMES_HOME=/path/to/hermes-data
# HERMES_BIN=/path/to/hermes
# HERMES_PYTHON=/path/to/python
# HERMES_SKILLS_DIR=/path/to/hermes-skills
# CLAWCONNECT_HERMES_STATE_DB=/path/to/state.db
# Hermes pairing/install enables the local API Server by default so assistant
# text deltas stay synchronized with mobile clients. Set local only as an
# explicit compatibility fallback; local CLI text is terminal-only.
# CLAWCONNECT_HERMES_RUNTIME_MODE=local
# CLAWCONNECT_HERMES_API_URL=http://127.0.0.1:8642
# CLAWCONNECT_HERMES_API_KEY=
# API_SERVER_HOST=127.0.0.1
# API_SERVER_PORT=8642
`;

type EnvMap = Record<string, string | undefined>;

const fileLoadedEnvKeys = new WeakMap<EnvMap, Set<string>>();

export interface LoadEnvOptions {
  cwd?: string;
  env?: EnvMap;
  paths?: string[];
}

export function getDefaultRelayServerUrl(env: EnvMap = process.env): string {
  return normalizeNonEmpty(env.CLAWCONNECT_RELAY_SERVER_URL) ?? DEFAULT_RELAY_SERVER_URL;
}

export function getConfiguredGatewayUrl(env: EnvMap = process.env): string | undefined {
  return normalizeNonEmpty(env.CLAWCONNECT_GATEWAY_URL);
}

export function getConfiguredGatewayPort(env: EnvMap = process.env): number | undefined {
  const value = normalizeNonEmpty(env.OPENCLAW_GATEWAY_PORT);
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  const port = Number.parseInt(value, 10);
  return port >= 1 && port <= 65_535 ? port : undefined;
}

/**
 * Resolve the host ASR command without requiring a ClawConnect restart.
 *
 * `loadAgentEnv()` intentionally copies file values into the process environment
 * once at startup. ASR installation happens from a live mobile chat, so the
 * installer must be able to update `.clawconnect/.env` without restarting the
 * very service that is carrying that chat. Values that originated from a file
 * are therefore refreshed from disk on each voice request, while a real shell
 * environment value keeps the documented precedence.
 */
export function getConfiguredAsrCommand(options: LoadEnvOptions = {}): string | undefined {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const paths = options.paths ?? defaultEnvPaths(cwd, env);

  return resolveLiveEnvValue("CLAWCONNECT_ASR_COMMAND", env, paths)
    ?? resolveLiveEnvValue("OPENCLAW_ASR_COMMAND", env, paths);
}

export function getUserEnvPath(): string {
  return join(homedir(), ".clawconnect", ".env");
}

export function ensureUserEnvFile(path = getUserEnvPath()): boolean {
  if (existsSync(path)) {
    return false;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, AGENT_ENV_TEMPLATE, "utf-8");
  setRestrictiveFilePermissions(path);
  return true;
}

export function loadAgentEnv(options: LoadEnvOptions = {}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const paths = options.paths ?? defaultEnvPaths(cwd, env);
  const loaded: string[] = [];

  for (const path of paths) {
    if (!existsSync(path)) continue;
    const values = parseEnvFile(readFileSync(path, "utf-8"));
    for (const [key, value] of Object.entries(values)) {
      if (env[key] === undefined) {
        env[key] = value;
        markFileLoadedEnvKey(env, key);
      }
    }
    loaded.push(path);
  }

  return loaded;
}

function resolveLiveEnvValue(key: string, env: EnvMap, paths: string[]): string | undefined {
  const environmentValue = normalizeNonEmpty(env[key]);
  if (environmentValue && !fileLoadedEnvKeys.get(env)?.has(key)) {
    return environmentValue;
  }

  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const values = parseEnvFile(readFileSync(path, "utf-8"));
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        return normalizeNonEmpty(values[key]);
      }
    } catch {
      // A concurrent installer may be replacing the file. Treat this request as
      // unconfigured instead of mutating or retaining a stale command.
      return undefined;
    }
  }

  return fileLoadedEnvKeys.get(env)?.has(key) ? undefined : environmentValue;
}

function markFileLoadedEnvKey(env: EnvMap, key: string): void {
  const keys = fileLoadedEnvKeys.get(env) ?? new Set<string>();
  keys.add(key);
  fileLoadedEnvKeys.set(env, keys);
}

export function parseEnvFile(raw: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const body = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
    const separatorIndex = body.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = body.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    const rawValue = body.slice(separatorIndex + 1).trim();
    values[key] = parseEnvValue(rawValue);
  }

  return values;
}

function defaultEnvPaths(cwd: string, env: EnvMap): string[] {
  const paths: string[] = [];
  const explicitPath = normalizeNonEmpty(env.CLAWCONNECT_ENV_FILE);
  if (explicitPath) {
    paths.push(resolve(cwd, explicitPath));
  }
  paths.push(getUserEnvPath());
  paths.push(resolve(cwd, ".env.local"));
  paths.push(resolve(cwd, ".env"));
  return dedupe(paths);
}

function parseEnvValue(rawValue: string): string {
  if (!rawValue) return "";

  const quote = rawValue[0];
  if ((quote === `"` || quote === `'`) && rawValue.endsWith(quote)) {
    const quoted = rawValue.slice(1, -1);
    return quote === `"` ? unescapeDoubleQuotedValue(quoted) : quoted;
  }

  const commentIndex = rawValue.search(/\s#/);
  return (commentIndex >= 0 ? rawValue.slice(0, commentIndex) : rawValue).trim();
}

function unescapeDoubleQuotedValue(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, `"`)
    .replace(/\\\\/g, "\\");
}

function normalizeNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
