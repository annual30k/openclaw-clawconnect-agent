import { type RelaySlashCommandDescriptor } from "./slash-command-catalog.js";
/** Messages the relay client sends to the relay server. */
export type RelayHelloMessage = {
    type: "hello";
    platform: string;
    agentVersion: string;
    capabilities?: string[];
    slashCommands?: readonly RelaySlashCommandDescriptor[];
};
export interface RelayManagerOptions {
    relayServerUrl: string;
    gatewayId: string;
    relaySecret: string;
    gatewayUrl: string;
    gatewayToken?: string;
    gatewayPassword?: string;
    defaultVoiceReplyEnabled?: boolean;
    onConnected?: () => void;
    onDisconnected?: () => void;
}
/**
 * Connects to the cloud relay server and the local OpenClaw Gateway,
 * then bridges messages between them indefinitely.
 *
 * The gateway client runs for as long as this relay connection is alive.
 * Returns a Promise that resolves `true` (retry) when the relay server
 * connection closes.
 */
export declare function runRelayManager(opts: RelayManagerOptions): Promise<boolean>;
export declare function buildRelayHelloMessage(opts: {
    platform: string;
    agentVersion: string;
    capabilities?: string[];
}): RelayHelloMessage;
