import { createHash } from "node:crypto";
import type { MobileAssistantUsage } from "../../core/relay/mobile-chat-run-bridge.js";
import type { TimelineContentBlock } from "../../core/relay/timeline-event-log.js";
import { withMessageText } from "../../core/relay/chat-payload.js";
import {
  canonicalizeSessionKey,
  type GatewaySessionDefaults,
} from "./session-context.js";
import type {
  ChatHistoryOutcome,
  HistoryMessage,
  HistoryResponse,
} from "./chat-history.js";

// OpenClaw v4 chat.history is session-scoped. Preserve every non-main key
// verbatim while continuing to collapse the documented aliases of main.
export function buildOpenClawGatewayHistoryParams(
  params: unknown,
  sessionDefaults: GatewaySessionDefaults,
): Record<string, unknown> {
  const record = asRecord(params) ?? {};
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

export function buildEmptyHistoryPage(
  params: unknown,
  sessionDefaults: GatewaySessionDefaults,
): HistoryResponse {
  const record = asRecord(params) ?? {};
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

export function hasHistoryCursor(params: unknown): boolean {
  const cursor = asRecord(params)?.cursor;
  return typeof cursor === "string" && cursor.trim().length > 0;
}

export function buildFinalPayloadFromHistoryOutcome(
  basePayload: unknown,
  outcome: Extract<ChatHistoryOutcome, { kind: "final" }>,
  contentBlocksOverride?: TimelineContentBlock[],
): unknown {
  const payload = outcome.text.trim()
    ? withMessageText(basePayload, outcome.text)
    : asRecord(basePayload)
      ? { ...asRecord(basePayload) }
      : {};
  const historyMessage = outcome.message;
  const content = contentBlocksOverride
    ?? (Array.isArray(historyMessage.content) ? historyMessage.content : []);
  const payloadRecord = asRecord(payload) ?? {};
  const existingMessage = asRecord(payloadRecord.message) ?? {};
  const projectionFields = historyMessage.projectionVersion === 3
    ? Object.fromEntries([
        "projectionVersion",
        "canonicalMessageId",
        "gatewayType",
        "producerId",
        "sourceSessionId",
        "sourceMessageId",
        "sourceOrderScope",
        "sourceOrderSeq",
        "parentSourceMessageId",
        "sourceRole",
        "timelineDelivery",
      ].flatMap((field) => historyMessage[field] === undefined ? [] : [[field, historyMessage[field]]]))
    : undefined;
  const timelineEvents = Array.isArray(payloadRecord.timelineEvents)
    ? payloadRecord.timelineEvents.map((event) => {
        const record = asRecord(event);
        return record?.eventType === "message.completed" && projectionFields
          ? { ...record, ...projectionFields }
          : event;
      })
    : undefined;
  return {
    ...payloadRecord,
    ...(timelineEvents ? { timelineEvents } : {}),
    ...(content.length > 0
      ? {
          message: {
            ...existingMessage,
            ...stripUndefinedHistoryMessageFields(historyMessage),
            role: "assistant",
            content,
          },
        }
      : {}),
  };
}

export function mergeCanonicalChatPayload(basePayload: unknown, canonicalPayload: unknown): unknown {
  const base = asRecord(basePayload);
  const canonical = asRecord(canonicalPayload);
  if (!base) {
    return canonicalPayload;
  }
  if (!canonical) {
    return basePayload;
  }
  const baseMessage = asRecord(base.message);
  const canonicalMessage = asRecord(canonical.message);
  const merged = {
    ...base,
    ...canonical,
  };
  return baseMessage || canonicalMessage
    ? {
        ...merged,
        message: {
          ...(baseMessage ?? {}),
          ...(canonicalMessage ?? {}),
        },
      }
    : merged;
}

export function resolveChatPayloadSeq(payload: unknown): number {
  return normalizeFiniteNumber(deepField(payload, ["seq", "sequence", "index"]))
    ?? resolveChatPayloadTimestamp(payload);
}

export function resolveChatPayloadTimestamp(payload: unknown): number {
  const value = normalizeFiniteNumber(deepField(payload, ["ts", "timestamp", "createdAt", "created_at", "time"]));
  if (value !== undefined) {
    return value > 10_000_000_000 ? Math.round(value) : Math.round(value * 1000);
  }
  return Date.now();
}

/**
 * Carry provider-owned lineage through the canonical live overlay. These are
 * protocol identities only; never derive them from assistant prose.
 */
export function extractChatLineage(payload: unknown): {
  clientMessageId?: string;
  idempotencyKey?: string;
} {
  const record = asRecord(payload);
  const message = asRecord(record?.message);
  const data = asRecord(record?.data);
  return stripUndefined({
    clientMessageId: firstNonEmptyString(
      record?.clientMessageId,
      record?.client_message_id,
      message?.clientMessageId,
      message?.client_message_id,
      data?.clientMessageId,
      data?.client_message_id,
    ),
    idempotencyKey: firstNonEmptyString(
      record?.idempotencyKey,
      record?.idempotency_key,
      message?.idempotencyKey,
      message?.idempotency_key,
      data?.idempotencyKey,
      data?.idempotency_key,
    ),
  });
}

export function extractChatErrorMessage(payload: unknown): string {
  const direct = firstNonEmptyString(deepField(payload, ["errorMessage", "error_message", "message", "text"]));
  if (direct) {
    return direct;
  }
  const error = asRecord(asRecord(payload)?.error);
  const nested = firstNonEmptyString(error?.message, error?.userMessage, error?.detail);
  return nested ?? "Request failed";
}

export function mobileAssistantUsageFromPayload(payload: unknown): MobileAssistantUsage {
  const record = asRecord(payload);
  const usage = asRecord(record?.usage);
  return stripUndefined({
    currentModel: firstNonEmptyString(record?.currentModel, record?.model, usage?.currentModel, usage?.model),
    provider: firstNonEmptyString(record?.provider, usage?.provider),
    contextUsage: normalizeNonNegativeInteger(record?.contextUsage)
      ?? normalizeNonNegativeInteger(record?.promptTokens)
      ?? normalizeNonNegativeInteger(record?.inputTokens)
      ?? normalizeNonNegativeInteger(usage?.contextUsage)
      ?? normalizeNonNegativeInteger(usage?.promptTokens)
      ?? normalizeNonNegativeInteger(usage?.inputTokens),
    contextLimit: normalizeNonNegativeInteger(record?.contextLimit)
      ?? normalizeNonNegativeInteger(record?.maxInputTokens)
      ?? normalizeNonNegativeInteger(usage?.contextLimit)
      ?? normalizeNonNegativeInteger(usage?.maxInputTokens),
  });
}

export function nonTextContentBlocks(payload: unknown): TimelineContentBlock[] {
  const payloadRecord = asRecord(payload);
  const message = asRecord(payloadRecord?.message);
  const topLevelContent = payloadRecord?.content;
  const content = Array.isArray(message?.content)
    ? message.content
    : Array.isArray(topLevelContent)
      ? topLevelContent
      : [];
  return content.filter((block): block is TimelineContentBlock => {
    const record = asRecord(block);
    return Boolean(record?.type) && record?.type !== "text";
  });
}

export function nonTextContentBlocksFromHistory(message: HistoryMessage): TimelineContentBlock[] {
  return Array.isArray(message.content)
    ? message.content.filter((block): block is TimelineContentBlock => {
        const record = asRecord(block);
        return Boolean(record?.type) && record?.type !== "text";
      })
    : [];
}

/** Merge protocol media with transcript media without emitting the same
 * attachment twice. OpenClaw may put the first image on the live terminal and
 * the remaining images only on delivery-mirror history rows. */
export function mergeNonTextContentBlocks(
  direct: TimelineContentBlock[],
  history: TimelineContentBlock[],
): TimelineContentBlock[] {
  const result = [...direct];
  const identities = new Set(direct.map(contentBlockIdentity).filter((value): value is string => Boolean(value)));
  for (const block of history) {
    const identity = contentBlockIdentity(block);
    if (identity && identities.has(identity)) continue;
    result.push(block);
    if (identity) identities.add(identity);
  }
  return result;
}

function contentBlockIdentity(block: TimelineContentBlock): string | undefined {
  const record = asRecord(block);
  if (!record) return undefined;
  const sourceRunId = firstNonEmptyString(record.sourceRunId, record.source_run_id);
  const toolCallId = firstNonEmptyString(
    record.toolCallId,
    record.tool_call_id,
    record.sourceToolCallId,
    record.source_tool_call_id,
  );
  const identity = firstNonEmptyString(
    record.attachmentId,
    record.attachment_id,
    record.fileId,
    record.file_id,
    record.artifactId,
    record.artifact_id,
    record.url,
    record.openUrl,
    record.downloadUrl,
    record.downloadPath,
    record.download_path,
  );
  if (sourceRunId && toolCallId) {
    return `openclaw-tool-call\u0000${sourceRunId}\u0000${toolCallId}\u0000${identity ?? "media"}`;
  }
  return identity ? `${firstNonEmptyString(record.type) ?? "block"}:${identity}` : undefined;
}

/**
 * Return a per-reply assistant identity when the provider exposes one. OpenClaw
 * can emit several message-tool replies inside one provider run; the run id is
 * only their lineage and must not be reused as the stream/message identity.
 */
export function assistantReplyMessageId(payload: unknown, runId: string): string | undefined {
  const record = asRecord(payload);
  const message = asRecord(record?.message);
  // OpenClaw emits message-tool completion events with the authoritative
  // idempotency key on the chat event itself. Transcript/history rows put the
  // same field under `message`; accept both shapes so concurrent media replies
  // do not collapse onto the run-level assistant message.
  const messageToolIdempotency = firstNonEmptyString(
    message?.idempotencyKey,
    message?.idempotency_key,
    record?.idempotencyKey,
    record?.idempotency_key,
  );
  const messageToolReply = Boolean(messageToolIdempotency?.includes(":message-tool:"));
  const explicitIdentities = [
    record?.assistantMessageId,
    record?.assistant_message_id,
    record?.messageId,
    record?.message_id,
  ]
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter((value) => value.length > 0)
    .filter((value) => !isRunLevelAssistantIdentity(value, runId));
  const identities = [
    ...explicitIdentities,
    // The message-tool idempotency key is the authoritative identity for
    // independent media replies. Ordinary assistant transcript ids must stay
    // on the run-level canonical message so history and live events merge.
    ...(messageToolReply && messageToolIdempotency ? [messageToolIdempotency] : []),
    ...(messageToolReply ? [
      ...messageToolIdentityValues(message?.content),
      ...deliveryMediaIdentityValues(message?.openclawDelivery, runId),
      ...timelineMediaIdentityValues(record?.timelineEvents),
      ...mediaIdentityValues(message?.content),
    ] : []),
  ]
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter((value) => value.length > 0)
    .filter((value) => !isRunLevelAssistantIdentity(value, runId));
  const uniqueIdentities = [...new Set(identities)].sort();
  if (uniqueIdentities.length === 0) return undefined;
  const digest = createHash("sha256")
    .update(JSON.stringify(["openclaw-assistant-reply-v1", runId.trim(), uniqueIdentities]))
    .digest("hex")
    .slice(0, 24);
  return `assistant-${runId.trim()}-reply-${digest}`;
}

/**
 * Resolve the identity of a transcript delivery row when the live chat
 * terminal did not carry the provider's message-tool idempotency key.  The
 * transcript row id is stable for that delivery and, unlike the mobile run
 * id, remains unique when one OpenClaw run sends several media replies.
 * Only media-bearing rows use this fallback: ordinary assistant history
 * rows must continue to merge into the run-level text message.
 */
export function assistantHistoryReplyMessageId(
  message: HistoryMessage | undefined,
  runId: string,
): string | undefined {
  if (!message || nonTextContentBlocksFromHistory(message).length === 0) return undefined;
  const record = asRecord(message);
  const identity = firstNonEmptyString(
    record?.messageId,
    record?.message_id,
    record?.id,
  );
  return identity ? assistantReplyMessageId({ messageId: identity }, runId) : undefined;
}

function isRunLevelAssistantIdentity(value: string, runId: string): boolean {
  const normalizedRunId = runId.trim();
  return value === normalizedRunId
    || value === `assistant-${normalizedRunId}`
    || value === `message-${normalizedRunId}`
    || value === `${normalizedRunId}:assistant-media`
    || new RegExp(`:(?:user|assistant|tool|system)$`, "i").test(value);
}

function messageToolIdentityValues(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const record = asRecord(block);
    const type = firstNonEmptyString(record?.type)?.toLowerCase().replace(/[\s_-]+/g, "");
    const name = firstNonEmptyString(record?.name, record?.toolName, record?.tool_name)?.toLowerCase();
    const id = firstNonEmptyString(record?.id, record?.toolCallId, record?.tool_call_id);
    return id && name === "message" && ["toolcall", "tooluse", "functioncall"].includes(type ?? "")
      ? [`tool:${id}`]
      : [];
  });
}

