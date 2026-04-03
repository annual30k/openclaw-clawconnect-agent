import { WebSocket } from "ws";
import { OpenClawGatewayClient } from "./gateway-client.js";
import { handleLocalCommand } from "../commands/local-handlers.js";
import { handleProviderCommand } from "../commands/provider-handlers.js";
import { DEFAULT_GATEWAY_SESSION_DEFAULTS, buildContextUsageFingerprint, readContextUsageSnapshot, canonicalizeRelayParams, canonicalizeSessionKey, extractGatewaySessionDefaults, } from "./session-context.js";
import { appendUniqueSuffix, extractChatRole, extractChatText, normalizeChatEventPayload, normalizeChatState, withMessageText, } from "./chat-payload.js";
import { extractHistoryOutcome, withTimeout } from "./chat-history.js";
import { prepareChatSendParams } from "./chat-send-attachments.js";
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
        let sessionDefaults = { ...DEFAULT_GATEWAY_SESSION_DEFAULTS };
        const chatBuffers = new Map();
        const chatFallbacks = new Map();
        const chatRunContexts = new Map();
        const contextUsageRefreshes = new Map();
        const contextUsageFingerprints = new Map();
        const clearChatFallback = (runId) => {
            const timer = chatFallbacks.get(runId);
            if (timer) {
                clearTimeout(timer);
                chatFallbacks.delete(runId);
            }
        };
        const publishContextUsageSnapshot = async (sessionKey, force = false) => {
            const normalizedSessionKey = canonicalizeSessionKey(sessionKey, sessionDefaults);
            if (typeof normalizedSessionKey !== "string" || normalizedSessionKey.trim().length === 0) {
                return;
            }
            const snapshot = await readContextUsageSnapshot(normalizedSessionKey.trim(), sessionDefaults);
            if (!snapshot) {
                return;
            }
            const fingerprint = buildContextUsageFingerprint(snapshot);
            if (!force && contextUsageFingerprints.get(snapshot.sessionKey) === fingerprint) {
                return;
            }
            contextUsageFingerprints.set(snapshot.sessionKey, fingerprint);
            send({
                type: "event",
                event: "context_usage",
                payload: {
                    sessionKey: snapshot.sessionKey,
                    currentModel: snapshot.currentModel,
                    contextUsage: snapshot.promptTokens ?? snapshot.contextUsage,
                    contextLimit: snapshot.contextLimit,
                    promptTokens: snapshot.promptTokens,
                    maxInputTokens: snapshot.contextLimit,
                },
            });
        };
        const scheduleContextUsageRefresh = (sessionKey, delayMs = 250, force = false) => {
            if (!sessionKey) {
                return;
            }
            const normalizedSessionKey = canonicalizeSessionKey(sessionKey, sessionDefaults);
            if (typeof normalizedSessionKey !== "string" || normalizedSessionKey.trim().length === 0) {
                return;
            }
            const key = normalizedSessionKey.trim();
            const existing = contextUsageRefreshes.get(key);
            if (existing) {
                clearTimeout(existing);
            }
            const timer = setTimeout(() => {
                contextUsageRefreshes.delete(key);
                void publishContextUsageSnapshot(key, force).catch((error) => {
                    console.warn(`[relay] failed to publish context usage for session ${key}: ${String(error)}`);
                });
            }, delayMs);
            timer.unref?.();
            contextUsageRefreshes.set(key, timer);
        };
        const scheduleChatHistoryFallback = (runId, context, attempt = 0) => {
            if (!runId || !context.sessionKey) {
                return;
            }
            clearChatFallback(runId);
            chatRunContexts.set(runId, context);
            const timer = setTimeout(() => {
                if (!gatewayClient) {
                    chatFallbacks.delete(runId);
                    return;
                }
                const fetchHistory = () => gatewayClient.request("chat.history", { sessionKey: context.sessionKey, limit: 10 });
                withTimeout(fetchHistory(), 800, "chat.history fallback")
                    .then(async (history) => {
                    const outcome = extractHistoryOutcome(history, context);
                    if (!outcome && attempt < 4) {
                        scheduleChatHistoryFallback(runId, context, attempt + 1);
                        return;
                    }
                    if (!outcome) {
                        chatFallbacks.delete(runId);
                        chatRunContexts.delete(runId);
                        return;
                    }
                    clearChatFallback(runId);
                    chatRunContexts.delete(runId);
                    if (outcome.kind === "final") {
                        console.log(`[relay] synthesized chat final from history: runId=${runId} sessionKey=${context.sessionKey} textLength=${outcome.text.length} attempt=${attempt}`);
                        send({
                            type: "event",
                            event: "chat",
                            payload: {
                                runId,
                                sessionKey: context.sessionKey,
                                state: "final",
                                role: "assistant",
                                message: {
                                    role: "assistant",
                                    content: [{ type: "text", text: outcome.text }],
                                },
                            },
                        });
                        return;
                    }
                    console.log(`[relay] synthesized chat error from history: runId=${runId} sessionKey=${context.sessionKey} attempt=${attempt}`);
                    send({
                        type: "event",
                        event: "chat",
                        payload: {
                            runId,
                            sessionKey: context.sessionKey,
                            state: "error",
                            role: "assistant",
                            errorMessage: outcome.errorMessage,
                        },
                    });
                })
                    .catch((err) => {
                    if (attempt < 4) {
                        scheduleChatHistoryFallback(runId, context, attempt + 1);
                        return;
                    }
                    console.warn(`[relay] chat history fallback failed runId=${runId}: ${String(err)}`);
                    chatFallbacks.delete(runId);
                    chatRunContexts.delete(runId);
                });
            }, attempt === 0 ? 1500 : 2000);
            timer.unref?.();
            chatFallbacks.set(runId, timer);
        };
        const refreshSessionDefaults = async () => {
            if (!gatewayClient) {
                return;
            }
            try {
                const payload = await gatewayClient.request("config.get", {});
                const nextDefaults = extractGatewaySessionDefaults(payload);
                if (nextDefaults) {
                    sessionDefaults = nextDefaults;
                    console.log(`[relay] session defaults updated mainSessionKey=${sessionDefaults.mainSessionKey} mainKey=${sessionDefaults.mainKey}`);
                }
                scheduleContextUsageRefresh(sessionDefaults.mainSessionKey, 50, true);
            }
            catch (err) {
                console.warn(`[relay] failed to load session defaults: ${String(err)}`);
            }
        };
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
                capabilities: ["chat", "skills", "schedules", "logs", "files"],
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
                    void refreshSessionDefaults();
                },
                onDisconnected: (reason) => {
                    console.log(`Gateway disconnected: ${reason}`);
                    send({ type: "gateway_disconnected", reason });
                },
                onEvent: (event, payload) => {
                    const normalizedPayload = event === "chat" ? normalizeChatEventPayload(payload) : payload;
                    if (event === "chat") {
                        const p = normalizedPayload;
                        const state = normalizeChatState(normalizedPayload);
                        const runId = typeof p?.runId === "string" ? p.runId : "";
                        const currentText = extractChatText(normalizedPayload);
                        const role = extractChatRole(normalizedPayload);
                        if (runId) {
                            if (role === "assistant" && (state === "delta" || state === "final" || state === "error" || state === "failed" || state === "fail")) {
                                clearChatFallback(runId);
                            }
                            if (state === "delta" || state === "streaming" || state === "in_progress") {
                                const previousText = chatBuffers.get(runId) ?? "";
                                chatBuffers.set(runId, appendUniqueSuffix(previousText, currentText));
                            }
                            else if (state === "error" || state === "failed" || state === "fail" || state === "aborted") {
                                chatBuffers.delete(runId);
                            }
                        }
                        if (state === "final" && p?.sessionKey) {
                            scheduleContextUsageRefresh(p.sessionKey, 450);
                            const bufferedText = runId ? chatBuffers.get(runId) ?? "" : "";
                            const resolvedText = currentText || bufferedText;
                            const runContext = runId ? chatRunContexts.get(runId) : undefined;
                            if (runId) {
                                chatBuffers.delete(runId);
                            }
                            if (resolvedText.trim()) {
                                if (runId) {
                                    chatRunContexts.delete(runId);
                                }
                                send({ type: "event", event, payload: withMessageText(normalizedPayload, resolvedText) });
                                return;
                            }
                            const sessionKey = p.sessionKey;
                            const fetchHistory = () => gatewayClient.request("chat.history", { sessionKey, limit: 10 });
                            withTimeout(fetchHistory(), 500, "chat.history")
                                .then(async (history) => {
                                let outcome = runContext ? extractHistoryOutcome(history, runContext) : null;
                                // Retry once after a short delay if OpenClaw hasn't committed the message yet.
                                if (!outcome) {
                                    await new Promise((resolve) => setTimeout(resolve, 150));
                                    const retryHistory = await withTimeout(fetchHistory(), 500, "chat.history retry");
                                    outcome = runContext ? extractHistoryOutcome(retryHistory, runContext) : null;
                                }
                                console.log(`[relay] chat final enriched from history: runId=${runId || "(unknown)"} outcome=${outcome?.kind ?? "none"} textLength=${outcome?.kind === "final" ? outcome.text.length : 0}`);
                                if (runId) {
                                    chatRunContexts.delete(runId);
                                }
                                if (outcome?.kind === "final") {
                                    send({ type: "event", event, payload: withMessageText(normalizedPayload, outcome.text) });
                                    return;
                                }
                                if (outcome?.kind === "error") {
                                    send({
                                        type: "event",
                                        event,
                                        payload: {
                                            ...normalizedPayload,
                                            state: "error",
                                            errorMessage: outcome.errorMessage,
                                        },
                                    });
                                    return;
                                }
                                send({ type: "event", event, payload: normalizedPayload });
                            })
                                .catch((err) => {
                                console.error(`[relay] chat.history fetch failed: ${err}`);
                                if (runId) {
                                    chatRunContexts.delete(runId);
                                }
                                send({ type: "event", event, payload: normalizedPayload });
                            });
                            return;
                        }
                        if (runId && (state === "error" || state === "failed" || state === "fail" || state === "aborted")) {
                            chatRunContexts.delete(runId);
                            scheduleContextUsageRefresh(p?.sessionKey, 450);
                        }
                    }
                    send({ type: "event", event, payload: normalizedPayload });
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
            const localResult = handleLocalCommand(msg.method, msg.params);
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
            if (msg.method === "chat.send") {
                msg.params = await prepareChatSendParams(msg.params);
            }
            const params = canonicalizeRelayParams(msg.method, msg.params, sessionDefaults);
            gatewayClient
                ?.request(msg.method, params)
                .then((result) => {
                console.log(`[relay] cmd ok method=${msg.method} id=${requestId ?? "(no-id)"}`);
                if ((msg.method === "chat.send" || msg.method === "agent") && params && typeof params === "object" && !Array.isArray(params)) {
                    const paramsRecord = params;
                    const sessionKey = typeof paramsRecord.sessionKey === "string" && paramsRecord.sessionKey.trim().length > 0
                        ? paramsRecord.sessionKey.trim()
                        : sessionDefaults.mainSessionKey;
                    const resultRecord = result && typeof result === "object" && !Array.isArray(result)
                        ? result
                        : undefined;
                    const runId = typeof resultRecord?.runId === "string" && resultRecord.runId.trim().length > 0
                        ? resultRecord.runId.trim()
                        : requestId;
                    if (runId) {
                        const promptText = typeof paramsRecord.message === "string" && paramsRecord.message.trim().length > 0
                            ? paramsRecord.message.trim()
                            : undefined;
                        const runContext = {
                            sessionKey,
                            requestedAtMs: Date.now(),
                            promptText,
                        };
                        scheduleChatHistoryFallback(runId, runContext);
                    }
                    scheduleContextUsageRefresh(sessionKey, 1200, msg.method === "chat.send" && /^\/model\s+/i.test(String(paramsRecord.message ?? "")));
                }
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
            for (const timer of chatFallbacks.values()) {
                clearTimeout(timer);
            }
            chatFallbacks.clear();
            for (const timer of contextUsageRefreshes.values()) {
                clearTimeout(timer);
            }
            contextUsageRefreshes.clear();
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