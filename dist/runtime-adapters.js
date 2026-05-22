import { runHermesRelayManager } from "./hermes/hermes-relay-manager.js";
import { runRelayManager } from "./relay/relay-manager.js";
const OPENCLAW_RUNTIME_ADAPTER = {
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
        onDisconnected: context.onDisconnected,
    }),
};
const HERMES_RUNTIME_ADAPTER = {
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
const RUNTIME_ADAPTERS = {
    openclaw: OPENCLAW_RUNTIME_ADAPTER,
    hermes: HERMES_RUNTIME_ADAPTER,
};
export function getGatewayRuntimeAdapter(gatewayType) {
    return RUNTIME_ADAPTERS[gatewayType];
}
//# sourceMappingURL=runtime-adapters.js.map