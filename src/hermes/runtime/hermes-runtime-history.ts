import { createHash } from "node:crypto";
import type { LocalResult } from "../../core/command-types.js";
import { canonicalizeMobileAssistantText } from "../../core/relay/mobile-chat-run-bridge.js";
import { buildHistorySnapshotPage } from "../../core/relay/timeline-event-builder.js";
import type { TimelineContentBlock } from "../../core/relay/timeline-event-log.js";
import { isTerminalHermesAssistantMessage } from "./hermes-runtime-history-completion.js";
import {
  hermesStateDbHistoryMessageId,
  type HermesStateDbMessageIdentityRole,
} from "./hermes-state-db-message-identity.js";
import { resolveHermesSessionIdFromParams, runHermesSessionExport } from "./hermes-runtime-sessions.js";
import { queryHermesHistoryPageFromStateDb } from "./hermes-runtime-state-db.js";
import { stringParam, toRecord } from "./hermes-runtime-values.js";

type HermesHistoryMessage = {
  id: string;
  role: string;
  content: TimelineContentBlock[];
  createdAt?: string;
  timestamp?: number | string;
  turnId?: string;
  runId?: string;
  partId?: string;
  clientMessageId?: string;
  idempotencyKey?: string;
  seq: number;
};

type ClawConnectMobileTurnMetadata = {
  sourceRunId?: string;
  sessionKey?: string;
};

type ActiveClawConnectMobileTurn = {
  turnId: string;
  runId: string;
};

const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 200;
const CURSOR_PREFIX = "seq:";
const CLAWCONNECT_MOBILE_BRIDGE_MARKER = "[ClawConnect mobile bridge]";
const CLAWCONNECT_MOBILE_TURN_MARKER = "[ClawConnect mobile turn]";
const HERMES_RUNTIME_CONTEXT_HINT_REGEX =
  /(^|\r?\n)[ \t]*\[Hermes runtime context\][\s\S]*?(?=\r?\n[ \t]*\[ClawConnect mobile bridge\]|\r?\n[ \t]*\[ClawConnect mobile turn\]|$)/gi;

type HermesHistoryCacheEntry = {
  parsed: unknown;
  sessionId?: string;
  messages: HermesHistoryMessage[];
};

const hermesHistoryCache = new Map<string, HermesHistoryCacheEntry>();

export function clearHermesHistoryCache(): void {
  hermesHistoryCache.clear();
}

export async function runHermesChatHistory(params: unknown): Promise<LocalResult> {
  const record = toRecord(params);
  const sessionKey = stringParam(record, "sessionKey", "session_key", "key", "session") ?? "main";
  const limit = normalizeHistoryLimit(record.limit);
  const cursorSeq = parseHistoryCursorSeq(record.cursor);
  const direction = normalizeHistoryDirection(record.direction);
  const resolved = await resolveHermesSessionIdFromParams(record);
  if (resolved.sessionId) {
    const stateDbPage = await queryHermesHistoryPageFromStateDb({
      sessionId: resolved.sessionId,
      limit,
      cursorSeq,
      direction,
    });
    if (stateDbPage) {
      const messages = normalizeHermesHistoryMessages({
        sessionId: stateDbPage.sessionId,
        messages: stateDbPage.messages,
        contextUser: stateDbPage.contextUser,
      }, { stateDbSessionId: stateDbPage.sessionId });
      return buildHermesHistoryResult({
        sessionKey,
        sessionId: stateDbPage.sessionId,
        cursor: typeof record.cursor === "string" ? record.cursor : undefined,
        page: {
          messages,
          hasMore: stateDbPage.hasMore,
          nextCursor: stateDbPage.nextCursor,
          newestCursor: stateDbPage.newestCursor,
        },
      });
    }
  }

  const exportResult = await runHermesSessionExport({
    ...record,
    sessionKey,
    output: "-",
    requireResolvedSession: true,
    skipStateDb: true,
    historyFallback: true,
  });
  if (!exportResult.ok) {
    return exportResult;
  }

  const exportOutput = toRecord(exportResult.payload).output;
  const exportHash = hashHermesHistoryExportOutput(exportOutput);
  const history = readHermesHistoryExportFromCache({
    sessionIdentity: stringParam(record, "sessionId", "session_id", "hermesSessionId", "id") ?? sessionKey,
    exportHash,
    exportOutput,
  });
  const parsed = history.parsed;
  const messages = history.messages;
  const page = paginateHermesHistory(messages, {
    limit,
    cursorSeq,
    direction,
  });

  const sessionId = stringParam(toRecord(parsed), "sessionId", "session_id", "id")
    ?? stringParam(record, "sessionId", "session_id", "hermesSessionId", "id");
  return buildHermesHistoryResult({
    sessionKey,
    sessionId,
    cursor: typeof record.cursor === "string" ? record.cursor : undefined,
    page,
  });
}

