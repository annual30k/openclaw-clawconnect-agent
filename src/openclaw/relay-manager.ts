import { WebSocket } from "ws";
import { OpenClawGatewayClient } from "./gateway-client.js";
import {
  bindRelayAbortSignal,
  buildRelayUrl,
  createRelayWebSocket,
  disconnectRelaySocketForRecovery,
  parseRelayFrame,
  sendRelayJson,
  sendRelayJsonWithWriteConfirmation,
  shouldRetryRelayClose,
  type RelaySendResult,
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
  LatestSnapshotCoalescer,
  buildAssistantStreamSnapshotKey,
  type AssistantStreamEmitResult,
} from "../core/relay/assistant-stream-coalescer.js";
import { reliableRelayOutboxForGateway } from "../core/relay/reliable-relay-outbox-registry.js";
import {
  isValidRelayHello,
  reliableDeliveryModeFromRelayHello,
  RELAY_HELLO_NEGOTIATION_TIMEOUT_MS,
} from "../core/relay/reliable-delivery-protocol.js";
import {
  buildChatSendIdempotencyRequest,
  ChatSendIdempotencyGuard,
} from "../core/relay/chat-send-idempotency.js";
import { prepareChatSendParams } from "./relay/chat-send-attachments.js";
import { canonicalizeOpenClawAssistantMediaSidecarPayload } from "./relay/assistant-media-sidecar.js";
import {
  relayOutgoingMediaInHistoryResponse,
  relayOutgoingMediaInPayload,
} from "./relay/outgoing-media-relay.js";
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
import {
  canonicalizeOpenClawChatSendResult,
  normalizeOpenClawMobileRunId,
  openClawChatRunIdentities,
  resolveExplicitMobileRunIdFromChatPayload,
  restoreOpenClawProviderRunIdForCommand,
  type OpenClawChatRunIdentity,
} from "./relay/chat-run-identity.js";
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
  identity?: OpenClawChatRunIdentity;
};

