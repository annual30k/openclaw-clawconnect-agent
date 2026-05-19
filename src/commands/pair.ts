import { configExists, readConfig, writeConfig } from "../config/config.js";
import { installCommand } from "./install.js";
import qrcodeTerminal from "qrcode-terminal";
import { t } from "../i18n/index.js";
import { execSync } from "child_process";
import { hostname } from "os";
import { getServicePlatform } from "../platform/service-manager.js";
import { toRelayHttpBase } from "./send-file-utils.js";
import { getDefaultRelayServerUrl } from "../config/env.js";

interface PairOptions {
  server?: string;
  name?: string;
  codeOnly?: boolean;
  gatewayType?: string;
  profile?: string;
}

export async function pairCommand(opts: PairOptions): Promise<void> {
  let gatewayId: string;
  let relaySecret: string;
  let accessCode: string;
  let displayName: string;
  let relayServerUrl: string;
  const gatewayType = normalizeGatewayType(opts.gatewayType);
  const capabilities = capabilitiesForGatewayType(gatewayType);

  const existingConfig = configExists() ? readConfig() : null;
  const existingGatewayType = existingConfig?.gatewayType ?? "openclaw";

  if (existingConfig && existingGatewayType === gatewayType) {
    const config = existingConfig;
    relayServerUrl = opts.server ?? config.relayServerUrl ?? getDefaultRelayServerUrl();
    gatewayId = config.gatewayId;
    relaySecret = config.relaySecret;
    displayName = opts.name ? sanitizeDisplayName(opts.name) : config.displayName;

    console.log(t("pair.alreadyRegistered", gatewayId));

    const httpBase = toRelayHttpBase(relayServerUrl);
    const res = await fetch(`${httpBase}/api/relay/accesscode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gatewayId, relaySecret }),
    });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 401) {
        throw new Error(t("pair.invalidCredentials"));
      }
      throw new Error(t("pair.refreshFailed", String(res.status), body));
    }

    const data = (await res.json()) as { accessCode: string };
    accessCode = data.accessCode;

    writeConfig({ ...config, relayServerUrl, displayName, gatewayType: config.gatewayType ?? gatewayType, capabilities: config.capabilities ?? capabilities });
  } else {
    if (existingConfig && existingGatewayType !== gatewayType) {
      console.log(`Existing ${existingGatewayType} gateway config found; registering a new ${gatewayType} gateway.`);
    }
    relayServerUrl = opts.server ?? existingConfig?.relayServerUrl ?? getDefaultRelayServerUrl();
    displayName = opts.name ? sanitizeDisplayName(opts.name) : getDisplayName();
    console.log(t("pair.registering"));

    const httpBase = toRelayHttpBase(relayServerUrl);
    const res = await fetch(`${httpBase}/api/relay/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName, gatewayType, capabilities }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(t("pair.registrationFailed", String(res.status), body));
    }

    const data = (await res.json()) as {
      gatewayId: string;
      relaySecret: string;
      accessCode: string;
    };

    gatewayId = data.gatewayId;
    relaySecret = data.relaySecret;
    accessCode = data.accessCode;

    writeConfig({ relayServerUrl, gatewayId, relaySecret, displayName, gatewayType, capabilities });

    console.log(t("pair.registered", gatewayId));
  }

  const httpBase = toRelayHttpBase(relayServerUrl);
  const qrPayload = JSON.stringify({
    type: "clawlink_pairing",
    version: 1,
    server: httpBase,
    gatewayId,
    accessCode,
    displayName,
    gatewayType,
    capabilities,
  });

  if (opts.codeOnly) {
    console.log(accessCode);
  } else {
    console.log(t("pair.scanQR"));
    qrcodeTerminal.generate(qrPayload, { small: true });
    console.log(t("pair.accessCode", accessCode));
  }

  console.log(t("pair.installingService"));
  installCommand();
}

function normalizeGatewayType(value: PairOptions["gatewayType"]): "openclaw" | "hermes" {
  return value === "hermes" ? value : "openclaw";
}

function capabilitiesForGatewayType(gatewayType: "openclaw" | "hermes"): string[] {
  switch (gatewayType) {
    case "hermes":
      return ["chat", "files", "logs", "restart", "sessions", "skills", "gateway_service"];
    case "openclaw":
    default:
      return ["chat", "skills", "schedules", "logs", "files"];
  }
}

function sanitizeDisplayName(name: string): string {
  // Replace smart quotes and other problematic characters with regular ones
  return name
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'") // Smart quotes -> regular quotes
    .replace(/[\u2013\u2014]/g, "-") // En/em dashes -> regular dash
    .replace(/[\u00A0]/g, " ") // Non-breaking space -> regular space
    .replace(/[\x00-\x1F\x7F]/g, ""); // Remove control characters only
}

function getDisplayName(): string {
  if (getServicePlatform() !== "macos") {
    return hostname();
  }
  try {
    const raw = execSync("scutil --get ComputerName", { encoding: "utf8" }).trim();
    return sanitizeDisplayName(raw);
  } catch {
    return hostname();
  }
}
