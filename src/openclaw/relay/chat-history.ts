import { createHash } from "node:crypto";
import { readFile, stat } from "fs/promises";
import { buildHistorySnapshotPage } from "../../core/relay/timeline-event-builder.js";
import type {
  CanonicalTimelineHistorySnapshotPage,
  TimelineContentBlock,
  TimelineMessageState,
  TimelineRole,
} from "../../core/relay/timeline-event-log.js";
import {
  resolveOpenClawSessionTranscript,
  type GatewaySessionDefaults,
} from "./session-context.js";

export type HistoryMessage = {
  [key: string]: unknown;
  id?: string;
  role?: string;
  content?: string | HistoryContentBlock[];
  timestamp?: number;
  createdAt?: string;
  seq?: number;
  clientMessageId?: string;
  idempotencyKey?: string;
  stopReason?: string;
  errorMessage?: string;
};

export type HistoryContentBlock = Record<string, unknown> & {
  type?: string;
  text?: string;
};

export type HistoryResponse = {
  sessionKey?: string;
  sessionId?: string;
  messages?: HistoryMessage[];
  hasMore?: boolean;
  nextCursor?: string;
  newestCursor?: string;
  timelineSnapshot?: CanonicalTimelineHistorySnapshotPage;
};

export type ChatHistoryOutcome =
  | { kind: "final"; text: string; message: HistoryMessage }
  | { kind: "error"; errorMessage: string }
  | null;

export type ChatRunContext = {
  sessionKey: string;
  requestedAtMs: number;
  promptText?: string;
};

export type ChatHistoryDirection = "older" | "newer";

export type TranscriptHistoryRequest = {
  sessionKey: string;
  sessionId?: string;
  transcriptPath: string;
  limit?: unknown;
  cursor?: unknown;
  direction?: unknown;
};

const DEFAULT_TRANSCRIPT_HISTORY_LIMIT = 100;
const MAX_TRANSCRIPT_HISTORY_LIMIT = 200;
const CURSOR_PREFIX = "seq:";

type TranscriptHistoryCacheEntry = {
  size: number;
  mtimeMs: number;
  messages: HistoryMessage[];
};

const transcriptHistoryCache = new Map<string, TranscriptHistoryCacheEntry>();

export function clearTranscriptHistoryCache(): void {
  transcriptHistoryCache.clear();
}

export async function readOpenClawTranscriptChatHistory(
  rawParams: unknown,
  defaults: GatewaySessionDefaults,
): Promise<HistoryResponse | null> {
  const params = normalizeTranscriptHistoryParams(rawParams, defaults.mainSessionKey);
  const transcript = await resolveOpenClawSessionTranscript(params.sessionKey, defaults);
  if (!transcript) {
    return null;
  }

  return readChatHistoryFromTranscriptFile({
    sessionKey: transcript.sessionKey,
    sessionId: transcript.sessionId,
    transcriptPath: transcript.logPath,
    limit: params.limit,
    cursor: params.cursor,
    direction: params.direction,
  });
}

