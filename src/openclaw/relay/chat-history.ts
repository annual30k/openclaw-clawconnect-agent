import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { restoreGatewayHistoryMessages } from "./gateway-history-projection.js";
import { readFile, stat } from "fs/promises";
import { buildHistorySnapshotPage } from "../../core/relay/timeline-event-builder.js";
import type {
  CanonicalTimelineHistorySnapshotPage,
  TimelineContentBlock,
  TimelineHistoryMessage,
  TimelineMessageState,
  TimelineRole,
} from "../../core/relay/timeline-event-log.js";
import {
  canonicalizeOpenClawSessionScope,
  resolveOpenClawSessionTranscript,
  sessionKeyCandidates,
  type GatewaySessionDefaults,
} from "./session-context.js";
import { resolveOpenClawStateDir } from "../runtime/openclaw-paths.js";
import {
  normalizeOpenClawAssistantMediaSidecars,
  normalizeOpenClawAutomaticMediaReplies,
} from "./assistant-media-sidecar.js";
import { adaptOpenClawMessageToolDelivery } from "./outgoing-media-relay.js";
import {
  canonicalProjectionMessageId,
  createProjectionMetadata,
  openClawAgentIdFromSessionKey,
  openClawSourceOrderScope,
} from "../../core/relay/timeline-projection-v3.js";
import { createSourceCommit, type SourceCommit } from "../../core/relay/source-commit.js";

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
  parentId?: string;
  turnId?: string;
  runId?: string;
  messageId?: string;
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
  projectionVersion?: 3;
  timelineSnapshot?: CanonicalTimelineHistorySnapshotPage;
  /** Internal source-range metadata used by the source-commit watcher. */
  sourceReadThroughSeq?: number;
  sourceRangeStartSeq?: number;
  sourceRangeHasGap?: boolean;
  sourceHasMore?: boolean;
};

export type ChatHistoryOutcome =
  | { kind: "final"; text: string; message: HistoryMessage }
  | { kind: "error"; errorMessage: string }
  | null;

export type ChatRunContext = {
  sessionKey: string;
  canonicalRunId: string;
  promptText?: string;
};

export type ChatHistoryDirection = "older" | "newer";

export type TranscriptHistoryRequest = {
  sessionKey: string;
  sessionId?: string;
  transcriptPath: string;
  /** Internal Relay identity; never forwarded to OpenClaw's wire API. */
  projectionGatewayId?: string;
  limit?: unknown;
  cursor?: unknown;
  direction?: unknown;
  projectionVersion?: 3;
  sessionDefaults?: GatewaySessionDefaults;
};

/**
 * Read the durable OpenClaw SQLite watermark for one session. This is a
 * source-commit signal only; callers must not use it to derive message ids or
 * reorder rows. It intentionally returns null when the authoritative SQLite
 * source is not available so the caller can use the native gateway stream.
 */
export function readOpenClawSourceCommitCursor(
  rawParams: unknown,
  defaults: GatewaySessionDefaults,
): SourceCommit | null {
  const params = normalizeTranscriptHistoryParams(rawParams, defaults.mainSessionKey);
  const agentId = params.sessionKey.match(/^agent:([^:]+):/)?.[1] ?? defaults.defaultAgentId ?? "main";
  const databasePath = join(resolveOpenClawStateDir(), "agents", agentId, "agent", "openclaw-agent.sqlite");
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const session = findSqliteSessionNode(database, params.sessionKey, defaults);
    const sourceSessionId = cleanHistoryString(session?.current_session_id);
    if (!sourceSessionId) return null;
    const row = database.prepare(`
      SELECT MAX(seq) AS committed_through_seq
      FROM transcript_events
      WHERE session_id = ?
    `).get(sourceSessionId) as { committed_through_seq?: unknown } | undefined;
    const committedThroughSeq = Number(row?.committed_through_seq ?? 0);
    if (!Number.isSafeInteger(committedThroughSeq) || committedThroughSeq < 0) return null;
    const gatewayId = requireProjectionIdentity(params.projectionGatewayId, "gatewayId");
    const sourceOrderScope = openClawSourceOrderScope({ agentId, sessionId: sourceSessionId });
    return createSourceCommit({
      gatewayType: "openclaw",
      gatewayId,
      producerId: agentId,
      sourceSessionId,
      sourceOrderScope,
      sourceGeneration: sourceSessionId,
      committedThroughSeq,
      sourceRevision: `seq:${committedThroughSeq}`,
    });
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

const DEFAULT_TRANSCRIPT_HISTORY_LIMIT = 100;
const MAX_TRANSCRIPT_HISTORY_LIMIT = 200;
const CURSOR_PREFIX = "seq:";
const OPENCLAW_HEARTBEAT_TRANSCRIPT_PROMPT = "[OpenClaw heartbeat poll]";
const OPENCLAW_HEARTBEAT_ACK = "HEARTBEAT_OK";

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
  // OpenClaw 2026.8 writes the live conversation into the agent SQLite event
  // log. Its seq is the same order used by Control UI; falling through to the
  // gateway projection loses that order for records appended asynchronously
  // (notably scheduled jobs with images).
  const sqliteHistory = readOpenClawSqliteChatHistory(params, defaults);
  if (sqliteHistory) {
    return sqliteHistory;
  }
  const transcript = await resolveOpenClawSessionTranscript(params.sessionKey, defaults);
  if (!transcript) {
    return null;
  }

  return readChatHistoryFromTranscriptFile({
    sessionKey: transcript.sessionKey,
    sessionId: transcript.sessionId,
    transcriptPath: transcript.logPath,
    projectionGatewayId: params.projectionGatewayId,
    limit: params.limit,
    cursor: params.cursor,
    direction: params.direction,
    projectionVersion: params.projectionVersion,
    sessionDefaults: defaults,
  });
}

