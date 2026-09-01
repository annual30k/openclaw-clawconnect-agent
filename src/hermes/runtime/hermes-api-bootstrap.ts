import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnvFile } from "../../config/env.js";
import { setRestrictiveDirPermissions, setRestrictiveFilePermissions } from "../../platform/service-manager-common.js";
import { resolveHermesApiSettings, readHermesHomeEnv } from "./hermes-runtime-api-settings.js";
import { resolveHermesHomeDir } from "./hermes-runtime-paths.js";
import { runHermes } from "./hermes-runtime-process.js";

type HermesEnvironment = Record<string, string | undefined>;

export interface HermesApiBootstrapOptions {
  env?: HermesEnvironment;
  hermesHome?: string;
  fileEnv?: Record<string, string>;
  runHermesCommand?: (args: string[]) => string;
  generateApiKey?: () => string;
  writeEnvValues?: (values: Record<string, string>) => void;
  readBackEnv?: () => Record<string, string>;
}

export type HermesApiBootstrapResult = "already-ready" | "configured" | "explicit-local" | "external-api";

/**
 * Make Hermes' local API Server the default ClawConnect transport.
 *
 * Hermes' CLI chat output is terminal-only, so it cannot provide synchronized
 * assistant text deltas. Pair/install therefore enables the local API Server
 * unless the operator explicitly opts into local/CLI mode. The operation is
 * idempotent and never exposes the generated API key to ClawConnect logs.
 */
export function ensureHermesApiServer(options: HermesApiBootstrapOptions = {}): HermesApiBootstrapResult {
  const env = options.env ?? process.env;
  const configuredMode = env.CLAWCONNECT_HERMES_RUNTIME_MODE?.trim().toLowerCase();
  if (configuredMode === "local" || configuredMode === "cli" || configuredMode === "native") {
    return "explicit-local";
  }

  const fileEnv = options.fileEnv ?? readHermesHomeEnv({ env, hermesHome: options.hermesHome });
  const settings = resolveHermesApiSettings({ env, fileEnv, hermesHome: options.hermesHome });
  const explicitUrl = firstNonEmpty(
    env.CLAWCONNECT_HERMES_API_URL,
    env.HERMES_API_SERVER_URL,
    fileEnv.CLAWCONNECT_HERMES_API_URL,
    fileEnv.HERMES_API_SERVER_URL,
  );
  if (explicitUrl && settings.executionReady) {
    return "external-api";
  }

  const enabled = isTruthy(firstNonEmpty(env.API_SERVER_ENABLED, fileEnv.API_SERVER_ENABLED));
  if (enabled && settings.executionReady) {
    return "already-ready";
  }

  const run = options.runHermesCommand ?? ((args: string[]) => runHermes(args));
  const existingKey = firstNonEmpty(
    env.CLAWCONNECT_HERMES_API_KEY,
    fileEnv.CLAWCONNECT_HERMES_API_KEY,
    env.API_SERVER_KEY,
    fileEnv.API_SERVER_KEY,
    settings.apiKey,
  );
  const apiKey = existingKey ?? (options.generateApiKey ?? (() => randomBytes(32).toString("hex")))();

  const values = {
    API_SERVER_ENABLED: "true",
    ...(!existingKey ? { API_SERVER_KEY: apiKey } : {}),
  };

  try {
    const writeEnvValues = options.writeEnvValues ?? ((nextValues: Record<string, string>) => {
      writeHermesEnvValues(nextValues, { env, hermesHome: options.hermesHome });
    });
    writeEnvValues(values);
    const verifiedEnv = options.readBackEnv
      ? options.readBackEnv()
      : options.writeEnvValues
        ? { ...fileEnv, ...values }
        : readHermesHomeEnv({ env, hermesHome: options.hermesHome });
    const verified = resolveHermesApiSettings({ env, fileEnv: verifiedEnv, hermesHome: options.hermesHome });
    if (!isTruthy(verifiedEnv.API_SERVER_ENABLED) || !verified.executionReady) {
      throw new Error("Hermes API environment verification failed");
    }
    run(["gateway", "restart"]);
  } catch {
    throw new Error(
      "Failed to enable and verify the Hermes API Server in its .env file. "
      + "Check the Hermes home permissions, or explicitly set CLAWCONNECT_HERMES_RUNTIME_MODE=local.",
    );
  }

  return "configured";
}

export function writeHermesEnvValues(
  values: Record<string, string>,
  options: Pick<HermesApiBootstrapOptions, "env" | "hermesHome"> = {},
): void {
  const env = options.env ?? process.env;
  const hermesHome = options.hermesHome ?? resolveHermesHomeDir({ env });
  const envPath = join(hermesHome, ".env");
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const requested = new Map(Object.entries(values));
  const pending = new Map(requested);
  const written = new Set<string>();
  const lines = current.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const key = match?.[1];
    if (!key || !requested.has(key)) return line;
    if (written.has(key)) return "";
    const value = requested.get(key) ?? "";
    written.add(key);
    pending.delete(key);
    return `${key}=${formatEnvValue(value)}`;
  });
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const [key, value] of pending) {
    lines.push(`${key}=${formatEnvValue(value)}`);
  }
  const output = `${lines.join("\n")}\n`;
  const tempPath = join(dirname(envPath), `.env.clawconnect-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  mkdirSync(hermesHome, { recursive: true });
  setRestrictiveDirPermissions(hermesHome);
  writeFileSync(tempPath, output, "utf8");
  setRestrictiveFilePermissions(tempPath);
  renameSync(tempPath, envPath);
  setRestrictiveFilePermissions(envPath);

  const verified = parseEnvFile(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(values)) {
    if (verified[key] !== value) {
      throw new Error(`Failed to verify Hermes environment key ${key}`);
    }
  }
}

function formatEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:@+-]*$/.test(value) ? value : JSON.stringify(value);
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes" || value?.toLowerCase() === "on";
}
