import { WebSocket } from "ws";
import { OpenClawGatewayClient } from "./gateway-client.js";
import { handleLocalCommand } from "../commands/local-handlers.js";
import { handleProviderCommand } from "../commands/provider-handlers.js";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";
import { mkdir, open as openFile, readFile, writeFile } from "fs/promises";
import { randomUUID } from "crypto";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const OUTBOUND_DIR = join(homedir(), ".openclaw", "media", "outbound");
const OPENCLAW_HOME = join(homedir(), ".openclaw");
const TRANSCRIPT_TAIL_CHUNK_BYTES = 64 * 1024;
const UI_SYNC_RUN_ID_PREFIX = "relay-ui-sync-";
function toFiniteInteger(value) {
    return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}
function toPositiveInteger(value) {
    const normalized = toFiniteInteger(value);
    return typeof normalized === "number" && normalized > 0 ? normalized : undefined;
}
function resolveAgentIdFromSessionKey(sessionKey, defaults) {
    const match = sessionKey.match(/^agent:([^:]+):/);
    if (match?.[1]) {
        return match[1];
    }
    return defaults.defaultAgentId || "main";
}
function resolveSessionsDir(sessionKey, defaults) {
    return join(OPENCLAW_HOME, "agents", resolveAgentIdFromSessionKey(sessionKey, defaults), "sessions");
}
async function readSessionStoreEntry(sessionKey, defaults) {
    const storePath = join(resolveSessionsDir(sessionKey, defaults), "sessions.json");
    try {
        const raw = await readFile(storePath, "utf8");
        const parsed = JSON.parse(raw);
        const directEntry = parsed?.[sessionKey];
        if (directEntry && typeof directEntry === "object") {
            return directEntry;
        }
        const mainAliases = new Set([sessionKey, defaults.mainSessionKey, defaults.mainKey, "main"]);
        const defaultAgentMainKey = defaults.defaultAgentId ? `agent:${defaults.defaultAgentId}:main` : undefined;
        if (defaultAgentMainKey) {
            const defaultEntry = parsed?.[defaultAgentMainKey];
            if (defaultEntry && typeof defaultEntry === "object" && mainAliases.has(sessionKey)) {
                return defaultEntry;
            }
        }
        if (mainAliases.has(sessionKey)) {
            const mainEntry = Object.entries(parsed).find(([key]) => key.endsWith(":main"))?.[1];
            if (mainEntry && typeof mainEntry === "object") {
                return mainEntry;
            }
            const firstEntry = Object.values(parsed).find((value) => value && typeof value === "object");
            return firstEntry ?? null;
        }
        return null;
    }
    catch {
        return null;
    }
}
function normalizeUsageRecord(rawUsage) {
    if (!rawUsage || typeof rawUsage !== "object" || Array.isArray(rawUsage)) {
        return undefined;
    }
    const usage = rawUsage;
    const input = toFiniteInteger(usage.input) ?? 0;
    const output = toFiniteInteger(usage.output) ?? 0;
    const cacheRead = toFiniteInteger(usage.cacheRead) ?? 0;
    const cacheWrite = toFiniteInteger(usage.cacheWrite) ?? 0;
    const total = toPositiveInteger(usage.total) ??
        toPositiveInteger(usage.totalTokens) ??
        toPositiveInteger(usage.total_tokens);
    const promptTokens = toPositiveInteger(usage.promptTokens) ??
        toPositiveInteger(usage.prompt_tokens);
    if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0 && !total && !promptTokens) {
        return undefined;
    }
    return {
        input: Math.max(0, input),
        output: Math.max(0, output),
        cacheRead: Math.max(0, cacheRead),
        cacheWrite: Math.max(0, cacheWrite),
        total,
        promptTokens,
    };
}
function derivePromptTokens(usage) {
    if (usage.promptTokens) {
        return usage.promptTokens;
    }
    const derived = usage.input + usage.cacheRead + usage.cacheWrite;
    return derived > 0 ? derived : undefined;
}
function resolveSessionLogPath(sessionKey, sessionId, entry, defaults) {
    const sessionsDir = resolveSessionsDir(sessionKey, defaults);
    const candidate = typeof entry?.sessionFile === "string" && entry.sessionFile.trim().length > 0
        ? entry.sessionFile.trim()
        : typeof entry?.transcriptPath === "string" && entry.transcriptPath.trim().length > 0
            ? entry.transcriptPath.trim()
            : "";
    if (!candidate) {
        return join(sessionsDir, `${sessionId}.jsonl`);
    }
    return isAbsolute(candidate) ? candidate : resolve(sessionsDir, candidate);
}
async function readFileTail(filePath, maxBytes = TRANSCRIPT_TAIL_CHUNK_BYTES) {
    const handle = await openFile(filePath, "r");
    try {
        const stats = await handle.stat();
        const size = Math.max(0, Math.floor(stats.size));
        if (size === 0) {
            return null;
        }
        const length = Math.min(size, maxBytes);
        const buffer = Buffer.alloc(length);
        const offset = Math.max(0, size - length);
        await handle.read(buffer, 0, length, offset);
        return buffer.toString("utf8");
    }
    finally {
        await handle.close();
    }
}
async function readUsageFromSessionLog(sessionKey, sessionId, entry, defaults) {
    const logPath = resolveSessionLogPath(sessionKey, sessionId, entry, defaults);
    try {
        const tail = await readFileTail(logPath);
        if (!tail) {
            return null;
        }
        const offset = tail.indexOf("\n");
        const lines = (offset > 0 ? tail.slice(offset + 1) : tail).split(/\n+/);
        let lastUsage;
        let model;
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            try {
                const parsed = JSON.parse(trimmed);
                const message = parsed.message && typeof parsed.message === "object" && !Array.isArray(parsed.message)
                    ? parsed.message
                    : undefined;
                const usage = normalizeUsageRecord(message?.usage ?? parsed.usage);
                if (usage) {
                    lastUsage = usage;
                }
                if (typeof message?.model === "string" && message.model.trim().length > 0) {
                    model = message.model.trim();
                }
                else if (typeof parsed.model === "string" && parsed.model.trim().length > 0) {
                    model = parsed.model.trim();
                }
            }
            catch {
                // Ignore malformed transcript lines.
            }
        }
        if (!lastUsage) {
            return null;
        }
        const promptTokens = derivePromptTokens(lastUsage) ?? lastUsage.total ?? lastUsage.input + lastUsage.output;
        const total = lastUsage.total ?? promptTokens + lastUsage.output;
        if (promptTokens === 0 && total === 0) {
            return null;
        }
        return {
            promptTokens,
            total,
            model,
        };
    }
    catch {
        return null;
    }
}
function deriveStoredContextUsage(entry) {
    if (!entry) {
        return undefined;
    }
    const total = toPositiveInteger(entry.totalTokens);
    if (total) {
        return total;
    }
    const input = toFiniteInteger(entry.inputTokens) ?? 0;
    const output = toFiniteInteger(entry.outputTokens) ?? 0;
    const fallback = input + output;
    return fallback > 0 ? fallback : undefined;
}
async function readContextUsageSnapshot(sessionKey, defaults) {
    const entry = await readSessionStoreEntry(sessionKey, defaults);
    if (!entry) {
        return null;
    }
    const contextLimit = toPositiveInteger(entry.contextTokens);
    let currentModel = typeof entry.model === "string" && entry.model.trim().length > 0 ? entry.model.trim() : undefined;
    let contextUsage = deriveStoredContextUsage(entry);
    let promptTokens;
    let totalTokens;
    if (typeof entry.sessionId === "string" && entry.sessionId.trim().length > 0) {
        const transcriptUsage = await readUsageFromSessionLog(sessionKey, entry.sessionId.trim(), entry, defaults);
        if (transcriptUsage) {
            promptTokens = transcriptUsage.promptTokens;
            totalTokens = transcriptUsage.total;
            const candidate = transcriptUsage.promptTokens || transcriptUsage.total;
            if (!contextUsage || candidate > contextUsage) {
                contextUsage = candidate;
            }
            if (!currentModel && transcriptUsage.model) {
                currentModel = transcriptUsage.model;
            }
        }
    }
    if (!currentModel && !contextLimit && !contextUsage) {
        return null;
    }
    return {
        sessionKey,
        currentModel,
        contextUsage,
        contextLimit,
        promptTokens,
        totalTokens,
    };
}
function normalizeChatEventPayload(rawPayload) {
    if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
        return rawPayload;
    }
    const payload = { ...rawPayload };
    const stateRaw = typeof payload.state === "string" ? payload.state.trim().toLowerCase() : "";
    const phaseRaw = typeof payload.phase === "string" ? payload.phase.trim().toLowerCase() : "";
    const hasState = stateRaw.length > 0;
    if (!hasState && phaseRaw) {
        if (phaseRaw.includes("delta") || phaseRaw.includes("stream")) {
            payload.state = "delta";
        }
        else if (phaseRaw.includes("final") || phaseRaw.includes("complete") || phaseRaw.includes("done")) {
            payload.state = "final";
        }
        else if (phaseRaw.includes("error") || phaseRaw.includes("fail")) {
            payload.state = "error";
        }
    }
    const normalizeTimestamp = (value) => {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
            return Math.round(value > 10_000_000_000 ? value : value * 1000);
        }
        if (typeof value === "string" && value.trim()) {
            const parsed = Number(value.trim());
            if (Number.isFinite(parsed) && parsed > 0) {
                return Math.round(parsed > 10_000_000_000 ? parsed : parsed * 1000);
            }
        }
        return undefined;
    };
    const resolvedTimestamp = normalizeTimestamp(payload.ts)
        ?? normalizeTimestamp(payload.timestamp)
        ?? normalizeTimestamp(payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)
            ? payload.message.timestamp
            : undefined);
    if (resolvedTimestamp !== undefined) {
        payload.ts = resolvedTimestamp;
    }
    const hasMessage = payload.message && typeof payload.message === "object" && !Array.isArray(payload.message);
    const text = typeof payload.text === "string" ? payload.text : undefined;
    const delta = typeof payload.delta === "string" ? payload.delta : undefined;
    const streamText = text ?? delta;
    if (!hasMessage && streamText && streamText.length > 0) {
        const role = typeof payload.role === "string" && payload.role.trim() ? payload.role.trim() : undefined;
        payload.message = {
            ...(role ? { role } : {}),
            ...(resolvedTimestamp !== undefined ? { timestamp: resolvedTimestamp } : {}),
            content: [{ type: "text", text: streamText }],
        };
    }
    return payload;
}
function extractGatewaySessionDefaults(rawPayload) {
    if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
        return null;
    }
    const payload = rawPayload;
    const snapshot = payload.snapshot && typeof payload.snapshot === "object" && !Array.isArray(payload.snapshot)
        ? payload.snapshot
        : undefined;
    const sessionDefaultsRaw = snapshot?.sessionDefaults && typeof snapshot.sessionDefaults === "object" && !Array.isArray(snapshot.sessionDefaults)
        ? snapshot.sessionDefaults
        : snapshot?.sessiondefaults && typeof snapshot.sessiondefaults === "object" && !Array.isArray(snapshot.sessiondefaults)
            ? snapshot.sessiondefaults
            : undefined;
    const mainSessionKey = typeof sessionDefaultsRaw?.mainSessionKey === "string"
        ? sessionDefaultsRaw.mainSessionKey.trim()
        : "";
    const mainKey = typeof sessionDefaultsRaw?.mainKey === "string" ? sessionDefaultsRaw.mainKey.trim() : "";
    const defaultAgentId = typeof sessionDefaultsRaw?.defaultAgentId === "string"
        ? sessionDefaultsRaw.defaultAgentId.trim()
        : "";
    if (mainSessionKey) {
        return {
            mainSessionKey,
            mainKey: mainKey || "main",
            defaultAgentId: defaultAgentId || undefined,
        };
    }
    const config = payload.config && typeof payload.config === "object" && !Array.isArray(payload.config)
        ? payload.config
        : undefined;
    const session = config?.session && typeof config.session === "object" && !Array.isArray(config.session)
        ? config.session
        : undefined;
    const scope = typeof session?.scope === "string" ? session.scope.trim() : "";
    if (scope === "global") {
        return {
            mainSessionKey: "global",
            mainKey: "global",
        };
    }
    return null;
}
function canonicalizeSessionKey(rawValue, defaults) {
    if (typeof rawValue !== "string") {
        return rawValue;
    }
    const trimmed = rawValue.trim();
    if (!trimmed) {
        return trimmed;
    }
    const mainKey = defaults.mainKey || "main";
    const isMainAlias = trimmed === "main" ||
        trimmed === mainKey ||
        trimmed === defaults.mainSessionKey ||
        (defaults.defaultAgentId
            ? trimmed === `agent:${defaults.defaultAgentId}:main` || trimmed === `agent:${defaults.defaultAgentId}:${mainKey}`
            : false);
    return isMainAlias ? defaults.mainSessionKey : trimmed;
}
function shouldCanonicalizeSessionKey(method) {
    return method === "chat.send" || method === "chat.history" || method === "chat.abort" || method === "agent";
}
function canonicalizeRelayParams(method, rawParams, defaults) {
    if (!shouldCanonicalizeSessionKey(method)) {
        return rawParams;
    }
    if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
        return rawParams;
    }
    const params = rawParams;
    if (!("sessionKey" in params)) {
        return rawParams;
    }
    return {
        ...params,
        sessionKey: canonicalizeSessionKey(params.sessionKey, defaults),
    };
}
function appendUniqueSuffix(base, suffix) {
    if (!suffix) {
        return base;
    }
    if (!base) {
        return suffix;
    }
    if (base.endsWith(suffix)) {
        return base;
    }
    const maxOverlap = Math.min(base.length, suffix.length);
    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
        if (base.slice(-overlap) === suffix.slice(0, overlap)) {
            return base + suffix.slice(overlap);
        }
    }
    return base + suffix;
}
function extractHistoryMessageText(message) {
    const content = Array.isArray(message?.content) ? message.content : [];
    const parts = content
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text?.trim() ?? "")
        .filter((text) => text.length > 0);
    return parts.join("\n\n");
}
function findHistoryUserIndex(messages, context) {
    const normalizedPrompt = context.promptText?.trim();
    const notBeforeMs = context.requestedAtMs - 1_000;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== "user") {
            continue;
        }
        const timestamp = typeof message.timestamp === "number" ? message.timestamp : Number.NaN;
        if (Number.isFinite(timestamp) && timestamp < notBeforeMs) {
            continue;
        }
        const text = extractHistoryMessageText(message);
        if (!normalizedPrompt || text === normalizedPrompt) {
            return index;
        }
    }
    return -1;
}
function extractHistoryOutcome(history, context) {
    const messages = history?.messages ?? [];
    if (messages.length === 0) {
        return null;
    }
    const userIndex = findHistoryUserIndex(messages, context);
    if (userIndex === -1) {
        return null;
    }
    let latestError = null;
    for (let index = userIndex + 1; index < messages.length; index += 1) {
        const message = messages[index];
        if (message.role !== "assistant") {
            continue;
        }
        const text = extractHistoryMessageText(message);
        if (text.length > 0) {
            return { kind: "final", text };
        }
        if (typeof message.errorMessage === "string" &&
            message.errorMessage.trim().length > 0 &&
            (message.stopReason === "error" || !message.stopReason)) {
            latestError = message.errorMessage.trim();
        }
    }
    return latestError ? { kind: "error", errorMessage: latestError } : null;
}
function hasPersistedHistoryUserMessage(history, context) {
    const messages = history?.messages ?? [];
    if (messages.length === 0) {
        return false;
    }
    return findHistoryUserIndex(messages, context) !== -1;
}
function extractChatText(rawPayload) {
    if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
        return "";
    }
    const payload = rawPayload;
    const message = payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)
        ? payload.message
        : undefined;
    const content = Array.isArray(message?.content) ? message?.content : [];
    const blockText = content.find((block) => {
        return Boolean(block) && typeof block === "object" && !Array.isArray(block) && block.type === "text";
    });
    if (typeof blockText?.text === "string" && blockText.text.trim().length > 0) {
        return blockText.text;
    }
    if (typeof payload.text === "string" && payload.text.trim().length > 0) {
        return payload.text;
    }
    if (typeof payload.delta === "string" && payload.delta.trim().length > 0) {
        return payload.delta;
    }
    const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
        ? payload.data
        : undefined;
    if (typeof data?.text === "string" && data.text.trim().length > 0) {
        return data.text;
    }
    if (typeof data?.delta === "string" && data.delta.trim().length > 0) {
        return data.delta;
    }
    return "";
}
function isUiSyncRunId(runId) {
    return typeof runId === "string" && runId.startsWith(UI_SYNC_RUN_ID_PREFIX);
}
function normalizeChatState(rawPayload) {
    if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
        return "";
    }
    const payload = rawPayload;
    const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
        ? payload.data
        : undefined;
    const rawState = typeof payload.state === "string" ? payload.state
        : typeof payload.phase === "string" ? payload.phase
            : typeof data?.phase === "string" ? data.phase
                : "";
    return rawState.trim().toLowerCase();
}
function extractChatRole(rawPayload) {
    if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
        return "";
    }
    const payload = rawPayload;
    if (typeof payload.role === "string" && payload.role.trim()) {
        return payload.role.trim().toLowerCase();
    }
    const message = payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)
        ? payload.message
        : undefined;
    if (typeof message?.role === "string" && message.role.trim()) {
        return message.role.trim().toLowerCase();
    }
    const state = normalizeChatState(rawPayload);
    if (state === "delta" ||
        state === "streaming" ||
        state === "in_progress" ||
        state === "final" ||
        state === "done" ||
        state === "completed" ||
        state === "complete" ||
        state === "error" ||
        state === "failed" ||
        state === "fail" ||
        state === "aborted") {
        return "assistant";
    }
    return "";
}
function withMessageText(rawPayload, text) {
    if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload) || !text.trim()) {
        return rawPayload;
    }
    const payload = { ...rawPayload };
    const existingMessage = payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)
        ? payload.message
        : undefined;
    const timestamp = typeof payload.ts === "number" && Number.isFinite(payload.ts) && payload.ts > 0
        ? payload.ts
        : typeof existingMessage?.timestamp === "number" && Number.isFinite(existingMessage.timestamp) && existingMessage.timestamp > 0
            ? existingMessage.timestamp
            : undefined;
    payload.message = {
        ...(typeof existingMessage?.role === "string" && existingMessage.role.trim() ? { role: existingMessage.role.trim() } : {}),
        ...(timestamp !== undefined ? { timestamp } : {}),
        content: [{ type: "text", text }],
    };
    if (timestamp !== undefined && payload.ts === undefined) {
        payload.ts = timestamp;
    }
    return payload;
}
async function withTimeout(promise, timeoutMs, label) {
    return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
        promise
            .then((value) => {
            clearTimeout(timer);
            resolve(value);
        })
            .catch((error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
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
        let gatewayRefreshClient = null;
        let sessionDefaults = { mainSessionKey: "main", mainKey: "main" };
        const chatBuffers = new Map();
        const chatFallbacks = new Map();
        const chatWebSyncs = new Map();
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
        const clearChatWebSync = (runId) => {
            const timer = chatWebSyncs.get(runId);
            if (timer) {
                clearTimeout(timer);
                chatWebSyncs.delete(runId);
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
            const fingerprint = JSON.stringify({
                currentModel: snapshot.currentModel ?? null,
                contextUsage: snapshot.contextUsage ?? null,
                contextLimit: snapshot.contextLimit ?? null,
            });
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
                    contextUsage: snapshot.contextUsage,
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
        const scheduleWebChatHistorySync = (runId, context, attempt = 0) => {
            if (!runId || !context.sessionKey) {
                return;
            }
            clearChatWebSync(runId);
            const timer = setTimeout(() => {
                const historyClient = gatewayClient;
                const refreshClient = gatewayRefreshClient;
                if (!historyClient || !refreshClient) {
                    chatWebSyncs.delete(runId);
                    return;
                }
                const fetchHistory = () => historyClient.request("chat.history", {
                    sessionKey: context.sessionKey,
                    limit: 10,
                });
                withTimeout(fetchHistory(), 600, "chat.history web sync")
                    .then((history) => {
                    if (!hasPersistedHistoryUserMessage(history, context)) {
                        if (attempt < 4) {
                            scheduleWebChatHistorySync(runId, context, attempt + 1);
                        }
                        else {
                            chatWebSyncs.delete(runId);
                        }
                        return;
                    }
                    clearChatWebSync(runId);
                    refreshClient
                        .request("chat.send", {
                        sessionKey: context.sessionKey,
                        message: "/debug",
                        deliver: false,
                        idempotencyKey: `${UI_SYNC_RUN_ID_PREFIX}${runId}`,
                    })
                        .then(() => {
                        console.log(`[relay] triggered local UI history refresh: runId=${runId} sessionKey=${context.sessionKey} attempt=${attempt}`);
                    })
                        .catch((err) => {
                        if (attempt < 4) {
                            scheduleWebChatHistorySync(runId, context, attempt + 1);
                            return;
                        }
                        console.warn(`[relay] ui history refresh failed runId=${runId}: ${String(err)}`);
                        chatWebSyncs.delete(runId);
                    });
                })
                    .catch((err) => {
                    if (attempt < 4) {
                        scheduleWebChatHistorySync(runId, context, attempt + 1);
                        return;
                    }
                    console.warn(`[relay] web chat sync fallback failed runId=${runId}: ${String(err)}`);
                    chatWebSyncs.delete(runId);
                });
            }, attempt === 0 ? 150 : 250);
            timer.unref?.();
            chatWebSyncs.set(runId, timer);
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
                capabilities: ["chat", "skills", "schedules", "logs"],
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
                        if (isUiSyncRunId(runId)) {
                            return;
                        }
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
            gatewayRefreshClient = new OpenClawGatewayClient({
                url: opts.gatewayUrl,
                token: opts.gatewayToken,
                password: opts.gatewayPassword,
                scopes: ["operator.read", "operator.write"],
                caps: [],
                clientDisplayName: "ClawConnect UI Sync",
                onConnected: () => {
                    console.log("Gateway UI sync client connected.");
                },
                onDisconnected: (reason) => {
                    console.log(`Gateway UI sync client disconnected: ${reason}`);
                },
                onEvent: () => {
                    // The refresh client only issues dummy chat.send requests to trigger
                    // local history reloads. It never forwards gateway events.
                },
            });
            gatewayClient.start();
            gatewayRefreshClient.start();
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
                        if (msg.method === "chat.send") {
                            scheduleWebChatHistorySync(runId, runContext);
                        }
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
            gatewayRefreshClient?.stop();
            gatewayClient = null;
            gatewayRefreshClient = null;
            for (const timer of chatFallbacks.values()) {
                clearTimeout(timer);
            }
            chatFallbacks.clear();
            for (const timer of chatWebSyncs.values()) {
                clearTimeout(timer);
            }
            chatWebSyncs.clear();
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