function readOpenClawSqliteChatHistory(
  params: ReturnType<typeof normalizeTranscriptHistoryParams>,
  defaults: GatewaySessionDefaults,
): HistoryResponse | null {
  const agentId = params.sessionKey.match(/^agent:([^:]+):/)?.[1] ?? defaults.defaultAgentId ?? "main";
  const databasePath = join(resolveOpenClawStateDir(), "agents", agentId, "agent", "openclaw-agent.sqlite");
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const session = findSqliteSessionNode(database, params.sessionKey, defaults);
    const sessionId = cleanHistoryString(session?.current_session_id);
    if (!sessionId) return null;

    const rows = database.prepare(`
      SELECT seq, event_json
      FROM transcript_events
      WHERE session_id = ?
      ORDER BY seq ASC
    `).all(sessionId) as Array<{ seq?: unknown; event_json?: unknown }>;
    const visibleParentIds = resolveSqliteVisibleParentIds(rows);
    const messages = rows
      .map((row) => sqliteTranscriptHistoryMessage(
        row,
        sessionId,
        params.projectionVersion === 3,
        visibleParentIds,
      ))
      .filter((message): message is HistoryMessage => Boolean(message));
    if (messages.length === 0 && rows.length === 0) return null;

    const cursorSeq = parseHistoryCursorSeq(params.cursor);
    const sourceRange = params.direction === "newer"
      ? (() => {
          const startIndex = rows.findIndex((row) => {
            const seq = typeof row.seq === "number" && Number.isSafeInteger(row.seq) ? row.seq : undefined;
            return seq !== undefined && (cursorSeq === undefined || seq > cursorSeq);
          });
          const resolvedStart = startIndex < 0 ? rows.length : startIndex;
          const rawPage = rows.slice(resolvedStart, resolvedStart + params.limit);
          const rawLast = rawPage.at(-1)?.seq;
          const rawFirst = rawPage[0]?.seq;
          const rawSeqs = rawPage.map((row) => row.seq);
          const sourceRangeHasGap = rawSeqs.some((seq, index) => {
            if (index === 0) return false;
            const previous = rawSeqs[index - 1];
            return typeof previous !== "number"
              || !Number.isSafeInteger(previous)
              || typeof seq !== "number"
              || !Number.isSafeInteger(seq)
              || seq !== previous + 1;
          });
          const sourceReadThroughSeq = typeof rawLast === "number" && Number.isSafeInteger(rawLast)
            ? rawLast
            : undefined;
          const sourceRangeStartSeq = typeof rawFirst === "number" && Number.isSafeInteger(rawFirst)
            ? rawFirst
            : undefined;
          return sourceReadThroughSeq === undefined || sourceRangeStartSeq === undefined
            ? undefined
            : {
                sourceReadThroughSeq,
                sourceRangeStartSeq,
                sourceRangeHasGap,
                sourceHasMore: resolvedStart + rawPage.length < rows.length,
              };
        })()
      : undefined;

    return buildTranscriptHistoryResponse({
      sessionKey: params.sessionKey,
      sessionId,
      projectionGatewayId: params.projectionGatewayId,
      messages: prepareTranscriptHistoryMessages(messages, params.sessionKey, params.projectionVersion, defaults),
      limit: params.limit,
      cursor: params.cursor,
      direction: params.direction,
      projectionVersion: params.projectionVersion,
      ...(sourceRange ?? {}),
    });
  } catch (error) {
    if (params.projectionVersion === 3 && error instanceof Error && error.message.startsWith("OpenClaw projection v3")) {
      throw error;
    }
    return null;
  } finally {
    database?.close();
  }
}

function findSqliteSessionNode(
  database: DatabaseSync,
  sessionKey: string,
  defaults: GatewaySessionDefaults,
): { current_session_id?: unknown } | undefined {
  const statement = database.prepare(`
    SELECT current_session_id
    FROM session_nodes
    WHERE session_key = ?
    LIMIT 1
  `);
  for (const candidate of sessionKeyCandidates(sessionKey, defaults)) {
    const session = statement.get(candidate) as { current_session_id?: unknown } | undefined;
    if (session) return session;
  }
  return undefined;
}

export async function readChatHistoryFromTranscriptFile(
  request: TranscriptHistoryRequest,
): Promise<HistoryResponse> {
  const messages = await readIndexedTranscriptMessages(
    request.transcriptPath,
    request.sessionKey,
    request.projectionVersion,
    request.sessionDefaults,
  );
  return buildTranscriptHistoryResponse({
    sessionKey: request.sessionKey,
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    projectionGatewayId: request.projectionGatewayId,
    messages,
    limit: normalizeHistoryLimit(request.limit),
    cursor: normalizeCursor(request.cursor),
    direction: normalizeHistoryDirection(request.direction),
    projectionVersion: request.projectionVersion,
  });
}

