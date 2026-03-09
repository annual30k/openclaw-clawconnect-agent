import { WebSocket } from "ws";
/**
 * Proxies WebSocket frames between the relay server (via relayWs) and the
 * local OpenClaw Gateway (via a new direct WebSocket connection).
 *
 * All frames are forwarded as raw bytes — no parsing of OpenClaw protocol.
 */
export class SessionProxy {
    sessionId;
    relayWs;
    gatewayUrl;
    gwWs = null;
    closed = false;
    constructor(sessionId, relayWs, gatewayUrl) {
        this.sessionId = sessionId;
        this.relayWs = relayWs;
        this.gatewayUrl = gatewayUrl;
    }
    async start() {
        return new Promise((resolve, reject) => {
            const gw = new WebSocket(this.gatewayUrl);
            this.gwWs = gw;
            const timeout = setTimeout(() => {
                gw.terminate();
                reject(new Error(`Timeout connecting to gateway at ${this.gatewayUrl}`));
            }, 10_000);
            gw.on("open", () => {
                clearTimeout(timeout);
                resolve();
            });
            gw.on("error", (err) => {
                clearTimeout(timeout);
                if (!this.closed)
                    reject(err);
            });
            // Gateway → relay server
            gw.on("message", (raw) => {
                if (this.relayWs.readyState !== WebSocket.OPEN)
                    return;
                const data = raw instanceof Buffer ? raw : Buffer.from(raw);
                const msg = {
                    ctrl: "DATA",
                    sessionId: this.sessionId,
                    data: data.toString("base64"),
                };
                this.relayWs.send(JSON.stringify(msg));
            });
            gw.on("close", () => {
                if (!this.closed) {
                    this.closed = true;
                    // Notify relay server that session is done
                    if (this.relayWs.readyState === WebSocket.OPEN) {
                        const msg = {
                            ctrl: "SESSION_CLOSE",
                            sessionId: this.sessionId,
                        };
                        this.relayWs.send(JSON.stringify(msg));
                    }
                }
            });
        });
    }
    // Called when DATA arrives from the relay server for this session
    forwardToGateway(base64Data) {
        if (!this.gwWs || this.gwWs.readyState !== WebSocket.OPEN)
            return;
        const buf = Buffer.from(base64Data, "base64");
        this.gwWs.send(buf);
    }
    close() {
        this.closed = true;
        this.gwWs?.close();
    }
}
//# sourceMappingURL=session-proxy.js.map