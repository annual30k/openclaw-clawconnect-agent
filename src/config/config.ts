import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { DEFAULT_GATEWAY_URL, getConfiguredGatewayUrl } from "./env.js";
import {
  setRestrictiveDirPermissions,
  setRestrictiveFilePermissions,
} from "../platform/service-manager-common.js";
import { CLAWCONNECT_HOME, profileConfigPath, profileRoot } from "./profile.js";

const OPENCLAW_CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");

export interface ClawConnectConfig {
  relayServerUrl: string;
  gatewayId: string;
  relaySecret: string;
  displayName: string;
  gatewayType?: "openclaw" | "hermes";
  capabilities?: string[];
  /** Shared token for the local OpenClaw Gateway (gateway.auth.token in openclaw config). */
  gatewayToken?: string;
  /** Password for the local OpenClaw Gateway (used when auth mode is "password"). */
  gatewayPassword?: string;
}

export function getConfigPath(profile?: string): string {
  return profileConfigPath(profile);
}

export function configExists(profile?: string): boolean {
  return existsSync(profileConfigPath(profile));
}

export function readConfig(profile?: string): ClawConnectConfig {
  const configPath = profileConfigPath(profile);
  if (!existsSync(configPath)) {
    throw new Error(`Config not found at ${configPath}. Run 'clawconnect pair' first.`);
  }
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as ClawConnectConfig;
}

export function writeConfig(config: ClawConnectConfig, profile?: string): void {
  const root = profileRoot(profile);
  const configPath = profileConfigPath(profile);
  mkdirSync(root, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  setRestrictiveDirPermissions(CLAWCONNECT_HOME);
  setRestrictiveDirPermissions(root);
  setRestrictiveFilePermissions(configPath);
}

export function readGatewayUrl(): string {
  const configuredGatewayUrl = getConfiguredGatewayUrl();
  if (configuredGatewayUrl) {
    return configuredGatewayUrl;
  }

  try {
    const raw = readFileSync(OPENCLAW_CONFIG_PATH, "utf-8");
    const json = JSON.parse(raw) as { gateway?: { port?: number } };
    const port = json?.gateway?.port ?? 18789;
    return `ws://localhost:${port}`;
  } catch {
    return DEFAULT_GATEWAY_URL;
  }
}

/**
 * Reads the gateway token or password. Priority order:
 * 1. ~/.clawconnect/config.json (gatewayToken / gatewayPassword)
 * 2. ~/.openclaw/openclaw.json (gateway.token / gateway.auth.token)
 * 3. Environment variables (OPENCLAW_GATEWAY_TOKEN / OPENCLAW_GATEWAY_PASSWORD)
 */
export function readGatewayAuth(cfg: ClawConnectConfig): { token?: string; password?: string } {
  if (cfg.gatewayToken || cfg.gatewayPassword) {
    return { token: cfg.gatewayToken, password: cfg.gatewayPassword };
  }
  // Try to read the token from OpenClaw's own config
  try {
    const raw = readFileSync(OPENCLAW_CONFIG_PATH, "utf-8");
    const json = JSON.parse(raw) as { gateway?: { token?: string; password?: string; auth?: { token?: string; password?: string } } };
    const token = json?.gateway?.token ?? json?.gateway?.auth?.token ?? undefined;
    const password = json?.gateway?.password ?? json?.gateway?.auth?.password ?? undefined;
    if (token || password) return { token, password };
  } catch {
    // ignore
  }
  // Fall back to environment variables (e.g. set via LaunchAgent)
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const envPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
  if (envToken || envPassword) {
    return { token: envToken, password: envPassword };
  }
  return {};
}
