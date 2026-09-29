import type { ClawConnectConfig } from "./config/config.js";
import { runHermesRelayManager } from "./hermes/hermes-relay-manager.js";
import { runRelayManager } from "./openclaw/relay-manager.js";
import type { GatewayType } from "./gateway-profiles.js";

export type GatewayRuntimeContext = {
  config: ClawConnectConfig;
  gatewayUrl: () => string;
  gatewayAuth: { token?: string; password?: string };
  signal: AbortSignal;
  onConnected: () => void;
  /** Relay 握手（hello 校验 + 可靠投递挂载）完成后触发；用于重置重连退避。 */
  onRelayReady: () => void;
  onDisconnected: (closeCode: number) => void;
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
    signal: context.signal,
    onConnected: context.onConnected,
    onRelayReady: context.onRelayReady,
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
    onRelayReady: context.onRelayReady,
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
