import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { HermesSessionItem } from "../hermes-session-store.js";
import {
  SUBPROCESS_ENV,
} from "./hermes-runtime-process.js";
import { resolveHermesPythonBin, resolveHermesStateDbPath } from "./hermes-runtime-paths.js";
import { stringValue, toRecord } from "./hermes-runtime-values.js";

const execFile = promisify(execFileCb);
const HERMES_STATE_DB_QUERY_TIMEOUT_MS = 5_000;
const HERMES_STATE_DB_LIST_LIMIT = 200;
const HERMES_STATE_DB_QUERY_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export type HermesStateDbHistoryPage = {
  sessionId: string;
  messages: Array<Record<string, unknown>>;
  contextUser?: Record<string, unknown>;
  hasMore: boolean;
  nextCursor?: string;
  newestCursor?: string;
};

const HERMES_STATE_DB_SCRIPT = String.raw`
import datetime
import json
import sqlite3
import sys

mode = sys.argv[1]
db_path = sys.argv[2]

def to_iso(value):
    if value is None:
        return None
    try:
        timestamp = float(value)
    except Exception:
        return None
    return datetime.datetime.fromtimestamp(timestamp, datetime.timezone.utc).isoformat().replace("+00:00", "Z")

def row_dict(row):
    return {key: row[key] for key in row.keys()}

def connect(writable=False):
    uri_mode = "rw" if writable else "ro"
    conn = sqlite3.connect(f"file:{db_path}?mode={uri_mode}", uri=True, timeout=1.0)
    conn.row_factory = sqlite3.Row
    if not writable:
        conn.execute("PRAGMA query_only=ON")
    return conn

conn = None
try:
    conn = connect(writable=(mode == "rewind_after"))
    if mode == "list":
        rows = conn.execute("""
            SELECT
              s.id,
              s.title,
              s.model,
              s.started_at,
              s.ended_at,
              s.message_count,
              (
                SELECT content FROM messages
                WHERE session_id = s.id AND role = 'user' AND COALESCE(active, 1) != 0
                ORDER BY id ASC LIMIT 1
              ) AS first_user_content,
              (
                SELECT content FROM messages
                WHERE session_id = s.id AND COALESCE(active, 1) != 0
                ORDER BY id DESC LIMIT 1
              ) AS latest_content,
              (
                SELECT timestamp FROM messages
                WHERE session_id = s.id AND COALESCE(active, 1) != 0
                ORDER BY id DESC LIMIT 1
              ) AS latest_message_at
            FROM sessions s
            WHERE COALESCE(s.archived, 0) = 0
            ORDER BY COALESCE(latest_message_at, s.ended_at, s.started_at) DESC
            LIMIT ?
        """, (int(sys.argv[3]),)).fetchall()
        payload = []
        for row in rows:
            last_active = row["latest_message_at"] if row["latest_message_at"] is not None else row["ended_at"]
            if last_active is None:
                last_active = row["started_at"]
            payload.append({
                "id": row["id"],
                "title": row["title"],
                "model": row["model"],
                "preview": row["latest_content"] or row["first_user_content"] or row["title"] or row["id"],
                "lastActivityAt": to_iso(last_active),
            })
        print(json.dumps({"ok": True, "payload": payload}, ensure_ascii=False))
    elif mode == "export":
        session_id = sys.argv[3]
        session = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if session is None:
            print(json.dumps({"ok": True, "payload": None}, ensure_ascii=False))
        else:
            data = row_dict(session)
            data["sessionId"] = session_id
            data["session_id"] = session_id
            messages = []
            for message in conn.execute("""
                SELECT * FROM messages
                WHERE session_id = ? AND COALESCE(active, 1) != 0
                ORDER BY id ASC
            """, (session_id,)).fetchall():
                item = row_dict(message)
                item["id"] = str(item.get("id"))
                item["createdAt"] = to_iso(item.get("timestamp"))
                messages.append(item)
            data["messages"] = messages
            print(json.dumps({"ok": True, "payload": data}, ensure_ascii=False))
    elif mode == "history_page":
        session_id = sys.argv[3]
        limit = max(1, int(sys.argv[4]))
        cursor = int(sys.argv[5]) if sys.argv[5] else None
        direction = "newer" if sys.argv[6] == "newer" else "older"
        session = conn.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if session is None:
            print(json.dumps({"ok": True, "payload": {"found": False}}, ensure_ascii=False))
        else:
            assistant_terminal = """
              AND (
                LOWER(COALESCE(role, '')) != 'assistant'
                OR (
                  LOWER(REPLACE(REPLACE(COALESCE(finish_reason, ''), '-', '_'), ' ', '_'))
                    NOT IN ('tool_calls', 'function_call')
                  AND (
                    tool_calls IS NULL
                    OR LOWER(TRIM(tool_calls)) IN ('', '[]', '{}', 'null')
                  )
                )
              )
            """
            if direction == "newer":
                boundary = cursor if cursor is not None else 0
                query = """
                    SELECT * FROM messages
                    WHERE session_id = ?
                      AND COALESCE(active, 1) != 0
                      AND id > ?
                """ + assistant_terminal + " ORDER BY id ASC LIMIT ?"
            else:
                boundary = cursor if cursor is not None else 9223372036854775807
                query = """
                    SELECT * FROM messages
                    WHERE session_id = ?
                      AND COALESCE(active, 1) != 0
                      AND id < ?
                """ + assistant_terminal + " ORDER BY id DESC LIMIT ?"
            selected = conn.execute(query, (session_id, boundary, limit + 1)).fetchall()
            has_more = len(selected) > limit
            selected = selected[:limit]
            if direction == "older":
                selected.reverse()
            messages = []
            for message in selected:
                item = row_dict(message)
                item["id"] = str(item.get("id"))
                item["seq"] = int(message["id"])
                item["createdAt"] = to_iso(item.get("timestamp"))
                messages.append(item)
            first_id = int(selected[0]["id"]) if selected else None
            last_id = int(selected[-1]["id"]) if selected else None
            context_user = None
            if first_id is not None:
                row = conn.execute("""
                    SELECT * FROM messages
                    WHERE session_id = ?
                      AND COALESCE(active, 1) != 0
                      AND role = 'user'
                      AND id < ?
                    ORDER BY id DESC LIMIT 1
                """, (session_id, first_id)).fetchone()
                if row is not None:
                    context_user = row_dict(row)
                    context_user["id"] = str(context_user.get("id"))
                    context_user["seq"] = int(row["id"])
                    context_user["createdAt"] = to_iso(context_user.get("timestamp"))
            payload = {
                "found": True,
                "sessionId": session_id,
                "messages": messages,
                "contextUser": context_user,
                "hasMore": has_more,
                "nextCursor": (
                    f"seq:{first_id}" if has_more and direction == "older" and first_id is not None
                    else f"seq:{last_id}" if has_more and direction == "newer" and last_id is not None
                    else None
                ),
                "newestCursor": f"seq:{last_id}" if last_id is not None else None,
            }
            print(json.dumps({"ok": True, "payload": payload}, ensure_ascii=False))
    elif mode == "active_head":
        session_id = sys.argv[3]
        session = conn.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if session is None:
            print(json.dumps({"ok": True, "payload": {"found": False}}, ensure_ascii=False))
        else:
            row = conn.execute("""
                SELECT MAX(id) AS head_message_id FROM messages
                WHERE session_id = ? AND COALESCE(active, 1) != 0
            """, (session_id,)).fetchone()
            print(json.dumps({
                "ok": True,
                "payload": {
                    "found": True,
                    "headMessageId": int(row["head_message_id"] or 0),
                },
            }, ensure_ascii=False))
    elif mode == "rewind_after":
        session_id = sys.argv[3]
        head_message_id = max(0, int(sys.argv[4]))
        expected_source_run_id = sys.argv[5]
        conn.execute("BEGIN IMMEDIATE")
        session = conn.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if session is None:
            conn.rollback()
            print(json.dumps({"ok": True, "payload": {"found": False}}, ensure_ascii=False))
        else:
            target = conn.execute("""
                SELECT id, role, content FROM messages
                WHERE session_id = ? AND id > ? AND COALESCE(active, 1) != 0
                ORDER BY id ASC LIMIT 1
            """, (session_id, head_message_id)).fetchone()
            if target is None:
                conn.rollback()
                print(json.dumps({
                    "ok": True,
                    "payload": {"found": True, "rewoundCount": 0},
                }, ensure_ascii=False))
            elif target["role"] != "user":
                conn.rollback()
                print(json.dumps({"ok": False, "error": "rewind target is not a user message"}, ensure_ascii=False))
            elif not isinstance(target["content"], str):
                conn.rollback()
                print(json.dumps({"ok": False, "error": "rewind target has no text metadata"}, ensure_ascii=False))
            else:
                lines = target["content"].splitlines()
                source_run_id_matches = False
                for index, line in enumerate(lines):
                    if line.strip() != "[ClawConnect mobile turn]":
                        continue
                    source_run_id = None
                    for metadata_line in lines[index + 1:]:
                        stripped = metadata_line.strip()
                        if not stripped:
                            break
                        if stripped.startswith("[") and stripped.endswith("]"):
                            break
                        if stripped.startswith("sourceRunId:"):
                            source_run_id = stripped[len("sourceRunId:"):].strip()
                            break
                    if source_run_id == expected_source_run_id:
                        source_run_id_matches = True
                        break
                if not source_run_id_matches:
                    conn.rollback()
                    print(json.dumps({"ok": False, "error": "rewind target run id mismatch"}, ensure_ascii=False))
                else:
                    cursor = conn.execute("""
                        UPDATE messages SET active = 0
                        WHERE session_id = ? AND id >= ? AND COALESCE(active, 1) != 0
                    """, (session_id, int(target["id"])))
                    if cursor.rowcount > 0:
                        conn.execute("""
                            UPDATE sessions SET rewind_count = COALESCE(rewind_count, 0) + 1
                            WHERE id = ?
                        """, (session_id,))
                    conn.commit()
                    print(json.dumps({
                        "ok": True,
                        "payload": {
                            "found": True,
                            "rewoundCount": int(cursor.rowcount),
                        },
                    }, ensure_ascii=False))
    else:
        print(json.dumps({"ok": False, "error": "unsupported mode"}, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
finally:
    if conn is not None:
        conn.close()
`;

