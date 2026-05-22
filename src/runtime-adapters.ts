import type { ClawConnectConfig, VoiceReplyConfig } from "./config/config.js";
import { runHermesRelayManager } from "./hermes/hermes-relay-manager.js";
import { runRelayManager } from "./relay/relay-manager.js";
import type { GatewayType } from "./gateway-profiles.js";

export type GatewayRuntimeContext = {
  config: ClawConnectConfig;
  gatewayUrl: () => string;
  gatewayAuth: { token?: string; password?: string };
  defaultVoiceReplyEnabled: boolean;
  defaultVoiceReplyConfig: VoiceReplyConfig;
  signal: AbortSignal;
  onConnected: () => void;
  onDisconnected: () => void;
};

export type GatewayRuntimeAdapter = {
  type: GatewayType;
  logsGatewayUrl: boolean;
  start: (context: GatewayRuntimeContext) => Promise<boolean>;
};

const OPENCLAW_RUNTIME_ADAPTER: GatewayRuntimeAdapter = {
  type: "openclaw",
  logsGatewayUrl: true,
  start: (context) => runRelayManager({
    relayServerUrl: context.config.relayServerUrl,
    gatewayId: context.config.gatewayId,
    relaySecret: context.config.relaySecret,
    gatewayUrl: context.gatewayUrl,
    gatewayToken: context.gatewayAuth.token,
    gatewayPassword: context.gatewayAuth.password,
    defaultVoiceReplyEnabled: context.defaultVoiceReplyEnabled,
    defaultVoiceReplyConfig: context.defaultVoiceReplyConfig,
    signal: context.signal,
    onConnected: context.onConnected,
    onDisconnected: context.onDisconnected,
  }),
};

const HERMES_RUNTIME_ADAPTER: GatewayRuntimeAdapter = {
  type: "hermes",
  logsGatewayUrl: false,
  start: (context) => runHermesRelayManager({
    relayServerUrl: context.config.relayServerUrl,
    gatewayId: context.config.gatewayId,
    relaySecret: context.config.relaySecret,
    displayName: context.config.displayName,
    capabilities: context.config.capabilities,
    signal: context.signal,
    onConnected: context.onConnected,
    onDisconnected: context.onDisconnected,
  }),
};

const RUNTIME_ADAPTERS: Record<GatewayType, GatewayRuntimeAdapter> = {
  openclaw: OPENCLAW_RUNTIME_ADAPTER,
  hermes: HERMES_RUNTIME_ADAPTER,
};

export function getGatewayRuntimeAdapter(gatewayType: GatewayType): GatewayRuntimeAdapter {
  return RUNTIME_ADAPTERS[gatewayType];
}