function buildHermesHistoryResult(params: {
  sessionKey: string;
  sessionId?: string;
  cursor?: string;
  page: { messages: HermesHistoryMessage[]; hasMore: boolean; nextCursor?: string; newestCursor?: string };
}): LocalResult {
  const { sessionKey, sessionId, page } = params;
  const payload = {
    sessionKey,
    ...(sessionId ? { sessionId } : {}),
    messages: page.messages,
    items: page.messages,
    hasMore: page.hasMore,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(page.newestCursor ? { newestCursor: page.newestCursor } : {}),
    timelineSnapshot: buildHistorySnapshotPage({
      gatewayId: "clawconnect",
      sessionKey,
      cursor: params.cursor ?? null,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor ?? null,
      newestCursor: page.newestCursor ?? null,
      orderPolicy: "transcript",
      messages: page.messages.map((message) => {
        const turnId = message.turnId ?? message.idempotencyKey ?? message.clientMessageId ?? `history-${sessionKey}-${message.seq}-${message.role}`;
        const attachmentIds = extractAttachmentIds(message.content);
        return {
          turnId,
          runId: message.runId ?? turnId,
          messageId: message.id,
          role: message.role as "user" | "assistant" | "tool" | "system",
          messageState: "completed" as const,
          createdAt: message.createdAt ?? timestampToIso(message.timestamp) ?? new Date().toISOString(),
          partId: message.partId ?? "part-text-1",
          content: message.content,
          seq: message.seq,
          turnSeq: message.seq,
          ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
          ...(message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : {}),
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        };
      }),
      attachments: [],
    }),
  };
  return { ok: true, payload };
}

function readHermesHistoryExportFromCache(params: {
  sessionIdentity: string;
  exportHash: string;
  exportOutput: unknown;
}): HermesHistoryCacheEntry {
  const primaryKey = hermesHistoryCacheKey(params.sessionIdentity, params.exportHash);
  const cached = hermesHistoryCache.get(primaryKey);
  if (cached) {
    return cached;
  }

  const parsed = parseHermesHistoryExportOutput(params.exportOutput);
  const sessionId = stringParam(toRecord(parsed), "sessionId", "session_id", "id");
  const entry: HermesHistoryCacheEntry = {
    parsed,
    ...(sessionId ? { sessionId } : {}),
    messages: normalizeHermesHistoryMessages(parsed),
  };
  hermesHistoryCache.set(primaryKey, entry);
  if (sessionId && sessionId !== params.sessionIdentity) {
    hermesHistoryCache.set(hermesHistoryCacheKey(sessionId, params.exportHash), entry);
  }
  return entry;
}

function hermesHistoryCacheKey(sessionIdentity: string, exportHash: string): string {
  return `${sessionIdentity}\u0000${exportHash}`;
}

function hashHermesHistoryExportOutput(value: unknown): string {
  const source = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(source ?? "").digest("hex");
}