export async function listHermesSessionsFromStateDb(): Promise<HermesSessionItem[] | undefined> {
  const payload = await runHermesStateDbQuery("list", [String(HERMES_STATE_DB_LIST_LIMIT)]);
  if (!Array.isArray(payload)) {
    return undefined;
  }
  return payload.flatMap((entry): HermesSessionItem[] => {
    const record = toRecord(entry);
    const hermesSessionId = stringValue(record.id);
    if (!hermesSessionId) {
      return [];
    }
    const title = cleanHermesStateDbPreview(stringValue(record.title));
    const preview = cleanHermesStateDbPreview(stringValue(record.preview));
    return [{
      sessionKey: `hermes:${hermesSessionId}`,
      hermesSessionId,
      displayName: title ?? preview ?? hermesSessionId,
      derivedTitle: title ?? preview,
      label: preview,
      lastActivityAt: stringValue(record.lastActivityAt),
      kind: "hermes",
    }];
  });
}

export async function exportHermesSessionFromStateDb(sessionId: string): Promise<Record<string, unknown> | undefined> {
  const normalized = sessionId.trim();
  if (!normalized) {
    return undefined;
  }
  const payload = await runHermesStateDbQuery("export", [normalized]);
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : undefined;
}

export async function queryHermesHistoryPageFromStateDb(params: {
  sessionId: string;
  limit: number;
  cursorSeq?: number;
  direction: "older" | "newer";
}): Promise<HermesStateDbHistoryPage | null | undefined> {
  const sessionId = params.sessionId.trim();
  if (!sessionId) {
    return null;
  }
  const payload = await runHermesStateDbQuery("history_page", [
    sessionId,
    String(Math.max(1, Math.floor(params.limit))),
    params.cursorSeq === undefined ? "" : String(Math.max(0, Math.floor(params.cursorSeq))),
    params.direction,
  ]);
  const record = toRecord(payload);
  if (record.found === false) {
    return null;
  }
  if (record.found !== true || !Array.isArray(record.messages)) {
    return undefined;
  }
  return {
    sessionId: stringValue(record.sessionId) ?? sessionId,
    messages: record.messages.flatMap((value) => {
      const message = toRecord(value);
      return Object.keys(message).length > 0 ? [message] : [];
    }),
    ...(Object.keys(toRecord(record.contextUser)).length > 0
      ? { contextUser: toRecord(record.contextUser) }
      : {}),
    hasMore: record.hasMore === true,
    ...(stringValue(record.nextCursor) ? { nextCursor: stringValue(record.nextCursor) } : {}),
    ...(stringValue(record.newestCursor) ? { newestCursor: stringValue(record.newestCursor) } : {}),
  };
}