function deliveryMediaIdentityValues(delivery: unknown, expectedRunId: string): string[] {
  const record = asRecord(delivery);
  // `mediaUrls` is only an upload/delivery receipt when it comes from the
  // explicit OpenClaw message-tool contract.  A generic payload field must not
  // become an assistant identity merely because it happens to be an array of
  // paths or URLs.
  if (
    record?.contract !== "openclaw.message-tool-delivery.v1"
    || record.toolName !== "message"
    || typeof record.toolCallId !== "string"
    || record.toolCallId.trim().length === 0
    || typeof record.idempotencyKey !== "string"
    || record.idempotencyKey.trim().length === 0
    || typeof record.sourceRunId !== "string"
    || record.sourceRunId.trim().length === 0
    || record.sourceRunId.trim() !== expectedRunId.trim()
  ) {
    return [];
  }
  return Array.isArray(record?.mediaUrls)
    ? record.mediaUrls.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
}

function timelineMediaIdentityValues(events: unknown): string[] {
  if (!Array.isArray(events)) return [];
  return events.flatMap((event) => {
    const record = asRecord(event);
    return record?.eventType === "message.completed" && record.role === "assistant"
      ? [
          ...stringArray(record.attachmentIds),
          ...mediaIdentityValues(record.content),
          ...messageToolIdentityValues(record.content),
        ]
      : [];
  });
}

function mediaIdentityValues(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const record = asRecord(block);
    const type = firstNonEmptyString(record?.type)?.toLowerCase();
    if (!type || !["image", "file", "audio", "voice", "video", "attachment"].includes(type)) return [];
    return [
      firstNonEmptyString(record?.attachmentId, record?.attachment_id),
      firstNonEmptyString(record?.fileId, record?.file_id),
      firstNonEmptyString(record?.artifactId, record?.artifact_id),
      firstNonEmptyString(record?.downloadUrl, record?.downloadPath, record?.download_path, record?.url),
    ].filter((value): value is string => Boolean(value));
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function stripUndefinedHistoryMessageFields(message: HistoryMessage): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(message).filter(([, value]) => value !== undefined),
  );
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

function deepField(payload: unknown, keys: string[]): unknown {
  const record = asRecord(payload);
  const message = asRecord(record?.message);
  const data = asRecord(record?.data);
  for (const key of keys) {
    if (record && record[key] !== undefined) return record[key];
    if (message && message[key] !== undefined) return message[key];
    if (data && data[key] !== undefined) return data[key];
  }
  return undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeFiniteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value.trim())
      : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  const number = normalizeFiniteNumber(value);
  return number !== undefined && number >= 0 ? Math.round(number) : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
