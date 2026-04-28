import { WebSocket } from "ws";
import { OpenClawGatewayClient } from "./gateway-client.js";
import { handleLocalCommand } from "../commands/local-handlers.js";
import { handleProviderCommand } from "../commands/provider-handlers.js";
import { readConfig, updateVoiceReplyConfig } from "../config/config.js";
import { DEFAULT_GATEWAY_SESSION_DEFAULTS, buildContextUsageFingerprint, readContextUsageSnapshot, canonicalizeRelayParams, canonicalizeSessionKey, extractGatewaySessionDefaults, } from "./session-context.js";
import { VoiceReplyPreferenceStore } from "./voice-reply-preference.js";
import { appendUniqueSuffix, extractChatRole, extractChatText, normalizeChatEventPayload, normalizeChatState, withMessageText, } from "./chat-payload.js";
import { extractHistoryOutcome, withTimeout } from "./chat-history.js";
import { buildOfficeEventPayload } from "./office-payload.js";
import { prepareChatSendParams } from "./chat-send-attachments.js";
import { sendVoiceReplyCommand } from "../commands/voice-reply.js";
import { OPENCLAW_SLASH_COMMAND_CATALOG, } from "./slash-command-catalog.js";
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
        // If a shutdown signal was provided, close the relay cleanly when fired.
        if (opts.signal) {
            if (opts.signal.aborted) {
                relayWs.close(1001, "shutdown");
            }
            else {
                opts.signal.addEventListener("abort", () => relayWs.close(1001, "shutdown"), { once: true });
            }
        }
        let gatewayClient = null;
        let sessionDefaults = { ...DEFAULT_GATEWAY_SESSION_DEFAULTS };
        const chatBuffers = new Map();
        const chatFallbacks = new Map();
        const chatRunContexts = new Map();
        const contextUsageRefreshes = new Map();
        const contextUsageFingerprints = new Map();
        const voiceReplyPreferences = new VoiceReplyPreferenceStore(opts.defaultVoiceReplyEnabled ?? false, sessionDefaults);
        voiceReplyPreferences.setDefaultVoiceReplySettings(opts.defaultVoiceReplyConfig);
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
                        if (shouldUseVoiceReply(runId, context.sessionKey)) {
                            return;
                        }
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
                    voiceReplyPreferences.setSessionDefaults(sessionDefaults);
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
        function publishOfficeSnapshot(eventName, payload) {
            const officePayload = buildOfficeEventPayload(eventName, payload, () => new Date().toISOString());
            if (!officePayload) {
                return;
            }
            send({ type: "event", event: "office", payload: officePayload });
        }
        function queueVoiceReply(runId, sessionKey, text) {
            const normalizedText = text.trim();
            if (!normalizedText) {
                return;
            }
            console.log(`[relay] queueing voice reply sessionKey=${sessionKey} textLength=${normalizedText.length}`);
            const resolvedSettings = voiceReplyPreferences.resolveSettings(runId, sessionKey);
            const resolvedRate = typeof resolvedSettings?.ratePercent === "number"
                ? `${resolvedSettings.ratePercent > 0 ? "+" : ""}${resolvedSettings.ratePercent}%`
                : undefined;
            void sendVoiceReplyCommand({
                text: normalizedText,
                gateway: opts.gatewayId,
                session: sessionKey,
                voice: resolvedSettings?.voiceIdentifier ?? (process.env.OPENCLAW_TTS_VOICE?.trim() || undefined),
                rate: resolvedRate ?? (process.env.OPENCLAW_TTS_RATE?.trim() || undefined),
                speaker: process.env.OPENCLAW_TTS_ENGINE?.trim() || undefined,
            }).catch((error) => {
                console.warn(`[relay] voice reply generation failed sessionKey=${sessionKey}: ${String(error)}`);
            });
        }
        function shouldUseVoiceReply(runId, sessionKey) {
            return voiceReplyPreferences.shouldUse(runId, sessionKey);
        }
        function shouldSendTextReply(runId, sessionKey) {
            return !shouldUseVoiceReply(runId, sessionKey);
        }
        relayWs.on("open", () => {
            console.log(`Connected to relay server (gatewayId=${opts.gatewayId})`);
            opts.onConnected?.();
            send(buildRelayHelloMessage({
                platform: process.platform,
                agentVersion: "1.0.0",
                capabilities: ["chat", "skills", "schedules", "logs", "files"],
            }));
            // Start the persistent gateway connection as soon as we're connected
            // to the relay server. Its lifetime is tied to this relay session.
            gatewayClient = new OpenClawGatewayClient({
                url: opts.gatewayUrl,
                token: opts.gatewayToken,
                password: opts.gatewayPassword,
                onConnected: () => {
                    console.log("Gateway connected.");
                    send({ type: "gateway_connected" });
                    publishOfficeSnapshot("gateway_connected", {
                        sessionKey: sessionDefaults.mainSessionKey,
                    });
                    void refreshSessionDefaults();
                },
                onDisconnected: (reason) => {
                    console.log(`Gateway disconnected: ${reason}`);
                    send({ type: "gateway_disconnected", reason });
                    publishOfficeSnapshot("gateway_disconnected", {
                        reason,
                    });
                },
                onEvent: (event, payload) => {
                    const normalizedPayload = event === "chat" ? normalizeChatEventPayload(payload) : payload;
                    const shouldPublishOffice = event === "chat" || event === "agent" || event === "context_usage";
                    if (event === "chat") {
                        const p = normalizedPayload;
                        const state = normalizeChatState(normalizedPayload);
                        const runId = typeof p?.runId === "string" ? p.runId : "";
                        const sessionKey = typeof p?.sessionKey === "string" && p.sessionKey.trim().length > 0 ? p.sessionKey.trim() : undefined;
                        const runContext = runId ? chatRunContexts.get(runId) : undefined;
                        const resolvedSessionKey = sessionKey ?? runContext?.sessionKey;
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
                        if (state === "final" && resolvedSessionKey) {
                            scheduleContextUsageRefresh(resolvedSessionKey, 450);
                            const bufferedText = runId ? chatBuffers.get(runId) ?? "" : "";
                            const resolvedText = currentText || bufferedText;
                            if (runId) {
                                chatBuffers.delete(runId);
                            }
                            if (resolvedText.trim()) {
                                if (runId) {
                                    chatRunContexts.delete(runId);
                                }
                                const outgoingPayload = withMessageText(normalizedPayload, resolvedText);
                                if (shouldPublishOffice) {
                                    publishOfficeSnapshot(event, outgoingPayload);
                                }
                                if (shouldSendTextReply(runId, resolvedSessionKey)) {
                                    send({ type: "event", event, payload: outgoingPayload });
                                }
                                else {
                                    queueVoiceReply(runId, resolvedSessionKey, resolvedText);
                                }
                                if (runId) {
                                    voiceReplyPreferences.clearRun(runId);
                                }
                                return;
                            }
                            const fetchHistory = () => gatewayClient.request("chat.history", { sessionKey: resolvedSessionKey, limit: 10 });
                            withTimeout(fetchHistory(), 500, "chat.history")
                                .then(async (history) => {
                                let outcome = runContext ? extractHistoryOutcome(history, runContext) : null;
                                // Retry once after a short delay if OpenClaw hasn't committed the message yet.
                                if (!outcome) {
                                    await new Promise((resolve) => setTimeout(resolve, 150));
                                    const retryHistory = await withTimeout(fetchHistory(), 500, "chat.history retry");
                                    outcome = runContext ? extractHistoryOutcome(retryHistory, runContext) : null;
                                }
                                if (runId) {
                                    chatRunContexts.delete(runId);
                                }
                                if (outcome?.kind === "final") {
                                    const outgoingPayload = withMessageText(normalizedPayload, outcome.text);
                                    if (shouldPublishOffice) {
                                        publishOfficeSnapshot(event, outgoingPayload);
                                    }
                                    if (shouldSendTextReply(runId, resolvedSessionKey)) {
                                        send({ type: "event", event, payload: outgoingPayload });
                                    }
                                    else {
                                        queueVoiceReply(runId, resolvedSessionKey, outcome.text);
                                    }
                                    if (runId) {
                                        voiceReplyPreferences.clearRun(runId);
                                    }
                                    return;
                                }
                                if (outcome?.kind === "error") {
                                    const outgoingPayload = {
                                        ...normalizedPayload,
                                        state: "error",
                                        errorMessage: outcome.errorMessage,
                                    };
                                    if (shouldPublishOffice) {
                                        publishOfficeSnapshot(event, outgoingPayload);
                                    }
                                    send({
                                        type: "event",
                                        event,
                                        payload: outgoingPayload,
                                    });
                                    if (runId) {
                                        voiceReplyPreferences.clearRun(runId);
                                    }
                                    return;
                                }
                                if (shouldPublishOffice) {
                                    publishOfficeSnapshot(event, normalizedPayload);
                                }
                                send({ type: "event", event, payload: normalizedPayload });
                                if (runId) {
                                    voiceReplyPreferences.clearRun(runId);
                                }
                            })
                                .catch((err) => {
                                console.error(`[relay] chat.history fetch failed: ${err}`);
                                if (runId) {
                                    chatRunContexts.delete(runId);
                                    voiceReplyPreferences.clearRun(runId);
                                }
                                if (shouldPublishOffice) {
                                    publishOfficeSnapshot(event, normalizedPayload);
                                }
                                send({ type: "event", event, payload: normalizedPayload });
                            });
                            return;
                        }
                        if (runId && (state === "error" || state === "failed" || state === "fail" || state === "aborted")) {
                            chatRunContexts.delete(runId);
                            scheduleContextUsageRefresh(p?.sessionKey, 450);
                        }
                        const shouldSuppressVoiceReplyText = role === "assistant"
                            && shouldUseVoiceReply(runId, resolvedSessionKey)
                            && state !== "error"
                            && state !== "failed"
                            && state !== "fail"
                            && state !== "aborted";
                        if (shouldSuppressVoiceReplyText) {
                            if (shouldPublishOffice) {
                                publishOfficeSnapshot(event, normalizedPayload);
                            }
                            return;
                        }
                        if (shouldPublishOffice) {
                            publishOfficeSnapshot(event, normalizedPayload);
                        }
                        send({ type: "event", event, payload: normalizedPayload });
                        return;
                    }
                },
            });
            gatewayClient.start();
        });
        relayWs.on("message", async (raw) => {
            let requestId;
            let methodForLog;
            try {
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
                requestId = msg.id;
                methodForLog = msg.method;
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
                // Handle local commands without forwarding to the gateway.
                const localResult = await handleLocalCommand(msg.method, msg.params, {
                    requestId,
                    gatewayId: opts.gatewayId,
                    publishEvent: (event) => send(event),
                });
                if (localResult !== null) {
                    if (localResult.ok && isVoiceReplyConfigCommand(msg.method)) {
                        const payload = localResult.payload;
                        voiceReplyPreferences.setDefaultVoiceReplySettings({
                            voiceIdentifier: typeof payload?.assistantVoiceReplyVoiceIdentifier === "string"
                                ? payload.assistantVoiceReplyVoiceIdentifier
                                : undefined,
                            ratePercent: typeof payload?.assistantVoiceReplyRatePercent === "number"
                                ? payload.assistantVoiceReplyRatePercent
                                : undefined,
                        });
                    }
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
                const paramsRecord = params && typeof params === "object" && !Array.isArray(params)
                    ? params
                    : undefined;
                const voiceReplyEnabled = typeof msg.voiceReplyEnabled === "boolean" ? msg.voiceReplyEnabled : undefined;
                const voiceReplyVoiceIdentifier = typeof msg.voiceReplyVoiceIdentifier === "string" && msg.voiceReplyVoiceIdentifier.trim().length > 0
                    ? msg.voiceReplyVoiceIdentifier.trim()
                    : undefined;
                const voiceReplyRatePercent = typeof msg.voiceReplyRatePercent === "number" && Number.isFinite(msg.voiceReplyRatePercent)
                    ? Math.max(-50, Math.min(50, Math.round(msg.voiceReplyRatePercent)))
                    : undefined;
                const requestSessionKey = paramsRecord && typeof paramsRecord.sessionKey === "string" && paramsRecord.sessionKey.trim().length > 0
                    ? paramsRecord.sessionKey.trim()
                    : undefined;
                if (requestId && typeof voiceReplyEnabled === "boolean" && (msg.method === "chat.send" || msg.method === "agent")) {
                    voiceReplyPreferences.register({
                        runId: requestId,
                        sessionKey: requestSessionKey,
                        enabled: voiceReplyEnabled,
                        voiceIdentifier: voiceReplyVoiceIdentifier,
                        ratePercent: voiceReplyRatePercent,
                    });
                    if (voiceReplyVoiceIdentifier !== undefined || voiceReplyRatePercent !== undefined) {
                        try {
                            const config = readConfig();
                            const updatedConfig = updateVoiceReplyConfig(config, {
                                voiceIdentifier: voiceReplyVoiceIdentifier,
                                ratePercent: voiceReplyRatePercent,
                            });
                            voiceReplyPreferences.setDefaultVoiceReplySettings({
                                voiceIdentifier: updatedConfig.assistantVoiceReplyVoiceIdentifier,
                                ratePercent: updatedConfig.assistantVoiceReplyRatePercent,
                            });
                        }
                        catch (error) {
                            console.warn(`[relay] failed to persist voice reply settings: ${String(error)}`);
                        }
                    }
                }
                if (!gatewayClient) {
                    throw new Error("gateway not connected");
                }
                gatewayClient
                    .request(msg.method, params)
                    .then((result) => {
                    let resolvedRunId;
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
                        resolvedRunId = runId;
                        if (runId && typeof voiceReplyEnabled === "boolean") {
                            voiceReplyPreferences.register({
                                runId,
                                sessionKey,
                                enabled: voiceReplyEnabled,
                                voiceIdentifier: voiceReplyVoiceIdentifier,
                                ratePercent: voiceReplyRatePercent,
                            });
                        }
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
                        // Let a model switch settle before publishing context usage again.
                        // Forced refreshes can replay a stale model snapshot and overwrite the new selection.
                        scheduleContextUsageRefresh(sessionKey, 1200);
                    }
                    if (requestId) {
                        if (resolvedRunId && resolvedRunId !== requestId) {
                            voiceReplyPreferences.clearRun(requestId);
                        }
                        send({ type: "res", id: requestId, ok: true, payload: result });
                    }
                })
                    .catch((err) => {
                    console.error(`[relay] cmd failed method=${msg.method} id=${requestId ?? "(no-id)"}: ${String(err)}`);
                    if (requestId) {
                        voiceReplyPreferences.clearRun(requestId);
                        send({ type: "res", id: requestId, ok: false, error: { message: String(err) } });
                    }
                });
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(`[relay] cmd failed method=${methodForLog ?? "(unknown)"} id=${requestId ?? "(no-id)"}: ${message}`);
                if (requestId) {
                    voiceReplyPreferences.clearRun(requestId);
                    send({ type: "res", id: requestId, ok: false, error: { message } });
                }
            }
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
            // Also stop retrying when the shutdown signal was received.
            const intentional = opts.signal?.aborted || code === 4000;
            resolve(!intentional);
        });
        relayWs.on("error", (err) => {
            console.error("Relay WebSocket error:", err.message);
            // close event will follow
        });
    });
}
function isVoiceReplyConfigCommand(method) {
    return method === "clawconnect.voiceReply.setConfig"
        || method === "pocketclaw.voiceReply.setConfig"
        || method === "clawpilot.voiceReply.setConfig";
}
export function buildRelayHelloMessage(opts) {
    return {
        type: "hello",
        platform: opts.platform,
        agentVersion: opts.agentVersion,
        capabilities: opts.capabilities,
        slashCommands: OPENCLAW_SLASH_COMMAND_CATALOG,
    };
}
function buildRelayUrl(serverUrl, gatewayId, relaySecret) {
    const base = serverUrl.replace(/\/+$/, "").replace(/^http/, "ws");
    return `${base}/relay/${gatewayId}?secret=${encodeURIComponent(relaySecret)}`;
}
//# sourceMappingURL=relay-manager.js.map