function buildTranscriptHistoryResponse(request: {
  sessionKey: string;
  sessionId?: string;
  projectionGatewayId?: string;
  messages: HistoryMessage[];
  limit: number;
  cursor?: string;
  direction: ChatHistoryDirection;
  projectionVersion?: 3;
  sourceReadThroughSeq?: number;
  sourceRangeStartSeq?: number;
  sourceRangeHasGap?: boolean;
  sourceHasMore?: boolean;
}): HistoryResponse {
  const projectionGatewayId = request.projectionVersion === 3
    ? requireProjectionIdentity(request.projectionGatewayId, "gatewayId")
    : request.projectionGatewayId ?? "clawconnect";
  const projectionSessionId = request.projectionVersion === 3
    ? requireProjectionIdentity(request.sessionId, "sourceSessionId")
    : request.sessionId;
  const cursorSeq = parseHistoryCursorSeq(request.cursor);
  const boundedMessages = request.direction === "newer" && request.sourceReadThroughSeq !== undefined
    ? request.messages.filter((message) => {
        const seq = messageSeq(message);
        return seq !== undefined
          && (cursorSeq === undefined || seq > cursorSeq)
          && seq <= request.sourceReadThroughSeq!;
      })
    : request.messages;
  const page = paginateHistoryMessages(boundedMessages, {
    limit: request.limit,
    direction: request.direction,
    cursorSeq,
  });

  return {
    sessionKey: request.sessionKey,
    ...(request.projectionVersion === 3 ? { projectionVersion: 3 as const } : {}),
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    messages: page.messages,
    hasMore: page.hasMore,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(page.newestCursor ? { newestCursor: page.newestCursor } : {}),
    ...(request.sourceReadThroughSeq !== undefined ? { sourceReadThroughSeq: request.sourceReadThroughSeq } : {}),
    ...(request.sourceRangeStartSeq !== undefined ? { sourceRangeStartSeq: request.sourceRangeStartSeq } : {}),
    ...(request.sourceRangeHasGap !== undefined ? { sourceRangeHasGap: request.sourceRangeHasGap } : {}),
    ...(request.sourceHasMore !== undefined ? { sourceHasMore: request.sourceHasMore } : {}),
    timelineSnapshot: buildHistorySnapshotPage({
      gatewayId: projectionGatewayId,
      sessionKey: request.sessionKey,
      cursor: normalizeCursor(request.cursor) ?? null,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor ?? null,
      newestCursor: page.newestCursor ?? null,
      orderPolicy: "transcript",
      ...(projectionSessionId
        ? {
            sourceOrderScope: request.projectionVersion === 3
              ? openClawSourceOrderScope({
                  agentId: openClawAgentIdFromSessionKey(request.sessionKey),
                  sessionId: projectionSessionId,
                })
              : projectionSessionId,
          }
        : {}),
      messages: page.messages.map((message, index) => {
        const seq = request.projectionVersion === 3
          ? requireProjectionSequence(messageSeq(message), index)
          : messageSeq(message) ?? index + 1;
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
        const toolCallId = role === "tool"
          ? historyString(message, "toolCallId", "tool_call_id")
          : undefined;
        const canonicalContent = toolCallId
          ? content.map((block) => historyString(block, "toolCallId", "tool_call_id")
            ? block
            : { ...block, toolCallId })
          : content;
        const sourceSessionId = request.projectionVersion === 3 ? projectionSessionId : undefined;
        const sourceMessageId = request.projectionVersion === 3
          ? requireProjectionIdentity(messageId, "sourceMessageId")
          : messageId;
        const projection = sourceSessionId && sourceMessageId
          ? createProjectionMetadata({
            gatewayType: "openclaw",
            gatewayId: projectionGatewayId,
            producerId: openClawAgentIdFromSessionKey(request.sessionKey),
            sourceSessionId,
            sourceMessageId,
            sourceOrderScope: openClawSourceOrderScope({
              agentId: openClawAgentIdFromSessionKey(request.sessionKey),
              sessionId: sourceSessionId,
            }),
            sourceOrderSeq: seq,
            sourceRole: role,
            ...(historyString(message, "parentId", "parent_id")
              ? { parentSourceMessageId: historyString(message, "parentId", "parent_id") }
              : {}),
            timelineDelivery: "independent",
          })
          : undefined;
        const timelineMessageId = projection?.canonicalMessageId ?? messageId ?? `${role}-${turnId}`;
        return {
          turnId,
          runId: historyString(message, "runId", "run_id") ?? turnId,
          messageId: timelineMessageId,
          role,
          messageState: normalizeTimelineMessageState(message),
          createdAt: normalizeTimelineCreatedAt(message) ?? fallbackTimelineCreatedAt(page.messages, index),
          partId: historyString(message, "partId", "part_id") ?? "part-text-1",
          content: canonicalContent,
          seq,
          turnSeq: historyNumber(message, "turnSeq", "turn_seq") ?? seq,
          ...(clientMessageId ? { clientMessageId } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(extractAttachmentIds(canonicalContent).length > 0
            ? { attachmentIds: extractAttachmentIds(canonicalContent) }
            : {}),
          ...(projection ?? {}),
        };
      }),
      attachments: [],
    }),
  };
}

/**
 * OpenClaw v4 may serve chat.history from its state database even when the
 * legacy transcript file is unavailable. The v4 response deliberately keeps
 * canonical identity under __openclaw, so Relay cannot consume its raw
 * messages as a timeline snapshot. Project those protocol fields here instead
 * of asking downstream clients to infer missing user turns from assistant text.
 */
export function canonicalizeOpenClawGatewayHistoryResponse(
  history: HistoryResponse,
  request: {
    sessionKey: string;
    cursor?: string;
    projectionVersion?: 3;
    projectionGatewayId?: string;
    sessionDefaults?: GatewaySessionDefaults;
  },
): HistoryResponse {
  const projectionGatewayId = request.projectionVersion === 3
    ? requireProjectionIdentity(request.projectionGatewayId, "gatewayId")
    : request.projectionGatewayId ?? "clawconnect";
  const requestedSessionKey = cleanHistoryString(history.sessionKey) ?? request.sessionKey;
  const restored = restoreGatewayHistoryMessages(history.messages ?? []);
  const projectionVersion = request.projectionVersion;
  const materializedDeliveries = materializeOpenClawMessageToolDeliveries(restored);
  const explicitSidecars = normalizeOpenClawAssistantMediaSidecars(
    materializedDeliveries.messages,
    requestedSessionKey,
    {
      ...(projectionVersion === 3 ? { projectionVersion: 3 as const } : {}),
      ...(request.sessionDefaults ? { sessionDefaults: request.sessionDefaults } : {}),
    },
  );
  const automaticMediaReplies = normalizeOpenClawAutomaticMediaReplies(
    explicitSidecars.messages,
    requestedSessionKey,
    {
      ...(projectionVersion === 3 ? { projectionVersion: 3 as const } : {}),
      ...(request.sessionDefaults ? { sessionDefaults: request.sessionDefaults } : {}),
    },
  );
  const normalizedHistory = materializedDeliveries.changed || restored !== history.messages || explicitSidecars.changed || automaticMediaReplies.changed
    ? { ...history, messages: automaticMediaReplies.messages as HistoryMessage[] }
    : history;
  const filtered = filterOpenClawHeartbeatHistoryResponse(normalizedHistory);
  if (filtered.timelineSnapshot && projectionVersion !== 3) {
    return filtered;
  }

  const sessionKey = canonicalizeOpenClawSessionScope(
    cleanHistoryString(filtered.sessionKey) ?? request.sessionKey,
    request.sessionDefaults,
  ) ?? (cleanHistoryString(filtered.sessionKey) ?? request.sessionKey);
  const messages = filtered.messages ?? [];
  const rawSourceSessionId = cleanHistoryString(filtered.sessionId);
  const sourceSessionId = projectionVersion === 3
    ? requireProjectionIdentity(rawSourceSessionId, "sourceSessionId")
    : undefined;
  const agentId = openClawAgentIdFromSessionKey(sessionKey);
  const sourceOrderScope = rawSourceSessionId
    ? projectionVersion === 3
      ? openClawSourceOrderScope({ agentId, sessionId: rawSourceSessionId })
      : rawSourceSessionId
    : messages.map(openClawTranscriptSource).find((value): value is string => Boolean(value));

  return {
    ...filtered,
    sessionKey,
    ...(projectionVersion === 3 ? { projectionVersion: 3 as const } : {}),
    timelineSnapshot: buildHistorySnapshotPage({
      gatewayId: projectionGatewayId,
      sessionKey,
      cursor: request.cursor ?? null,
      hasMore: Boolean(filtered.hasMore),
      nextCursor: filtered.nextCursor ?? null,
      newestCursor: filtered.newestCursor ?? null,
      orderPolicy: "transcript",
      ...(sourceOrderScope ? { sourceOrderScope } : {}),
      messages: canonicalizeOpenClawGatewayHistoryMessages(messages, sessionKey, {
        agentId,
        projectionGatewayId,
        ...(projectionVersion === 3 ? { projectionVersion: 3 as const } : {}),
        ...(sourceSessionId ? { sourceSessionId } : {}),
        ...(sourceOrderScope ? { sourceOrderScope } : {}),
      }),
      attachments: [],
    }),
  };
}

function canonicalizeOpenClawGatewayHistoryMessages(
  messages: HistoryMessage[],
  sessionKey: string,
  projection?: {
    agentId: string;
    projectionGatewayId?: string;
    projectionVersion?: 3;
    sourceSessionId?: string;
    sourceOrderScope?: string;
  },
): TimelineHistoryMessage[] {
  const finalAssistantIndexByRunId = new Map<string, number>();
  messages.forEach((message, index) => {
    if (normalizeTimelineRole(message.role) !== "assistant") return;
    const runId = openClawRunId(message);
    if (runId) finalAssistantIndexByRunId.set(runId, index);
  });

  return messages.map((message, index) => {
    const seq = projection?.projectionVersion === 3
      ? requireProjectionSequence(messageSeq(message), index)
      : messageSeq(message) ?? index + 1;
    const role = normalizeTimelineRole(message.role);
    const rawIdempotencyKey = historyString(message, "idempotencyKey", "idempotency_key")
      ?? openClawHistoryString(message, "idempotencyKey", "idempotency_key");
    const clientMessageId = historyString(message, "clientMessageId", "client_message_id");
    const normalizedInputId = normalizeTranscriptTurnId(rawIdempotencyKey)
      ?? normalizeTranscriptTurnId(clientMessageId);
    const providerMessageId = historyString(message, "messageId", "message_id", "id")
      ?? openClawHistoryString(message, "id");
    const sourceMessageId = projection?.projectionVersion === 3
      ? requireProjectionIdentity(providerMessageId, "sourceMessageId")
      : providerMessageId;
    const runId = historyString(message, "runId", "run_id")
      ?? openClawRunId(message)
      ?? normalizedInputId;
    const turnId = historyString(message, "turnId", "turn_id")
      ?? runId
      ?? normalizedInputId
      ?? providerMessageId
      ?? `history-${sessionKey}-${seq}-${role}`;
    const toolCallId = role === "tool"
      ? historyString(message, "toolCallId", "tool_call_id")
      : undefined;
    const content = normalizeTimelineContentBlocks(message.content);
    const canonicalContent = toolCallId
      ? content.map((block) => historyString(block, "toolCallId", "tool_call_id")
        ? block
        : { ...block, toolCallId })
      : content;
    const messageId = gatewayHistoryMessageId({
      role,
      turnId,
      runId,
      providerMessageId,
      toolCallId,
      index,
      finalAssistantIndexByRunId,
      projectionVersion: projection?.projectionVersion,
    });
    const sourceSessionId = projection?.sourceSessionId;
    const sourceOrderScope = projection?.sourceOrderScope;
    const projectionMetadata = projection?.projectionVersion === 3
      && sourceSessionId && sourceOrderScope && sourceMessageId
      ? createProjectionMetadata({
        gatewayType: "openclaw",
        gatewayId: requireProjectionIdentity(projection.projectionGatewayId, "gatewayId"),
        producerId: projection.agentId,
        sourceSessionId,
        sourceMessageId,
        sourceOrderScope,
        sourceOrderSeq: seq,
        sourceRole: role,
        ...(historyString(message, "parentId", "parent_id")
          ? { parentSourceMessageId: historyString(message, "parentId", "parent_id") }
          : {}),
        timelineDelivery: "independent",
      })
      : undefined;

    const timelineMessageId = projectionMetadata?.canonicalMessageId ?? messageId;
    return {
      turnId,
      runId: runId ?? turnId,
      messageId: timelineMessageId,
      role,
      messageState: normalizeTimelineMessageState(message),
      createdAt: normalizeTimelineCreatedAt(message) ?? fallbackTimelineCreatedAt(messages, index),
      partId: historyString(message, "partId", "part_id") ?? "part-text-1",
      content: canonicalContent,
      seq,
      turnSeq: historyNumber(message, "turnSeq", "turn_seq") ?? seq,
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(normalizedInputId ? { idempotencyKey: normalizedInputId } : {}),
      ...(extractAttachmentIds(canonicalContent).length > 0
        ? { attachmentIds: extractAttachmentIds(canonicalContent) }
        : {}),
      ...(projectionMetadata ?? {}),
    };
  });
}

function gatewayHistoryMessageId(input: {
  role: TimelineRole;
  turnId: string;
  runId?: string;
  providerMessageId?: string;
  toolCallId?: string;
  index: number;
  finalAssistantIndexByRunId: Map<string, number>;
  projectionVersion?: 3;
}): string {
  if (input.role === "user" && input.runId) {
    return `user-${input.runId}`;
  }
  if (
    input.role === "assistant"
    && input.runId
    && input.finalAssistantIndexByRunId.get(input.runId) === input.index
  ) {
    return `assistant-${input.runId}`;
  }
  if (input.role === "tool" && input.toolCallId) {
    return `tool-${input.toolCallId}`;
  }
  return input.providerMessageId ?? `${input.role}-${input.turnId}`;
}

function openClawHistoryMetadata(message: HistoryMessage): Record<string, unknown> | undefined {
  return isRecord(message.__openclaw) ? message.__openclaw : undefined;
}

function openClawHistoryString(message: HistoryMessage, ...fields: string[]): string | undefined {
  const metadata = openClawHistoryMetadata(message);
  return metadata ? historyString(metadata, ...fields) : undefined;
}

function openClawRunId(message: HistoryMessage): string | undefined {
  return openClawHistoryString(message, "runId", "run_id");
}

function openClawTranscriptSource(message: HistoryMessage): string | undefined {
  const position = openClawHistoryMetadata(message)?.transcriptPosition;
  return isRecord(position) ? historyString(position, "source") : undefined;
}

function normalizeTranscriptHistoryParams(
  rawParams: unknown,
  fallbackSessionKey: string,
): {
  sessionKey: string;
  limit: number;
  cursor?: string;
  direction: ChatHistoryDirection;
  projectionVersion?: 3;
  projectionGatewayId?: string;
} {
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
    ...(record.projectionVersion === 3 ? { projectionVersion: 3 as const } : {}),
    ...(typeof record.projectionGatewayId === "string" && record.projectionGatewayId.trim().length > 0
      ? { projectionGatewayId: record.projectionGatewayId.trim() }
      : {}),
  };
}