export async function readChatHistoryFromTranscriptFile(
  request: TranscriptHistoryRequest,
): Promise<HistoryResponse> {
  const messages = await readIndexedTranscriptMessages(request.transcriptPath);
  const limit = normalizeHistoryLimit(request.limit);
  const direction = normalizeHistoryDirection(request.direction);
  const cursorSeq = parseHistoryCursorSeq(request.cursor);
  const page = paginateHistoryMessages(messages, {
    limit,
    direction,
    cursorSeq,
  });

  return {
    sessionKey: request.sessionKey,
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    messages: page.messages,
    hasMore: page.hasMore,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(page.newestCursor ? { newestCursor: page.newestCursor } : {}),
    timelineSnapshot: buildHistorySnapshotPage({
      gatewayId: "clawconnect",
      sessionKey: request.sessionKey,
      cursor: normalizeCursor(request.cursor) ?? null,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor ?? null,
      newestCursor: page.newestCursor ?? null,
      orderPolicy: "transcript",
      messages: page.messages.map((message, index) => {
        const seq = messageSeq(message) ?? index + 1;
        const role = normalizeTimelineRole(message.role);
        const clientMessageId = historyString(message, "clientMessageId", "client_message_id");
        const idempotencyKey = historyString(message, "idempotencyKey", "idempotency_key");
        const messageId = historyString(message, "messageId", "message_id", "id");
        const turnId =
          historyString(message, "turnId", "turn_id")
          ?? idempotencyKey
          ?? clientMessageId
          ?? messageId
          ?? `history-${request.sessionKey}-${seq}-${role}`;
        const content = normalizeTimelineContentBlocks(message.content);
        return {
          turnId,
          runId: historyString(message, "runId", "run_id") ?? turnId,
          messageId: messageId ?? `${role}-${turnId}`,
          role,
          messageState: normalizeTimelineMessageState(message),
          createdAt: normalizeTimelineCreatedAt(message) ?? fallbackTimelineCreatedAt(page.messages, index),
          partId: historyString(message, "partId", "part_id") ?? "part-text-1",
          content,
          seq,
          turnSeq: historyNumber(message, "turnSeq", "turn_seq") ?? seq,
          ...(clientMessageId ? { clientMessageId } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(extractAttachmentIds(content).length > 0 ? { attachmentIds: extractAttachmentIds(content) } : {}),
        };
      }),
      attachments: [],
    }),
  };
}

function normalizeTranscriptHistoryParams(
  rawParams: unknown,
  fallbackSessionKey: string,
): { sessionKey: string; limit: number; cursor?: string; direction: ChatHistoryDirection } {
  const record = isRecord(rawParams) ? rawParams : {};
  const sessionKey = typeof record.sessionKey === "string" && record.sessionKey.trim().length > 0
    ? record.sessionKey.trim()
    : fallbackSessionKey;
  const cursor = normalizeCursor(record.cursor);
  return {
    sessionKey,
    limit: normalizeHistoryLimit(record.limit),
    ...(cursor ? { cursor } : {}),
    direction: normalizeHistoryDirection(record.direction),
  };
}

async function readIndexedTranscriptMessages(transcriptPath: string): Promise<HistoryMessage[]> {
  const stats = await stat(transcriptPath);
  const cached = transcriptHistoryCache.get(transcriptPath);
  if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
    return cached.messages;
  }

  const raw = await readFile(transcriptPath, "utf8");
  const messages: HistoryMessage[] = [];
  for (const line of raw.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const message = parseTranscriptHistoryLine(trimmed, messages.length + 1);
    if (message) {
      messages.push(message);
    }
  }

  transcriptHistoryCache.set(transcriptPath, {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    messages,
  });
  return messages;
}

function parseTranscriptHistoryLine(line: string, seq: number): HistoryMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || parsed.type !== "message") {
    return null;
  }

  const rawMessage = isRecord(parsed.message) ? parsed.message : undefined;
  if (!rawMessage) {
    return null;
  }

  const message: HistoryMessage = { ...rawMessage, seq };
  if (typeof message.id !== "string" || message.id.trim().length === 0) {
    const id = typeof parsed.id === "string" && parsed.id.trim().length > 0 ? parsed.id.trim() : `transcript-${seq}`;
    message.id = id;
  }
  const timestamp = normalizeHistoryTimestamp(message.timestamp ?? parsed.timestamp);
  if (timestamp !== undefined) {
    message.timestamp = timestamp;
  }
  const createdAt = normalizeHistoryCreatedAt(parsed.timestamp ?? message.timestamp);
  if (createdAt && (typeof message.createdAt !== "string" || message.createdAt.trim().length === 0)) {
    message.createdAt = createdAt;
  }
  return message;
}

