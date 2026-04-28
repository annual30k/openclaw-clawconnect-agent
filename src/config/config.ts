import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { DEFAULT_GATEWAY_URL, getConfiguredGatewayUrl } from "./env.js";
import {
  setRestrictiveDirPermissions,
  setRestrictiveFilePermissions,
} from "../platform/service-manager-common.js";

const CONFIG_DIR = join(homedir(), ".clawconnect");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const OPENCLAW_CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");

export interface ClawConnectConfig {
  relayServerUrl: string;
  gatewayId: string;
  relaySecret: string;
  displayName: string;
  assistantVoiceReplyVoiceIdentifier?: string;
  assistantVoiceReplyRatePercent?: number;
  /** Shared token for the local OpenClaw Gateway (gateway.auth.token in openclaw config). */
  gatewayToken?: string;
  /** Password for the local OpenClaw Gateway (used when auth mode is "password"). */
  gatewayPassword?: string;
}

export interface VoiceReplyConfig {
  voiceIdentifier?: string;
  ratePercent?: number;
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function readConfig(): ClawConnectConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Config not found at ${CONFIG_PATH}. Run 'clawconnect pair' first.`);
  }
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as ClawConnectConfig;
}

export function writeConfig(config: ClawConnectConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  setRestrictiveDirPermissions(CONFIG_DIR);
  setRestrictiveFilePermissions(CONFIG_PATH);
}

export function readVoiceReplyConfig(cfg: ClawConnectConfig): VoiceReplyConfig {
  return {
    voiceIdentifier: normalizeVoiceIdentifier(cfg.assistantVoiceReplyVoiceIdentifier),
    ratePercent: clampRatePercent(cfg.assistantVoiceReplyRatePercent),
  };
}

export function updateVoiceReplyConfig(config: ClawConnectConfig, voiceReplyConfig: VoiceReplyConfig): ClawConnectConfig {
  const nextConfig: ClawConnectConfig = { ...config };
  const voiceIdentifier = normalizeVoiceIdentifier(voiceReplyConfig.voiceIdentifier);
  const ratePercent = clampRatePercent(voiceReplyConfig.ratePercent);

  if (voiceIdentifier === undefined) {
    delete nextConfig.assistantVoiceReplyVoiceIdentifier;
  } else {
    nextConfig.assistantVoiceReplyVoiceIdentifier = voiceIdentifier;
  }

  if (ratePercent === undefined) {
    delete nextConfig.assistantVoiceReplyRatePercent;
  } else {
    nextConfig.assistantVoiceReplyRatePercent = ratePercent;
  }

  writeConfig(nextConfig);
  return nextConfig;
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

function normalizeVoiceIdentifier(voiceIdentifier: string | undefined): string | undefined {
  const trimmed = voiceIdentifier?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function clampRatePercent(ratePercent: number | undefined): number | undefined {
  if (typeof ratePercent !== "number" || !Number.isFinite(ratePercent)) {
    return undefined;
  }
  return Math.min(50, Math.max(-50, Math.round(ratePercent)));
}
