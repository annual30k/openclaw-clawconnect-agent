import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildHermesStateDbRealtimePayloads,
  createHermesStateDbRealtimeWatcher,
  queryHermesStateDbMaxMessageId,
  queryHermesStateDbRealtimeRows,
  resolveHermesStateDbRealtimePath,
  resolveHermesStateDbRealtimePython,
  type HermesStateDbRealtimeCursor,
  type HermesStateDbRealtimeMessageRow,
} from "./relay/hermes-state-db-realtime.js";
import { writeHermesStateDb } from "./hermes-runtime-test-support.js";

function message(row: Partial<HermesStateDbRealtimeMessageRow> & {
  id: number;
  sessionId?: string;
  role: HermesStateDbRealtimeMessageRow["role"];
  content: string;
}): HermesStateDbRealtimeMessageRow {
  return {
    sessionId: "20260706_164841_883495",
    sessionSource: "cli",
    timestamp: 1783327728 + row.id,
    active: true,
    observed: false,
    ...row,
  };
}

test("Hermes state db realtime emits completed PC TUI transcript rows with stable timeline identities", () => {
  const cursor: HermesStateDbRealtimeCursor = { lastMessageId: 9, openTurnsBySession: {} };
  const result = buildHermesStateDbRealtimePayloads({
    gatewayId: "gw-hermes",
    cursor,
    rows: [
      message({ id: 10, role: "user", content: "你好" }),
      message({ id: 11, role: "assistant", content: "你好！有什么我可以帮你处理的？" }),
    ],
  });

  assert.equal(result.cursor.lastMessageId, 11);
  assert.equal(result.payloads.length, 2);
  assert.deepEqual(
    result.payloads.flatMap((payload) => payload.timelineEvents.map((event) => event.eventType)),
    ["turn.user.created", "message.completed", "run.completed"],
  );
  assert.deepEqual(
    result.payloads.flatMap((payload) => payload.timelineEvents.map((event) => event.sessionKey)),
    ["hermes:20260706_164841_883495", "hermes:20260706_164841_883495", "hermes:20260706_164841_883495"],
  );
  assert.deepEqual(
    result.payloads.flatMap((payload) => payload.timelineEvents.map((event) => event.messageId)),
    [
      "hermes-db-20260706_164841_883495-message-10-user",
      "hermes-db-20260706_164841_883495-message-11-assistant",
      "hermes-db-20260706_164841_883495-message-11-assistant",
    ],
  );
  assert.equal(result.payloads[0]?.timelineEvents[0]?.content[0]?.text, "你好");
  assert.equal(result.payloads[1]?.timelineEvents[0]?.content[0]?.text, "你好！有什么我可以帮你处理的？");
});

test("Hermes state db realtime skips ClawConnect mobile-origin turns that were already streamed", () => {
  const cursor: HermesStateDbRealtimeCursor = { lastMessageId: 19, openTurnsBySession: {} };
  const result = buildHermesStateDbRealtimePayloads({
    gatewayId: "gw-hermes",
    cursor,
    rows: [
      message({
        id: 20,
        role: "user",
        sessionSource: "api_server",
        content: [
          "67890",
          "",
          "[ClawConnect mobile turn]",
          "sourceRunId: mobile-run-1",
          "sessionKey: hermes:20260701_173627_d5f9f7",
        ].join("\n"),
      }),
      message({
        id: 21,
        role: "assistant",
        sessionSource: "api_server",
        content: "收到：67890",
      }),
      message({
        id: 22,
        role: "user",
        sessionSource: "cli",
        content: "PC follow-up",
      }),
    ],
  });

  assert.equal(result.cursor.lastMessageId, 22);
  assert.equal(result.payloads.length, 1);
  assert.equal(result.payloads[0]?.timelineEvents[0]?.eventType, "turn.user.created");
  assert.equal(result.payloads[0]?.timelineEvents[0]?.content[0]?.text, "PC follow-up");
});

test("Hermes state db realtime ignores inactive and already-seen rows", () => {
  const cursor: HermesStateDbRealtimeCursor = { lastMessageId: 30, openTurnsBySession: {} };
  const result = buildHermesStateDbRealtimePayloads({
    gatewayId: "gw-hermes",
    cursor,
    rows: [
      message({ id: 30, role: "user", content: "seen" }),
      message({ id: 31, role: "assistant", content: "rewound", active: false }),
      message({ id: 32, role: "assistant", content: "" }),
    ],
  });

  assert.equal(result.cursor.lastMessageId, 32);
  assert.deepEqual(result.payloads, []);
});

