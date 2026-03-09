import { WebSocket } from "ws";
/**
 * Proxies WebSocket frames between the relay server (via relayWs) and the
 * local OpenClaw Gateway (via a new direct WebSocket connection).
 *
 * All frames are forwarded as raw bytes — no parsing of OpenClaw protocol.
 */
export declare class SessionProxy {
    private readonly sessionId;
    private readonly relayWs;
    private readonly gatewayUrl;
    private gwWs;
    private closed;
    constructor(sessionId: string, relayWs: WebSocket, gatewayUrl: string);
    start(): Promise<void>;
    forwardToGateway(base64Data: string): void;
    close(): void;
}
