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
}

/**
 * Resolve the effective Hermes API endpoint from the ClawConnect process env
 * and the selected Hermes home's .env file. Keeping this in one lightweight
 * module lets `status` and the runtime report/use exactly the same endpoint.
 */
export function resolveHermesApiSettings(options: HermesApiSettingsOptions = {}): HermesApiSettings {
  const env = options.env ?? process.env;
  const fileEnv = options.fileEnv ?? readHermesHomeEnv({
    env,
    hermesHome: options.hermesHome,
  });
  const explicitUrl = firstNonEmpty(
    env.CLAWCONNECT_HERMES_API_URL,
    env.HERMES_API_SERVER_URL,
    fileEnv.CLAWCONNECT_HERMES_API_URL,
    fileEnv.HERMES_API_SERVER_URL,
  );
  const apiKey = firstNonEmpty(
    env.CLAWCONNECT_HERMES_API_KEY,
    env.API_SERVER_KEY,
    fileEnv.CLAWCONNECT_HERMES_API_KEY,
    fileEnv.API_SERVER_KEY,
  );
  const configuredHost = firstNonEmpty(env.API_SERVER_HOST, fileEnv.API_SERVER_HOST);
  const configuredPort = validPort(firstNonEmpty(env.API_SERVER_PORT, fileEnv.API_SERVER_PORT));
  const configured = Boolean(explicitUrl || apiKey || configuredHost || configuredPort);

  if (explicitUrl) {
    return { baseUrl: normalizeBaseUrl(explicitUrl), apiKey, configured };
  }

  const host = formatUrlHost(configuredHost ?? DEFAULT_HERMES_API_HOST);
  const port = configuredPort ?? DEFAULT_HERMES_API_PORT;
  return { baseUrl: `http://${host}:${port}`, apiKey, configured };
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
