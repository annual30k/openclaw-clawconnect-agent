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
    /** Relay 握手（hello 校验 + 可靠投递挂载）完成后触发；用于重置重连退避。 */
    onRelayReady: () => void;
    onDisconnected: (closeCode: number) => void;
};
export type GatewayRuntimeAdapter = {
    type: GatewayType;
    logsGatewayUrl: boolean;
    start: (context: GatewayRuntimeContext) => Promise<boolean>;
};
export declare function getGatewayRuntimeAdapter(gatewayType: GatewayType): GatewayRuntimeAdapter;