function paginateHistoryMessages(
  messages: HistoryMessage[],
  opts: { limit: number; direction: ChatHistoryDirection; cursorSeq?: number },
): { messages: HistoryMessage[]; hasMore: boolean; nextCursor?: string; newestCursor?: string } {
  if (messages.length === 0) {
    return { messages: [], hasMore: false };
  }

  if (opts.direction === "newer") {
    const startIndex = opts.cursorSeq === undefined
      ? Math.max(0, messages.length - opts.limit)
      : firstIndexAfterSeq(messages, opts.cursorSeq);
    const page = messages.slice(startIndex, startIndex + opts.limit);
    return {
      messages: page,
      hasMore: startIndex + page.length < messages.length,
      ...(lastMessageSeq(page) ? { newestCursor: formatHistoryCursor(lastMessageSeq(page)!) } : {}),
    };
  }

  const endExclusive = resolveOlderEndExclusive(messages, opts.cursorSeq);
  const start = Math.max(0, endExclusive - opts.limit);
  const page = messages.slice(start, endExclusive);
  const firstSeq = firstMessageSeq(page);
  const newestSeq = lastMessageSeq(page);
  return {
    messages: page,
    hasMore: start > 0,
    ...(start > 0 && firstSeq ? { nextCursor: formatHistoryCursor(firstSeq) } : {}),
    ...(newestSeq ? { newestCursor: formatHistoryCursor(newestSeq) } : {}),
  };
}

function resolveOlderEndExclusive(messages: HistoryMessage[], cursorSeq: number | undefined): number {
  if (cursorSeq === undefined) {
    return messages.length;
  }
  const newestSeq = messageSeq(messages[messages.length - 1]);
  if (newestSeq !== undefined && cursorSeq > newestSeq) {
    return messages.length;
  }
  const index = messages.findIndex((message) => {
    const seq = messageSeq(message);
    return seq !== undefined && seq >= cursorSeq;
  });
  return index === -1 ? messages.length : Math.max(0, index);
}

function firstIndexAfterSeq(messages: HistoryMessage[], cursorSeq: number): number {
  const index = messages.findIndex((message) => {
    const seq = messageSeq(message);
    return seq !== undefined && seq > cursorSeq;
  });
  return index === -1 ? messages.length : index;
}

function normalizeHistoryLimit(value: unknown): number {
  const parsed =
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(value)
      : typeof value === "string" && value.trim().length > 0
        ? Number.parseInt(value.trim(), 10)
        : DEFAULT_TRANSCRIPT_HISTORY_LIMIT;
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TRANSCRIPT_HISTORY_LIMIT;
  }
  return Math.max(1, Math.min(MAX_TRANSCRIPT_HISTORY_LIMIT, parsed));
}

function normalizeHistoryDirection(value: unknown): ChatHistoryDirection {
  return value === "newer" ? "newer" : "older";
}

function normalizeCursor(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseHistoryCursorSeq(value: unknown): number | undefined {
  const cursor = normalizeCursor(value);
  if (!cursor) {
    return undefined;
  }
  const raw = cursor.startsWith(CURSOR_PREFIX) ? cursor.slice(CURSOR_PREFIX.length) : cursor;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function formatHistoryCursor(seq: number): string {
  return `${CURSOR_PREFIX}${seq}`;
}

function firstMessageSeq(messages: HistoryMessage[]): number | undefined {
  return messageSeq(messages[0]);
}

function lastMessageSeq(messages: HistoryMessage[]): number | undefined {
  return messageSeq(messages[messages.length - 1]);
}

function messageSeq(message: HistoryMessage | undefined): number | undefined {
  const raw = message?.seq;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.round(raw) : undefined;
}

function normalizeHistoryTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value > 10_000_000_000 ? value : value * 1000);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value.trim());
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.round(numeric > 10_000_000_000 ? numeric : numeric * 1000);
    }
    const parsed = Date.parse(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
  }
  return undefined;
}