async function readIndexedTranscriptMessages(
  transcriptPath: string,
  sessionKey: string,
  projectionVersion?: 3,
  sessionDefaults?: GatewaySessionDefaults,
): Promise<HistoryMessage[]> {
  const stats = await stat(transcriptPath);
  const cacheKey = `${transcriptPath}\u0000${projectionVersion === 3 ? "v3" : "v2"}`;
  const cached = transcriptHistoryCache.get(cacheKey);
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
    const message = parseTranscriptHistoryLine(trimmed, messages.length + 1, projectionVersion === 3);
    if (message) {
      messages.push(message);
    }
  }
  const visibleMessages = prepareTranscriptHistoryMessages(messages, sessionKey, projectionVersion, sessionDefaults);

  transcriptHistoryCache.set(cacheKey, {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    messages: visibleMessages,
  });
  return visibleMessages;
}

function sqliteTranscriptHistoryMessage(
  row: { seq?: unknown; event_json?: unknown },
  sessionId: string,
  strictProjectionV3 = false,
  visibleParentIds?: ReadonlyMap<string, string>,
): HistoryMessage | null {
  const seq = typeof row.seq === "number" && Number.isFinite(row.seq) && row.seq > 0
    ? Math.round(row.seq)
    : undefined;
  if (!seq || typeof row.event_json !== "string") return null;

  let event: unknown;
  try {
    event = JSON.parse(row.event_json);
  } catch {
    return null;
  }
  if (!isRecord(event) || event.type !== "message" || !isRecord(event.message)) return null;

  // `event.id`/`event.parentId` form the transcript's real lineage graph.
  // Do not replace that graph with a synthetic seq id: assistant events often
  // lack their own run id and are linked back to the originating user turn
  // only through those event ids.
  const sourceMessageId = cleanHistoryString(event.id);
  const message: HistoryMessage = { ...event.message, seq };
  if (strictProjectionV3 && !cleanHistoryString(message.id) && !sourceMessageId) {
    throw new Error(`OpenClaw projection v3 sourceMessageId is missing at source seq ${seq}`);
  }
  if (!cleanHistoryString(message.id)) {
    message.id = sourceMessageId ?? `sqlite-${sessionId}-${seq}`;
  }
  const timestamp = normalizeHistoryTimestamp(message.timestamp ?? event.timestamp);
  if (timestamp !== undefined) {
    message.timestamp = timestamp;
    message.createdAt = cleanHistoryString(message.createdAt) ?? new Date(timestamp).toISOString();
  }
  const parentId = (sourceMessageId ? visibleParentIds?.get(sourceMessageId) : undefined)
    ?? cleanHistoryString(event.parentId)
    ?? cleanHistoryString(message.parentId);
  if (parentId) message.parentId = parentId;
  return message;
}

