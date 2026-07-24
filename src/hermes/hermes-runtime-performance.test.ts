import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleHermesCommand, runHermesChatHistory } from "./hermes-runtime.js";
import {
  buildHermesStateDbRealtimePayloads,
  type HermesStateDbRealtimeMessageRow,
} from "./relay/hermes-state-db-realtime.js";
import { restoreEnv, writeHermesStateDb } from "./hermes-runtime-test-support.js";

test("Hermes history pages a state.db session larger than 1 MiB by authoritative message id", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-history-large-state-db-"));
  const previousStateDb = process.env.CLAWCONNECT_HERMES_STATE_DB;
  const previousHermesBin = process.env.HERMES_BIN;
  try {
    const sessionId = "20260723_120000_large";
    const dbPath = writeHermesStateDb(root);
    const cliCalledPath = join(root, "cli-called");
    const hermesBin = join(root, "hermes");
    writeFileSync(hermesBin, [
      "#!/bin/sh",
      `touch ${JSON.stringify(cliCalledPath)}`,
      "exit 2",
      "",
    ].join("\n"));
    chmodSync(hermesBin, 0o755);
    const seedScript = String.raw`
import sqlite3
import sys

db_path = sys.argv[1]
session_id = sys.argv[2]
conn = sqlite3.connect(db_path)
conn.execute(
    "INSERT INTO sessions (id, source, started_at, message_count) VALUES (?, 'cli', ?, ?)",
    (session_id, 1784808000, 400),
)
for index in range(1, 401):
    role = "system"
    content = f"message-{index}-" + ("x" * 4096)
    if index == 397:
        role = "user"
        content = "direct PC prompt"
    elif index == 398:
        role = "assistant"
        content = "direct PC reply"
    elif index == 399:
        role = "user"
        content = "mobile prompt\n\n[ClawConnect mobile turn]\nsourceRunId: large-mobile-run\nsessionKey: hermes:" + session_id
    elif index == 400:
        role = "assistant"
        content = "mobile terminal reply"
    conn.execute(
        "INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, ?, ?, ?, 1)",
        (session_id, role, content, 1784808000 + index),
    )
conn.commit()
conn.close()
`;
    execFileSync("python3", ["-c", seedScript, dbPath, sessionId], { stdio: "pipe" });
    assert.ok(statSync(dbPath).size > 1024 * 1024);
    process.env.CLAWCONNECT_HERMES_STATE_DB = dbPath;
    process.env.HERMES_BIN = hermesBin;

    const newest = await runHermesChatHistory({ sessionKey: `hermes:${sessionId}`, limit: 10 });
    assert.equal(newest.ok, true);
    const newestPayload = newest.payload as HistoryPayload;
    assert.deepEqual(newestPayload.messages.map((message) => message.seq), [391, 392, 393, 394, 395, 396, 397, 398, 399, 400]);
    assert.equal(newestPayload.hasMore, true);
    assert.equal(newestPayload.nextCursor, "seq:391");
    assert.equal(newestPayload.newestCursor, "seq:400");
    assert.deepEqual(
      newestPayload.messages.slice(-4).map((message) => [message.seq, message.id]),
      [
        [397, `hermes-db-${sessionId}-message-397-user`],
        [398, `hermes-db-${sessionId}-message-398-assistant`],
        [399, "user-large-mobile-run"],
        [400, "assistant-large-mobile-run"],
      ],
    );
    assert.deepEqual(
      newestPayload.timelineSnapshot?.messages.slice(-4).map((message) => [message.seq, message.messageId]),
      newestPayload.messages.slice(-4).map((message) => [message.seq, message.id]),
    );

    const realtime = buildHermesStateDbRealtimePayloads({
      gatewayId: "gw-hermes",
      cursor: { lastMessageId: 396, openTurnsBySession: {} },
      rows: [
        stateDbRealtimeMessage(397, sessionId, "user", "direct PC prompt"),
        stateDbRealtimeMessage(398, sessionId, "assistant", "direct PC reply"),
        stateDbRealtimeMessage(
          399,
          sessionId,
          "user",
          `mobile prompt\n\n[ClawConnect mobile turn]\nsourceRunId: large-mobile-run\nsessionKey: hermes:${sessionId}`,
        ),
        stateDbRealtimeMessage(400, sessionId, "assistant", "mobile terminal reply"),
      ],
    });
    const realtimeCompletedMessageIds = realtime.payloads.flatMap((payload) =>
      payload.timelineEvents
        .filter((event) => event.eventType !== "run.completed")
        .map((event) => event.messageId),
    );
    assert.deepEqual(realtimeCompletedMessageIds, [
      `hermes-db-${sessionId}-message-397-user`,
      `hermes-db-${sessionId}-message-398-assistant`,
      "assistant-large-mobile-run",
    ]);
    assert.deepEqual(
      newestPayload.messages.filter((message) => [397, 398, 400].includes(message.seq)).map((message) => message.id),
      realtimeCompletedMessageIds,
    );

    const older = await runHermesChatHistory({
      sessionKey: `hermes:${sessionId}`,
      limit: 10,
      cursor: newestPayload.nextCursor,
      direction: "older",
    });
    assert.equal(older.ok, true);
    const olderPayload = older.payload as HistoryPayload;
    assert.deepEqual(olderPayload.messages.map((message) => message.seq), [381, 382, 383, 384, 385, 386, 387, 388, 389, 390]);
    assert.equal(olderPayload.nextCursor, "seq:381");

    const newer = await runHermesChatHistory({
      sessionKey: `hermes:${sessionId}`,
      limit: 5,
      cursor: "seq:390",
      direction: "newer",
    });
    assert.equal(newer.ok, true);
    const newerPayload = newer.payload as HistoryPayload;
    assert.deepEqual(newerPayload.messages.map((message) => message.seq), [391, 392, 393, 394, 395]);
    assert.equal(newerPayload.nextCursor, "seq:395");

    const assistantOnly = await runHermesChatHistory({ sessionKey: `hermes:${sessionId}`, limit: 1 });
    assert.equal(assistantOnly.ok, true);
    const assistantOnlyPayload = assistantOnly.payload as HistoryPayload;
    assert.deepEqual(assistantOnlyPayload.messages.map((message) => [message.seq, message.runId]), [
      [400, "large-mobile-run"],
    ]);
    assert.equal(statExists(cliCalledPath), false);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_STATE_DB", previousStateDb);
    restoreEnv("HERMES_BIN", previousHermesBin);
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent Hermes status commands do not block the Node event loop", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-status-async-"));
  const previousHermesBin = process.env.HERMES_BIN;
  try {
    const hermesBin = join(root, "hermes");
    writeFileSync(hermesBin, [
      "#!/usr/bin/env node",
      "if (process.argv[2] !== 'status') process.exit(2);",
      "setTimeout(() => {",
      "  console.log('Gateway Service\\nStatus: running');",
      "}, 250);",
      "",
    ].join("\n"));
    chmodSync(hermesBin, 0o755);
    process.env.HERMES_BIN = hermesBin;

    const eventLoopTick = new Promise<"tick">((resolve) => setTimeout(() => resolve("tick"), 25));
    const first = handleHermesCommand("hermes.status", {});
    const second = handleHermesCommand("hermes.status", {});
    assert.ok(first instanceof Promise);
    assert.ok(second instanceof Promise);
    const statusResults = Promise.all([first, second]);
    assert.equal(await Promise.race([eventLoopTick, statusResults.then(() => "status" as const)]), "tick");

    const [firstResult, secondResult] = await statusResults;
    assert.equal(firstResult?.ok, true);
    assert.equal(secondResult?.ok, true);
    assert.match(String((firstResult?.payload as { output?: string })?.output), /Status: running/);
  } finally {
    restoreEnv("HERMES_BIN", previousHermesBin);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes history CLI fallback is bounded, cancelled, and single-flight", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-history-cli-fallback-"));
  const previousStateDb = process.env.CLAWCONNECT_HERMES_STATE_DB;
  const previousHermesBin = process.env.HERMES_BIN;
  const previousTimeout = process.env.CLAWCONNECT_HERMES_HISTORY_EXPORT_TIMEOUT_MS;
  try {
    const pidPath = join(root, "slow.pid");
    const slowBin = join(root, "hermes-slow");
    writeFileSync(slowBin, [
      "#!/bin/sh",
      `printf '%s' "$$" > ${JSON.stringify(pidPath)}`,
      "exec node -e \"setTimeout(() => console.log('{}'), 5000)\"",
      "",
    ].join("\n"));
    chmodSync(slowBin, 0o755);
    process.env.CLAWCONNECT_HERMES_STATE_DB = join(root, "missing.db");
    process.env.CLAWCONNECT_HERMES_HISTORY_EXPORT_TIMEOUT_MS = "1000";
    process.env.HERMES_BIN = slowBin;

    const startedAt = Date.now();
    const timedOut = await runHermesChatHistory({ sessionKey: "hermes:timeout-session", limit: 10 });
    assert.equal(timedOut.ok, false);
    assert.ok(Date.now() - startedAt < 3_000);
    await waitFor(() => statExists(pidPath), 3_000);
    const slowPid = Number(readFileSync(pidPath, "utf8"));
    await waitFor(() => !isProcessAlive(slowPid), 3_000);
    assert.equal(isProcessAlive(slowPid), false);

    const invocationLog = join(root, "invocations.log");
    const sharedBin = join(root, "hermes-shared");
    writeFileSync(sharedBin, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(invocationLog)}, 'export\\n');`,
      "setTimeout(() => console.log(JSON.stringify({ sessionId: 'shared', messages: [] })), 300);",
      "",
    ].join("\n"));
    chmodSync(sharedBin, 0o755);
    process.env.CLAWCONNECT_HERMES_HISTORY_EXPORT_TIMEOUT_MS = "2000";
    process.env.HERMES_BIN = sharedBin;

    const first = runHermesChatHistory({ sessionKey: "hermes:shared-session", limit: 10 });
    const second = runHermesChatHistory({ sessionKey: "hermes:shared-session", limit: 10 });
    const competing = runHermesChatHistory({ sessionKey: "hermes:other-session", limit: 10 });
    const [firstResult, secondResult, competingResult] = await Promise.all([first, second, competing]);
    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, true);
    assert.equal(competingResult.ok, false);
    assert.match(String(competingResult.error), /hermes_history_export_busy/);
    assert.equal(readFileSync(invocationLog, "utf8").trim().split("\n").length, 1);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_STATE_DB", previousStateDb);
    restoreEnv("HERMES_BIN", previousHermesBin);
    restoreEnv("CLAWCONNECT_HERMES_HISTORY_EXPORT_TIMEOUT_MS", previousTimeout);
    rmSync(root, { recursive: true, force: true });
  }
});

type HistoryPayload = {
  messages: Array<{ id: string; seq: number; runId?: string }>;
  timelineSnapshot?: { messages: Array<{ messageId: string; seq?: number }> };
  hasMore: boolean;
  nextCursor?: string;
  newestCursor?: string;
};

function statExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function stateDbRealtimeMessage(
  id: number,
  sessionId: string,
  role: HermesStateDbRealtimeMessageRow["role"],
  content: string,
): HermesStateDbRealtimeMessageRow {
  return {
    id,
    sessionId,
    sessionSource: "cli",
    role,
    content,
    timestamp: 1784808000 + id,
    active: true,
    observed: false,
    ...(role === "assistant" ? { finishReason: "stop" } : {}),
  };
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
