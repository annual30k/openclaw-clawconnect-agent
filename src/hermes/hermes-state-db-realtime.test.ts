import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildHermesStateDbRealtimePayloads,
  createHermesStateDbRealtimeQueryClient,
  createHermesStateDbRealtimeWatcher,
  queryHermesStateDbMaxMessageId,
  queryHermesStateDbRealtimeOpenTurnRows,
  queryHermesStateDbRealtimeRows,
  readHermesStateDbRealtimePayload,
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

test("Hermes state db realtime retries a transient empty subprocess output", async () => {
  const outputs = ["", '{"ok":true,"payload":42}'];
  let attempts = 0;
  const payload = await readHermesStateDbRealtimePayload(async () => {
    attempts += 1;
    return outputs.shift() ?? "";
  });

  assert.equal(payload, 42);
  assert.equal(attempts, 2);
});

test("Hermes state db realtime caps retries for truncated JSON output", async () => {
  let attempts = 0;
  await assert.rejects(
    readHermesStateDbRealtimePayload(async () => {
      attempts += 1;
      return '{"ok":true';
    }),
    /invalid JSON: .* after 2 attempts/,
  );
  assert.equal(attempts, 2);
});

test("Hermes state db realtime does not retry a structured query failure", async () => {
  let attempts = 0;
  await assert.rejects(
    readHermesStateDbRealtimePayload(async () => {
      attempts += 1;
      return '{"ok":false,"error":"database is locked"}';
    }),
    /database is locked/,
  );
  assert.equal(attempts, 1);
});

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

test("Hermes state db realtime suppresses mobile user and tool-call rows but backfills terminal final", () => {
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
        content: "Let me check.",
        finishReason: "tool_calls",
        toolCalls: JSON.stringify([{ id: "call-check" }]),
      }),
      message({
        id: 22,
        role: "assistant",
        sessionSource: "api_server",
        content: "收到：67890",
        finishReason: "stop",
      }),
      message({
        id: 23,
        role: "user",
        sessionSource: "cli",
        content: "PC follow-up",
      }),
    ],
  });

  assert.equal(result.cursor.lastMessageId, 23);
  assert.deepEqual(result.cursor.openTurnsBySession["20260706_164841_883495"], {
    turnId: "hermes-db-20260706_164841_883495-turn-23",
    runId: "hermes-db-20260706_164841_883495-turn-23",
    mobileTurn: false,
  });
  assert.equal(result.payloads.length, 2);
  assert.deepEqual(
    result.payloads[0]?.timelineEvents.map((event) => [
      event.eventType,
      event.sessionKey,
      event.turnId,
      event.messageId,
      event.content[0]?.text,
    ]),
    [
      [
        "message.completed",
        "hermes:20260701_173627_d5f9f7",
        "mobile-run-1",
        "assistant-mobile-run-1",
        "收到：67890",
      ],
      [
        "run.completed",
        "hermes:20260701_173627_d5f9f7",
        "mobile-run-1",
        "assistant-mobile-run-1",
        undefined,
      ],
    ],
  );
  assert.equal(result.payloads[1]?.timelineEvents[0]?.eventType, "turn.user.created");
  assert.equal(result.payloads[1]?.timelineEvents[0]?.content[0]?.text, "PC follow-up");
});

