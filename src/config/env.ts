import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

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
# ~/.openclaw/openclaw.json and falling back to ws://localhost:18789.
# CLAWCONNECT_GATEWAY_URL=ws://localhost:18789

# Optional: Gateway auth fallback.
# Prefer \`clawconnect set-token\` or ~/.openclaw/openclaw.json when possible.
# OPENCLAW_GATEWAY_TOKEN=
# OPENCLAW_GATEWAY_PASSWORD=

# Optional: assistant voice replies.
# OPENCLAW_TTS_ENABLED=0
# OPENCLAW_TTS_VOICE=Ting-Ting
# OPENCLAW_TTS_RATE=
# OPENCLAW_TTS_ENGINE=

# Optional: override how local maintenance commands find the OpenClaw CLI.
# OPENCLAW_BIN=/usr/local/bin/openclaw
# OPENCLAW_PACKAGE_BIN=/path/to/openclaw/package/dist/index.js
`;

type EnvMap = Record<string, string | undefined>;

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

export function getUserEnvPath(): string {
  return join(homedir(), ".clawconnect", ".env");
}

export function ensureUserEnvFile(path = getUserEnvPath()): boolean {
  if (existsSync(path)) {
    return false;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, AGENT_ENV_TEMPLATE, { encoding: "utf-8", mode: 0o600 });
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
      }
    }
    loaded.push(path);
  }

  return loaded;
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
