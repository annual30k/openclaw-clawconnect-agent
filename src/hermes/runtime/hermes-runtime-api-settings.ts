import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvFile } from "../../config/env.js";
import { resolveHermesHomeDir } from "./hermes-runtime-paths.js";

const DEFAULT_HERMES_API_HOST = "127.0.0.1";
const DEFAULT_HERMES_API_PORT = 8642;

type HermesApiEnvironment = Record<string, string | undefined>;

export interface HermesApiSettingsOptions {
  env?: HermesApiEnvironment;
  hermesHome?: string;
  fileEnv?: Record<string, string>;
}

export interface HermesApiSettings {
  baseUrl: string;
  apiKey?: string;
  configured: boolean;
  executionReady: boolean;
}

export type HermesRuntimeExecutionMode = "local" | "api";

interface HermesApiServerConfig {
  host?: string;
  port?: string;
  apiKey?: string;
}

/**
 * Resolve the effective Hermes API endpoint from explicit ClawConnect
 * overrides and the selected Hermes home's active configuration. Hermes gives
 * config.yaml's platforms.api_server.extra values precedence over API_SERVER_*
 * environment variables, so matching that order keeps both processes pointed
 * at the same listener after a Hermes port change.
 */
export function resolveHermesApiSettings(options: HermesApiSettingsOptions = {}): HermesApiSettings {
  const env = options.env ?? process.env;
  const hermesHome = options.hermesHome ?? resolveHermesHomeDir({ env });
  const fileEnv = options.fileEnv ?? readHermesHomeEnv({
    env,
    hermesHome,
  });
  const apiServerConfig = readHermesApiServerConfig(hermesHome);
  const explicitUrl = firstNonEmpty(
    env.CLAWCONNECT_HERMES_API_URL,
    env.HERMES_API_SERVER_URL,
    fileEnv.CLAWCONNECT_HERMES_API_URL,
    fileEnv.HERMES_API_SERVER_URL,
  );
  const apiKey = firstNonEmpty(
    env.CLAWCONNECT_HERMES_API_KEY,
    fileEnv.CLAWCONNECT_HERMES_API_KEY,
    apiServerConfig.apiKey,
    env.API_SERVER_KEY,
    fileEnv.API_SERVER_KEY,
  );
  const configuredHost = firstNonEmpty(
    apiServerConfig.host,
    env.API_SERVER_HOST,
    fileEnv.API_SERVER_HOST,
  );
  const configuredPort = validPort(firstNonEmpty(
    apiServerConfig.port,
    env.API_SERVER_PORT,
    fileEnv.API_SERVER_PORT,
  ));
  const apiServerEnabled = isTruthy(firstNonEmpty(
    env.API_SERVER_ENABLED,
    fileEnv.API_SERVER_ENABLED,
  ));
  const configured = Boolean(explicitUrl || apiKey || configuredHost || configuredPort);
  // When Hermes explicitly enables its API Server it uses the documented
  // 127.0.0.1:8642 defaults even if host/port are absent from .env.
  const executionReady = Boolean(apiKey && (explicitUrl || configuredHost || configuredPort || apiServerEnabled));

  if (explicitUrl) {
    return { baseUrl: normalizeBaseUrl(explicitUrl), apiKey, configured, executionReady };
  }

  const host = formatUrlHost(configuredHost ?? DEFAULT_HERMES_API_HOST);
  const port = configuredPort ?? DEFAULT_HERMES_API_PORT;
  return { baseUrl: `http://${host}:${port}`, apiKey, configured, executionReady };
}

export function resolveHermesRuntimeExecutionMode(
  options: HermesApiSettingsOptions = {},
): HermesRuntimeExecutionMode {
  const env = options.env ?? process.env;
  const configuredMode = env.CLAWCONNECT_HERMES_RUNTIME_MODE?.trim().toLowerCase();
  if (configuredMode === "api" || configuredMode === "api_server") {
    return "api";
  }
  if (configuredMode === "local" || configuredMode === "cli" || configuredMode === "native") {
    return "local";
  }

  // Legacy installs implicitly selected the API transport by providing a
  // complete endpoint + key. Resolve this from the same process/file sources
  // as the runtime itself so status and execution cannot disagree. A lone key
  // or endpoint is intentionally insufficient and keeps the local default.
  return resolveHermesApiSettings({ ...options, env }).executionReady ? "api" : "local";
}

export function readHermesHomeEnv(options: Pick<HermesApiSettingsOptions, "env" | "hermesHome"> = {}): Record<string, string> {
  const env = options.env ?? process.env;
  const hermesHome = options.hermesHome ?? resolveHermesHomeDir({ env });
  const envPath = join(hermesHome, ".env");
  if (!existsSync(envPath)) {
    return {};
  }
  try {
    return parseEnvFile(readFileSync(envPath, "utf8"));
  } catch {
    return {};
  }
}

function readHermesApiServerConfig(hermesHome: string): HermesApiServerConfig {
  const configPath = join(hermesHome, "config.yaml");
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    return parseHermesApiServerConfig(readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Read only Hermes' documented block-style API Server fields. This deliberately
 * avoids treating arbitrary YAML as executable configuration while supporting
 * quoted values and inline comments used by Hermes' generated config file.
 */
function parseHermesApiServerConfig(content: string): HermesApiServerConfig {
  const result: HermesApiServerConfig = {};
  const path: Array<{ indent: number; key: string }> = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripYamlComment(rawLine);
    if (!line.trim()) {
      continue;
    }
    const match = line.match(/^(\s*)([^:\s][^:]*):(?:\s*(.*))?$/);
    if (!match || match[1].includes("\t")) {
      continue;
    }
    const indent = match[1].length;
    const key = match[2].trim();
    const rawValue = match[3]?.trim() ?? "";
    while (path.length > 0 && path[path.length - 1].indent >= indent) {
      path.pop();
    }

    const parentPath = path.map((entry) => entry.key).join(".");
    if (parentPath === "platforms.api_server.extra") {
      const value = parseYamlScalar(rawValue);
      if (key === "host") {
        result.host = value;
      } else if (key === "port") {
        result.port = value;
      } else if (key === "key") {
        result.apiKey = value;
      }
    }
    if (!rawValue) {
      path.push({ indent, key });
    }
  }
  return result;
}

function stripYamlComment(line: string): string {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote && (quote === "'" || line[index - 1] !== "\\")) {
        quote = undefined;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "#" && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseYamlScalar(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "~") {
    return undefined;
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : trimmed;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/g, "");
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes" || value?.toLowerCase() === "on";
}

function validPort(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  const port = Number.parseInt(value, 10);
  return port >= 1 && port <= 65_535 ? port : undefined;
}

function formatUrlHost(value: string): string {
  const host = value.trim();
  return host.includes(":") && !(host.startsWith("[") && host.endsWith("]"))
    ? `[${host}]`
    : host;
}