test("Hermes state db realtime quarantines an incomplete mobile turn instead of publishing an orphan reply", () => {
  const first = buildHermesStateDbRealtimePayloads({
    gatewayId: "gw-hermes",
    cursor: { lastMessageId: 49, openTurnsBySession: {} },
    rows: [
      message({
        id: 50,
        role: "user",
        sessionSource: "api_server",
        content: [
          "mobile prompt",
          "",
          "[ClawConnect mobile turn]",
          "sessionKey: hermes:mobile-session",
        ].join("\n"),
      }),
      message({
        id: 51,
        role: "assistant",
        sessionSource: "api_server",
        content: "must not become an orphan reply",
        finishReason: "stop",
      }),
    ],
  });

  assert.deepEqual(first.payloads, []);
  assert.deepEqual(first.warnings, [{
    code: "mobile_turn_metadata_incomplete",
    sessionId: "20260706_164841_883495",
    rowId: 50,
    missingFields: ["sourceRunId"],
  }]);
  assert.equal(first.cursor.openTurnsBySession["20260706_164841_883495"]?.invalidMobileTurn, true);

  const later = buildHermesStateDbRealtimePayloads({
    gatewayId: "gw-hermes",
    cursor: first.cursor,
    rows: [message({
      id: 52,
      role: "assistant",
      sessionSource: "api_server",
      content: "later orphan reply",
      finishReason: "stop",
    })],
  });
  assert.deepEqual(later.payloads, []);
  assert.deepEqual(later.warnings, []);
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
    insertStateDbMessages(dbPath, [
      {
        sessionId: "20260706_164841_883495",
        source: "cli",
        role: "user",
        content: "inserted after the max-id snapshot",
        timestamp: 1783327731,
      },
    ]);
    const openTurnRows = await queryHermesStateDbRealtimeOpenTurnRows({
      dbPath,
      upToMessageId: 3,
    });
    assert.deepEqual(openTurnRows.map((row) => [row.id, row.sessionId, row.role, row.content]), [
      [2, "20260706_164841_883495", "user", "new"],
      [3, "20260706_164841_883495", "assistant", "reply"],
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

test("Hermes state db realtime watcher restores mobile turn identity across reconnect", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-state-db-reconnect-"));
  let watcher: ReturnType<typeof createHermesStateDbRealtimeWatcher> | undefined;
  try {
    const dbPath = writeHermesStateDb(root);
    insertStateDbMessages(dbPath, [
      {
        sessionId: "mobile-session",
        source: "api_server",
        role: "user",
        content: [
          "mobile prompt",
          "",
          "[ClawConnect mobile turn]",
          "sourceRunId: mobile-run-after-reconnect",
          "sessionKey: hermes:mobile-session",
        ].join("\n"),
        timestamp: 1783327800,
      },
      {
        sessionId: "pc-session",
        source: "cli",
        role: "user",
        content: "PC prompt before reconnect",
        timestamp: 1783327801,
      },
    ]);

    const published: Array<{
      runId: string;
      timelineEvents: Array<{ eventType: string; turnId: string; content: Array<{ text?: string }> }>;
    }> = [];
    watcher = createHermesStateDbRealtimeWatcher({
      gatewayId: "gw-hermes",
      dbPath,
      publishPayload: (payload) => published.push(payload),
    });

    await watcher.primeCursor();
    assert.deepEqual(watcher.cursor(), {
      lastMessageId: 2,
      openTurnsBySession: {
        "mobile-session": {
          turnId: "mobile-run-after-reconnect",
          runId: "mobile-run-after-reconnect",
          mobileTurn: true,
          sessionKey: "hermes:mobile-session",
        },
        "pc-session": {
          turnId: "hermes-db-pc-session-turn-2",
          runId: "hermes-db-pc-session-turn-2",
          mobileTurn: false,
        },
      },
    });

    insertStateDbMessages(dbPath, [
      {
        sessionId: "mobile-session",
        source: "api_server",
        role: "assistant",
        content: "mobile terminal reply",
        finishReason: "stop",
        timestamp: 1783327802,
      },
      {
        sessionId: "pc-session",
        source: "cli",
        role: "assistant",
        content: "PC reply after reconnect",
        timestamp: 1783327803,
      },
    ]);

    await watcher.pollOnce();

    assert.equal(published.length, 2);
    assert.equal(published[0]?.runId, "mobile-run-after-reconnect");
    assert.deepEqual(
      published[0]?.timelineEvents.map((event) => [event.eventType, event.turnId, event.content[0]?.text]),
      [
        ["message.completed", "mobile-run-after-reconnect", "mobile terminal reply"],
        ["run.completed", "mobile-run-after-reconnect", undefined],
      ],
    );
    assert.equal(published[1]?.runId, "hermes-db-pc-session-turn-2");
    assert.deepEqual(
      published[1]?.timelineEvents.map((event) => [event.eventType, event.turnId, event.content[0]?.text]),
      [
        ["message.completed", "hermes-db-pc-session-turn-2", "PC reply after reconnect"],
        ["run.completed", "hermes-db-pc-session-turn-2", undefined],
      ],
    );
  } finally {
    watcher?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes state db realtime watcher does not poll before reconnect context is restored", async () => {
  const mobileUser = message({
    id: 50,
    sessionId: "mobile-session",
    sessionSource: "api_server",
    role: "user",
    content: [
      "mobile prompt",
      "",
      "[ClawConnect mobile turn]",
      "sourceRunId: mobile-run-before-poll",
      "sessionKey: hermes:mobile-session",
    ].join("\n"),
  });
  let restoreContext: ((rows: HermesStateDbRealtimeMessageRow[]) => void) | undefined;
  const contextRows = new Promise<HermesStateDbRealtimeMessageRow[]>((resolve) => {
    restoreContext = resolve;
  });
  let rowQueries = 0;
  let observeRowQuery: (() => void) | undefined;
  const rowQueryObserved = new Promise<void>((resolve) => {
    observeRowQuery = resolve;
  });
  const published: unknown[] = [];
  const watcher = createHermesStateDbRealtimeWatcher({
    gatewayId: "gw-hermes",
    dbPath: join(tmpdir(), "state.db"),
    pollIntervalMs: 250,
    publishPayload: (payload) => published.push(payload),
    queryMaxMessageId: async () => 50,
    queryOpenTurnRows: async () => contextRows,
    queryRows: async () => {
      rowQueries += 1;
      observeRowQuery?.();
      return [message({
        id: 51,
        sessionId: "mobile-session",
        sessionSource: "api_server",
        role: "assistant",
        content: "reply already delivered by streaming",
      })];
    },
  });

  watcher.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(rowQueries, 0);

    restoreContext?.([mobileUser]);
    let pollTimeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        rowQueryObserved,
        new Promise((_, reject) => {
          pollTimeout = setTimeout(() => reject(new Error("watcher did not poll after prime")), 1_000);
        }),
      ]);
    } finally {
      if (pollTimeout) clearTimeout(pollTimeout);
    }
  } finally {
    watcher.stop();
  }

  assert.equal(rowQueries, 1);
  assert.equal(published.length, 1);
  assert.equal(
    (published[0] as { timelineEvents: Array<{ messageId: string }> }).timelineEvents[0]?.messageId,
    "assistant-mobile-run-before-poll",
  );
});

