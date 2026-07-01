import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HermesSessionItem } from "../hermes-session-store.js";
import {
  HERMES_HOME_DIR,
  SUBPROCESS_ENV,
} from "./hermes-runtime-process.js";
import { stringValue, toRecord } from "./hermes-runtime-values.js";

const execFile = promisify(execFileCb);
const HERMES_STATE_DB_QUERY_TIMEOUT_MS = 5_000;
const HERMES_STATE_DB_LIST_LIMIT = 200;

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

def connect():
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    return conn

try:
    conn = connect()
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
    else:
        print(json.dumps({"ok": False, "error": "unsupported mode"}, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
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

export function buildEmptyHermesHistoryExport(sessionIdentity: string | undefined): Record<string, unknown> {
  return {
    sessionId: sessionIdentity?.trim() || "main",
    messages: [],
  };
}

function resolveHermesStateDbPath(): string | undefined {
  const explicit = process.env.CLAWCONNECT_HERMES_STATE_DB?.trim();
  if (explicit) {
    return explicit;
  }
  if (process.env.HERMES_BIN?.trim()) {
    return undefined;
  }
  return join(process.env.HERMES_HOME?.trim() || HERMES_HOME_DIR, "state.db");
}

function resolveHermesStateDbPython(): string {
  const explicit = process.env.HERMES_PYTHON?.trim();
  if (explicit) {
    return explicit;
  }
  const venvPython = join(process.env.HERMES_HOME?.trim() || HERMES_HOME_DIR, "hermes-agent", "venv", "bin", "python");
  return existsSync(venvPython) ? venvPython : "python3";
}

async function runHermesStateDbQuery(mode: "list" | "export", args: string[]): Promise<unknown | undefined> {
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