function parseHermesHistoryExportOutput(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const firstObjectBrace = trimmed.indexOf("{");
    const lastObjectBrace = trimmed.lastIndexOf("}");
    if (firstObjectBrace >= 0 && lastObjectBrace > firstObjectBrace) {
      try {
        return JSON.parse(trimmed.slice(firstObjectBrace, lastObjectBrace + 1)) as unknown;
      } catch {
        return {};
      }
    }
    return {};
  }
}

function normalizeHermesHistoryMessages(
  parsed: unknown,
  options: { stateDbSessionId?: string } = {},
): HermesHistoryMessage[] {
  const record = toRecord(parsed);
  const rawMessages =
    Array.isArray(record.messages) ? record.messages
      : Array.isArray(record.items) ? record.items
        : Array.isArray(parsed) ? parsed
          : [];

  const sessionId = stringParam(record, "sessionId", "session_id", "id");
  const messages: HermesHistoryMessage[] = [];
  let activeMobileTurn = activeMobileTurnFromContextUser(record.contextUser);
  rawMessages.forEach((entry, index) => {
    const source = toRecord(entry);
    if (Object.keys(source).length === 0) {
      return;
    }
    const role = normalizeHistoryRole(source.role);
    // Hermes 在工具调用前也会写入带正文的 assistant 行。只有明确终态的
    // assistant 才能进入移动端历史，否则刷新会用中间提示覆盖同 run 的最终回答。
    if (role === "assistant" && !isTerminalHermesAssistantMessage(source)) {
      return;
    }
    const rawText = extractHistoryText(source);
    const mobileTurn = role === "user" ? parseClawConnectMobileTurnMetadata(rawText) : {};
    const normalized = normalizeHistoryText(role, rawText);
    const content = normalizeHistoryContentBlocks(source, normalized);
    if (!normalized && content.length === 0) {
      return;
    }
    const seq = numberParam(source, "seq") ?? index + 1;
    const sourceTurnId = stringParam(source, "turnId", "turn_id") ?? mobileTurn.sourceRunId;
    const sourceRunId = stringParam(source, "runId", "run_id") ?? mobileTurn.sourceRunId;
    const sourceClientMessageId = stringParam(source, "clientMessageId", "client_message_id") ?? mobileTurn.sourceRunId;
    const sourceIdempotencyKey = stringParam(source, "idempotencyKey", "idempotency_key") ?? mobileTurn.sourceRunId;
    const stateDbRowId = stringParam(source, "id") ?? seq;
    const mobileRunId = role === "user"
      ? mobileTurn.sourceRunId
      : role === "assistant"
        ? activeMobileTurn?.runId
        : undefined;
    const sourceMessageId = options.stateDbSessionId
      ? hermesStateDbHistoryMessageId({
        sessionId: options.stateDbSessionId,
        rowId: stateDbRowId,
        role: role as HermesStateDbMessageIdentityRole,
        mobileRunId,
      })
      : stringParam(source, "id", "messageId", "message_id") ?? `history-${seq}`;
    const message: HermesHistoryMessage = {
      id: sourceMessageId,
      role,
      content,
      ...(sourceTurnId ? { turnId: sourceTurnId } : {}),
      ...(sourceRunId ? { runId: sourceRunId } : {}),
      ...(stringParam(source, "partId", "part_id") ? { partId: stringParam(source, "partId", "part_id") } : {}),
      ...(sourceClientMessageId ? { clientMessageId: sourceClientMessageId } : {}),
      ...(sourceIdempotencyKey ? { idempotencyKey: sourceIdempotencyKey } : {}),
      ...(readTimestamp(source) ? { timestamp: readTimestamp(source) } : {}),
      ...(readCreatedAt(source) ? { createdAt: readCreatedAt(source) } : {}),
      seq,
    };
    const resolvedMessage = activeMobileTurn && (role === "assistant" || role === "tool")
      ? inheritClawConnectMobileTurn(message, activeMobileTurn)
      : message;
    messages.push(resolvedMessage);
    if (role === "user") {
      activeMobileTurn = sourceRunId && sourceTurnId
        ? { turnId: sourceTurnId, runId: sourceRunId }
        : undefined;
    }
  });
  return withHermesHistoryFallbackTimestamps(messages, sessionId);
}