test("Hermes state db realtime watcher retries a failed reconnect prime without publishing history", async () => {
  const mobileUser = message({
    id: 60,
    sessionId: "mobile-session",
    sessionSource: "api_server",
    role: "user",
    content: [
      "mobile prompt",
      "",
      "[ClawConnect mobile turn]",
      "sourceRunId: mobile-run-after-prime-retry",
      "sessionKey: hermes:mobile-session",
    ].join("\n"),
  });
  let openTurnQueries = 0;
  let rowQueries = 0;
  const errors: string[] = [];
  const published: unknown[] = [];
  const watcher = createHermesStateDbRealtimeWatcher({
    gatewayId: "gw-hermes",
    dbPath: join(tmpdir(), "state.db"),
    publishPayload: (payload) => published.push(payload),
    queryMaxMessageId: async () => 60,
    queryOpenTurnRows: async () => {
      openTurnQueries += 1;
      if (openTurnQueries === 1) {
        throw new Error("truncated state db context output");
      }
      return [mobileUser];
    },
    queryRows: async () => {
      rowQueries += 1;
      return [message({
        id: 61,
        sessionId: "mobile-session",
        sessionSource: "api_server",
        role: "assistant",
        content: "reply already delivered by streaming",
      })];
    },
    onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
  });

  await watcher.pollOnce();

  assert.equal(openTurnQueries, 1);
  assert.equal(rowQueries, 0);
  assert.deepEqual(published, []);
  assert.deepEqual(errors, ["truncated state db context output"]);
  assert.deepEqual(watcher.cursor(), { lastMessageId: 0, openTurnsBySession: {} });

  await watcher.pollOnce();

  assert.equal(openTurnQueries, 2);
  assert.equal(rowQueries, 1);
  assert.equal(published.length, 1);
  assert.deepEqual(watcher.cursor(), {
    lastMessageId: 61,
    openTurnsBySession: {
      "mobile-session": {
        turnId: "mobile-run-after-prime-retry",
        runId: "mobile-run-after-prime-retry",
        mobileTurn: true,
        sessionKey: "hermes:mobile-session",
      },
    },
  });
});

