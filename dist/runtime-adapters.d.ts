import type { ClawConnectConfig } from "./config/config.js";
import type { GatewayType } from "./gateway-profiles.js";
export type GatewayRuntimeContext = {
    config: ClawConnectConfig;
    gatewayUrl: () => string;
    gatewayAuth: {
        token?: string;
        password?: string;
    };
    signal: AbortSignal;
    onConnected: () => void;
    onDisconnected: () => void;
};
export type GatewayRuntimeAdapter = {
    type: GatewayType;
    logsGatewayUrl: boolean;
    start: (context: GatewayRuntimeContext) => Promise<boolean>;
};
export declare function getGatewayRuntimeAdapter(gatewayType: GatewayType): GatewayRuntimeAdapter;