function normalizeHistoryCreatedAt(value: unknown): string | undefined {
  const timestamp = normalizeHistoryTimestamp(value);
  return timestamp === undefined ? undefined : new Date(timestamp).toISOString();
}

function normalizeTimelineRole(value: unknown): TimelineRole {
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

function normalizeTimelineMessageState(message: HistoryMessage): TimelineMessageState {
  return typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0
    ? "failed"
    : "completed";
}

function normalizeTimelineCreatedAt(message: HistoryMessage): string | undefined {
  if (typeof message.createdAt === "string" && message.createdAt.trim().length > 0) {
    return message.createdAt.trim();
  }
  const timestamp = normalizeHistoryTimestamp(message.timestamp);
  return timestamp === undefined ? undefined : new Date(timestamp).toISOString();
}

function fallbackTimelineCreatedAt(messages: HistoryMessage[], index: number): string {
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    const createdAt = normalizeTimelineCreatedAt(messages[previous]);
    if (!createdAt) {
      continue;
    }
    const ms = Date.parse(createdAt);
    if (Number.isFinite(ms)) {
      return new Date(ms + (index - previous)).toISOString();
    }
  }
  for (let next = index + 1; next < messages.length; next += 1) {
    const createdAt = normalizeTimelineCreatedAt(messages[next]);
    if (!createdAt) {
      continue;
    }
    const ms = Date.parse(createdAt);
    if (Number.isFinite(ms)) {
      return new Date(Math.max(0, ms - (next - index))).toISOString();
    }
  }
  return new Date().toISOString();
}

function normalizeTimelineContentBlocks(value: HistoryMessage["content"]): TimelineContentBlock[] {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? [{ type: "text", text }] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((block): TimelineContentBlock[] => {
    if (!isRecord(block)) {
      return [];
    }
    const type = typeof block.type === "string" && block.type.trim().length > 0 ? block.type.trim() : "text";
    return [normalizeTimelineContentBlock({ ...block, type })];
  });
}

function normalizeTimelineContentBlock(block: TimelineContentBlock): TimelineContentBlock {
  const type = String(block.type).trim().toLowerCase();
  if (!["image", "file", "audio", "voice", "video"].includes(type)) {
    return { ...block, type };
  }

  const fileId = historyString(block, "fileId", "file_id");
  const attachmentId =
    historyString(block, "attachmentId", "attachment_id")
    ?? fileId
    ?? stableAttachmentId(block);
  return compactBlock({
    ...block,
    type: type === "voice" ? "audio" : type,
    ...(attachmentId ? { attachmentId } : {}),
    ...(fileId ? { fileId } : {}),
    ...(historyString(block, "fileName", "file_name", "name", "filename") ? {
      fileName: historyString(block, "fileName", "file_name", "name", "filename"),
    } : {}),
    ...(historyString(block, "mimeType", "mime_type", "contentType", "content_type") ? {
      mimeType: historyString(block, "mimeType", "mime_type", "contentType", "content_type"),
    } : {}),
    ...(historyNumber(block, "byteSize", "byte_size", "sizeBytes", "size_bytes") ? {
      byteSize: historyNumber(block, "byteSize", "byte_size", "sizeBytes", "size_bytes"),
    } : {}),
    ...(historyNumber(block, "width", "imageWidth", "image_width") ? {
      width: historyNumber(block, "width", "imageWidth", "image_width"),
    } : {}),
    ...(historyNumber(block, "height", "imageHeight", "image_height") ? {
      height: historyNumber(block, "height", "imageHeight", "image_height"),
    } : {}),
    transferState: historyString(block, "transferState", "transfer_state", "status") ?? "available",
  });
}

function extractAttachmentIds(blocks: TimelineContentBlock[]): string[] {
  return blocks
    .map((block) => historyString(block, "attachmentId", "attachment_id", "fileId", "file_id"))
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
}