function activeMobileTurnFromContextUser(value: unknown): ActiveClawConnectMobileTurn | undefined {
  const source = toRecord(value);
  if (Object.keys(source).length === 0 || normalizeHistoryRole(source.role) !== "user") {
    return undefined;
  }
  const metadata = parseClawConnectMobileTurnMetadata(extractHistoryText(source));
  return metadata.sourceRunId
    ? { turnId: metadata.sourceRunId, runId: metadata.sourceRunId }
    : undefined;
}

function inheritClawConnectMobileTurn(
  message: HermesHistoryMessage,
  turn: ActiveClawConnectMobileTurn,
): HermesHistoryMessage {
  // 显式的 mobile turn 元数据是 ClawConnect 与 Hermes history 的身份合同；
  // 同一用户 turn 内的后续 host 输出必须继承它，避免历史刷新把回答当成独立旧消息排序。
  return {
    ...message,
    turnId: message.turnId ?? turn.turnId,
    runId: message.runId ?? turn.runId,
  };
}

function normalizeHistoryRole(value: unknown): string {
  const role = typeof value === "string" ? value.trim().toLowerCase().replace("_", "") : "";
  switch (role) {
    case "user":
    case "assistant":
    case "system":
      return role;
    case "tool":
    case "toolresult":
      return "tool";
    default:
      return "assistant";
  }
}

function extractHistoryText(record: Record<string, unknown>): string {
  const content = record.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .flatMap((block) => {
        const blockRecord = toRecord(block);
        const type = typeof blockRecord.type === "string" ? blockRecord.type.trim().toLowerCase() : "";
        if (type && type !== "text" && type !== "output_text" && type !== "input_text") {
          return [];
        }
        return typeof blockRecord.text === "string" ? [blockRecord.text] : [];
      })
      .filter((text) => text.trim().length > 0)
      .join("\n\n");
  }
  for (const key of ["text", "message", "output"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

function normalizeHistoryContentBlocks(
  record: Record<string, unknown>,
  normalizedText: string,
): TimelineContentBlock[] {
  const blocks: TimelineContentBlock[] = [];
  if (normalizedText) {
    blocks.push({ type: "text", text: normalizedText });
  }

  const content = record.content;
  if (!Array.isArray(content)) {
    return blocks;
  }

  for (const block of content) {
    const blockRecord = toRecord(block);
    if (Object.keys(blockRecord).length === 0) {
      continue;
    }
    const type = typeof blockRecord.type === "string" ? blockRecord.type.trim().toLowerCase() : "";
    if (!type || type === "text" || type === "output_text" || type === "input_text") {
      continue;
    }
    blocks.push(normalizeAttachmentContentBlock({ ...blockRecord, type }));
  }

  return blocks;
}

function normalizeAttachmentContentBlock(block: TimelineContentBlock): TimelineContentBlock {
  const type = String(block.type).trim().toLowerCase();
  if (!["image", "file", "audio", "voice", "video"].includes(type)) {
    return { ...block, type };
  }
  const fileId = stringParam(block, "fileId", "file_id");
  const attachmentId =
    stringParam(block, "attachmentId", "attachment_id")
    ?? fileId
    ?? stableAttachmentId(block);
  return compactBlock({
    ...block,
    type: type === "voice" ? "audio" : type,
    ...(attachmentId ? { attachmentId } : {}),
    ...(fileId ? { fileId } : {}),
    ...(stringParam(block, "fileName", "file_name", "name", "filename") ? {
      fileName: stringParam(block, "fileName", "file_name", "name", "filename"),
    } : {}),
    ...(stringParam(block, "mimeType", "mime_type", "contentType", "content_type") ? {
      mimeType: stringParam(block, "mimeType", "mime_type", "contentType", "content_type"),
    } : {}),
    ...(numberParam(block, "byteSize", "byte_size", "sizeBytes", "size_bytes") ? {
      byteSize: numberParam(block, "byteSize", "byte_size", "sizeBytes", "size_bytes"),
    } : {}),
    ...(numberParam(block, "width", "imageWidth", "image_width") ? {
      width: numberParam(block, "width", "imageWidth", "image_width"),
    } : {}),
    ...(numberParam(block, "height", "imageHeight", "image_height") ? {
      height: numberParam(block, "height", "imageHeight", "image_height"),
    } : {}),
    transferState: stringParam(block, "transferState", "transfer_state", "status") ?? "available",
  });
}

function extractAttachmentIds(blocks: TimelineContentBlock[]): string[] {
  return blocks
    .map((block) => stringParam(block, "attachmentId", "attachment_id", "fileId", "file_id"))
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
}

function stableAttachmentId(block: Record<string, unknown>): string | undefined {
  const source = [
    stringParam(block, "fileName", "file_name", "name", "filename"),
    stringParam(block, "mimeType", "mime_type", "contentType", "content_type"),
    stringParam(block, "downloadUrl", "download_url", "downloadPath", "download_path", "url"),
    numberParam(block, "byteSize", "byte_size", "sizeBytes", "size_bytes"),
  ].filter((value) => value !== undefined).join("\u0000");
  return source ? `att_${createHash("sha256").update(source).digest("hex").slice(0, 16)}` : undefined;
}

function numberParam(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.round(value);
    }
  }
  return undefined;
}

