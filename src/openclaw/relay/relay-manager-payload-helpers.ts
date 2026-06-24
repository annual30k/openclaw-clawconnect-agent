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

export function shouldUseLegacyOpenClawHistoryFallback(
  params: unknown,
  sessionDefaults: GatewaySessionDefaults,
): boolean {
  const record = asRecord(params) ?? {};
  const rawSessionKey =
    typeof record.sessionKey === "string" && record.sessionKey.trim().length > 0
      ? record.sessionKey.trim()
      : sessionDefaults.mainSessionKey;
  const normalized = canonicalizeSessionKey(rawSessionKey, sessionDefaults);
  return typeof normalized === "string" && normalized === sessionDefaults.mainSessionKey;
}

// legacy OpenClaw 只可靠暴露主会话历史。非主会话不能回退到 legacy 参数，
// 否则会把其他会话的历史映射到当前移动端 session。
export function buildLegacyOpenClawHistoryParams(
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
): unknown {
  const payload = outcome.text.trim()
    ? withMessageText(basePayload, outcome.text)
    : asRecord(basePayload)
      ? { ...asRecord(basePayload) }
      : {};
  const historyMessage = outcome.message;
  const content = Array.isArray(historyMessage.content) ? historyMessage.content : [];
  if (content.length === 0) {
    return payload;
  }
  const payloadRecord = asRecord(payload) ?? {};
  const existingMessage = asRecord(payloadRecord.message) ?? {};
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
