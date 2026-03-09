export interface ClawaiConfig {
    relayServerUrl: string;
    gatewayId: string;
    relaySecret: string;
    displayName: string;
    /** Shared token for the local OpenClaw Gateway (gateway.auth.token in openclaw config). */
    gatewayToken?: string;
    /** Password for the local OpenClaw Gateway (used when auth mode is "password"). */
    gatewayPassword?: string;
}
export declare function configExists(): boolean;
export declare function readConfig(): ClawaiConfig;
export declare function writeConfig(config: ClawaiConfig): void;
export declare function readGatewayUrl(): string;
/**
 * Reads the gateway token or password. Priority order:
 * 1. ~/.clawconnect/config.json (gatewayToken / gatewayPassword)
 * 2. ~/.openclaw/openclaw.json (gateway.token / gateway.auth.token)
 * 3. Environment variables (OPENCLAW_GATEWAY_TOKEN / OPENCLAW_GATEWAY_PASSWORD)
 */
export declare function readGatewayAuth(cfg: ClawaiConfig): {
    token?: string;
    password?: string;
};