test("Hermes state db realtime reads new rows from SQLite by autoincrement id", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-state-db-realtime-"));
  try {
    const dbPath = writeHermesStateDb(root);
    insertStateDbMessages(dbPath, [
      { sessionId: "20260706_164841_883495", source: "cli", role: "user", content: "old", timestamp: 1783327728 },
      { sessionId: "20260706_164841_883495", source: "cli", role: "user", content: "new", timestamp: 1783327729 },
      { sessionId: "20260706_164841_883495", source: "cli", role: "assistant", content: "reply", timestamp: 1783327730 },
    ]);

    assert.equal(await queryHermesStateDbMaxMessageId({ dbPath }), 3);
    const rows = await queryHermesStateDbRealtimeRows({ dbPath, afterMessageId: 1 });
    assert.deepEqual(rows.map((row) => [row.id, row.sessionId, row.sessionSource, row.role, row.content]), [
      [2, "20260706_164841_883495", "cli", "user", "new"],
      [3, "20260706_164841_883495", "cli", "assistant", "reply"],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes state db realtime watcher primes current max id and publishes only later rows", async () => {
  let rows: HermesStateDbRealtimeMessageRow[] = [
    message({ id: 40, role: "user", content: "already present" }),
  ];
  const published: Array<{ timelineEvents: Array<{ eventType: string; content: Array<{ text?: string }> }> }> = [];
  const watcher = createHermesStateDbRealtimeWatcher({
    gatewayId: "gw-hermes",
    dbPath: join(tmpdir(), "state.db"),
    publishPayload: (payload) => published.push(payload),
    queryMaxMessageId: async () => Math.max(0, ...rows.map((row) => row.id)),
    queryRows: async ({ afterMessageId }) => rows.filter((row) => row.id > afterMessageId),
  });

  await watcher.primeCursor();
  await watcher.pollOnce();
  assert.deepEqual(published, []);

  rows = [
    ...rows,
    message({ id: 41, role: "user", content: "PC prompt" }),
    message({ id: 42, role: "assistant", content: "PC reply" }),
  ];

  await watcher.pollOnce();
  await watcher.pollOnce();

  assert.equal(published.length, 2);
  assert.deepEqual(
    published.flatMap((payload) => payload.timelineEvents.map((event) => [event.eventType, event.content[0]?.text])),
    [
      ["turn.user.created", "PC prompt"],
      ["message.completed", "PC reply"],
      ["run.completed", undefined],
    ],
  );
});

test("Hermes state db realtime Python resolver supports Windows virtualenv layout", () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-state-db-python-"));
  const previousHome = process.env.HERMES_HOME;
  const previousPython = process.env.HERMES_PYTHON;
  try {
    const pythonPath = join(root, "hermes-agent", "venv", "Scripts", "python.exe");
    mkdirSync(join(root, "hermes-agent", "venv", "Scripts"), { recursive: true });
    writeFileSync(pythonPath, "");
    process.env.HERMES_HOME = root;
    delete process.env.HERMES_PYTHON;

    assert.equal(resolveHermesStateDbRealtimePython(), pythonPath);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HERMES_HOME;
    } else {
      process.env.HERMES_HOME = previousHome;
    }
    if (previousPython === undefined) {
      delete process.env.HERMES_PYTHON;
    } else {
      process.env.HERMES_PYTHON = previousPython;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes state db realtime path expands custom home and explicit database paths", () => {
  const previousHome = process.env.HERMES_HOME;
  const previousStateDb = process.env.CLAWCONNECT_HERMES_STATE_DB;
  try {
    process.env.HERMES_HOME = "~/custom-hermes-state";
    delete process.env.CLAWCONNECT_HERMES_STATE_DB;
    assert.equal(
      resolveHermesStateDbRealtimePath(),
      join(homedir(), "custom-hermes-state", "state.db"),
    );

    process.env.CLAWCONNECT_HERMES_STATE_DB = "~/custom-hermes.db";
    assert.equal(resolveHermesStateDbRealtimePath(), join(homedir(), "custom-hermes.db"));
  } finally {
    if (previousHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHome;
    if (previousStateDb === undefined) delete process.env.CLAWCONNECT_HERMES_STATE_DB;
    else process.env.CLAWCONNECT_HERMES_STATE_DB = previousStateDb;
  }
});

function insertStateDbMessages(
  dbPath: string,
  messages: Array<{ sessionId: string; source: string; role: string; content: string; timestamp: number }>,
): void {
  const script = String.raw`
import json
import sqlite3
import sys

db_path = sys.argv[1]
messages = json.loads(sys.argv[2])
conn = sqlite3.connect(db_path)
for message in messages:
    conn.execute(
        "INSERT OR IGNORE INTO sessions (id, source, started_at, message_count) VALUES (?, ?, ?, 0)",
        (message["sessionId"], message["source"], message["timestamp"] - 1),
    )
    conn.execute(
        "INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, ?, ?, ?, 1)",
        (message["sessionId"], message["role"], message["content"], message["timestamp"]),
    )
conn.commit()
conn.close()
`;
  execFileSync("python3", ["-c", script, dbPath, JSON.stringify(messages)], { stdio: "pipe" });
}