/**
 * SQLite stores every transcript event in one parent graph, including hidden
 * custom/thinking rows. Collapse only those hidden hops so visible messages
 * retain deterministic source lineage and can inherit the originating mobile
 * run id. Distinct message identities remain untouched.
 */
function resolveSqliteVisibleParentIds(
  rows: Array<{ seq?: unknown; event_json?: unknown }>,
): Map<string, string> {
  type SqliteEventNode = {
    eventId: string;
    parentId?: string;
    visibleMessageId?: string;
  };

  const nodes = new Map<string, SqliteEventNode>();
  for (const row of rows) {
    if (typeof row.event_json !== "string") continue;
    let event: unknown;
    try {
      event = JSON.parse(row.event_json);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    const eventId = cleanHistoryString(event.id);
    if (!eventId) continue;
    const visibleMessageId = event.type === "message" && isRecord(event.message)
      ? cleanHistoryString(event.message.id) ?? eventId
      : undefined;
    nodes.set(eventId, {
      eventId,
      ...(cleanHistoryString(event.parentId) ? { parentId: cleanHistoryString(event.parentId) } : {}),
      ...(visibleMessageId ? { visibleMessageId } : {}),
    });
  }

  const resolved = new Map<string, string>();
  for (const node of nodes.values()) {
    if (!node.visibleMessageId || !node.parentId) continue;
    let parentId: string | undefined = node.parentId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = nodes.get(parentId);
      if (!parent) break;
      if (parent.visibleMessageId) {
        resolved.set(node.eventId, parent.visibleMessageId);
        break;
      }
      parentId = parent.parentId;
    }
  }
  return resolved;
}

