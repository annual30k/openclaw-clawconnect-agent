import { WebSocket } from "ws";
import { OpenClawGatewayClient } from "./gateway-client.js";
import { handleLocalCommand } from "../commands/local-handlers.js";
import { handleProviderCommand } from "../commands/provider-handlers.js";
import { homedir } from "os";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { randomUUID } from "crypto";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const OUTBOUND_DIR = join(homedir(), ".openclaw", "media", "outbound");
// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
/**
 * Connects to the cloud relay server and the local OpenClaw Gateway,
 * then bridges messages between them indefinitely.
 *
 * The gateway client runs for as long as this relay connection is alive.
 * Returns a Promise that resolves `true` (retry) when the relay server
 * connection closes.
 */
export async function runRelayManager(opts) {
    const wsUrl = buildRelayUrl(opts.relayServerUrl, opts.gatewayId, opts.relaySecret);
    return new Promise((resolve) => {
        let relayWs;
        try {
            relayWs = new WebSocket(wsUrl);
        }
        catch (err) {
            console.error("Failed to create relay WebSocket:", err);
            resolve(true);
            return;
        }
        let gatewayClient = null;
        function send(msg) {
            if (relayWs.readyState === WebSocket.OPEN) {
                relayWs.send(JSON.stringify(msg));
            }
        }
        relayWs.on("open", () => {
            console.log(`Connected to relay server (gatewayId=${opts.gatewayId})`);
            opts.onConnected?.();
            send({
                type: "hello",
                platform: process.platform,
                agentVersion: "1.0.0",
            });
            // Start the persistent gateway connection as soon as we're connected
            // to the relay server. Its lifetime is tied to this relay session.
            gatewayClient = new OpenClawGatewayClient({
                url: opts.gatewayUrl,
                token: opts.gatewayToken,
                password: opts.gatewayPassword,
                onConnected: () => {
                    console.log("Gateway connected.");
                    send({ type: "gateway_connected" });
                },
                onDisconnected: (reason) => {
                    console.log(`Gateway disconnected: ${reason}`);
                    send({ type: "gateway_disconnected", reason });
                },
                onEvent: (event, payload) => {
                    // On chat final, fetch history to get actual content (OpenClaw 2026.3.2+
                    // no longer includes message content in the chat final event payload).
                    // This mirrors what the macOS 2026.3.2 client does.
                    if (event === "chat") {
                        const p = payload;
                        if (p?.state === "final" && p?.sessionKey) {
                            const sessionKey = p.sessionKey;
                            const runId = p.runId;
                            const fetchHistory = () => gatewayClient.request("chat.history", { sessionKey, limit: 10 });
                            const extractText = (h) => {
                                const msgs = h?.messages ?? [];
                                const last = [...msgs].reverse().find((m) => m.role === "assistant");
                                return last?.content?.find((b) => b.type === "text")?.text;
                            };
                            fetchHistory()
                                .then(async (history) => {
                                let text = extractText(history);
                                // Retry once after 600ms if OpenClaw hasn't committed the message yet
                                if (!text) {
                                    await new Promise((resolve) => setTimeout(resolve, 600));
                                    const retryHistory = await fetchHistory();
                                    text = extractText(retryHistory);
                                }
                                if (text) {
                                    p.message = { content: [{ type: "text", text }] };
                                }
                                console.log(`[relay] chat final (history fetched): runId=${runId} textLength=${text?.length ?? 0}`);
                                send({ type: "event", event, payload });
                            })
                                .catch((err) => {
                                console.error(`[relay] chat.history fetch failed: ${err}`);
                                send({ type: "event", event, payload });
                            });
                            return; // will send after history fetch
                        }
                    }
                    send({ type: "event", event, payload });
                },
            });
            gatewayClient.start();
        });
        relayWs.on("message", async (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            }
            catch {
                return;
            }
            if (msg.type === "heartbeat") {
                send({ type: "heartbeat" });
                return;
            }
            if (msg.type === "hello") {
                return;
            }
            if (msg.type !== "cmd" || !msg.method)
                return;
            const requestId = msg.id;
            console.log(`[relay] cmd received method=${msg.method} id=${requestId ?? "(no-id)"}`);
            // Handle clawpilot.provider.* commands locally (async)
            const providerPromise = handleProviderCommand(msg.method, msg.params);
            if (providerPromise !== null) {
                const result = await providerPromise;
                if (requestId) {
                    send({
                        type: "res",
                        id: requestId,
                        ok: result.ok,
                        ...(result.ok
                            ? { payload: result.payload }
                            : { error: { message: result.error } }),
                    });
                }
                return;
            }
            // Handle clawpilot.* commands locally without forwarding to the gateway
            const localResult = handleLocalCommand(msg.method);
            if (localResult !== null) {
                if (requestId) {
                    if (localResult.ok) {
                        send({ type: "res", id: requestId, ok: true, payload: localResult.payload });
                    }
                    else {
                        send({ type: "res", id: requestId, ok: false, error: { message: localResult.error } });
                    }
                }
                return;
            }
            // Handle chat.send with attachments - save to disk and add path reference
            if (msg.method === "chat.send") {
                const params = msg.params;
                // Always set deliver:false so OpenClaw responds via WebSocket (not external channel)
                params.deliver = false;
                if (params.attachments && params.attachments.length > 0) {
                    const fileReferences = [];
                    // Ensure outbound directory exists
                    await mkdir(OUTBOUND_DIR, { recursive: true });
                    // Save each attachment to disk and create path reference
                    for (const att of params.attachments) {
                        try {
                            // Decode base64 to buffer
                            const buffer = Buffer.from(att.content, "base64");
                            const ext = att.mimeType === "image/png" ? ".png" : ".jpg";
                            const stagedFileName = `${randomUUID()}${ext}`;
                            const stagedPath = join(OUTBOUND_DIR, stagedFileName);
                            // Write to disk
                            await writeFile(stagedPath, buffer);
                            console.log(`[relay] Saved attachment to: ${stagedPath}`);
                            // Create path reference (same format as ClawX)
                            fileReferences.push(`[media attached: ${stagedPath} (${att.mimeType}) | ${stagedPath}]`);
                        }
                        catch (err) {
                            console.error(`[relay] Failed to save attachment: ${err}`);
                        }
                    }
                    // Append file references to message
                    if (fileReferences.length > 0) {
                        const refs = fileReferences.join("\n");
                        params.message = params.message ? `${params.message}\n\n${refs}` : refs;
                        console.log(`[relay] Added file references to message`);
                    }
                }
            }
            gatewayClient
                ?.request(msg.method, msg.params)
                .then((result) => {
                console.log(`[relay] cmd ok method=${msg.method} id=${requestId ?? "(no-id)"}`);
                if (requestId) {
                    send({ type: "res", id: requestId, ok: true, payload: result });
                }
            })
                .catch((err) => {
                console.error(`[relay] cmd failed method=${msg.method} id=${requestId ?? "(no-id)"}: ${String(err)}`);
                if (requestId) {
                    send({ type: "res", id: requestId, ok: false, error: { message: String(err) } });
                }
            });
        });
        relayWs.on("close", (code, reason) => {
            console.log(`Relay connection closed: ${code} ${reason.toString()}`);
            opts.onDisconnected?.();
            gatewayClient?.stop();
            gatewayClient = null;
            // Code 4000 = server kicked us because another relay client took over.
            // Stop retrying so the two instances don't bounce each other forever.
            resolve(code !== 4000);
        });
        relayWs.on("error", (err) => {
            console.error("Relay WebSocket error:", err.message);
            // close event will follow
        });
    });
}
function buildRelayUrl(serverUrl, gatewayId, relaySecret) {
    const base = serverUrl.replace(/\/+$/, "").replace(/^http/, "ws");
    return `${base}/relay/${gatewayId}?secret=${encodeURIComponent(relaySecret)}`;
}
//# sourceMappingURL=relay-manager.js.map