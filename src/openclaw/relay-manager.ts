import { WebSocket } from "ws";
import { OpenClawGatewayClient } from "./gateway-client.js";
import {
  bindRelayAbortSignal,
  buildRelayUrl,
  parseRelayFrame,
  sendRelayJson,
  shouldRetryRelayClose,
} from "../core/relay/relay-server-connection.js";
import { handleLocalCommand } from "./handlers/local-handlers.js";
import { handleProviderCommand } from "./handlers/provider-handlers.js";
import {
  DEFAULT_GATEWAY_SESSION_DEFAULTS,
  buildContextUsageFingerprint,
  readContextUsageSnapshot,
  canonicalizeRelayParams,
  canonicalizeSessionKey,
  extractGatewaySessionDefaults,
  type GatewaySessionDefaults,
} from "./relay/session-context.js";
import {
  appendUniqueSuffix,
  extractChatRole,
  extractChatText,
  normalizeChatEventPayload,
  normalizeChatState,
  withMessageText,
} from "../core/relay/chat-payload.js";
import {
  extractHistoryOutcome,
  readOpenClawTranscriptChatHistory,
  withTimeout,
  type ChatHistoryOutcome,
  type ChatRunContext,
  type HistoryMessage,
  type HistoryResponse,
} from "./relay/chat-history.js";
import {
  buildMobileAssistantErrorPayload,
  buildMobileAssistantFinalPayload,
} from "../core/relay/mobile-chat-run-bridge.js";
import { buildOfficeEventPayload } from "../core/relay/office-payload.js";
import { prepareChatSendParams } from "./relay/chat-send-attachments.js";
import { relayOutgoingMediaInHistoryResponse, relayOutgoingMediaInPayload } from "./relay/outgoing-media-relay.js";
import { prepareOpenClawVoiceInputCommand } from "./relay/openclaw-voice-input.js";
import { voiceInputSetupMessage } from "../core/relay/voice-input.js";
import type { FileUploadResult } from "../core/relay/file-upload.js";
import { gatewayCapabilitiesForType } from "../gateway-profiles.js";
import type { RelaySlashCommandDescriptor } from "../core/relay/slash-command-types.js";
import { OPENCLAW_SLASH_COMMAND_CATALOG } from "./relay/slash-command-catalog.js";

// ---------------------------------------------------------------------------
// Messages: relay client ↔ relay server
// ---------------------------------------------------------------------------

/** Messages the relay client sends to the relay server. */
export type RelayHelloMessage = {
  type: "hello";
  platform: string;
  agentVersion: string;
  capabilities?: string[];
  slashCommands?: readonly RelaySlashCommandDescriptor[];
};

type ToServer =
  | RelayHelloMessage
  | { type: "heartbeat" }
  | { type: "gateway_connected" }
  | { type: "gateway_disconnected"; reason: string }
  | { type: "event"; event: string; payload: unknown }
  | { type: "res"; id: string; ok: boolean; payload?: unknown; error?: { message?: string } };

const CHAT_HISTORY_FETCH_TIMEOUT_MS = 3000;
const CHAT_HISTORY_FALLBACK_INITIAL_DELAY_MS = 1200;
const CHAT_HISTORY_FALLBACK_RETRY_DELAY_MS = 1800;
const CHAT_HISTORY_FALLBACK_MAX_ATTEMPTS = 8;
const CHAT_HISTORY_FINAL_RETRY_DELAY_MS = 750;

