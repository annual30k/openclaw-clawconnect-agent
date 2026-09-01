import { createRequire } from "node:module";
import { gatewayCapabilitiesForType } from "./gateway-profiles.js";
import type { HermesRuntimeExecutionMode } from "./hermes/runtime/hermes-runtime-api-settings.js";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as { version?: unknown };

export const CLAWCONNECT_AGENT_VERSION = typeof packageMetadata.version === "string"
  ? packageMetadata.version
  : "unknown";

export const CHAT_TIMELINE_DELTA_CAPABILITY = "chat_timeline_delta_v1";
export const CHAT_TOOL_LIFECYCLE_CAPABILITY = "chat_tool_lifecycle_v1";

export type HostRuntimeMetadata = {
  platform: string;
  agentVersion: string;
  capabilities: string[];
};

export function buildOpenClawHostRuntimeMetadata(
  platform = process.platform,
): HostRuntimeMetadata {
  return {
    platform,
    agentVersion: CLAWCONNECT_AGENT_VERSION,
    capabilities: mergeCapabilities(
      gatewayCapabilitiesForType("openclaw"),
      [CHAT_TIMELINE_DELTA_CAPABILITY, CHAT_TOOL_LIFECYCLE_CAPABILITY],
    ),
  };
}

export function buildHermesHostRuntimeMetadata(
  mode: HermesRuntimeExecutionMode,
  configuredCapabilities?: readonly string[],
  platform = process.platform,
): HostRuntimeMetadata {
  const liveEventCapabilities = mode === "api"
    ? [CHAT_TIMELINE_DELTA_CAPABILITY, CHAT_TOOL_LIFECYCLE_CAPABILITY]
    : [CHAT_TOOL_LIFECYCLE_CAPABILITY];
  return {
    platform: `${platform} (Hermes ${mode === "api" ? "API" : "CLI"})`,
    agentVersion: CLAWCONNECT_AGENT_VERSION,
    capabilities: mergeCapabilities(
      configuredCapabilities ?? [...gatewayCapabilitiesForType("hermes"), "models"],
      liveEventCapabilities,
    ),
  };
}

function mergeCapabilities(...groups: ReadonlyArray<readonly string[]>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const capability of group) {
      const normalized = capability.trim();
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}
