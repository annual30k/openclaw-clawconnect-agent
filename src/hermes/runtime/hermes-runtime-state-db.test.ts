import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { restoreEnv, writeHermesStateDb } from "../hermes-runtime-test-support.js";
import {
  captureHermesSessionActiveHead,
  queryHermesHistoryPageFromStateDb,
  rewindHermesSessionAfterActiveHead,
} from "./hermes-runtime-state-db.js";

test("Hermes state.db history page tolerates BLOB columns written by newer Hermes versions", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawconnect-hermes-blob-column-"));
  const previousStateDb = process.env.CLAWCONNECT_HERMES_STATE_DB;
  try {
    const dbPath = writeHermesStateDb(root);
    const sessionId = "blob_session";
    process.env.CLAWCONNECT_HERMES_STATE_DB = dbPath;
    // 新版 Hermes 增加了 display_identity BLOB 列；历史页查询必须仍能序列化整行。
    execFileSync("python3", ["-c", String.raw`
import sqlite3
import sys
db_path, session_id = sys.argv[1:3]
conn = sqlite3.connect(db_path)
conn.execute("ALTER TABLE messages ADD COLUMN display_identity BLOB")
conn.execute("INSERT INTO sessions (id, source, started_at, message_count) VALUES (?, 'cli', 1, 2)", (session_id,))
conn.execute("INSERT INTO messages (session_id, role, content, timestamp, active, display_identity) VALUES (?, 'user', 'question', 1, 1, ?)", (session_id, bytes.fromhex("00ff10")))
conn.execute("INSERT INTO messages (session_id, role, content, timestamp, active, display_identity) VALUES (?, 'assistant', 'answer', 2, 1, ?)", (session_id, bytes.fromhex("a1b2")))
conn.commit()
conn.close()
`, dbPath, sessionId], { stdio: "pipe" });

    const page = await queryHermesHistoryPageFromStateDb({ sessionId, limit: 50, direction: "older" });
    assert.ok(page, "state.db page must be readable");
    assert.equal(page.messages.length, 2);
    assert.deepEqual(page.messages.map((message) => [message.role, message.seq, message.display_identity]), [
      ["user", 1, "00ff10"],
      ["assistant", 2, "a1b2"],
    ]);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_STATE_DB", previousStateDb);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes abort rewind refuses a different user run beyond the captured boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "clawconnect-hermes-rewind-owner-"));
  const previousStateDb = process.env.CLAWCONNECT_HERMES_STATE_DB;
  try {
    const dbPath = writeHermesStateDb(root);
    const sessionId = "shared_session";
    process.env.CLAWCONNECT_HERMES_STATE_DB = dbPath;
    execFileSync("python3", ["-c", String.raw`
import sqlite3
import sys
db_path, session_id = sys.argv[1:3]
conn = sqlite3.connect(db_path)
conn.execute("INSERT INTO sessions (id, source, started_at, message_count) VALUES (?, 'cli', 1, 1)", (session_id,))
conn.execute("INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, 'assistant', 'completed', 1, 1)", (session_id,))
conn.commit()
conn.close()
`, dbPath, sessionId], { stdio: "pipe" });

    const head = await captureHermesSessionActiveHead(sessionId);
    assert.equal(typeof head, "number");
    execFileSync("python3", ["-c", String.raw`
import sqlite3
import sys
db_path, session_id = sys.argv[1:3]
conn = sqlite3.connect(db_path)
conn.execute("INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, 'user', ?, 2, 1)", (session_id, "desktop turn"))
conn.execute("INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, 'user', ?, 3, 1)", (session_id, "mobile turn\n\n[ClawConnect mobile turn]\nsourceRunId: mobile-run\nsessionKey: main"))
conn.commit()
conn.close()
`, dbPath, sessionId], { stdio: "pipe" });

    assert.equal(await rewindHermesSessionAfterActiveHead(sessionId, head!, "mobile-run"), false);
    const result = JSON.parse(execFileSync("python3", ["-c", String.raw`
import json, sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
rows = conn.execute("SELECT content, active FROM messages WHERE session_id = ? ORDER BY id", (sys.argv[2],)).fetchall()
rewind_count = conn.execute("SELECT rewind_count FROM sessions WHERE id = ?", (sys.argv[2],)).fetchone()[0]
print(json.dumps({"rows": rows, "rewindCount": rewind_count}))
conn.close()
`, dbPath, sessionId], { encoding: "utf8" })) as {
      rows: Array<[string, number]>;
      rewindCount: number;
    };
    assert.equal(result.rows.every((row) => row[1] === 1), true);
    assert.equal(result.rewindCount, 0);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_STATE_DB", previousStateDb);
    rmSync(root, { recursive: true, force: true });
  }
});
