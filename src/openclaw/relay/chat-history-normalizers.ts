import { createHash } from "node:crypto";
import type { TimelineContentBlock, TimelineMessageState, TimelineRole } from "../../core/relay/timeline-event-log.js";
import type { ChatHistoryDirection, HistoryMessage } from "./chat-history.js";

/**
 * OpenClaw 历史行的纯归一化/分页/内容块工具：无 I/O、无状态，仅依赖类型定义。
 * 从 chat-history.ts 拆出以保持读取管线文件的内聚；对外契约与原实现完全一致。
 */
export const DEFAULT_TRANSCRIPT_HISTORY_LIMIT = 100;
export const MAX_TRANSCRIPT_HISTORY_LIMIT = 200;
export const CURSOR_PREFIX = "seq:";

export function openClawHistoryMetadata(message: HistoryMessage): Record<string, unknown> | undefined {
  return isRecord(message.__openclaw) ? message.__openclaw : undefined;
}

export function openClawHistoryString(message: HistoryMessage, ...fields: string[]): string | undefined {
  const metadata = openClawHistoryMetadata(message);
  return metadata ? historyString(metadata, ...fields) : undefined;
}

export function openClawRunId(message: HistoryMessage): string | undefined {
  return openClawHistoryString(message, "runId", "run_id");
}

export function openClawTranscriptSource(message: HistoryMessage): string | undefined {
  const position = openClawHistoryMetadata(message)?.transcriptPosition;
  return isRecord(position) ? historyString(position, "source") : undefined;
}

export function cleanHistoryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function paginateHistoryMessages(
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

export function resolveOlderEndExclusive(messages: HistoryMessage[], cursorSeq: number | undefined): number {
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

export function firstIndexAfterSeq(messages: HistoryMessage[], cursorSeq: number): number {
  const index = messages.findIndex((message) => {
    const seq = messageSeq(message);
    return seq !== undefined && seq > cursorSeq;
  });
  return index === -1 ? messages.length : index;
}

export function normalizeHistoryLimit(value: unknown): number {
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

export function normalizeHistoryDirection(value: unknown): ChatHistoryDirection {
  return value === "newer" ? "newer" : "older";
}

export function requireProjectionIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`OpenClaw projection v3 identity is missing ${field}`);
  }
  return value.trim();
}

export function requireProjectionSequence(value: number | undefined, index: number): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    throw new Error(`OpenClaw projection v3 sourceOrderSeq is missing or invalid at row ${index}`);
  }
  return value as number;
}

export function normalizeCursor(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function parseHistoryCursorSeq(value: unknown): number | undefined {
  const cursor = normalizeCursor(value);
  if (!cursor) {
    return undefined;
  }
  const raw = cursor.startsWith(CURSOR_PREFIX) ? cursor.slice(CURSOR_PREFIX.length) : cursor;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function formatHistoryCursor(seq: number): string {
  return `${CURSOR_PREFIX}${seq}`;
}

export function firstMessageSeq(messages: HistoryMessage[]): number | undefined {
  return messageSeq(messages[0]);
}

export function lastMessageSeq(messages: HistoryMessage[]): number | undefined {
  return messageSeq(messages[messages.length - 1]);
}

export function messageSeq(message: HistoryMessage | undefined): number | undefined {
  const raw = message?.seq ?? (message ? historyNumber(openClawHistoryMetadata(message) ?? {}, "seq") : undefined);
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.round(raw) : undefined;
}

export function normalizeHistoryTimestamp(value: unknown): number | undefined {
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

export function normalizeHistoryCreatedAt(value: unknown): string | undefined {
  const timestamp = normalizeHistoryTimestamp(value);
  return timestamp === undefined ? undefined : new Date(timestamp).toISOString();
}

export function normalizeTimelineRole(value: unknown): TimelineRole {
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

export function normalizeTimelineMessageState(message: HistoryMessage): TimelineMessageState {
  return typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0
    ? "failed"
    : "completed";
}

export function normalizeTimelineCreatedAt(message: HistoryMessage): string | undefined {
  if (typeof message.createdAt === "string" && message.createdAt.trim().length > 0) {
    return message.createdAt.trim();
  }
  const timestamp = normalizeHistoryTimestamp(message.timestamp);
  return timestamp === undefined ? undefined : new Date(timestamp).toISOString();
}

export function fallbackTimelineCreatedAt(messages: HistoryMessage[], index: number): string {
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

export function normalizeTimelineContentBlocks(value: HistoryMessage["content"]): TimelineContentBlock[] {
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

export function normalizeTimelineContentBlock(block: TimelineContentBlock): TimelineContentBlock {
  const type = String(block.type).trim().toLowerCase();
  if (!["image", "file", "audio", "voice", "video"].includes(type)) {
    return { ...block, type };
  }

  const fileId = historyString(block, "fileId", "file_id");
  const previewUrl = historyString(block, "previewUrl", "preview_url", "thumbnailUrl", "thumbnail_url");
  const downloadUrl = historyString(block, "downloadUrl", "download_url", "downloadPath", "download_path", "url");
  const declaredTransferState = historyString(block, "transferState", "transfer_state", "status");
  // OpenClaw transcripts can retain an attachment identity after its media
  // object has disappeared. Such a block is a stable unavailable placeholder,
  // not an available attachment: Relay intentionally rejects available blocks
  // that cannot be previewed or downloaded.
  const claimsAvailability = declaredTransferState === undefined
    || ["available", "linked", "uploaded"].includes(declaredTransferState.toLowerCase());
  const transferState = !previewUrl && !downloadUrl && claimsAvailability
    ? "expired"
    : declaredTransferState ?? "available";
  const attachmentId =
    historyString(block, "attachmentId", "attachment_id")
    ?? fileId
    ?? stableAttachmentId(block);
  return compactBlock({
    ...block,
    type: type === "voice" ? "audio" : type,
    ...(attachmentId ? { attachmentId } : {}),
    ...(fileId ? { fileId } : {}),
    ...(previewUrl ? { previewUrl } : {}),
    ...(downloadUrl ? { downloadUrl } : {}),
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
    transferState,
    ...(!previewUrl && !downloadUrl && transferState === "expired" ? { isRemoteExpired: true } : {}),
  });
}

export function extractAttachmentIds(blocks: TimelineContentBlock[]): string[] {
  return blocks
    .map((block) => historyString(block, "attachmentId", "attachment_id", "fileId", "file_id"))
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
}

export function stableAttachmentId(block: Record<string, unknown>): string | undefined {
  const source = [
    historyString(block, "fileName", "file_name", "name", "filename"),
    historyString(block, "mimeType", "mime_type", "contentType", "content_type"),
    historyString(block, "downloadUrl", "download_url", "downloadPath", "download_path", "url"),
    historyNumber(block, "byteSize", "byte_size", "sizeBytes", "size_bytes"),
  ].filter((value) => value !== undefined).join("\u0000");
  return source ? `att_${createHash("sha256").update(source).digest("hex").slice(0, 16)}` : undefined;
}

export function compactBlock(block: TimelineContentBlock): TimelineContentBlock {
  return Object.fromEntries(Object.entries(block).filter(([, value]) => value !== undefined)) as TimelineContentBlock;
}

export function historyString(record: Record<string, unknown>, ...fields: string[]): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function historyNumber(record: Record<string, unknown>, ...fields: string[]): number | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.round(value);
    }
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