/**
 * Capture an authoritative active-message boundary before resuming a Hermes
 * CLI session. The row id is stable and lets abort recovery exclude only rows
 * created by the canceled invocation without comparing message text or time.
 */
export async function captureHermesSessionActiveHead(sessionId: string): Promise<number | undefined> {
  const normalized = sessionId.trim();
  if (!normalized) {
    return undefined;
  }
  const record = toRecord(await runHermesStateDbQuery("active_head", [normalized]));
  if (record.found !== true || typeof record.headMessageId !== "number" || !Number.isSafeInteger(record.headMessageId)) {
    return undefined;
  }
  return Math.max(0, record.headMessageId);
}

/** Soft-rewind rows appended after a previously captured active head. */
export async function rewindHermesSessionAfterActiveHead(
  sessionId: string,
  headMessageId: number,
  expectedSourceRunId: string,
): Promise<boolean> {
  const normalized = sessionId.trim();
  const normalizedSourceRunId = expectedSourceRunId.trim();
  if (!normalized || !normalizedSourceRunId || !Number.isSafeInteger(headMessageId) || headMessageId < 0) {
    return false;
  }
  const record = toRecord(await runHermesStateDbQuery("rewind_after", [
    normalized,
    String(headMessageId),
    normalizedSourceRunId,
  ]));
  return record.found === true;
}