test("Hermes state db realtime watcher replays an existing mobile terminal final during prime", async () => {
  const mobileUser = message({
    id: 70,
    sessionId: "mobile-session",
    sessionSource: "api_server",
    role: "user",
    content: [
      "weather prompt",
      "",
      "[ClawConnect mobile turn]",
      "sourceRunId: mobile-weather-run",
      "sessionKey: qa-no-cli-stream",
    ].join("\n"),
  });
  const intermediate = message({
    id: 71,
    sessionId: "mobile-session",
    sessionSource: "api_server",
    role: "assistant",
    content: "Let me use the browser to fetch the weather data.",
    finishReason: "tool_calls",
    toolCalls: JSON.stringify([{ id: "call-browser" }]),
  });
  const final = message({
    id: 72,
    sessionId: "mobile-session",
    sessionSource: "api_server",
    role: "assistant",
    content: "福州明日天气完整表格",
    finishReason: "stop",
  });
  const published: Array<{
    sessionKey: string;
    runId: string;
    timelineEvents: Array<{ eventType: string; messageId: string; content: Array<{ text?: string }> }>;
  }> = [];
  const watcher = createHermesStateDbRealtimeWatcher({
    gatewayId: "gw-hermes",
    dbPath: join(tmpdir(), "state.db"),
    publishPayload: (payload) => published.push(payload),
    queryMaxMessageId: async () => 72,
    queryOpenTurnRows: async () => [mobileUser, intermediate, final],
    queryRows: async () => [],
  });

  await watcher.primeCursor();

  assert.equal(published.length, 1);
  assert.equal(published[0]?.sessionKey, "qa-no-cli-stream");
  assert.equal(published[0]?.runId, "mobile-weather-run");
  assert.deepEqual(
    published[0]?.timelineEvents.map((event) => [
      event.eventType,
      event.messageId,
      event.content[0]?.text,
    ]),
    [
      ["message.completed", "assistant-mobile-weather-run", "福州明日天气完整表格"],
      ["run.completed", "assistant-mobile-weather-run", undefined],
    ],
  );
});

test("Hermes state db realtime watcher reuses one Python process across polls and closes it on stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-state-db-process-lifecycle-"));
  let watcher: ReturnType<typeof createHermesStateDbRealtimeWatcher> | undefined;
  try {
    const dbPath = writeHermesStateDb(root);
    const spawnLog = join(root, "python-spawns.log");
    const pythonWrapper = join(root, "python-wrapper.sh");
    writeFileSync(pythonWrapper, [
      "#!/bin/sh",
      `printf 'spawn\\n' >> ${JSON.stringify(spawnLog)}`,
      "exec python3 \"$@\"",
      "",
    ].join("\n"));
    chmodSync(pythonWrapper, 0o755);

    let client = createHermesStateDbRealtimeQueryClient({ dbPath, pythonBin: pythonWrapper });
    watcher = createHermesStateDbRealtimeWatcher({
      gatewayId: "gw-hermes",
      dbPath,
      pollIntervalMs: 250,
      publishPayload: () => {},
      queryClientFactory: () => client,
    });
    watcher.start();
    await waitFor(() => client.processId() !== undefined, 3_000);
    const firstPid = client.processId();
    assert.ok(firstPid);

    await new Promise((resolve) => setTimeout(resolve, 850));
    await waitFor(() => spawnCount(spawnLog) === 1, 3_000);
    assert.equal(spawnCount(spawnLog), 1);
    assert.equal(isProcessAlive(firstPid!), true);

    watcher.stop();
    await waitFor(() => !isProcessAlive(firstPid!), 3_000);
    assert.equal(isProcessAlive(firstPid!), false);

    client = createHermesStateDbRealtimeQueryClient({ dbPath, pythonBin: pythonWrapper });
    watcher.start();
    await waitFor(() => client.processId() !== undefined, 3_000);
    const secondPid = client.processId();
    assert.ok(secondPid);
    assert.notEqual(secondPid, firstPid);
    await waitFor(() => spawnCount(spawnLog) === 2, 3_000);
    assert.equal(spawnCount(spawnLog), 2);
  } finally {
    watcher?.stop();
    rmSync(root, { recursive: true, force: true });
  }
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
  messages: Array<{
    sessionId: string;
    source: string;
    role: string;
    content: string;
    timestamp: number;
    finishReason?: string;
    toolCalls?: string;
  }>,
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
        "INSERT INTO messages (session_id, role, content, timestamp, active, finish_reason, tool_calls) VALUES (?, ?, ?, ?, 1, ?, ?)",
        (
            message["sessionId"],
            message["role"],
            message["content"],
            message["timestamp"],
            message.get("finishReason"),
            message.get("toolCalls"),
        ),
    )
conn.commit()
conn.close()
`;
  execFileSync("python3", ["-c", script, dbPath, JSON.stringify(messages)], { stdio: "pipe" });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`condition was not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnCount(path: string): number {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value.length > 0 ? value.split("\n").length : 0;
  } catch {
    return 0;
  }
}