function prepareTranscriptHistoryMessages(
  messages: HistoryMessage[],
  sessionKey: string,
  projectionVersion?: 3,
  sessionDefaults?: GatewaySessionDefaults,
): HistoryMessage[] {
  messages = materializeOpenClawMessageToolDeliveries(messages).messages;
  // Fold the automatic assistant-media sidecar before lineage reconstruction.
  // Lineage deliberately rewrites idempotency keys to mobile turn IDs, while
  // the raw <run>:assistant-media key and parentId are the authoritative
  // relationship needed to keep the desktop and mobile projections aligned.
  const projectionOptions = projectionVersion === 3 ? { projectionVersion: 3 as const } : undefined;
  const relationOptions = {
    ...(projectionOptions ?? {}),
    ...(sessionDefaults ? { sessionDefaults } : {}),
  };
  const explicitSidecars = normalizeOpenClawAssistantMediaSidecars(messages, sessionKey, relationOptions).messages as HistoryMessage[];
  restoreTranscriptTurnLineage(explicitSidecars, projectionVersion);
  const foldedMessages = normalizeOpenClawAutomaticMediaReplies(
    explicitSidecars,
    sessionKey,
    relationOptions,
  ).messages as HistoryMessage[];
  return filterOpenClawHeartbeatArtifacts(foldedMessages);
}

/**
 * The installed OpenClaw producer records a settled message-tool delivery as
 * a `toolResult` row. That row is an execution detail, not a user-visible
 * timeline item. Promote only the producer's strict, structured receipt to an
 * independent assistant row; never use its prose content or generic
 * `openclawDelivery.mediaUrls` display field as evidence.
 */
function materializeOpenClawMessageToolDeliveries(
  messages: HistoryMessage[],
): { messages: HistoryMessage[]; changed: boolean } {
  let changed = false;
  const materialized = messages.map((message) => {
    if (message.role !== "toolResult" && message.role !== "tool_result") {
      return message;
    }
    const receipt = adaptOpenClawMessageToolDelivery(message);
    if (!receipt) return message;
    changed = true;
    return {
      ...message,
      role: "assistant",
      runId: receipt.sourceRunId,
      turnId: receipt.sourceRunId,
      idempotencyKey: receipt.idempotencyKey,
      // Keep the strict typed receipt on the canonical row until the relay
      // replaces its local paths with uploaded attachment blocks.
      openclawDelivery: receipt,
      content: [],
    };
  });
  return { messages: materialized, changed };
}

/**
 * OpenClaw 会把内部心跳探测写入 transcript。只有精确的保留提示最终得到纯确认回执时，
 * 才隐藏整段内部记录；若心跳产生真实告警，则保留完整内容供用户查看。
 */
export function filterOpenClawHeartbeatArtifacts<T extends HistoryMessage>(messages: T[]): T[] {
  const visible: T[] = [];
  let index = 0;

  while (index < messages.length) {
    if (!isOpenClawHeartbeatPrompt(messages[index])) {
      visible.push(messages[index]);
      index += 1;
      continue;
    }

    const artifactEnd = resolveHeartbeatArtifactEnd(messages, index);
    if (artifactEnd === undefined) {
      visible.push(messages[index]);
      index += 1;
      continue;
    }
    index = artifactEnd;
  }

  return visible.length === messages.length ? messages : visible;
}

export function filterOpenClawHeartbeatHistoryResponse(history: HistoryResponse): HistoryResponse {
  const messages = history.messages ?? [];
  const visibleMessages = filterOpenClawHeartbeatArtifacts(messages);
  const snapshotMessages = history.timelineSnapshot?.messages;
  const visibleSnapshotMessages = snapshotMessages
    ? filterOpenClawHeartbeatArtifacts(snapshotMessages)
    : undefined;
  if (visibleMessages === messages && visibleSnapshotMessages === snapshotMessages) {
    return history;
  }
  return {
    ...history,
    messages: visibleMessages,
    ...(history.timelineSnapshot && visibleSnapshotMessages
      ? {
          timelineSnapshot: {
            ...history.timelineSnapshot,
            messages: visibleSnapshotMessages,
          },
        }
      : {}),
  };
}

function resolveHeartbeatArtifactEnd(messages: HistoryMessage[], startIndex: number): number | undefined {
  for (let index = startIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "user") {
      return undefined;
    }
    if (isOpenClawHeartbeatAcknowledgement(message)) {
      return index + 1;
    }
    if (isHeartbeatToolArtifact(message)) {
      continue;
    }
    if (message.role === "assistant") {
      const content = resolveTextOnlyHistoryContent(message.content);
      // Empty assistant placeholder text is ignored while waiting for terminal ack
      if (!content.text.trim()) {
        continue;
      }
      // Non-empty assistant text that is NOT HEARTBEAT_OK is a real heartbeat alert -> do not filter
      return undefined;
    }
    if (message.role !== "tool" && message.role !== "toolResult" && message.role !== "tool_result") {
      return undefined;
    }
  }
  return undefined;
}