/** Messages the relay server sends to the relay client. */
interface FromServer {
  type: "cmd" | "hello" | "heartbeat";
  id?: string;
  method: string;
  params: unknown;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RelayManagerOptions {
  relayServerUrl: string;
  gatewayId: string;
  relaySecret: string;
  gatewayUrl: string | (() => string);
  gatewayToken?: string;
  gatewayPassword?: string;
  onConnected?: () => void;
  onDisconnected?: () => void;
  /** Optional abort signal.  When aborted the relay WebSocket is closed
   *  cleanly (code 1001) and the retry loop stops. */
  signal?: AbortSignal;
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
export async function runRelayManager(opts: RelayManagerOptions): Promise<boolean> {
  const wsUrl = buildRelayUrl(opts.relayServerUrl, opts.gatewayId, opts.relaySecret);

  return new Promise<boolean>((resolve) => {
    let relayWs: WebSocket;
    try {
      relayWs = new WebSocket(wsUrl);
    } catch (err) {
      console.error("Failed to create relay WebSocket:", err);
      resolve(true);
      return;
    }

    bindRelayAbortSignal(relayWs, opts.signal);

    let gatewayClient: OpenClawGatewayClient | null = null;
    let sessionDefaults: GatewaySessionDefaults = { ...DEFAULT_GATEWAY_SESSION_DEFAULTS };
    const chatBuffers = new Map<string, string>();
    const chatFallbacks = new Map<string, ReturnType<typeof setTimeout>>();
    const chatRunContexts = new Map<string, ChatRunContext>();
    const outgoingMediaUploadCache = new Map<string, FileUploadResult>();
    const contextUsageRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
    const contextUsageFingerprints = new Map<string, string>();

    const clearChatFallback = (runId: string): void => {
      const timer = chatFallbacks.get(runId);
      if (timer) {
        clearTimeout(timer);
        chatFallbacks.delete(runId);
      }
    };

    const publishContextUsageSnapshot = async (sessionKey: string, force = false): Promise<void> => {
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

    const scheduleContextUsageRefresh = (sessionKey: string | undefined, delayMs = 250, force = false): void => {
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

    const scheduleChatHistoryFallback = (runId: string, context: ChatRunContext, attempt = 0): void => {
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
        const fetchHistory = () =>
          requestChatHistoryFromClawConnect({ sessionKey: context.sessionKey, limit: 10 });
        withTimeout(fetchHistory(), CHAT_HISTORY_FETCH_TIMEOUT_MS, "chat.history fallback")
          .then(async (history) => {
            const outcome = extractHistoryOutcome(history, context);
            if (!outcome && attempt < CHAT_HISTORY_FALLBACK_MAX_ATTEMPTS) {
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
              const basePayload = buildMobileAssistantFinalPayload({
                run: { runId, sessionKey: context.sessionKey },
                text: outcome.text,
              });
              await publishAndSendGatewayEvent("chat", buildFinalPayloadFromHistoryOutcome(basePayload, outcome), true);
              return;
            }
            await publishAndSendGatewayEvent(
              "chat",
              buildMobileAssistantErrorPayload({
                run: { runId, sessionKey: context.sessionKey },
                errorMessage: outcome.errorMessage,
              }),
              true,
            );
          })
          .catch((err) => {
            if (attempt < CHAT_HISTORY_FALLBACK_MAX_ATTEMPTS) {
              scheduleChatHistoryFallback(runId, context, attempt + 1);
              return;
            }
            console.warn(`[relay] chat history fallback failed runId=${runId}: ${String(err)}`);
            chatFallbacks.delete(runId);
            chatRunContexts.delete(runId);
          });
      }, attempt === 0 ? CHAT_HISTORY_FALLBACK_INITIAL_DELAY_MS : CHAT_HISTORY_FALLBACK_RETRY_DELAY_MS);
      timer.unref?.();
      chatFallbacks.set(runId, timer);
    };

    const refreshSessionDefaults = async (): Promise<void> => {
      if (!gatewayClient) {
        return;
      }
      try {
        const payload = await gatewayClient.request("config.get", {});
        const nextDefaults = extractGatewaySessionDefaults(payload);
        if (nextDefaults) {
          sessionDefaults = nextDefaults;
        }
        scheduleContextUsageRefresh(sessionDefaults.mainSessionKey, 50, true);
      } catch (err) {
        console.warn(`[relay] failed to load session defaults: ${String(err)}`);
      }
    };

    function send(msg: ToServer): void {
      sendRelayJson(relayWs, msg);
    }

    function publishOfficeSnapshot(eventName: string, payload: unknown): void {
      const officePayload = buildOfficeEventPayload(eventName, payload, () => new Date().toISOString());
      if (!officePayload) {
        return;
      }
      send({ type: "event", event: "office", payload: officePayload });
    }

    async function publishAndSendGatewayEvent(eventName: string, payload: unknown, publishOffice: boolean): Promise<void> {
      const outgoingPayload = eventName === "chat"
        ? await relayOutgoingMediaInPayload(payload, {
            relayServerUrl: opts.relayServerUrl,
            relaySecret: opts.relaySecret,
            gatewayId: opts.gatewayId,
            senderDisplayName: "OpenClaw",
            cache: outgoingMediaUploadCache,
          })
        : payload;
      if (publishOffice) {
        publishOfficeSnapshot(eventName, outgoingPayload);
      }
      send({ type: "event", event: eventName, payload: outgoingPayload });
    }

    async function relayOutgoingMediaForResponse(method: string, payload: unknown): Promise<unknown> {
      if (method !== "chat.history") {
        return payload;
      }
      return relayOutgoingMediaInHistoryResponse(payload, {
        relayServerUrl: opts.relayServerUrl,
        relaySecret: opts.relaySecret,
        gatewayId: opts.gatewayId,
        senderDisplayName: "OpenClaw",
        cache: outgoingMediaUploadCache,
      });
    }

    async function requestChatHistoryFromClawConnect(params: unknown): Promise<HistoryResponse> {
      try {
        const transcriptHistory = await readOpenClawTranscriptChatHistory(params, sessionDefaults);
        if (transcriptHistory) {
          return transcriptHistory;
        }
      } catch (err) {
        console.warn(`[relay] transcript chat.history unavailable: ${String(err)}`);
      }

      if (hasHistoryCursor(params)) {
        return buildEmptyHistoryPage(params);
      }
      if (!gatewayClient) {
        throw new Error("gateway not connected");
      }
      return gatewayClient.request<HistoryResponse>("chat.history", buildLegacyOpenClawHistoryParams(params));
    }

    function buildLegacyOpenClawHistoryParams(params: unknown): Record<string, unknown> {
      const record = params && typeof params === "object" && !Array.isArray(params)
        ? (params as Record<string, unknown>)
        : {};
      const rawSessionKey =
        typeof record.sessionKey === "string" && record.sessionKey.trim().length > 0
          ? record.sessionKey.trim()
          : sessionDefaults.mainSessionKey;
      const sessionKey = canonicalizeSessionKey(rawSessionKey, sessionDefaults);
      const legacyParams: Record<string, unknown> = {
        sessionKey: typeof sessionKey === "string" && sessionKey.trim().length > 0
          ? sessionKey.trim()
          : sessionDefaults.mainSessionKey,
      };
      const limit = normalizePositiveInteger(record.limit);
      if (limit !== undefined) {
        legacyParams.limit = limit;
      }
      const maxChars = normalizePositiveInteger(record.maxChars);
      if (maxChars !== undefined) {
        legacyParams.maxChars = maxChars;
      }
      return legacyParams;
    }

    function buildEmptyHistoryPage(params: unknown): HistoryResponse {
      const record = params && typeof params === "object" && !Array.isArray(params)
        ? (params as Record<string, unknown>)
        : {};
      const rawSessionKey =
        typeof record.sessionKey === "string" && record.sessionKey.trim().length > 0
          ? record.sessionKey.trim()
          : sessionDefaults.mainSessionKey;
      const sessionKey = canonicalizeSessionKey(rawSessionKey, sessionDefaults);
      return {
        sessionKey: typeof sessionKey === "string" && sessionKey.trim().length > 0
          ? sessionKey.trim()
          : sessionDefaults.mainSessionKey,
        messages: [],
        hasMore: false,
      };
    }

    function hasHistoryCursor(params: unknown): boolean {
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        return false;
      }
      const cursor = (params as Record<string, unknown>).cursor;
      return typeof cursor === "string" && cursor.trim().length > 0;
    }

    function normalizePositiveInteger(value: unknown): number | undefined {
      const parsed =
        typeof value === "number" && Number.isFinite(value)
          ? Math.round(value)
          : typeof value === "string" && value.trim().length > 0
            ? Number.parseInt(value.trim(), 10)
            : Number.NaN;
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    }

    function buildFinalPayloadFromHistoryOutcome(
      basePayload: unknown,
      outcome: Extract<ChatHistoryOutcome, { kind: "final" }>,
    ): unknown {
      const payload = outcome.text.trim()
        ? withMessageText(basePayload, outcome.text)
        : basePayload && typeof basePayload === "object" && !Array.isArray(basePayload)
          ? { ...(basePayload as Record<string, unknown>) }
          : {};
      const historyMessage = outcome.message;
      const content = Array.isArray(historyMessage.content) ? historyMessage.content : [];
      if (content.length === 0) {
        return payload;
      }
      const payloadRecord = payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
      const existingMessage = payloadRecord.message && typeof payloadRecord.message === "object" && !Array.isArray(payloadRecord.message)
        ? (payloadRecord.message as Record<string, unknown>)
        : {};
      return {
        ...payloadRecord,
        message: {
          ...existingMessage,
          ...stripUndefinedHistoryMessageFields(historyMessage),
          role: "assistant",
          content,
        },
      };
    }

    function stripUndefinedHistoryMessageFields(message: HistoryMessage): Record<string, unknown> {
      return Object.fromEntries(
        Object.entries(message).filter(([, value]) => value !== undefined),
      );
    }

    relayWs.on("open", () => {
      console.log(`Connected to relay server (gatewayId=${opts.gatewayId})`);
      opts.onConnected?.();
      send(
        buildRelayHelloMessage({
          platform: process.platform,
          agentVersion: "1.0.0",
          capabilities: gatewayCapabilitiesForType("openclaw"),
        }),
      );

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
            const p = normalizedPayload as { sessionKey?: string; runId?: string };
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
              } else if (state === "error" || state === "failed" || state === "fail" || state === "aborted") {
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
                void publishAndSendGatewayEvent(event, outgoingPayload, shouldPublishOffice);
                return;
              }

              const fetchHistory = () =>
                requestChatHistoryFromClawConnect({ sessionKey: resolvedSessionKey, limit: 10 });
              withTimeout(fetchHistory(), CHAT_HISTORY_FETCH_TIMEOUT_MS, "chat.history")
                .then(async (history) => {
                  let outcome = runContext ? extractHistoryOutcome(history, runContext) : null;
                  // Retry once if OpenClaw has emitted final before the transcript is committed.
                  if (!outcome) {
                    await new Promise((resolve) => setTimeout(resolve, CHAT_HISTORY_FINAL_RETRY_DELAY_MS));
                    const retryHistory = await withTimeout(fetchHistory(), CHAT_HISTORY_FETCH_TIMEOUT_MS, "chat.history retry");
                    outcome = runContext ? extractHistoryOutcome(retryHistory, runContext) : null;
                  }
                  if (runId && outcome) {
                    chatRunContexts.delete(runId);
                  }
                  if (outcome?.kind === "final") {
                    const outgoingPayload = buildFinalPayloadFromHistoryOutcome(normalizedPayload, outcome);
                    await publishAndSendGatewayEvent(event, outgoingPayload, shouldPublishOffice);
                    return;
                  }
                  if (outcome?.kind === "error") {
                    const outgoingPayload = {
                      ...(normalizedPayload as Record<string, unknown>),
                      state: "error",
                      errorMessage: outcome.errorMessage,
                    };
                    await publishAndSendGatewayEvent(event, outgoingPayload, shouldPublishOffice);
                    return;
                  }
                  if (runId && runContext) {
                    scheduleChatHistoryFallback(runId, runContext, 0);
                    return;
                  }
                  await publishAndSendGatewayEvent(event, normalizedPayload, shouldPublishOffice);
                })
                .catch((err) => {
                  console.error(`[relay] chat.history fetch failed: ${err}`);
                  if (runId && runContext) {
                    scheduleChatHistoryFallback(runId, runContext, 0);
                    return;
                  }
                  void publishAndSendGatewayEvent(event, normalizedPayload, shouldPublishOffice);
                });
              return;
            }

            if (runId && (state === "error" || state === "failed" || state === "fail" || state === "aborted")) {
              chatRunContexts.delete(runId);
              scheduleContextUsageRefresh(p?.sessionKey, 450);
            }
            void publishAndSendGatewayEvent(event, normalizedPayload, shouldPublishOffice);
            return;
          }
          void publishAndSendGatewayEvent(event, normalizedPayload, shouldPublishOffice);
        },
      });

      gatewayClient.start();
    });

    relayWs.on("message", async (raw) => {
      let requestId: string | undefined;
      let methodForLog: string | undefined;
      let voiceInputRun: { runId: string; sessionKey: string } | undefined;
      try {
      const msg = parseRelayFrame<FromServer>(raw);
      if (!msg) {
        return;
      }

      if (msg.type === "heartbeat") {
        send({ type: "heartbeat" });
        return;
      }

      if (msg.type === "hello") {
        return;
      }

      if (msg.type !== "cmd" || !msg.method) return;

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
        if (requestId) {
          if (localResult.ok) {
            send({ type: "res", id: requestId, ok: true, payload: localResult.payload });
          } else {
            send({ type: "res", id: requestId, ok: false, error: { message: localResult.error } });
          }
        }
        return;
      }

      if (msg.method === "chat.voice.send") {
        const voiceInput = await prepareOpenClawVoiceInputCommand(msg.params, {
          requestId,
          sessionDefaults,
        });
        voiceInputRun = voiceInput.run;
        msg.params = voiceInput.params;
        msg.method = voiceInput.method;
      }

      if (msg.method === "chat.send") {
        msg.params = await prepareChatSendParams(msg.params);
      }

      const params = canonicalizeRelayParams(msg.method, msg.params, sessionDefaults);
      const paramsRecord =
        params && typeof params === "object" && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : undefined;

      if (!gatewayClient && msg.method !== "chat.history") {
        throw new Error("gateway not connected");
      }

      const commandPromise = msg.method === "chat.history"
        ? requestChatHistoryFromClawConnect(params)
        : gatewayClient!.request(msg.method, params);

      commandPromise
        .then(async (result) => {
          let resolvedRunId: string | undefined;
          if ((msg.method === "chat.send" || msg.method === "agent") && params && typeof params === "object" && !Array.isArray(params)) {
            const paramsRecord = params as Record<string, unknown>;
            const sessionKey =
              typeof paramsRecord.sessionKey === "string" && paramsRecord.sessionKey.trim().length > 0
                ? paramsRecord.sessionKey.trim()
                : sessionDefaults.mainSessionKey;
            const resultRecord = result && typeof result === "object" && !Array.isArray(result)
              ? (result as Record<string, unknown>)
              : undefined;
            const runId =
              typeof resultRecord?.runId === "string" && resultRecord.runId.trim().length > 0
                ? resultRecord.runId.trim()
                : requestId;
            resolvedRunId = runId;
            if (runId) {
              const promptText =
                typeof paramsRecord.message === "string" && paramsRecord.message.trim().length > 0
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
            const responsePayload = await relayOutgoingMediaForResponse(msg.method, result);
            send({ type: "res", id: requestId, ok: true, payload: responsePayload });
          }
        })
        .catch((err: unknown) => {
          console.error(`[relay] cmd failed method=${msg.method} id=${requestId ?? "(no-id)"}: ${String(err)}`);
          if (requestId) {
            send({ type: "res", id: requestId, ok: false, error: { message: String(err) } });
          }
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[relay] cmd failed method=${methodForLog ?? "(unknown)"} id=${requestId ?? "(no-id)"}: ${message}`);
        const setupMessage = voiceInputSetupMessage(err);
        if (setupMessage && voiceInputRun) {
          send({
            type: "event",
            event: "chat",
            payload: buildMobileAssistantErrorPayload({
              run: voiceInputRun,
              errorMessage: setupMessage,
            }),
          });
          if (requestId) {
            send({ type: "res", id: requestId, ok: true, payload: voiceInputRun });
          }
        } else if (requestId) {
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
      resolve(shouldRetryRelayClose(code, opts.signal));
    });

    relayWs.on("error", (err) => {
      console.error("Relay WebSocket error:", err.message);
      // close event will follow
    });
  });
}

export function buildRelayHelloMessage(opts: {
  platform: string;
  agentVersion: string;
  capabilities?: string[];
}): RelayHelloMessage {
  return {
    type: "hello",
    platform: opts.platform,
    agentVersion: opts.agentVersion,
    capabilities: opts.capabilities,
    slashCommands: OPENCLAW_SLASH_COMMAND_CATALOG,
  };
}
