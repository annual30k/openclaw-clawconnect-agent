import { createHash } from "node:crypto";
import type { LocalResult } from "../../core/command-types.js";
import { canonicalizeMobileAssistantText } from "../../core/relay/mobile-chat-run-bridge.js";
import { buildHistorySnapshotPage } from "../../core/relay/timeline-event-builder.js";
import type { TimelineContentBlock } from "../../core/relay/timeline-event-log.js";
import { runHermesSessionExport } from "./hermes-runtime-sessions.js";
import { stringParam, toRecord } from "./hermes-runtime-values.js";

type HermesHistoryMessage = {
  id: string;
  role: string;
  content: TimelineContentBlock[];
  createdAt?: string;
  timestamp?: number | string;
  seq: number;
};

const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 200;
const CURSOR_PREFIX = "seq:";

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
  const exportResult = await runHermesSessionExport({ ...record, sessionKey, output: "-" });
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
    limit: normalizeHistoryLimit(record.limit),
    cursorSeq: parseHistoryCursorSeq(record.cursor),
    direction: normalizeHistoryDirection(record.direction),
  });

  const sessionId = stringParam(toRecord(parsed), "sessionId", "session_id", "id")
    ?? stringParam(record, "sessionId", "session_id", "hermesSessionId", "id");
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
      cursor: typeof record.cursor === "string" ? record.cursor : null,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor ?? null,
      newestCursor: page.newestCursor ?? null,
      messages: page.messages.map((message) => {
        const turnId = `history-${sessionKey}-${message.seq}-${message.role}`;
        return {
          turnId,
          runId: turnId,
          messageId: `${message.role}-${turnId}`,
          role: message.role as "user" | "assistant" | "tool" | "system",
          messageState: "completed" as const,
          createdAt: message.createdAt ?? timestampToIso(message.timestamp) ?? new Date(0).toISOString(),
          partId: "part-text-1",
          content: message.content,
          seq: message.seq,
          turnSeq: message.seq,
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

function normalizeHermesHistoryMessages(parsed: unknown): HermesHistoryMessage[] {
  const record = toRecord(parsed);
  const rawMessages =
    Array.isArray(record.messages) ? record.messages
      : Array.isArray(record.items) ? record.items
        : Array.isArray(parsed) ? parsed
          : [];

  return rawMessages.flatMap((entry, index): HermesHistoryMessage[] => {
    const source = toRecord(entry);
    if (Object.keys(source).length === 0) {
      return [];
    }
    const role = normalizeHistoryRole(source.role);
    const rawText = extractHistoryText(source);
    const normalized = normalizeHistoryText(role, rawText);
    const content = normalizeHistoryContentBlocks(source, normalized);
    if (!normalized && content.length === 0) {
      return [];
    }
    const seq = index + 1;
    return [{
      id: stringParam(source, "id", "messageId", "message_id") ?? `history-${seq}`,
      role,
      content,
      ...(readTimestamp(source) ? { timestamp: readTimestamp(source) } : {}),
      ...(readCreatedAt(source) ? { createdAt: readCreatedAt(source) } : {}),
      seq,
    }];
  });
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
    blocks.push({ ...blockRecord, type });
  }

  return blocks;
}

function normalizeHistoryText(role: string, text: string): string {
  if (role === "user") {
    return text.trim();
  }
  const canonical = canonicalizeMobileAssistantText(text);
  return canonical.text.trim();
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