function isOpenClawHeartbeatPrompt(message: HistoryMessage): boolean {
  if (message.role !== "user") {
    return false;
  }
  const content = resolveTextOnlyHistoryContent(message.content);
  if (content.hasNonTextContent) {
    return false;
  }
  const text = content.text.replace(/\r/g, "").trim();
  return text === "[OpenClaw heartbeat poll]" || text === "OpenClaw heartbeat poll";
}

function isOpenClawHeartbeatAcknowledgement(message: HistoryMessage): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const content = resolveTextOnlyHistoryContent(message.content);
  if (content.hasNonTextContent) {
    return false;
  }
  const text = content.text.replace(/\r/g, "").trim();
  return text === "HEARTBEAT_OK" || text === "HEARTBEAT OK";
}

function isHeartbeatToolArtifact(message: HistoryMessage): boolean {
  if (message.role === "tool" || message.role === "toolResult" || message.role === "tool_result") {
    return true;
  }
  if (message.role !== "assistant" || !Array.isArray(message.content) || message.content.length === 0) {
    return false;
  }
  return message.content.every((block) => {
    const type = typeof block.type === "string" ? block.type.trim().toLowerCase().replaceAll("_", "") : "";
    return type === "toolcall" || type === "functioncall" || type === "tooluse";
  });
}

function resolveTextOnlyHistoryContent(content: HistoryMessage["content"]): {
  text: string;
  hasNonTextContent: boolean;
} {
  if (typeof content === "string") {
    return { text: content, hasNonTextContent: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", hasNonTextContent: content !== undefined };
  }
  let text = "";
  let hasNonTextContent = false;
  for (const block of content) {
    const type = typeof block.type === "string" ? block.type.trim().toLowerCase() : "";
    if (type !== "text" && type !== "input_text" && type !== "output_text") {
      hasNonTextContent = true;
      continue;
    }
    if (typeof block.text !== "string") {
      hasNonTextContent = true;
      continue;
    }
    text += block.text;
  }
  return { text, hasNonTextContent };
}

function parseTranscriptHistoryLine(line: string, seq: number, strictProjectionV3 = false): HistoryMessage | null {
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
    if (strictProjectionV3 && (typeof parsed.id !== "string" || parsed.id.trim().length === 0)) {
      throw new Error(`OpenClaw projection v3 sourceMessageId is missing at source seq ${seq}`);
    }
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
  if (typeof parsed.parentId === "string" && parsed.parentId.trim().length > 0) {
    message.parentId = parsed.parentId.trim();
  }
  return message;
}

/**
 * OpenClaw transcript entries form an explicit parent chain, while realtime
 * events use the mobile request id as runId. Carry the originating user
 * idempotency key through that chain so history and realtime resolve to the
 * same canonical message without comparing text or timestamps.
 */
function restoreTranscriptTurnLineage(messages: HistoryMessage[], projectionVersion?: 3): void {
  const byId = new Map<string, HistoryMessage>();
  const lastAssistantByMobileTurn = new Map<string, HistoryMessage>();
  for (const message of messages) {
    const id = cleanHistoryString(message.id);
    if (id) byId.set(id, message);
  }

  for (const message of messages) {
    if (message.role === "user" || cleanHistoryString(message.runId) || cleanHistoryString(message.turnId)) {
      continue;
    }
    let parentId = cleanHistoryString(message.parentId);
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      if (parent.role === "user") {
        const mobileTurnId = normalizeTranscriptTurnId(parent.idempotencyKey)
          ?? normalizeTranscriptTurnId(parent.clientMessageId);
        const turnId = mobileTurnId
          ?? cleanHistoryString(parent.id);
        if (turnId) {
          message.turnId = turnId;
          message.runId = turnId;
        }
        if (mobileTurnId) {
          message.idempotencyKey = mobileTurnId;
          if (message.role === "assistant") {
            lastAssistantByMobileTurn.set(mobileTurnId, message);
          }
        }
        break;
      }
      parentId = cleanHistoryString(parent.parentId);
    }
  }

  // 一个 OpenClaw turn 可能包含若干工具中间消息；只有最后一个 assistant 输出
  // 与实时 final 共用 canonical messageId，其他中间消息继续保留 transcript 身份。
  if (projectionVersion !== 3) {
    for (const [turnId, message] of lastAssistantByMobileTurn.entries()) {
      message.messageId = `assistant-${turnId}`;
    }
  }
}

function normalizeTranscriptTurnId(value: unknown): string | undefined {
  const cleaned = cleanHistoryString(value);
  return cleaned?.replace(/:(?:user|assistant|tool|system)$/i, "") || undefined;
}

function cleanHistoryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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

function requireProjectionIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`OpenClaw projection v3 identity is missing ${field}`);
  }
  return value.trim();
}