type OpenClawAssistantSnapshot = {
  eventName: string;
  payload: unknown;
  publishOffice: boolean;
  userMessage?: string;
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
  const outboxLookup = reliableRelayOutboxForGateway(opts.gatewayId, {
    storageDirectory: opts.reliableOutboxStorageDirectory,
    relayIdentity: opts.relayServerUrl,
  });
  if (outboxLookup.status === "rejected") {
    console.error(`[relay] cannot start reliable delivery: ${outboxLookup.error.message}`);
    return true;
  }
  const deliveryOutbox = outboxLookup.outbox;

  return new Promise<boolean>((resolve) => {
    let relayWs: WebSocket;
    try {
      relayWs = createRelayWebSocket(wsUrl);
    } catch (err) {
      console.error("Failed to create relay WebSocket:", err);
      resolve(true);
      return;
    }

    bindRelayAbortSignal(relayWs, opts.signal);

    let gatewayClient: OpenClawGatewayClient | null = null;
    let sessionDefaults: GatewaySessionDefaults = { ...DEFAULT_GATEWAY_SESSION_DEFAULTS };
    const chatFallbacks = new Map<string, ReturnType<typeof setTimeout>>();
    const chatRunContexts = new Map<string, OpenClawChatRunIdentity>();
    const chatSendDedupe = new OpenClawChatSendDedupeCoordinator(() => sessionDefaults);
    const outgoingMediaUploadCache = new Map<string, FileUploadResult>();
    const contextUsageRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
    const contextUsageFingerprints = new Map<string, string>();
    let relayHelloNegotiated = false;
    let relayHelloTimer: ReturnType<typeof setTimeout> | undefined;

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

    const scheduleChatHistoryFallback = (providerRunId: string, context: OpenClawChatRunIdentity, attempt = 0): void => {
      if (!providerRunId || !context.sessionKey) {
        return;
      }
      clearChatFallback(providerRunId);
      chatRunContexts.set(providerRunId, context);
      const timer = setTimeout(() => {
        if (!gatewayClient) {
          chatFallbacks.delete(providerRunId);
          return;
        }
        const fetchHistory = () =>
          requestChatHistoryFromClawConnect({ sessionKey: context.sessionKey, limit: 10 });
        withTimeout(fetchHistory(), CHAT_HISTORY_FETCH_TIMEOUT_MS, "chat.history fallback")
          .then(async (history) => {
            const outcome = extractHistoryOutcome(history, context);
            if (!outcome && attempt < CHAT_HISTORY_FALLBACK_MAX_ATTEMPTS) {
              scheduleChatHistoryFallback(providerRunId, context, attempt + 1);
              return;
            }
            if (!outcome) {
              chatFallbacks.delete(providerRunId);
              chatRunContexts.delete(providerRunId);
              openClawChatRunIdentities.clearTransient(opts.gatewayId, providerRunId);
              return;
            }
            clearChatFallback(providerRunId);
            chatRunContexts.delete(providerRunId);
            if (outcome.kind === "final") {
              openClawChatRunIdentities.markTerminal(opts.gatewayId, providerRunId);
              const basePayload = buildMobileAssistantFinalPayload({
                run: { runId: context.canonicalRunId, sessionKey: context.sessionKey },
                text: outcome.text,
                includeTimelineEvents: true,
              });
              await publishAndSendGatewayEvent(
                "chat",
                buildFinalPayloadFromHistoryOutcome(basePayload, outcome),
                true,
                context.promptText,
              );
              openClawChatRunIdentities.clearTransient(opts.gatewayId, providerRunId);
              return;
            }
            openClawChatRunIdentities.markTerminal(opts.gatewayId, providerRunId);
            await publishAndSendGatewayEvent(
              "chat",
              buildMobileAssistantErrorPayload({
                run: { runId: context.canonicalRunId, sessionKey: context.sessionKey },
                errorMessage: outcome.errorMessage,
                includeTimelineEvents: true,
              }),
              true,
            );
            openClawChatRunIdentities.clearTransient(opts.gatewayId, providerRunId);
          })
          .catch((err) => {
            if (attempt < CHAT_HISTORY_FALLBACK_MAX_ATTEMPTS) {
              scheduleChatHistoryFallback(providerRunId, context, attempt + 1);
              return;
            }
            console.warn(`[relay] chat history fallback failed runId=${providerRunId}: ${String(err)}`);
            chatFallbacks.delete(providerRunId);
            chatRunContexts.delete(providerRunId);
            openClawChatRunIdentities.clearTransient(opts.gatewayId, providerRunId);
          });
      }, attempt === 0 ? CHAT_HISTORY_FALLBACK_INITIAL_DELAY_MS : CHAT_HISTORY_FALLBACK_RETRY_DELAY_MS);
      timer.unref?.();
      chatFallbacks.set(providerRunId, timer);
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

    let lastBackpressureWarningAt = 0;
    function queueReliable(msg: OpenClawRelayToServer): AssistantStreamEmitResult | undefined {
      const enqueue = deliveryOutbox.enqueueIfReliable(msg);
      if (enqueue.status === "not_reliable") return undefined;
      if (enqueue.status === "accepted") return { status: "delivered" };
      console.error(`[relay] reliable frame rejected reason=${enqueue.reason}: ${enqueue.error.message}`);
      disconnectRelaySocketForRecovery(relayWs, "reliable_outbox_overload");
      return { status: "retryable", error: enqueue.error };
    }

    function reportSendResult(result: RelaySendResult): void {
      if (result.status === "backpressure_skipped" && Date.now() - lastBackpressureWarningAt >= 10_000) {
        lastBackpressureWarningAt = Date.now();
        console.warn(`[relay] stream snapshot skipped under backpressure buffered=${result.bufferedAmount} projected=${result.projectedBufferedAmount}`);
      } else if (result.status === "backpressure_disconnected") {
        console.warn(`[relay] disconnected saturated WebSocket buffered=${result.bufferedAmount} projected=${result.projectedBufferedAmount}`);
      } else if (result.status === "socket_not_open" || result.status === "send_failed") {
        console.warn(`[relay] best-effort frame not sent status=${result.status}`);
      }
    }

    function send(msg: OpenClawRelayToServer): AssistantStreamEmitResult {
      const reliable = queueReliable(msg);
      if (reliable) return reliable;
      const result = sendRelayJson(relayWs, msg, undefined, (error) => {
        if (error) console.warn(`[relay] WebSocket write failed: ${error.message}`);
      });
      reportSendResult(result);
      return result.status === "sent"
        ? { status: "delivered" }
        : { status: "retryable", error: result.error ?? new Error(`relay_send_${result.status}`) };
    }

    async function sendWithWriteConfirmation(
      msg: OpenClawRelayToServer,
    ): Promise<AssistantStreamEmitResult> {
      const reliable = queueReliable(msg);
      if (reliable) return reliable;
      const result = await sendRelayJsonWithWriteConfirmation(relayWs, msg);
      reportSendResult(result);
      return result.status === "sent"
        ? { status: "delivered" }
        : { status: "retryable", error: result.error ?? new Error(`relay_send_${result.status}`) };
    }

    async function publishAndSendGatewayEvent(
      eventName: string,
      payload: unknown,
      publishOffice: boolean,
      userMessage?: string,
    ): Promise<void>;
    async function publishAndSendGatewayEvent(
      eventName: string,
      payload: unknown,
      publishOffice: boolean,
      userMessage: string | undefined,
      confirmWrite: true,
    ): Promise<AssistantStreamEmitResult>;
    async function publishAndSendGatewayEvent(
      eventName: string,
      payload: unknown,
      publishOffice: boolean,
      userMessage?: string,
      confirmWrite = false,
    ): Promise<void | AssistantStreamEmitResult> {
      let outgoingPayload = payload;
      if (eventName === "chat") {
        try {
          outgoingPayload = await relayOutgoingMediaInPayload(payload, {
            relayServerUrl: opts.relayServerUrl,
            relaySecret: opts.relaySecret,
            gatewayId: opts.gatewayId,
            senderDisplayName: "OpenClaw",
            cache: outgoingMediaUploadCache,
            userMessage,
          });
        } catch (error) {
          if (!hasCanonicalTerminalTimeline(payload)) throw error;
          // The answer is already complete. Attachment enrichment must not keep
          // the canonical terminal outside the ACK-backed outbox during a Relay
          // disconnect; replay the original terminal and let history/file flows
          // reconcile any media separately.
          console.warn(`[relay] terminal media enrichment failed; sending canonical terminal without enrichment: ${String(error)}`);
          outgoingPayload = payload;
        }
      }
      if (publishOffice) {
        publishOfficeSnapshot(send, eventName, outgoingPayload);
      }
      const message: OpenClawRelayToServer = {
        type: "event",
        event: eventName,
        payload: outgoingPayload,
      };
      if (confirmWrite) return sendWithWriteConfirmation(message);
      send(message);
    }

    const assistantSnapshots = new LatestSnapshotCoalescer<string, OpenClawAssistantSnapshot>({
      emit: (_key, snapshot) => {
        const publishOffice = snapshot.publishOffice;
        snapshot.publishOffice = false;
        return publishAndSendGatewayEvent(
          snapshot.eventName,
          snapshot.payload,
          publishOffice,
          snapshot.userMessage,
          true,
        );
      },
      onError: (error, key) => {
        console.warn(`[relay] assistant snapshot publish failed key=${key}: ${String(error)}`);
      },
    });

    const assistantSnapshotKey = (runId: string | undefined, sessionKey: string | undefined): string | undefined => {
      if (!runId?.trim() || !sessionKey?.trim()) {
        return undefined;
      }
      return buildAssistantStreamSnapshotKey({
        sessionKey,
        runId,
        messageId: `assistant-${runId}`,
      });
    };

    const runAfterAssistantSnapshot = (
      key: string | undefined,
      close: boolean,
      operation: () => void | Promise<void>,
      releaseClosed = false,
    ): void => {
      let result: void | Promise<void>;
      try {
        result = key
          ? close
            ? assistantSnapshots.closeAfterFlush(key, operation)
            : assistantSnapshots.flushThen(key, operation)
          : operation();
      } catch (error) {
        console.warn(`[relay] ordered gateway event publish failed: ${String(error)}`);
        return;
      }
      void Promise.resolve(result)
        .catch((error) => {
          console.warn(`[relay] ordered gateway event publish failed: ${String(error)}`);
        })
        .finally(() => {
          if (key && close && releaseClosed) assistantSnapshots.releaseClosed(key);
        });
    };

    const snapshotKeyForGatewayPayload = (payload: unknown): string | undefined => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return undefined;
      }
      const record = payload as Record<string, unknown>;
      const providerRunId = typeof record.runId === "string" && record.runId.trim()
        ? record.runId.trim()
        : undefined;
      const explicitCanonicalRunId = resolveExplicitMobileRunIdFromChatPayload(payload);
      const runContext = providerRunId
        ? chatRunContexts.get(providerRunId) ?? openClawChatRunIdentities.resolve(opts.gatewayId, providerRunId)
        : undefined;
      const runId = runContext?.canonicalRunId ?? explicitCanonicalRunId ?? providerRunId;
      const sessionKey = typeof record.sessionKey === "string" && record.sessionKey.trim()
        ? record.sessionKey.trim()
        : runContext?.sessionKey;
      return assistantSnapshotKey(runId, sessionKey);
    };

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
      relayHelloTimer = setTimeout(() => {
        if (relayHelloNegotiated) return;
        console.warn("[relay] Relay hello negotiation timed out; reconnecting without protocol downgrade");
        disconnectRelaySocketForRecovery(relayWs, "relay_hello_timeout");
      }, opts.relayHelloTimeoutMs ?? RELAY_HELLO_NEGOTIATION_TIMEOUT_MS);
      relayHelloTimer.unref?.();

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
          const normalizedPayload = event === "chat"
            ? canonicalizeOpenClawAssistantMediaSidecarPayload(normalizeChatEventPayload(payload))
            : payload;
          const shouldPublishOffice = event === "chat" || event === "agent" || event === "context_usage";
          if (event === "chat") {
            const p = normalizedPayload as { sessionKey?: string; runId?: string };
            const state = normalizeChatState(normalizedPayload);
            const providerRunId = typeof p?.runId === "string" ? p.runId.trim() : "";
            const isStreamingState = state === "delta" || state === "streaming" || state === "in_progress";
            const isTerminalState = state === "final" || state === "error" || state === "failed" || state === "fail" || state === "aborted";
            const sessionKey = typeof p?.sessionKey === "string" && p.sessionKey.trim().length > 0 ? p.sessionKey.trim() : undefined;
            const explicitCanonicalRunId = resolveExplicitMobileRunIdFromChatPayload(normalizedPayload);
            let runContext = providerRunId
              ? chatRunContexts.get(providerRunId) ?? openClawChatRunIdentities.resolve(opts.gatewayId, providerRunId)
              : undefined;
            if (!runContext && providerRunId && sessionKey) {
              runContext = {
                gatewayId: opts.gatewayId,
                providerRunId,
                canonicalRunId: explicitCanonicalRunId ?? providerRunId,
                sessionKey,
              };
              openClawChatRunIdentities.ensure(runContext);
              chatRunContexts.set(providerRunId, runContext);
            }
            if (providerRunId && isStreamingState && openClawChatRunIdentities.isTerminal(opts.gatewayId, providerRunId)) {
              return;
            }
            if (providerRunId && isTerminalState) {
              openClawChatRunIdentities.markTerminal(opts.gatewayId, providerRunId);
            }
            const canonicalRunId = runContext?.canonicalRunId ?? explicitCanonicalRunId ?? providerRunId;
            const resolvedSessionKey = sessionKey ?? runContext?.sessionKey;
            const currentText = extractChatText(normalizedPayload);
            const role = extractChatRole(normalizedPayload);
            const runSnapshotKey = assistantSnapshotKey(canonicalRunId, resolvedSessionKey);
            if (isOpenClawHeartbeatText(currentText) || (runContext?.promptText && isOpenClawHeartbeatText(runContext.promptText))) {
              if (providerRunId && (state === "final" || state === "error" || state === "failed" || state === "fail" || state === "aborted")) {
                openClawChatRunIdentities.clearTransient(opts.gatewayId, providerRunId);
                chatRunContexts.delete(providerRunId);
              }
              if (runSnapshotKey) {
                assistantSnapshots.clear(runSnapshotKey);
              }
              return;
            }
            let realtimePayload = normalizedPayload;

            if (providerRunId) {
              if (state === "final" || state === "error" || state === "failed" || state === "fail" || state === "aborted") {
                chatSendDedupe.scheduleForRun(providerRunId, 100);
              }
              if (role === "assistant" && (state === "delta" || state === "final" || state === "error" || state === "failed" || state === "fail")) {
                clearChatFallback(providerRunId);
              }
              if (state === "delta" || state === "streaming" || state === "in_progress") {
                const previousText = openClawChatRunIdentities.accumulatedText(opts.gatewayId, providerRunId);
                const bufferedText = appendUniqueSuffix(previousText, currentText);
                openClawChatRunIdentities.setAccumulatedText(opts.gatewayId, providerRunId, bufferedText);
                if (role === "assistant" && bufferedText.trim()) {
                  realtimePayload = resolvedSessionKey
                    ? mergeCanonicalChatPayload(
                        normalizedPayload,
                        buildMobileAssistantDeltaPayload({
                          run: { runId: canonicalRunId, sessionKey: resolvedSessionKey },
                          seq: resolveChatPayloadSeq(normalizedPayload),
                          timestampMs: resolveChatPayloadTimestamp(normalizedPayload),
                          delta: bufferedText,
                          includeTimelineEvents: true,
                        }),
                      )
                    : withMessageText(normalizedPayload, bufferedText);
                }
              } else if (state === "error" || state === "failed" || state === "fail" || state === "aborted") {
                if (role === "assistant" && resolvedSessionKey) {
                  realtimePayload = mergeCanonicalChatPayload(
                    normalizedPayload,
                    buildMobileAssistantErrorPayload({
                      run: { runId: canonicalRunId, sessionKey: resolvedSessionKey },
                      errorMessage: extractChatErrorMessage(normalizedPayload),
                      includeTimelineEvents: true,
                    }),
                  );
                }
              }
            }

            if (
              runSnapshotKey &&
              role === "assistant" &&
              (state === "delta" || state === "streaming" || state === "in_progress") &&
              extractChatText(realtimePayload).trim()
            ) {
              assistantSnapshots.schedule(runSnapshotKey, {
                eventName: event,
                payload: realtimePayload,
                publishOffice: shouldPublishOffice,
                userMessage: runContext?.promptText,
              });
              return;
            }

            if (state === "final" && resolvedSessionKey) {
              scheduleContextUsageRefresh(resolvedSessionKey, 450);
              const bufferedText = providerRunId
                ? openClawChatRunIdentities.accumulatedText(opts.gatewayId, providerRunId)
                : "";
              const resolvedText = appendUniqueSuffix(bufferedText, currentText);
              if (resolvedText.trim()) {
                const outgoingPayload = providerRunId
                  ? mergeCanonicalChatPayload(
                      normalizedPayload,
                      buildMobileAssistantFinalPayload({
                        run: { runId: canonicalRunId, sessionKey: resolvedSessionKey },
                        text: resolvedText,
                        contentBlocks: nonTextContentBlocks(normalizedPayload),
                        includeTimelineEvents: true,
                        ...mobileAssistantUsageFromPayload(normalizedPayload),
                      }),
                    )
                  : withMessageText(normalizedPayload, resolvedText);
                runAfterAssistantSnapshot(runSnapshotKey, true, async () => {
                  await publishAndSendGatewayEvent(event, outgoingPayload, shouldPublishOffice, runContext?.promptText);
                  if (providerRunId) {
                    openClawChatRunIdentities.clearTransient(opts.gatewayId, providerRunId);
                    chatRunContexts.delete(providerRunId);
                  }
                }, Boolean(providerRunId));
                return;
              }

              const fetchHistory = () =>
                requestChatHistoryFromClawConnect({ sessionKey: resolvedSessionKey, limit: 10 });
              const publishHistoryTerminal = () => withTimeout(
                fetchHistory(),
                CHAT_HISTORY_FETCH_TIMEOUT_MS,
                "chat.history",
              )
                .then(async (history) => {
                  let outcome = runContext ? extractHistoryOutcome(history, runContext) : null;
                  // Retry once if OpenClaw has emitted final before the transcript is committed.
                  if (!outcome) {
                    await new Promise((resolve) => setTimeout(resolve, CHAT_HISTORY_FINAL_RETRY_DELAY_MS));
                    const retryHistory = await withTimeout(fetchHistory(), CHAT_HISTORY_FETCH_TIMEOUT_MS, "chat.history retry");
                    outcome = runContext ? extractHistoryOutcome(retryHistory, runContext) : null;
                  }
                  if (providerRunId && outcome) {
                    chatRunContexts.delete(providerRunId);
                  }
                  if (outcome?.kind === "final") {
                    const basePayload = providerRunId
                      ? buildMobileAssistantFinalPayload({
                          run: { runId: canonicalRunId, sessionKey: resolvedSessionKey },
                          text: outcome.text,
                          contentBlocks: nonTextContentBlocksFromHistory(outcome.message),
                          includeTimelineEvents: true,
                          ...mobileAssistantUsageFromPayload(normalizedPayload),
                        })
                      : normalizedPayload;
                    const outgoingPayload = buildFinalPayloadFromHistoryOutcome(basePayload, outcome);
                    await publishAndSendGatewayEvent(event, outgoingPayload, shouldPublishOffice, runContext?.promptText);
                    if (providerRunId) openClawChatRunIdentities.clearTransient(opts.gatewayId, providerRunId);
                    return;
                  }
                  if (outcome?.kind === "error") {
                    const outgoingPayload = providerRunId
                      ? mergeCanonicalChatPayload(
                          normalizedPayload,
                          buildMobileAssistantErrorPayload({
                            run: { runId: canonicalRunId, sessionKey: resolvedSessionKey },
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
                    if (providerRunId) openClawChatRunIdentities.clearTransient(opts.gatewayId, providerRunId);
                    return;
                  }
                  if (providerRunId && runContext) {
                    scheduleChatHistoryFallback(providerRunId, runContext, 0);
                    return;
                  }
                  await publishAndSendGatewayEvent(event, normalizedPayload, shouldPublishOffice);
                })
                .catch((err) => {
                  console.error(`[relay] chat.history fetch failed: ${err}`);
                  if (providerRunId && runContext) {
                    scheduleChatHistoryFallback(providerRunId, runContext, 0);
                    return;
                  }
                  void publishAndSendGatewayEvent(event, normalizedPayload, shouldPublishOffice);
                });
              runAfterAssistantSnapshot(runSnapshotKey, true, publishHistoryTerminal, Boolean(providerRunId));
              return;
            }

            if (providerRunId && (state === "error" || state === "failed" || state === "fail" || state === "aborted")) {
              chatRunContexts.delete(providerRunId);
              scheduleContextUsageRefresh(p?.sessionKey, 450);
            }
            const isTerminal = state === "error" || state === "failed" || state === "fail" || state === "aborted";
            runAfterAssistantSnapshot(runSnapshotKey, isTerminal, async () => {
              await publishAndSendGatewayEvent(event, realtimePayload, shouldPublishOffice);
              if (providerRunId && isTerminal) {
                openClawChatRunIdentities.clearTransient(opts.gatewayId, providerRunId);
              }
            }, Boolean(providerRunId && isTerminal));
            return;
          }
          runAfterAssistantSnapshot(snapshotKeyForGatewayPayload(normalizedPayload), false, () => (
            publishAndSendGatewayEvent(event, normalizedPayload, shouldPublishOffice)
          ));
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
        if (!isValidRelayHello(msg, opts.gatewayId)) {
          console.warn("[relay] invalid Relay hello; reconnecting without protocol downgrade");
          disconnectRelaySocketForRecovery(relayWs, "invalid_relay_hello");
          return;
        }
        if (relayHelloNegotiated) return;
        relayHelloNegotiated = true;
        if (relayHelloTimer) {
          clearTimeout(relayHelloTimer);
          relayHelloTimer = undefined;
        }
        const deliveryMode = reliableDeliveryModeFromRelayHello(msg);
        deliveryOutbox.attach(relayWs, deliveryMode);
        console.log(`[relay] reliable delivery mode=${deliveryMode}`);
        return;
      }

      if (msg.type === "event_ack") {
        deliveryOutbox.acknowledge(msg.id);
        return;
      }

      if (msg.type === "response_ack") {
        deliveryOutbox.acknowledgeResponse(msg.id, msg.responsePhase);
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
        const providerIdentifiedParams = restoreOpenClawProviderRunIdForCommand(
          commandMethod,
          preparedParams,
          opts.gatewayId,
          openClawChatRunIdentities,
        );
        const params = canonicalizeRelayParams(commandMethod, providerIdentifiedParams, sessionDefaults);
        if (!gatewayClient && commandMethod !== "chat.history") {
          throw new Error("gateway not connected");
        }
        const paramsRecord = params && typeof params === "object" && !Array.isArray(params)
          ? params as Record<string, unknown>
          : undefined;
        const registerIdentity = (result: unknown): OpenClawChatRunIdentity | undefined => {
          const resultRecord = result && typeof result === "object" && !Array.isArray(result)
            ? result as Record<string, unknown>
            : undefined;
          const providerRunId =
            typeof resultRecord?.runId === "string" && resultRecord.runId.trim().length > 0
              ? resultRecord.runId.trim()
              : requestId;
          const canonicalRunId = commandMethod === "chat.send"
            ? normalizeOpenClawMobileRunId(paramsRecord?.idempotencyKey)
              ?? normalizeOpenClawMobileRunId(voiceInputRun?.runId)
              ?? providerRunId
            : providerRunId;
          if ((commandMethod !== "chat.send" && commandMethod !== "agent") || !providerRunId || !canonicalRunId) {
            return undefined;
          }
          const identity: OpenClawChatRunIdentity = {
            gatewayId: opts.gatewayId,
            providerRunId,
            canonicalRunId,
            sessionKey: typeof paramsRecord?.sessionKey === "string" && paramsRecord.sessionKey.trim().length > 0
              ? paramsRecord.sessionKey.trim()
              : sessionDefaults.mainSessionKey,
            promptText: typeof paramsRecord?.message === "string" && paramsRecord.message.trim().length > 0
              ? paramsRecord.message.trim()
              : undefined,
          };
          openClawChatRunIdentities.register(identity);
          chatRunContexts.set(identity.providerRunId, identity);
          return identity;
        };
        let identity: OpenClawChatRunIdentity | undefined;
        const result = commandMethod === "chat.history"
          ? await requestChatHistoryFromClawConnect(params)
          : await gatewayClient!.request(commandMethod, params, {
              // response 帧内同步登记，保证紧随其后的首个 delta 已能解析 canonical 身份。
              onResponse: (response) => {
                identity = registerIdentity(response);
              },
            });
        identity ??= registerIdentity(result);
        return { params, result, identity };
      };
      const commandExecution = chatSendIdempotencyRequest
        ? openClawChatSendIdempotency.execute(chatSendIdempotencyRequest, executeCommand)
        : { status: "started" as const, promise: executeCommand() };

      commandExecution.promise
        .then(async ({ params, result, identity }) => {
          const paramsRecord =
            params && typeof params === "object" && !Array.isArray(params)
              ? (params as Record<string, unknown>)
              : undefined;
          const resultRecord = result && typeof result === "object" && !Array.isArray(result)
            ? (result as Record<string, unknown>)
            : undefined;
          const providerRunId =
            typeof resultRecord?.runId === "string" && resultRecord.runId.trim().length > 0
              ? resultRecord.runId.trim()
              : requestId;
          const canonicalRunId = commandMethod === "chat.send"
            ? normalizeOpenClawMobileRunId(paramsRecord?.idempotencyKey)
              ?? normalizeOpenClawMobileRunId(voiceInputRun?.runId)
              ?? providerRunId
            : providerRunId;
          if (commandExecution.status === "started") {
            const chatSendDedupeRequest = commandMethod === "chat.send"
              ? chatSendDedupe.buildRequest(paramsRecord)
              : undefined;
            if ((commandMethod === "chat.send" || commandMethod === "agent") && params && typeof params === "object" && !Array.isArray(params)) {
              const sessionKey =
                typeof paramsRecord?.sessionKey === "string" && paramsRecord.sessionKey.trim().length > 0
                  ? paramsRecord.sessionKey.trim()
                  : sessionDefaults.mainSessionKey;
              if (providerRunId && identity) {
                scheduleChatHistoryFallback(providerRunId, identity);
              }
              if (commandMethod === "chat.send" && chatSendDedupeRequest) {
                chatSendDedupe.register(chatSendDedupeRequest, providerRunId);
              }
              // Let a model switch settle before publishing context usage again.
              // Forced refreshes can replay a stale model snapshot and overwrite the new selection.
              scheduleContextUsageRefresh(sessionKey, 1200);
            }
          }
          if (requestId) {
            const externallyIdentifiedResult = commandMethod === "chat.send" && canonicalRunId
              ? canonicalizeOpenClawChatSendResult(result, canonicalRunId)
              : result;
            const responsePayload = await relayOutgoingMediaForResponse(commandMethod, externallyIdentifiedResult);
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
      if (relayHelloTimer) {
        clearTimeout(relayHelloTimer);
        relayHelloTimer = undefined;
      }
      assistantSnapshots.dispose();
      deliveryOutbox.detach(relayWs);
      resolve(shouldRetryRelayClose(code, opts.signal));
    });

    function isOpenClawHeartbeatText(text?: string): boolean {
      if (!text) return false;
      const trimmed = text.replace(/\r/g, "").trim();
      const lower = trimmed.toLowerCase();
      const upper = trimmed.toUpperCase();
      return (
        lower === "[openclaw heartbeat poll]" ||
        lower === "openclaw heartbeat poll" ||
        lower.startsWith("[openclaw heartbeat poll]") ||
        lower.startsWith("openclaw heartbeat poll") ||
        upper === "HEARTBEAT_OK" ||
        upper === "HEARTBEAT OK" ||
        upper.startsWith("HEARTBEAT_OK") ||
        upper.startsWith("HEARTBEAT OK")
      );
    }

    function hasCanonicalTerminalTimeline(payload: unknown): boolean {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
      const record = payload as Record<string, unknown>;
      const state = typeof record.state === "string" ? record.state.trim().toLowerCase() : "";
      if (!["final", "error", "failed", "fail", "aborted"].includes(state)) return false;
      return Array.isArray(record.timelineEvents) && record.timelineEvents.some((event) => {
        if (!event || typeof event !== "object" || Array.isArray(event)) return false;
        const eventType = (event as Record<string, unknown>).eventType;
        return typeof eventType === "string"
          && ["message.completed", "run.completed", "run.failed", "run.aborted"].includes(eventType);
      });
    }

    relayWs.on("error", (err) => {
      console.error("Relay WebSocket error:", err.message);
      // close event will follow
    });
  });
}
