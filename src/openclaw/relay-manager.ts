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
  filterOpenClawHeartbeatHistoryResponse,
  readOpenClawTranscriptChatHistory,
  withTimeout,
  type ChatRunContext,
  type HistoryResponse,
} from "./relay/chat-history.js";
import {
  OpenClawChatSendDedupeCoordinator,
} from "./relay/chat-send-dedupe-coordinator.js";
import {
  buildMobileAssistantDeltaPayload,
  buildMobileAssistantErrorPayload,
  buildMobileAssistantFinalPayload,
} from "../core/relay/mobile-chat-run-bridge.js";
import {
  buildChatSendIdempotencyRequest,
  ChatSendIdempotencyGuard,
} from "../core/relay/chat-send-idempotency.js";
import { prepareChatSendParams } from "./relay/chat-send-attachments.js";
import { relayOutgoingMediaInHistoryResponse, relayOutgoingMediaInPayload } from "./relay/outgoing-media-relay.js";
import { prepareOpenClawVoiceInputCommand } from "./relay/openclaw-voice-input.js";
import { voiceInputSetupMessage } from "../core/relay/voice-input.js";
import type { FileUploadResult } from "../core/relay/file-upload.js";
import { gatewayCapabilitiesForType } from "../gateway-profiles.js";
import { buildRelayHelloMessage } from "./relay/relay-manager-hello.js";
import {
  CHAT_HISTORY_FALLBACK_INITIAL_DELAY_MS,
  CHAT_HISTORY_FALLBACK_MAX_ATTEMPTS,
  CHAT_HISTORY_FALLBACK_RETRY_DELAY_MS,
  CHAT_HISTORY_FETCH_TIMEOUT_MS,
  CHAT_HISTORY_FINAL_RETRY_DELAY_MS,
} from "./relay/relay-manager-history-timing.js";
import { publishOfficeSnapshot } from "./relay/relay-manager-office-events.js";
import type {
  OpenClawRelayFromServer,
  OpenClawRelayToServer,
  RelayManagerOptions,
} from "./relay/relay-manager-protocol.js";
export { buildRelayHelloMessage } from "./relay/relay-manager-hello.js";
export type { RelayHelloMessage, RelayManagerOptions } from "./relay/relay-manager-protocol.js";
import {
  buildEmptyHistoryPage,
  buildFinalPayloadFromHistoryOutcome,
  buildLegacyOpenClawHistoryParams,
  extractChatErrorMessage,
  hasHistoryCursor,
  mergeCanonicalChatPayload,
  mobileAssistantUsageFromPayload,
  nonTextContentBlocks,
  nonTextContentBlocksFromHistory,
  resolveChatPayloadSeq,
  resolveChatPayloadTimestamp,
  shouldUseLegacyOpenClawHistoryFallback,
} from "./relay/relay-manager-payload-helpers.js";

type OpenClawChatCommandExecution = {
  params: unknown;
  result: unknown;
};