export function buildEmptyHermesHistoryExport(sessionIdentity: string | undefined): Record<string, unknown> {
  return {
    sessionId: sessionIdentity?.trim() || "main",
    messages: [],
  };
}

function resolveHermesStateDbPython(): string {
  return resolveHermesPythonBin();
}

async function runHermesStateDbQuery(
  mode: "list" | "export" | "history_page" | "active_head" | "rewind_after",
  args: string[],
): Promise<unknown | undefined> {
  const dbPath = resolveHermesStateDbPath();
  if (!dbPath || !existsSync(dbPath)) {
    return undefined;
  }
  try {
    const { stdout } = await execFile(resolveHermesStateDbPython(), ["-c", HERMES_STATE_DB_SCRIPT, mode, dbPath, ...args], {
      cwd: homedir(),
      encoding: "utf8",
      env: { ...SUBPROCESS_ENV, ...process.env },
      timeout: HERMES_STATE_DB_QUERY_TIMEOUT_MS,
      maxBuffer: HERMES_STATE_DB_QUERY_MAX_BUFFER_BYTES,
      windowsHide: true,
    });
    const parsed = JSON.parse(stdout.trim()) as { ok?: boolean; payload?: unknown };
    return parsed.ok === true ? parsed.payload : undefined;
  } catch {
    return undefined;
  }
}

function cleanHermesStateDbPreview(value: string | undefined): string | undefined {
  const clean = value
    ?.replace(/\[Hermes runtime context][\s\S]*$/i, "")
    .replace(/\[ClawConnect mobile bridge][\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean || undefined;
}
