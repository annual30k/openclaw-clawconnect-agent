import { execFile as execFileCb, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
import { hermesStateDbMessageId } from "../runtime/hermes-state-db-message-identity.js";

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
  finishReason?: string;
  toolCalls?: string;
  platformMessageId?: string;
};

export type HermesStateDbRealtimeOpenTurn = {
  turnId: string;
  runId: string;
  mobileTurn: boolean;
  sessionKey?: string;
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

db_path = sys.argv[2]

def connect():
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    return conn

def message_payload(row):
    return {
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
        "finishReason": row["finish_reason"],
        "toolCalls": row["tool_calls"],
        "platformMessageId": row["platform_message_id"],
    }

def query(conn, mode, args):
    if mode == "max":
        row = conn.execute("SELECT COALESCE(MAX(id), 0) AS max_id FROM messages").fetchone()
        return int(row["max_id"] or 0)
    elif mode == "rows":
        after_id = int(args[0])
        limit = int(args[1])
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
              m.finish_reason,
              m.tool_calls,
              m.platform_message_id
            FROM messages m
            LEFT JOIN sessions s ON s.id = m.session_id
            WHERE m.id > ?
            ORDER BY m.id ASC
            LIMIT ?
        """, (after_id, limit)).fetchall()
        return [message_payload(row) for row in rows]
    elif mode == "open_turn_users":
        up_to_id = int(args[0])
        rows = conn.execute("""
            WITH latest_user AS (
              SELECT session_id, MAX(id) AS message_id
              FROM messages
              WHERE id <= ?
                AND role = 'user'
                AND COALESCE(active, 1) = 1
              GROUP BY session_id
            ),
            latest_terminal_assistant AS (
              SELECT m.session_id, MAX(m.id) AS message_id
              FROM messages m
              INNER JOIN latest_user latest
                ON latest.session_id = m.session_id
              WHERE m.id > latest.message_id
                AND m.id <= ?
                AND m.role = 'assistant'
                AND COALESCE(m.active, 1) = 1
                AND LOWER(COALESCE(m.finish_reason, '')) NOT IN ('tool_calls', 'function_call')
                AND (
                  m.tool_calls IS NULL
                  OR TRIM(m.tool_calls) IN ('', '[]', '{}', 'null')
                )
              GROUP BY m.session_id
            )
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
              m.finish_reason,
              m.tool_calls,
              m.platform_message_id
            FROM messages m
            INNER JOIN latest_user latest
              ON latest.session_id = m.session_id
            LEFT JOIN latest_terminal_assistant terminal
              ON terminal.session_id = m.session_id
            LEFT JOIN sessions s ON s.id = m.session_id
            WHERE (
                m.id = latest.message_id
                OR m.id = terminal.message_id
              )
              AND COALESCE(m.active, 1) = 1
            ORDER BY m.id ASC
        """, (up_to_id, up_to_id)).fetchall()
        return [message_payload(row) for row in rows]
    raise ValueError("unsupported mode")

def execute(conn, mode, args):
    try:
        return {"ok": True, "payload": query(conn, mode, args)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

conn = connect()
mode = sys.argv[1]
if mode == "serve":
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            response = execute(conn, request.get("mode"), request.get("args") or [])
        except Exception as exc:
            response = {"ok": False, "error": str(exc)}
        response["id"] = request.get("id") if isinstance(request, dict) else None
        print(json.dumps(response, ensure_ascii=False), flush=True)
else:
    print(json.dumps(execute(conn, mode, sys.argv[3:]), ensure_ascii=False))
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
      // 移动端 user 已由 Relay 接收，不重复回写；但最终 assistant 必须从
      // state.db 用相同 runId 回补，防止 live 断线或错误的中间完成让刷新丢回答。
      const mobileTurn = isClawConnectMobileTurn(row.content);
      const turn = buildOpenTurn(row, mobileTurn);
      cursor.openTurnsBySession[row.sessionId] = turn;
      if (mobileTurn) {
        continue;
      }
      payloads.push(buildUserPayload(params.gatewayId, row, turn, visibleText));
      continue;
    }

    const turn = cursor.openTurnsBySession[row.sessionId] ?? buildOpenTurn(row, false);
    if (turn.mobileTurn && !isTerminalHermesStateDbAssistant(row)) {
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

export async function queryHermesStateDbRealtimeOpenTurnRows(params: {
  dbPath: string;
  upToMessageId: number;
  pythonBin?: string;
}): Promise<HermesStateDbRealtimeMessageRow[]> {
  if (!existsSync(params.dbPath)) {
    return [];
  }
  const upToMessageId = Math.max(0, Math.floor(params.upToMessageId));
  const payload = await runHermesStateDbRealtimeQuery(
    "open_turn_users",
    params.dbPath,
    [String(upToMessageId)],
    params.pythonBin,
  );
  return Array.isArray(payload) ? payload.flatMap(parseHermesStateDbRealtimeMessageRow) : [];
}

export type HermesStateDbRealtimeQueryClient = {
  queryMaxMessageId: () => Promise<number>;
  queryRows: (params: { afterMessageId: number; limit?: number }) => Promise<HermesStateDbRealtimeMessageRow[]>;
  queryOpenTurnRows: (params: { upToMessageId: number }) => Promise<HermesStateDbRealtimeMessageRow[]>;
  close: () => void;
  processId: () => number | undefined;
};

export function createHermesStateDbRealtimeQueryClient(params: {
  dbPath: string;
  pythonBin?: string;
  timeoutMs?: number;
}): HermesStateDbRealtimeQueryClient {
  type PendingQuery = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  };

  let child: ChildProcessWithoutNullStreams | undefined;
  let stdoutBuffer = "";
  let stderrTail = "";
  let nextRequestId = 1;
  let closed = false;
  const pending = new Map<number, PendingQuery>();
  const timeoutMs = Math.max(250, Math.floor(params.timeoutMs ?? HERMES_STATE_DB_REALTIME_QUERY_TIMEOUT_MS));

  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };

  const stopChild = (expectedChild: ChildProcessWithoutNullStreams, error?: Error): void => {
    if (child === expectedChild) {
      child = undefined;
    }
    if (error) {
      rejectPending(error);
    }
    if (!expectedChild.killed) {
      expectedChild.kill();
    }
  };

  const ensureChild = (): ChildProcessWithoutNullStreams => {
    if (closed) {
      throw new Error("Hermes state.db realtime query client is closed");
    }
    if (child && !child.killed) {
      return child;
    }

    stdoutBuffer = "";
    stderrTail = "";
    const started = spawn(
      params.pythonBin ?? resolveHermesStateDbRealtimePython(),
      ["-u", "-c", HERMES_STATE_DB_REALTIME_QUERY_SCRIPT, "serve", params.dbPath],
      {
        cwd: homedir(),
        env: { ...SUBPROCESS_ENV, ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child = started;
    started.stdout.setEncoding("utf8");
    started.stderr.setEncoding("utf8");
    started.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line) {
          let response: { id?: unknown; ok?: unknown; payload?: unknown; error?: unknown };
          try {
            response = JSON.parse(line) as typeof response;
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            stopChild(started, new Error(`Hermes state.db realtime server returned invalid JSON: ${detail}`));
            return;
          }
          const requestId = numberValue(response.id);
          const request = requestId === undefined ? undefined : pending.get(requestId);
          if (request) {
            pending.delete(requestId!);
            clearTimeout(request.timeout);
            if (response.ok === true) {
              request.resolve(response.payload);
            } else {
              request.reject(new Error(
                typeof response.error === "string" ? response.error : "Hermes state.db realtime query failed",
              ));
            }
          }
        }
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });
    started.stderr.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-8_192);
    });
    started.once("error", (error) => {
      stopChild(started, error);
    });
    started.once("exit", (code, signal) => {
      if (child === started) {
        child = undefined;
      }
      if (pending.size > 0) {
        const detail = stderrTail.trim();
        rejectPending(new Error(
          `Hermes state.db realtime server exited (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`,
        ));
      }
    });
    return started;
  };

  const query = async (mode: "max" | "rows" | "open_turn_users", args: string[]): Promise<unknown> => {
    const started = ensureChild();
    const requestId = nextRequestId++;
    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        const error = new Error(`Hermes state.db realtime ${mode} query timed out after ${timeoutMs}ms`);
        reject(error);
        stopChild(started, error);
      }, timeoutMs);
      timeout.unref?.();
      pending.set(requestId, { resolve, reject, timeout });
      started.stdin.write(`${JSON.stringify({ id: requestId, mode, args })}\n`, (error) => {
        if (!error) {
          return;
        }
        const request = pending.get(requestId);
        if (!request) {
          return;
        }
        pending.delete(requestId);
        clearTimeout(request.timeout);
        request.reject(error);
        stopChild(started, error);
      });
    });
  };

  return {
    queryMaxMessageId: async () => {
      const payload = await query("max", []);
      return numberValue(payload) ?? 0;
    },
    queryRows: async ({ afterMessageId, limit }) => {
      const payload = await query("rows", [
        String(Math.max(0, Math.floor(afterMessageId))),
        String(Math.max(1, Math.floor(limit ?? HERMES_STATE_DB_REALTIME_DEFAULT_LIMIT))),
      ]);
      return Array.isArray(payload) ? payload.flatMap(parseHermesStateDbRealtimeMessageRow) : [];
    },
    queryOpenTurnRows: async ({ upToMessageId }) => {
      const payload = await query("open_turn_users", [String(Math.max(0, Math.floor(upToMessageId)))]);
      return Array.isArray(payload) ? payload.flatMap(parseHermesStateDbRealtimeMessageRow) : [];
    },
    close: () => {
      closed = true;
      const activeChild = child;
      if (activeChild) {
        stopChild(activeChild, new Error("Hermes state.db realtime query client closed"));
      }
    },
    processId: () => child?.pid,
  };
}

export function createHermesStateDbRealtimeWatcher(params: {
  gatewayId: string;
  dbPath: string;
  publishPayload: (payload: HermesStateDbRealtimePayload) => void;
  pollIntervalMs?: number;
  queryMaxMessageId?: () => Promise<number>;
  queryRows?: (params: { afterMessageId: number }) => Promise<HermesStateDbRealtimeMessageRow[]>;
  queryOpenTurnRows?: (params: { upToMessageId: number }) => Promise<HermesStateDbRealtimeMessageRow[]>;
  queryClientFactory?: () => HermesStateDbRealtimeQueryClient;
  onError?: (error: unknown) => void;
}): HermesStateDbRealtimeWatcher {
  let cursor: HermesStateDbRealtimeCursor = { lastMessageId: 0, openTurnsBySession: {} };
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let primed = false;
  let startGeneration = 0;
  let queryClient: HermesStateDbRealtimeQueryClient | undefined;
  const pollIntervalMs = Math.max(250, Math.floor(params.pollIntervalMs ?? HERMES_STATE_DB_REALTIME_DEFAULT_POLL_INTERVAL_MS));
  const ensureQueryClient = (): HermesStateDbRealtimeQueryClient => {
    queryClient ??= params.queryClientFactory?.()
      ?? createHermesStateDbRealtimeQueryClient({ dbPath: params.dbPath });
    return queryClient;
  };
  const queryMaxMessageId = params.queryMaxMessageId
    ?? (() => existsSync(params.dbPath) ? ensureQueryClient().queryMaxMessageId() : Promise.resolve(0));
  const queryRows = params.queryRows
    ?? ((queryParams: { afterMessageId: number }) => existsSync(params.dbPath)
      ? ensureQueryClient().queryRows(queryParams)
      : Promise.resolve([]));
  const queryOpenTurnRows = params.queryOpenTurnRows
    ?? ((queryParams: { upToMessageId: number }) => existsSync(params.dbPath)
      ? ensureQueryClient().queryOpenTurnRows(queryParams)
      : Promise.resolve([]));

  async function withErrorBoundary(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      params.onError?.(error);
    }
  }

  async function tryPrimeCursor(): Promise<boolean> {
    try {
      const maxMessageId = await queryMaxMessageId();
      const openTurnRows = await queryOpenTurnRows({ upToMessageId: maxMessageId });
      const restored = restoreHermesStateDbRealtimeOpenTurns(
        params.gatewayId,
        cursor,
        openTurnRows,
      );
      cursor = {
        ...restored.cursor,
        lastMessageId: Math.max(cursor.lastMessageId, maxMessageId),
      };
      for (const payload of restored.payloads) {
        params.publishPayload(payload);
      }
      return true;
    } catch (error) {
      params.onError?.(error);
      return false;
    }
  }

  async function primeCursor(): Promise<void> {
    primed = await tryPrimeCursor();
  }

  async function pollOnce(expectedStartGeneration?: number): Promise<void> {
    if (running) {
      return;
    }
    running = true;
    try {
      if (!primed) {
        primed = await tryPrimeCursor();
        if (!primed) {
          return;
        }
      }
      if (expectedStartGeneration !== undefined && expectedStartGeneration !== startGeneration) {
        return;
      }
      await withErrorBoundary(async () => {
        const rows = await queryRows({ afterMessageId: cursor.lastMessageId });
        if (
          rows.length === 0
          || (expectedStartGeneration !== undefined && expectedStartGeneration !== startGeneration)
        ) {
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
    } finally {
      running = false;
    }
  }

  function start(): void {
    if (timer) {
      return;
    }
    const generation = ++startGeneration;
    void pollOnce(generation);
    timer = setInterval(() => {
      void pollOnce(generation);
    }, pollIntervalMs);
  }

  function stop(): void {
    startGeneration += 1;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    queryClient?.close();
    queryClient = undefined;
    primed = false;
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
  mode: "max" | "rows" | "open_turn_users",
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
        maxBuffer: 16 * 1024 * 1024,
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
    ...(stringValue(record.finishReason) ? { finishReason: stringValue(record.finishReason) } : {}),
    ...(stringValue(record.toolCalls) ? { toolCalls: stringValue(record.toolCalls) } : {}),
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

function restoreHermesStateDbRealtimeOpenTurns(
  gatewayId: string,
  cursor: HermesStateDbRealtimeCursor,
  rows: HermesStateDbRealtimeMessageRow[],
): HermesStateDbRealtimeBuildResult {
  const restored: HermesStateDbRealtimeCursor = {
    lastMessageId: cursor.lastMessageId,
    openTurnsBySession: {},
  };
  const latestMobileFinalBySession = new Map<string, {
    row: HermesStateDbRealtimeMessageRow;
    turn: HermesStateDbRealtimeOpenTurn;
  }>();
  for (const row of [...rows].sort((left, right) => left.id - right.id)) {
    if (!row.active) {
      continue;
    }
    if (row.role === "user") {
      const mobileTurn = isClawConnectMobileTurn(row.content);
      const visibleText = normalizeHermesStateDbUserText(row.content);
      if (!visibleText && !mobileTurn) {
        delete restored.openTurnsBySession[row.sessionId];
        latestMobileFinalBySession.delete(row.sessionId);
        continue;
      }
      restored.openTurnsBySession[row.sessionId] = buildOpenTurn(row, mobileTurn);
      continue;
    }
    const turn = restored.openTurnsBySession[row.sessionId];
    if (!turn?.mobileTurn || !isTerminalHermesStateDbAssistant(row)) {
      continue;
    }
    const visibleText = normalizeHermesStateDbOutputText(row.content);
    if (!visibleText) {
      continue;
    }
    latestMobileFinalBySession.set(row.sessionId, { row, turn });
  }
  const payloads = [...latestMobileFinalBySession.values()]
    .sort((left, right) => left.row.id - right.row.id)
    .map(({ row, turn }) => buildOutputPayload(
      gatewayId,
      row,
      turn,
      normalizeHermesStateDbOutputText(row.content),
    ));
  return { cursor: restored, payloads };
}

function buildOpenTurn(row: HermesStateDbRealtimeMessageRow, mobileTurn: boolean): HermesStateDbRealtimeOpenTurn {
  const mobileSourceRunId = row.role === "user" ? clawConnectMobileSourceRunId(row.content) : undefined;
  const mobileSessionKey = row.role === "user" ? clawConnectMobileSessionKey(row.content) : undefined;
  const turnId = mobileSourceRunId
    ?? (row.role === "user"
      ? `hermes-db-${row.sessionId}-turn-${row.id}`
      : `hermes-db-${row.sessionId}-orphan-turn-${row.id}`);
  return {
    turnId,
    runId: turnId,
    mobileTurn,
    ...(mobileSessionKey ? { sessionKey: mobileSessionKey } : {}),
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
    sessionKey: hermesStateDbTurnSessionKey(row.sessionId, turn),
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
    sessionKey: hermesStateDbTurnSessionKey(row.sessionId, turn),
    row,
    turn,
    eventType: "message.completed",
    role: row.role,
    messageState: "completed",
    runState: "active",
    content: [{ type: "text", text }],
    ...(turn.mobileTurn && row.role === "assistant"
      ? { messageId: `assistant-${turn.runId}` }
      : {}),
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
  const messageId = params.messageId ?? hermesStateDbMessageId({
    sessionId: params.row.sessionId,
    rowId: params.row.id,
    role: params.row.role,
  });
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

function hermesStateDbTurnSessionKey(
  sessionId: string,
  turn: HermesStateDbRealtimeOpenTurn,
): string {
  return turn.sessionKey?.trim() || hermesStateDbSessionKey(sessionId);
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

function clawConnectMobileSourceRunId(text: string): string | undefined {
  return clawConnectMobileMetadataValue(text, "sourceRunId");
}

function clawConnectMobileSessionKey(text: string): string | undefined {
  return clawConnectMobileMetadataValue(text, "sessionKey");
}

function clawConnectMobileMetadataValue(text: string, key: string): string | undefined {
  const markerIndex = text.indexOf(CLAWCONNECT_MOBILE_TURN_MARKER);
  if (markerIndex < 0) {
    return undefined;
  }
  const metadataBlock = text.slice(markerIndex + CLAWCONNECT_MOBILE_TURN_MARKER.length);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s*${escapedKey}\\s*:\\s*(.+?)\\s*$`, "im").exec(metadataBlock);
  return match?.[1]?.trim() || undefined;
}

function isTerminalHermesStateDbAssistant(row: HermesStateDbRealtimeMessageRow): boolean {
  if (row.role !== "assistant") {
    return false;
  }
  const finishReason = row.finishReason?.trim().toLowerCase().replace(/[\s-]+/g, "_") ?? "";
  if (finishReason === "tool_calls" || finishReason === "function_call") {
    return false;
  }
  return !hasHermesStateDbToolCalls(row.toolCalls);
}

function hasHermesStateDbToolCalls(value: string | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "[]" || trimmed === "{}" || trimmed === "null") {
    return false;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.length > 0;
    }
    if (parsed && typeof parsed === "object") {
      return Object.keys(parsed as Record<string, unknown>).length > 0;
    }
    return parsed !== null;
  } catch {
    return true;
  }
}

function timestampToIso(timestamp: number): string {
  return new Date(timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp).toISOString();
}