// 保留在连接实例之外，使 Relay WebSocket 断线重连后的同轮重投仍能复用终态结果。
const openClawChatSendIdempotency = new ChatSendIdempotencyGuard<OpenClawChatCommandExecution>();

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
    const chatSendDedupe = new OpenClawChatSendDedupeCoordinator(() => sessionDefaults);
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
                includeTimelineEvents: true,
              });
              await publishAndSendGatewayEvent(
                "chat",
                buildFinalPayloadFromHistoryOutcome(basePayload, outcome),
                true,
                context.promptText,
              );
              return;
            }
            await publishAndSendGatewayEvent(
              "chat",
              buildMobileAssistantErrorPayload({
                run: { runId, sessionKey: context.sessionKey },
                errorMessage: outcome.errorMessage,
                includeTimelineEvents: true,
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

    function send(msg: OpenClawRelayToServer): void {
      sendRelayJson(relayWs, msg);
    }

    async function publishAndSendGatewayEvent(
      eventName: string,
      payload: unknown,
      publishOffice: boolean,
      userMessage?: string,
    ): Promise<void> {
      const outgoingPayload = eventName === "chat"
        ? await relayOutgoingMediaInPayload(payload, {
            relayServerUrl: opts.relayServerUrl,
            relaySecret: opts.relaySecret,
            gatewayId: opts.gatewayId,
            senderDisplayName: "OpenClaw",
            cache: outgoingMediaUploadCache,
            userMessage,
          })
        : payload;
      if (publishOffice) {
        publishOfficeSnapshot(send, eventName, outgoingPayload);
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
        await chatSendDedupe.dedupePendingForSession(params);
        const transcriptHistory = await readOpenClawTranscriptChatHistory(params, sessionDefaults);
        if (transcriptHistory) {
          return transcriptHistory;
        }
      } catch (err) {
        console.warn(`[relay] transcript chat.history unavailable: ${String(err)}`);
      }

      if (hasHistoryCursor(params)) {
        return buildEmptyHistoryPage(params, sessionDefaults);
      }
      if (!shouldUseLegacyOpenClawHistoryFallback(params, sessionDefaults)) {
        return buildEmptyHistoryPage(params, sessionDefaults);
      }
      if (!gatewayClient) {
        throw new Error("gateway not connected");
      }
      const history = await gatewayClient.request<HistoryResponse>(
        "chat.history",
        buildLegacyOpenClawHistoryParams(params, sessionDefaults),
      );
      return filterOpenClawHeartbeatHistoryResponse(history);
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
          publishOfficeSnapshot(send, "gateway_connected", {
            sessionKey: sessionDefaults.mainSessionKey,
          });
          void refreshSessionDefaults();
        },

        onDisconnected: (reason) => {
          console.log(`Gateway disconnected: ${reason}`);
          send({ type: "gateway_disconnected", reason });
          publishOfficeSnapshot(send, "gateway_disconnected", {
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
            let realtimePayload = normalizedPayload;

            if (runId) {
              if (state === "final" || state === "error" || state === "failed" || state === "fail" || state === "aborted") {
                chatSendDedupe.scheduleForRun(runId, 100);
              }
              if (role === "assistant" && (state === "delta" || state === "final" || state === "error" || state === "failed" || state === "fail")) {
                clearChatFallback(runId);
              }
              if (state === "delta" || state === "streaming" || state === "in_progress") {
                const previousText = chatBuffers.get(runId) ?? "";
                const bufferedText = appendUniqueSuffix(previousText, currentText);
                chatBuffers.set(runId, bufferedText);
                if (role === "assistant" && bufferedText.trim()) {
                  realtimePayload = resolvedSessionKey
                    ? mergeCanonicalChatPayload(
                        normalizedPayload,
                        buildMobileAssistantDeltaPayload({
                          run: { runId, sessionKey: resolvedSessionKey },
                          seq: resolveChatPayloadSeq(normalizedPayload),
                          timestampMs: resolveChatPayloadTimestamp(normalizedPayload),
                          delta: bufferedText,
                          includeTimelineEvents: true,
                        }),
                      )
                    : withMessageText(normalizedPayload, bufferedText);
                }
              } else if (state === "error" || state === "failed" || state === "fail" || state === "aborted") {
                chatBuffers.delete(runId);
                if (role === "assistant" && resolvedSessionKey) {
                  realtimePayload = mergeCanonicalChatPayload(
                    normalizedPayload,
                    buildMobileAssistantErrorPayload({
                      run: { runId, sessionKey: resolvedSessionKey },
                      errorMessage: extractChatErrorMessage(normalizedPayload),
                      includeTimelineEvents: true,
                    }),
                  );
                }
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
                const outgoingPayload = runId
                  ? mergeCanonicalChatPayload(
                      normalizedPayload,
                      buildMobileAssistantFinalPayload({
                        run: { runId, sessionKey: resolvedSessionKey },
                        text: resolvedText,
                        contentBlocks: nonTextContentBlocks(normalizedPayload),
                        includeTimelineEvents: true,
                        ...mobileAssistantUsageFromPayload(normalizedPayload),
                      }),
                    )
                  : withMessageText(normalizedPayload, resolvedText);
                void publishAndSendGatewayEvent(event, outgoingPayload, shouldPublishOffice, runContext?.promptText);
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
                    const basePayload = runId
                      ? buildMobileAssistantFinalPayload({
                          run: { runId, sessionKey: resolvedSessionKey },
                          text: outcome.text,
                          contentBlocks: nonTextContentBlocksFromHistory(outcome.message),
                          includeTimelineEvents: true,
                          ...mobileAssistantUsageFromPayload(normalizedPayload),
                        })
                      : normalizedPayload;
                    const outgoingPayload = buildFinalPayloadFromHistoryOutcome(basePayload, outcome);
                    await publishAndSendGatewayEvent(event, outgoingPayload, shouldPublishOffice, runContext?.promptText);
                    return;
                  }
                  if (outcome?.kind === "error") {
                    const outgoingPayload = runId
                      ? mergeCanonicalChatPayload(
                          normalizedPayload,
                          buildMobileAssistantErrorPayload({
                            run: { runId, sessionKey: resolvedSessionKey },
                            errorMessage: outcome.errorMessage,
                            includeTimelineEvents: true,
                          }),
                        )
                      : {
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
            void publishAndSendGatewayEvent(event, realtimePayload, shouldPublishOffice);
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
      const msg = parseRelayFrame<OpenClawRelayFromServer>(raw);
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

      const commandMethod = msg.method;
      const rawCommandParams = msg.params;
      const rawParamsRecord = rawCommandParams && typeof rawCommandParams === "object" && !Array.isArray(rawCommandParams)
        ? (rawCommandParams as Record<string, unknown>)
        : undefined;
      const rawSessionKey = typeof rawParamsRecord?.sessionKey === "string" && rawParamsRecord.sessionKey.trim()
        ? rawParamsRecord.sessionKey.trim()
        : sessionDefaults.mainSessionKey;
      const normalizedSessionKey = canonicalizeSessionKey(rawSessionKey, sessionDefaults);
      const chatSendIdempotencyRequest = commandMethod === "chat.send" && rawParamsRecord
        ? buildChatSendIdempotencyRequest({
          gatewayId: opts.gatewayId,
          sessionKey: typeof normalizedSessionKey === "string" && normalizedSessionKey.trim()
            ? normalizedSessionKey.trim()
            : sessionDefaults.mainSessionKey,
          idempotencyKey: rawParamsRecord.idempotencyKey,
          payload: {
            method: "chat.send",
            params: {
              ...rawParamsRecord,
              sessionKey: normalizedSessionKey,
            },
          },
        })
        : undefined;

      const executeCommand = async (): Promise<OpenClawChatCommandExecution> => {
        const preparedParams = commandMethod === "chat.send"
          ? await prepareChatSendParams(rawCommandParams, {
            relayServerUrl: opts.relayServerUrl,
            relaySecret: opts.relaySecret,
          })
          : rawCommandParams;
        const params = canonicalizeRelayParams(commandMethod, preparedParams, sessionDefaults);
        if (!gatewayClient && commandMethod !== "chat.history") {
          throw new Error("gateway not connected");
        }
        const result = commandMethod === "chat.history"
          ? await requestChatHistoryFromClawConnect(params)
          : await gatewayClient!.request(commandMethod, params);
        return { params, result };
      };
      const commandExecution = chatSendIdempotencyRequest
        ? openClawChatSendIdempotency.execute(chatSendIdempotencyRequest, executeCommand)
        : { status: "started" as const, promise: executeCommand() };

      commandExecution.promise
        .then(async ({ params, result }) => {
          if (commandExecution.status === "started") {
            const paramsRecord =
              params && typeof params === "object" && !Array.isArray(params)
                ? (params as Record<string, unknown>)
                : undefined;
            const chatSendDedupeRequest = commandMethod === "chat.send"
              ? chatSendDedupe.buildRequest(paramsRecord)
              : undefined;
            if ((commandMethod === "chat.send" || commandMethod === "agent") && params && typeof params === "object" && !Array.isArray(params)) {
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
              if (commandMethod === "chat.send" && chatSendDedupeRequest) {
                chatSendDedupe.register(chatSendDedupeRequest, runId);
              }
              // Let a model switch settle before publishing context usage again.
              // Forced refreshes can replay a stale model snapshot and overwrite the new selection.
              scheduleContextUsageRefresh(sessionKey, 1200);
            }
          }
          if (requestId) {
            const responsePayload = await relayOutgoingMediaForResponse(commandMethod, result);
            send({ type: "res", id: requestId, ok: true, payload: responsePayload });
          }
        })
        .catch((err: unknown) => {
          console.error(`[relay] cmd failed method=${commandMethod} id=${requestId ?? "(no-id)"}: ${String(err)}`);
          if (requestId) {
            send({ type: "res", id: requestId, ok: false, error: { message: String(err) } });
          }
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[relay] cmd failed method=${methodForLog ?? "(unknown)"} id=${requestId ?? "(no-id)"}: ${message}`);
        const setupMessage = voiceInputSetupMessage(err, "openclaw");
        if (setupMessage && voiceInputRun) {
          send({
            type: "event",
            event: "chat",
            payload: buildMobileAssistantErrorPayload({
              run: voiceInputRun,
              errorMessage: setupMessage,
              includeTimelineEvents: true,
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
      chatSendDedupe.clearAll();
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