function requireProjectionSequence(value: number | undefined, index: number): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    throw new Error(`OpenClaw projection v3 sourceOrderSeq is missing or invalid at row ${index}`);
  }
  return value as number;
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
  const raw = message?.seq ?? (message ? historyNumber(openClawHistoryMetadata(message) ?? {}, "seq") : undefined);
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
  preferredText?: string,
): ChatHistoryOutcome {
  const messages = history?.messages ?? [];
  if (messages.length === 0) {
    return null;
  }

  const scope = findHistoryScope(messages, context);
  if (!scope) {
    return null;
  }
  if (scope.hasUser && hasUnresolvedUserBefore(messages, scope.startIndex)) {
    return null;
  }

  let latestError: string | null = null;
  let latestFinal: Extract<ChatHistoryOutcome, { kind: "final" }> | null = null;
  // `preferredText` is retained for call-site compatibility only.  Assistant
  // prose is not a message identity and must never select an attachment row;
  // the stable turn/message/tool ids above and source order are authoritative.
  void preferredText;
  // When the history page starts after the user row, the first assistant row
  // carrying the same stable run id is the deterministic scope boundary. Do
  // not require a text/timestamp guess just because pagination omitted the
  // user record.
  const firstMessageIndex = scope.hasUser ? scope.startIndex + 1 : scope.startIndex;
  for (let index = firstMessageIndex; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "user") {
      return null;
    }
    if (message.role !== "assistant") {
      continue;
    }
    const text = extractHistoryMessageText(message);
    const mediaOnlyProjectionRow = history?.projectionVersion === 3
      && text.length === 0
      && nonTextHistoryContent(message).length > 0;
    if (!mediaOnlyProjectionRow && (text.length > 0 || hasHistoryMessageContent(message))) {
      // One OpenClaw run may contain several independent message-tool replies.
      // The last authoritative assistant row is the terminal history outcome;
      // returning the first row loses later media on fallback/replay.
      latestFinal = { kind: "final", text, message };
      continue;
    }
    if (
      typeof message.errorMessage === "string" &&
      message.errorMessage.trim().length > 0 &&
      (message.stopReason === "error" || !message.stopReason)
    ) {
      latestError = message.errorMessage.trim();
    }
  }

  return latestFinal ?? (latestError ? { kind: "error", errorMessage: latestError } : null);
}

/**
 * Return all media delivery rows belonging to the matched OpenClaw turn.
 * A provider may emit only the first image on the live terminal while the
 * remaining message-tool deliveries are committed to history. This helper
 * keeps the user-turn boundary as the only scope and never matches by text.
 */
export function extractHistoryMediaContent(
  history: HistoryResponse | undefined,
  context: ChatRunContext,
): TimelineContentBlock[] {
  const messages = history?.messages ?? [];
  const scope = findHistoryScope(messages, context);
  if (!scope || (scope.hasUser && hasUnresolvedUserBefore(messages, scope.startIndex))) return [];
  const media: HistoryContentBlock[] = [];
  const firstMessageIndex = scope.hasUser ? scope.startIndex + 1 : scope.startIndex;
  for (let index = firstMessageIndex; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "user") break;
    if (message.role === "assistant") media.push(...nonTextHistoryContent(message));
  }
  return media.filter((block): block is TimelineContentBlock => typeof block.type === "string");
}

/**
 * Collect media rows only when the provider gives an explicit parent edge.
 * v3 message-tool rows remain independent canonical messages; this helper is
 * solely for an outgoing terminal payload that deliberately owns its child
 * sidecars, and never falls back to run/client/text/time matching.
 */
export function extractExplicitParentMediaContent(
  history: HistoryResponse | undefined,
  parentMessage: HistoryMessage | undefined,
): TimelineContentBlock[] {
  if (!history || !parentMessage) return [];
  const parentMessageId = historyString(parentMessage, "messageId", "message_id", "id");
  if (!parentMessageId) return [];
  return (history.messages ?? []).flatMap((message) => {
    const explicitParentId = historyString(message, "parentId", "parent_id");
    if (explicitParentId !== parentMessageId) return [];
    return nonTextHistoryContent(message);
  }).filter((block): block is TimelineContentBlock => typeof block.type === "string");
}

function nonTextHistoryContent(message: HistoryMessage): HistoryContentBlock[] {
  return Array.isArray(message.content)
    ? message.content.filter((block) => {
        const type = typeof block?.type === "string" ? block.type.trim().toLowerCase() : "";
        return ["image", "file", "audio", "voice", "video", "attachment"].includes(type);
      })
    : [];
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
  // OpenClaw 在工具轮开始时会先落一条 thinking + toolCall 的 assistant 行。
  // thinking/reasoning 属于内部推理，不是用户可见终答；若把它当成内容，移动端会
  // 在工具仍运行时收到 run.completed，并提前发送队列中的下一条消息。
  // OpenClaw 的不同网关版本会同时出现 tool_call 与 toolCall 两种拼法；
  // 在调用方转小写后，后者会变成 toolcall，因此这里统一去掉分隔符再判断。
  const normalizedType = type.replace(/[\s_-]+/g, "");
  return normalizedType === "thinking"
    || normalizedType === "reasoning"
    || normalizedType === "reasoningcontent"
    || normalizedType === "analysis"
    || normalizedType === "toolcall"
    || normalizedType === "tooluse"
    || normalizedType === "toolresult"
    || normalizedType === "functioncall"
    || normalizedType === "functionresult"
    || normalizedType === "computercall"
    || normalizedType === "computercalloutput";
}

type HistoryScope = {
  startIndex: number;
  hasUser: boolean;
};

function findHistoryScope(messages: HistoryMessage[], context: ChatRunContext): HistoryScope | undefined {
  const canonicalRunId = normalizeTranscriptTurnId(context.canonicalRunId);
  if (!canonicalRunId) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") {
      continue;
    }
    const stableIds = [
      message.idempotencyKey,
      message.clientMessageId,
      message.turnId,
      message.runId,
    ].map(normalizeTranscriptTurnId);
    if (stableIds.includes(canonicalRunId)) {
      return { startIndex: index, hasUser: true };
    }
  }

  // `chat.history` is paginated, and a busy OpenClaw turn can append more
  // than the live enrichment page size after its user row (tool calls,
  // delivery mirrors, and the final commentary). The assistant delivery rows
  // still carry the authoritative run/turn id, so use the first matching row
  // as the scope boundary when the user row is outside this page. This is a
  // stable identity-based reconciliation, not a text or timestamp heuristic.
  const firstRunMessageIndex = messages.findIndex((message) => {
    const stableIds = [
      message.runId,
      message.turnId,
      message.idempotencyKey,
      message.clientMessageId,
    ].map(normalizeTranscriptTurnId);
    return stableIds.includes(canonicalRunId);
  });
  return firstRunMessageIndex >= 0
    ? { startIndex: firstRunMessageIndex, hasUser: false }
    : undefined;
}
