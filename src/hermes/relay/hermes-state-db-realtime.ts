import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { canonicalizeMobileAssistantText } from "../../core/relay/mobile-chat-run-bridge.js";
import {
  type CanonicalTimelineEvent,
  type TimelineContentBlock,
  type TimelineRole,
  parseCanonicalTimelineEvent,
} from "../../core/relay/timeline-event-log.js";
import {
  SUBPROCESS_ENV,
} from "../runtime/hermes-runtime-process.js";
import { resolveHermesPythonBin, resolveHermesStateDbPath } from "../runtime/hermes-runtime-paths.js";

const execFile = promisify(execFileCb);

export type HermesStateDbRealtimeMessageRow = {
  id: number;
  sessionId: string;
  sessionSource: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  timestamp: number;
  active: boolean;
  observed: boolean;
  toolName?: string;
  toolCallId?: string;
  platformMessageId?: string;
};

export type HermesStateDbRealtimeOpenTurn = {
  turnId: string;
  runId: string;
  skipUntilNextUser: boolean;
};

export type HermesStateDbRealtimeCursor = {
  lastMessageId: number;
  openTurnsBySession: Record<string, HermesStateDbRealtimeOpenTurn>;
};

export type HermesStateDbRealtimePayload = {
  runId: string;
  sessionKey: string;
  state: "history_sync";
  role: TimelineRole;
  timelineEvents: CanonicalTimelineEvent[];
};

export type HermesStateDbRealtimeBuildResult = {
  cursor: HermesStateDbRealtimeCursor;
  payloads: HermesStateDbRealtimePayload[];
};

const CLAWCONNECT_MOBILE_TURN_MARKER = "[ClawConnect mobile turn]";
const CLAWCONNECT_MOBILE_BRIDGE_MARKER = "[ClawConnect mobile bridge]";
const HERMES_STATE_DB_REALTIME_QUERY_TIMEOUT_MS = 5_000;
const HERMES_STATE_DB_REALTIME_QUERY_ATTEMPTS = 2;
const HERMES_STATE_DB_REALTIME_DEFAULT_LIMIT = 200;
const HERMES_STATE_DB_REALTIME_DEFAULT_POLL_INTERVAL_MS = 750;
const HERMES_RUNTIME_CONTEXT_HINT_REGEX =
  /(^|\r?\n)[ \t]*\[Hermes runtime context\][\s\S]*?(?=\r?\n[ \t]*\[ClawConnect mobile bridge\]|\r?\n[ \t]*\[ClawConnect mobile turn\]|$)/gi;

const HERMES_STATE_DB_REALTIME_QUERY_SCRIPT = String.raw`
import json
import sqlite3
import sys

mode = sys.argv[1]
db_path = sys.argv[2]

def connect():
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    return conn

try:
    conn = connect()
    if mode == "max":
        row = conn.execute("SELECT COALESCE(MAX(id), 0) AS max_id FROM messages").fetchone()
        print(json.dumps({"ok": True, "payload": int(row["max_id"] or 0)}, ensure_ascii=False))
    elif mode == "rows":
        after_id = int(sys.argv[3])
        limit = int(sys.argv[4])
        rows = conn.execute("""
            SELECT
              m.id,
              m.session_id,
              COALESCE(s.source, '') AS session_source,
              m.role,
              COALESCE(m.content, '') AS content,
              m.timestamp,
              COALESCE(m.active, 1) AS active,
              COALESCE(m.observed, 0) AS observed,
              m.tool_name,
              m.tool_call_id,
              m.platform_message_id
            FROM messages m
            LEFT JOIN sessions s ON s.id = m.session_id
            WHERE m.id > ?
            ORDER BY m.id ASC
            LIMIT ?
        """, (after_id, limit)).fetchall()
        payload = []
        for row in rows:
            payload.append({
                "id": int(row["id"]),
                "sessionId": row["session_id"],
                "sessionSource": row["session_source"],
                "role": row["role"],
                "content": row["content"],
                "timestamp": row["timestamp"],
                "active": bool(row["active"]),
                "observed": bool(row["observed"]),
                "toolName": row["tool_name"],
                "toolCallId": row["tool_call_id"],
                "platformMessageId": row["platform_message_id"],
            })
        print(json.dumps({"ok": True, "payload": payload}, ensure_ascii=False))
    else:
        print(json.dumps({"ok": False, "error": "unsupported mode"}, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
`;

export type HermesStateDbRealtimeWatcher = {
  primeCursor: () => Promise<void>;
  pollOnce: () => Promise<void>;
  start: () => void;
  stop: () => void;
  cursor: () => HermesStateDbRealtimeCursor;
};

