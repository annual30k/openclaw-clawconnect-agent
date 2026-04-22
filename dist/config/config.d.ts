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
export declare function configExists(): boolean;
export declare function readConfig(): ClawConnectConfig;
export declare function writeConfig(config: ClawConnectConfig): void;
export declare function readVoiceReplyConfig(cfg: ClawConnectConfig): VoiceReplyConfig;
export declare function updateVoiceReplyConfig(config: ClawConnectConfig, voiceReplyConfig: VoiceReplyConfig): ClawConnectConfig;
export declare function readGatewayUrl(): string;
/**
 * Reads the gateway token or password. Priority order:
 * 1. ~/.clawconnect/config.json (gatewayToken / gatewayPassword)
 * 2. ~/.openclaw/openclaw.json (gateway.token / gateway.auth.token)
 * 3. Environment variables (OPENCLAW_GATEWAY_TOKEN / OPENCLAW_GATEWAY_PASSWORD)
 */
export declare function readGatewayAuth(cfg: ClawConnectConfig): {
    token?: string;
    password?: string;
};