function stableAttachmentId(block: Record<string, unknown>): string | undefined {
  const source = [
    historyString(block, "fileName", "file_name", "name", "filename"),
    historyString(block, "mimeType", "mime_type", "contentType", "content_type"),
    historyString(block, "downloadUrl", "download_url", "downloadPath", "download_path", "url"),
    historyNumber(block, "byteSize", "byte_size", "sizeBytes", "size_bytes"),
  ].filter((value) => value !== undefined).join("\u0000");
  return source ? `att_${createHash("sha256").update(source).digest("hex").slice(0, 16)}` : undefined;
}

function compactBlock(block: TimelineContentBlock): TimelineContentBlock {
  return Object.fromEntries(Object.entries(block).filter(([, value]) => value !== undefined)) as TimelineContentBlock;
}

function historyString(record: Record<string, unknown>, ...fields: string[]): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function historyNumber(record: Record<string, unknown>, ...fields: string[]): number | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.round(value);
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function extractHistoryOutcome(
  history: HistoryResponse | undefined,
  context: ChatRunContext,
): ChatHistoryOutcome {
  const messages = history?.messages ?? [];
  if (messages.length === 0) {
    return null;
  }

  const userIndex = findHistoryUserIndex(messages, context);
  if (userIndex === -1) {
    return null;
  }
  if (hasUnresolvedUserBefore(messages, userIndex)) {
    return null;
  }

  let latestError: string | null = null;
  for (let index = userIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "user") {
      return null;
    }
    if (message.role !== "assistant") {
      continue;
    }
    const text = extractHistoryMessageText(message);
    if (text.length > 0 || hasHistoryMessageContent(message)) {
      return { kind: "final", text, message };
    }
    if (
      typeof message.errorMessage === "string" &&
      message.errorMessage.trim().length > 0 &&
      (message.stopReason === "error" || !message.stopReason)
    ) {
      latestError = message.errorMessage.trim();
    }
  }

  return latestError ? { kind: "error", errorMessage: latestError } : null;
}

function hasUnresolvedUserBefore(messages: HistoryMessage[], userIndex: number): boolean {
  for (let index = userIndex - 1; index >= 0; index -= 1) {
    const role = messages[index]?.role;
    if (role === "assistant") {
      return false;
    }
    if (role === "user") {
      return true;
    }
  }
  return false;
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
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

function extractHistoryMessageText(message: HistoryMessage | undefined): string {
  if (typeof message?.content === "string") {
    return message.content.trim();
  }
  const content = Array.isArray(message?.content) ? message.content : [];
  const parts = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text?.trim() ?? "")
    .filter((text) => text.length > 0);
  return parts.join("\n\n");
}

function hasHistoryMessageContent(message: HistoryMessage | undefined): boolean {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }

    const type = typeof block.type === "string" ? block.type.trim().toLowerCase() : "";
    if (type === "text" || type === "markdown" || type === "output_text" || type === "input_text") {
      return typeof block.text === "string" && block.text.trim().length > 0;
    }
    if (isToolOnlyHistoryBlockType(type)) {
      return false;
    }

    return Object.entries(block).some(([key, value]) => {
      if (key === "type") {
        return false;
      }
      if (typeof value === "string") {
        return value.trim().length > 0;
      }
      return value !== undefined && value !== null;
    });
  });
}

function isToolOnlyHistoryBlockType(type: string): boolean {
  return type === "tool_call"
    || type === "tool_use"
    || type === "tool_result"
    || type === "function_call"
    || type === "function_result"
    || type === "computer_call"
    || type === "computer_call_output";
}

function findHistoryUserIndex(messages: HistoryMessage[], context: ChatRunContext): number {
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
    if (!normalizedPrompt || historyUserTextMatches(text, normalizedPrompt)) {
      return index;
    }
  }

  return -1;
}

function historyUserTextMatches(text: string, normalizedPrompt: string): boolean {
  return text === normalizedPrompt || text.endsWith(normalizedPrompt);
}