export function buildHermesStateDbRealtimePayloads(params: {
  gatewayId: string;
  cursor: HermesStateDbRealtimeCursor;
  rows: HermesStateDbRealtimeMessageRow[];
}): HermesStateDbRealtimeBuildResult {
  const cursor = cloneCursor(params.cursor);
  const payloads: HermesStateDbRealtimePayload[] = [];
  const rows = [...params.rows].sort((left, right) => left.id - right.id);

  for (const row of rows) {
    if (row.id <= cursor.lastMessageId) {
      continue;
    }
    cursor.lastMessageId = Math.max(cursor.lastMessageId, row.id);
    if (!row.active) {
      continue;
    }

    if (row.role === "user") {
      const visibleText = normalizeHermesStateDbUserText(row.content);
      if (!visibleText) {
        delete cursor.openTurnsBySession[row.sessionId];
        continue;
      }
      // ClawConnect 自己发起的移动端 turn 已经通过 API/CLI streaming 推送过；
      // state.db 回写只用于历史，所以后续 assistant/tool 行必须跳过到下一个 user 行。
      const skipUntilNextUser = isClawConnectMobileTurn(row.content);
      const turn = buildOpenTurn(row, skipUntilNextUser);
      cursor.openTurnsBySession[row.sessionId] = turn;
      if (skipUntilNextUser) {
        continue;
      }
      payloads.push(buildUserPayload(params.gatewayId, row, turn, visibleText));
      continue;
    }

    const turn = cursor.openTurnsBySession[row.sessionId] ?? buildOpenTurn(row, false);
    if (turn.skipUntilNextUser) {
      continue;
    }
    const visibleText = normalizeHermesStateDbOutputText(row.content);
    if (!visibleText) {
      continue;
    }
    payloads.push(buildOutputPayload(params.gatewayId, row, turn, visibleText));
  }

  return { cursor, payloads };
}

export async function queryHermesStateDbMaxMessageId(params: {
  dbPath: string;
  pythonBin?: string;
}): Promise<number> {
  if (!existsSync(params.dbPath)) {
    return 0;
  }
  const payload = await runHermesStateDbRealtimeQuery("max", params.dbPath, [], params.pythonBin);
  return typeof payload === "number" && Number.isFinite(payload) ? Math.max(0, Math.floor(payload)) : 0;
}

export async function queryHermesStateDbRealtimeRows(params: {
  dbPath: string;
  afterMessageId: number;
  limit?: number;
  pythonBin?: string;
}): Promise<HermesStateDbRealtimeMessageRow[]> {
  if (!existsSync(params.dbPath)) {
    return [];
  }
  const afterMessageId = Math.max(0, Math.floor(params.afterMessageId));
  const limit = Math.max(1, Math.floor(params.limit ?? HERMES_STATE_DB_REALTIME_DEFAULT_LIMIT));
  const payload = await runHermesStateDbRealtimeQuery(
    "rows",
    params.dbPath,
    [String(afterMessageId), String(limit)],
    params.pythonBin,
  );
  return Array.isArray(payload) ? payload.flatMap(parseHermesStateDbRealtimeMessageRow) : [];
}

export function createHermesStateDbRealtimeWatcher(params: {
  gatewayId: string;
  dbPath: string;
  publishPayload: (payload: HermesStateDbRealtimePayload) => void;
  pollIntervalMs?: number;
  queryMaxMessageId?: () => Promise<number>;
  queryRows?: (params: { afterMessageId: number }) => Promise<HermesStateDbRealtimeMessageRow[]>;
  onError?: (error: unknown) => void;
}): HermesStateDbRealtimeWatcher {
  let cursor: HermesStateDbRealtimeCursor = { lastMessageId: 0, openTurnsBySession: {} };
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  const pollIntervalMs = Math.max(250, Math.floor(params.pollIntervalMs ?? HERMES_STATE_DB_REALTIME_DEFAULT_POLL_INTERVAL_MS));
  const queryMaxMessageId = params.queryMaxMessageId
    ?? (() => queryHermesStateDbMaxMessageId({ dbPath: params.dbPath }));
  const queryRows = params.queryRows
    ?? ((queryParams: { afterMessageId: number }) => queryHermesStateDbRealtimeRows({
      dbPath: params.dbPath,
      afterMessageId: queryParams.afterMessageId,
    }));

  async function withErrorBoundary(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      params.onError?.(error);
    }
  }

  async function primeCursor(): Promise<void> {
    await withErrorBoundary(async () => {
      const maxMessageId = await queryMaxMessageId();
      cursor = {
        ...cursor,
        lastMessageId: Math.max(cursor.lastMessageId, maxMessageId),
      };
    });
  }

  async function pollOnce(): Promise<void> {
    if (running) {
      return;
    }
    running = true;
    await withErrorBoundary(async () => {
      const rows = await queryRows({ afterMessageId: cursor.lastMessageId });
      if (rows.length === 0) {
        return;
      }
      const result = buildHermesStateDbRealtimePayloads({
        gatewayId: params.gatewayId,
        cursor,
        rows,
      });
      cursor = result.cursor;
      for (const payload of result.payloads) {
        params.publishPayload(payload);
      }
    });
    running = false;
  }

  function start(): void {
    if (timer) {
      return;
    }
    void primeCursor().then(() => pollOnce());
    timer = setInterval(() => {
      void pollOnce();
    }, pollIntervalMs);
  }

  function stop(): void {
    if (!timer) {
      return;
    }
    clearInterval(timer);
    timer = undefined;
  }

  return {
    primeCursor,
    pollOnce,
    start,
    stop,
    cursor: () => cloneCursor(cursor),
  };
}