function compactBlock(block: TimelineContentBlock): TimelineContentBlock {
  return Object.fromEntries(Object.entries(block).filter(([, value]) => value !== undefined)) as TimelineContentBlock;
}

function normalizeHistoryText(role: string, text: string): string {
  if (role === "user") {
    return stripClawConnectMobileBridgeMetadata(text).trim();
  }
  const canonical = canonicalizeMobileAssistantText(text);
  return canonical.text.trim();
}

function parseClawConnectMobileTurnMetadata(text: string): ClawConnectMobileTurnMetadata {
  const markerIndex = text.indexOf(CLAWCONNECT_MOBILE_TURN_MARKER);
  if (markerIndex < 0) {
    return {};
  }
  const metadataBlock = text.slice(markerIndex + CLAWCONNECT_MOBILE_TURN_MARKER.length);
  return {
    sourceRunId: metadataValue(metadataBlock, "sourceRunId"),
    sessionKey: metadataValue(metadataBlock, "sessionKey"),
  };
}

function metadataValue(block: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s*${escapedKey}\\s*:\\s*(.+?)\\s*$`, "im").exec(block);
  const value = match?.[1]?.trim();
  return value || undefined;
}

function stripClawConnectMobileBridgeMetadata(text: string): string {
  const withoutRuntimeContext = text
    .replace(HERMES_RUNTIME_CONTEXT_HINT_REGEX, "$1")
    .replace(/\n{3,}/g, "\n\n");
  const cutoff = [
    withoutRuntimeContext.indexOf(CLAWCONNECT_MOBILE_BRIDGE_MARKER),
    withoutRuntimeContext.indexOf(CLAWCONNECT_MOBILE_TURN_MARKER),
  ]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const visible = cutoff === undefined ? withoutRuntimeContext : withoutRuntimeContext.slice(0, cutoff);
  return visible
    .split(/\r?\n/)
    .filter((line) => !/^\s*\[file attached:\s+.+\]\s*$/i.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function readTimestamp(record: Record<string, unknown>): number | string | undefined {
  const value = record.timestamp ?? record.ts ?? record.time;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function readCreatedAt(record: Record<string, unknown>): string | undefined {
  return stringParam(record, "createdAt", "created_at");
}

function withHermesHistoryFallbackTimestamps(
  messages: HermesHistoryMessage[],
  sessionId: string | undefined,
): HermesHistoryMessage[] {
  const firstKnown = firstKnownHistoryTimestampMs(messages);
  let lastResolvedMs = hermesSessionStartMs(sessionId)
    ?? (firstKnown ? firstKnown.ms - firstKnown.index : undefined)
    ?? Date.now();
  lastResolvedMs -= 1;
  return messages.map((message) => {
    const knownMs = historyMessageTimestampMs(message);
    if (knownMs !== undefined) {
      lastResolvedMs = Math.max(lastResolvedMs + 1, knownMs);
      return message;
    }
    lastResolvedMs += 1;
    return {
      ...message,
      createdAt: new Date(lastResolvedMs).toISOString(),
    };
  });
}

function firstKnownHistoryTimestampMs(messages: HermesHistoryMessage[]): { index: number; ms: number } | undefined {
  for (const [index, message] of messages.entries()) {
    const ms = historyMessageTimestampMs(message);
    if (ms !== undefined) {
      return { index, ms };
    }
  }
  return undefined;
}

function historyMessageTimestampMs(message: HermesHistoryMessage): number | undefined {
  const createdAtMs = Date.parse(message.createdAt ?? "");
  if (Number.isFinite(createdAtMs)) {
    return createdAtMs;
  }
  const timestamp = timestampToIso(message.timestamp);
  const timestampMs = Date.parse(timestamp ?? "");
  return Number.isFinite(timestampMs) ? timestampMs : undefined;
}

function hermesSessionStartMs(sessionId: string | undefined): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(sessionId ?? "");
  if (!match) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function timestampToIso(value: number | string | undefined): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 10_000_000_000 ? value * 1_000 : value).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return new Date(parsed < 10_000_000_000 ? parsed * 1_000 : parsed).toISOString();
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

function normalizeHistoryLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) {
    return DEFAULT_HISTORY_LIMIT;
  }
  return Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.floor(parsed)));
}

function normalizeHistoryDirection(value: unknown): "older" | "newer" {
  return typeof value === "string" && value.trim().toLowerCase() === "newer" ? "newer" : "older";
}

function parseHistoryCursorSeq(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith(CURSOR_PREFIX)) {
    return undefined;
  }
  const parsed = Number(trimmed.slice(CURSOR_PREFIX.length));
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : undefined;
}

function paginateHermesHistory(
  messages: HermesHistoryMessage[],
  options: { limit: number; cursorSeq?: number; direction: "older" | "newer" },
): { messages: HermesHistoryMessage[]; hasMore: boolean; nextCursor?: string; newestCursor?: string } {
  const sorted = [...messages].sort((left, right) => left.seq - right.seq);
  const filtered = options.cursorSeq === undefined
    ? sorted
    : options.direction === "newer"
      ? sorted.filter((message) => message.seq > options.cursorSeq!)
      : sorted.filter((message) => message.seq < options.cursorSeq!);
  const page = options.direction === "newer"
    ? filtered.slice(0, options.limit)
    : filtered.slice(Math.max(0, filtered.length - options.limit));
  const hasMore = filtered.length > page.length;
  const firstSeq = page[0]?.seq;
  const lastSeq = page[page.length - 1]?.seq;
  return {
    messages: page,
    hasMore,
    ...(hasMore && firstSeq !== undefined && options.direction === "older" ? { nextCursor: `${CURSOR_PREFIX}${firstSeq}` } : {}),
    ...(hasMore && lastSeq !== undefined && options.direction === "newer" ? { nextCursor: `${CURSOR_PREFIX}${lastSeq}` } : {}),
    ...(lastSeq !== undefined ? { newestCursor: `${CURSOR_PREFIX}${lastSeq}` } : {}),
  };
}