export function resolveHermesStateDbRealtimePath(): string | undefined {
  return resolveHermesStateDbPath();
}

export function resolveHermesStateDbRealtimePython(): string {
  return resolveHermesPythonBin();
}

async function runHermesStateDbRealtimeQuery(
  mode: "max" | "rows",
  dbPath: string,
  args: string[],
  pythonBin = resolveHermesStateDbRealtimePython(),
): Promise<unknown> {
  return readHermesStateDbRealtimePayload(async () => {
    const { stdout } = await execFile(
      pythonBin,
      ["-c", HERMES_STATE_DB_REALTIME_QUERY_SCRIPT, mode, dbPath, ...args],
      {
        cwd: homedir(),
        encoding: "utf8",
        env: { ...SUBPROCESS_ENV, ...process.env },
        timeout: HERMES_STATE_DB_REALTIME_QUERY_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    return stdout;
  });
}

class HermesStateDbRealtimeOutputError extends Error {}

export async function readHermesStateDbRealtimePayload(
  readOutput: () => Promise<string>,
  maxAttempts = HERMES_STATE_DB_REALTIME_QUERY_ATTEMPTS,
): Promise<unknown> {
  const attempts = Math.max(1, Math.floor(maxAttempts));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let parsed: unknown;
    try {
      const output = (await readOutput()).trim();
      if (!output) {
        throw new HermesStateDbRealtimeOutputError("Hermes state.db realtime query returned empty output");
      }
      try {
        parsed = JSON.parse(output);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new HermesStateDbRealtimeOutputError(
          `Hermes state.db realtime query returned invalid JSON: ${detail}`,
        );
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new HermesStateDbRealtimeOutputError("Hermes state.db realtime query returned an invalid payload");
      }
    } catch (error) {
      if (error instanceof HermesStateDbRealtimeOutputError && attempt < attempts) {
        continue;
      }
      if (error instanceof HermesStateDbRealtimeOutputError && attempts > 1) {
        throw new HermesStateDbRealtimeOutputError(`${error.message} after ${attempts} attempts`);
      }
      throw error;
    }

    const result = parsed as { ok?: boolean; payload?: unknown; error?: unknown };
    if (result.ok === true) {
      return result.payload;
    }
    throw new Error(
      typeof result.error === "string" ? result.error : "Hermes state.db realtime query failed",
    );
  }
  throw new Error("Hermes state.db realtime query failed");
}

function parseHermesStateDbRealtimeMessageRow(value: unknown): HermesStateDbRealtimeMessageRow[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const id = numberValue(record.id);
  const sessionId = stringValue(record.sessionId);
  const role = parseTimelineRole(record.role);
  const timestamp = numberValue(record.timestamp);
  if (id === undefined || !sessionId || !role || timestamp === undefined) {
    return [];
  }
  return [{
    id,
    sessionId,
    sessionSource: stringValue(record.sessionSource) ?? "",
    role,
    content: stringValue(record.content) ?? "",
    timestamp,
    active: booleanValue(record.active, true),
    observed: booleanValue(record.observed, false),
    ...(stringValue(record.toolName) ? { toolName: stringValue(record.toolName) } : {}),
    ...(stringValue(record.toolCallId) ? { toolCallId: stringValue(record.toolCallId) } : {}),
    ...(stringValue(record.platformMessageId) ? { platformMessageId: stringValue(record.platformMessageId) } : {}),
  }];
}

function parseTimelineRole(value: unknown): HermesStateDbRealtimeMessageRow["role"] | undefined {
  const role = stringValue(value)?.trim().toLowerCase();
  return role === "user" || role === "assistant" || role === "tool" || role === "system"
    ? role
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  return fallback;
}

function cloneCursor(cursor: HermesStateDbRealtimeCursor): HermesStateDbRealtimeCursor {
  return {
    lastMessageId: cursor.lastMessageId,
    openTurnsBySession: Object.fromEntries(
      Object.entries(cursor.openTurnsBySession).map(([key, value]) => [key, { ...value }]),
    ),
  };
}

function buildOpenTurn(row: HermesStateDbRealtimeMessageRow, skipUntilNextUser: boolean): HermesStateDbRealtimeOpenTurn {
  const turnId = row.role === "user"
    ? `hermes-db-${row.sessionId}-turn-${row.id}`
    : `hermes-db-${row.sessionId}-orphan-turn-${row.id}`;
  return {
    turnId,
    runId: turnId,
    skipUntilNextUser,
  };
}

function buildUserPayload(
  gatewayId: string,
  row: HermesStateDbRealtimeMessageRow,
  turn: HermesStateDbRealtimeOpenTurn,
  text: string,
): HermesStateDbRealtimePayload {
  const event = buildTimelineEvent({
    gatewayId,
    sessionKey: hermesStateDbSessionKey(row.sessionId),
    row,
    turn,
    eventType: "turn.user.created",
    role: "user",
    messageState: "completed",
    runState: "active",
    content: [{ type: "text", text }],
  });
  return {
    runId: turn.runId,
    sessionKey: event.sessionKey,
    state: "history_sync",
    role: "user",
    timelineEvents: [event],
  };
}

function buildOutputPayload(
  gatewayId: string,
  row: HermesStateDbRealtimeMessageRow,
  turn: HermesStateDbRealtimeOpenTurn,
  text: string,
): HermesStateDbRealtimePayload {
  const completed = buildTimelineEvent({
    gatewayId,
    sessionKey: hermesStateDbSessionKey(row.sessionId),
    row,
    turn,
    eventType: "message.completed",
    role: row.role,
    messageState: "completed",
    runState: "active",
    content: [{ type: "text", text }],
  });
  const runCompleted = buildTimelineEvent({
    gatewayId,
    sessionKey: completed.sessionKey,
    row,
    turn,
    eventType: "run.completed",
    role: row.role,
    messageState: "completed",
    runState: "completed",
    content: [],
    messageId: completed.messageId,
    partId: "run-state",
  });
  return {
    runId: turn.runId,
    sessionKey: completed.sessionKey,
    state: "history_sync",
    role: row.role,
    timelineEvents: [completed, runCompleted],
  };
}

function buildTimelineEvent(params: {
  gatewayId: string;
  sessionKey: string;
  row: HermesStateDbRealtimeMessageRow;
  turn: HermesStateDbRealtimeOpenTurn;
  eventType: CanonicalTimelineEvent["eventType"];
  role: TimelineRole;
  messageState: CanonicalTimelineEvent["messageState"];
  runState: CanonicalTimelineEvent["runState"];
  content: TimelineContentBlock[];
  messageId?: string;
  partId?: string;
}): CanonicalTimelineEvent {
  const messageId = params.messageId ?? hermesStateDbMessageId(params.row);
  return parseCanonicalTimelineEvent({
    protocolVersion: 2,
    eventId: `evt-${messageId}-${params.eventType}`,
    eventType: params.eventType,
    gatewayId: params.gatewayId,
    sessionKey: params.sessionKey,
    turnId: params.turn.turnId,
    runId: params.turn.runId,
    messageId,
    partId: params.partId ?? "part-text-1",
    attachmentId: null,
    seq: params.row.id,
    turnSeq: params.row.id,
    role: params.role,
    messageState: params.messageState,
    runState: params.runState,
    createdAt: timestampToIso(params.row.timestamp),
    source: "history",
    content: params.content,
    attachment: null,
    error: null,
  });
}

function hermesStateDbSessionKey(sessionId: string): string {
  return sessionId.startsWith("hermes:") ? sessionId : `hermes:${sessionId}`;
}

function hermesStateDbMessageId(row: HermesStateDbRealtimeMessageRow): string {
  return `hermes-db-${row.sessionId}-message-${row.id}-${row.role}`;
}

function normalizeHermesStateDbUserText(text: string): string {
  return stripClawConnectMetadata(text)
    .split(/\r?\n/)
    .filter((line) => !/^\s*\[file attached:\s+.+]\s*$/i.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeHermesStateDbOutputText(text: string): string {
  return canonicalizeMobileAssistantText(text).text.trim();
}

function stripClawConnectMetadata(text: string): string {
  const withoutRuntimeContext = text
    .replace(HERMES_RUNTIME_CONTEXT_HINT_REGEX, "$1")
    .replace(/\n{3,}/g, "\n\n");
  const cutoff = [
    withoutRuntimeContext.indexOf(CLAWCONNECT_MOBILE_BRIDGE_MARKER),
    withoutRuntimeContext.indexOf(CLAWCONNECT_MOBILE_TURN_MARKER),
  ]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  return cutoff === undefined ? withoutRuntimeContext : withoutRuntimeContext.slice(0, cutoff);
}

function isClawConnectMobileTurn(text: string): boolean {
  return text.includes(CLAWCONNECT_MOBILE_TURN_MARKER);
}

function timestampToIso(timestamp: number): string {
  return new Date(timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp).toISOString();
}
