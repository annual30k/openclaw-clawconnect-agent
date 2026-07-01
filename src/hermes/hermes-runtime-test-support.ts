import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildHermesAssistantDeltaPayload,
  buildHermesRuntimeContextHint,
  isDuplicateHermesCronJob,
  isHermesSlashCommandMessage,
  parseHermesToolLogLine,
  parseHermesSkillsList,
  parseHermesSessionUsageSnapshot,
  parseHermesStatusSnapshot,
  selectHermesSessionForCompletedChat,
  stripHermesSecurityReviewNotices,
  stripHermesSessionResumeNotices,
  runHermesChat,
  runHermesChatHistory,
  handleHermesCommand,
} from "./hermes-runtime.js";
import { runHermesSessionExport } from "./runtime/hermes-runtime-sessions.js";
import {
  hermesModelListResultFromPayload,
  modelItemsFromHermesModelOptionsPayload,
} from "./runtime/hermes-runtime-models.js";
import {
  listStoredHermesSessions,
  mergeLiveHermesSessionsWithStoredAliases,
  parseHermesSessionsList,
  rememberHermesSession,
} from "./hermes-session-store.js";
import {
  readHermesContextLimitFromModelsDevCacheRecord,
} from "./runtime/hermes-runtime-usage.js";

export function restoreEnv(name: string, previousValue: string | undefined): void {
  if (previousValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previousValue;
  }
}

export function writeHermesStateDb(root: string): string {
  const dbPath = join(root, "state.db");
  const script = String.raw`
import sqlite3
import sys

db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
conn.executescript("""
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  user_id TEXT,
  model TEXT,
  model_config TEXT,
  system_prompt TEXT,
  parent_session_id TEXT,
  started_at REAL NOT NULL,
  ended_at REAL,
  end_reason TEXT,
  message_count INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  billing_provider TEXT,
  billing_base_url TEXT,
  billing_mode TEXT,
  estimated_cost_usd REAL,
  actual_cost_usd REAL,
  cost_status TEXT,
  cost_source TEXT,
  pricing_version TEXT,
  title TEXT,
  api_call_count INTEGER DEFAULT 0,
  handoff_state TEXT,
  handoff_platform TEXT,
  handoff_error TEXT,
  cwd TEXT,
  rewind_count INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  content TEXT,
  tool_call_id TEXT,
  tool_calls TEXT,
  tool_name TEXT,
  timestamp REAL NOT NULL,
  token_count INTEGER,
  finish_reason TEXT,
  reasoning TEXT,
  reasoning_content TEXT,
  reasoning_details TEXT,
  codex_reasoning_items TEXT,
  codex_message_items TEXT,
  platform_message_id TEXT,
  observed INTEGER DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
""")
conn.commit()
conn.close()
`;
  execFileSync("python3", ["-c", script, dbPath], { stdio: "pipe" });
  return dbPath;
}

export function writeStateDbHistoryCompletingHermesBin(root: string): {
  binPath: string;
  exportCalledPath: string;
} {
  const binPath = join(root, "hermes-state-db-history-completion");
  const readyPath = join(root, "state-db-history-ready");
  const exportCalledPath = join(root, "state-db-export-called");
  const dbPath = join(root, "state.db");
  const sessionId = "20260622_100613_8947a8";
  writeFileSync(binPath, [
    "#!/usr/bin/env node",
    "const fs = require('fs');",
    "const { execFileSync } = require('child_process');",
    "const args = process.argv.slice(2);",
    `const readyPath = ${JSON.stringify(readyPath)};`,
    `const exportCalledPath = ${JSON.stringify(exportCalledPath)};`,
    `const dbPath = ${JSON.stringify(dbPath)};`,
    `const sessionId = ${JSON.stringify(sessionId)};`,
    "function writeCompletedTurn(query) {",
    "  const script = String.raw`",
    "import sqlite3",
    "import sys",
    "db_path, session_id, query = sys.argv[1:4]",
    "conn = sqlite3.connect(db_path)",
    "conn.execute(\"INSERT OR REPLACE INTO sessions (id, source, model, started_at, title, message_count) VALUES (?, 'cli', 'gpt-5.5', 1780000000.0, 'Greeting', 2)\", (session_id,))",
    "conn.execute(\"DELETE FROM messages WHERE session_id = ?\", (session_id,))",
    "conn.execute(\"INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, 'user', ?, 1780000001.0, 1)\", (session_id, query))",
    "conn.execute(\"INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, 'assistant', 'direct-db reply', 1780000002.0, 1)\", (session_id,))",
    "conn.commit()",
    "conn.close()",
    "`;",
    "  execFileSync('python3', ['-c', script, dbPath, sessionId, query], { stdio: 'ignore' });",
    "  fs.writeFileSync(readyPath, '1');",
    "}",
    "if (args[0] === 'sessions' && args[1] === 'list') {",
    "  console.log('Title                            Preview          Last Active   ID');",
    "  if (fs.existsSync(readyPath)) console.log('Greeting                         direct-db reply  just now      20260622_100613_8947a8');",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'sessions' && args[1] === 'export') {",
    "  fs.writeFileSync(exportCalledPath, args.join(' '));",
    "  console.error('sessions export should not be needed for state.db completion');",
    "  process.exit(2);",
    "}",
    "if (args[0] === 'chat') {",
    "  const queryIndex = args.indexOf('--query');",
    "  const query = queryIndex >= 0 ? args[queryIndex + 1] : '';",
    "  setTimeout(() => writeCompletedTurn(query), 100);",
    "  setTimeout(() => process.exit(0), 3500);",
    "  return;",
    "}",
    "if (args[0] === 'status') { process.exit(0); }",
    "console.error(`unexpected args: ${args.join(' ')}`);",
    "process.exit(2);",
    "",
  ].join("\n"), "utf8");
  chmodSync(binPath, 0o755);
  assert.equal(existsSync(binPath), true);
  return { binPath, exportCalledPath };
}
export function writeMutableHistoryHermesBin(root: string, payloadPath: string): string {
  const binPath = join(root, "hermes-history-mutable");
  writeFileSync(binPath, [
    "#!/bin/sh",
    "if [ \"$1\" = \"sessions\" ] && [ \"$2\" = \"export\" ]; then",
    `  cat '${payloadPath.replace(/'/g, "'\\''")}'`,
    "  printf '\\n'",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"sessions\" ] && [ \"$2\" = \"list\" ]; then",
    "  echo 'Title                            Preview          Last Active   ID'",
    "  echo 'History                          visible reply    just now      20260529_100000_history'",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"status\" ]; then exit 0; fi",
    "echo \"unexpected args: $@\" >&2",
    "exit 2",
    "",
  ].join("\n"), "utf8");
  chmodSync(binPath, 0o755);
  assert.equal(existsSync(binPath), true);
  return binPath;
}
export function writePagedHistoryHermesBin(root: string): string {
  const binPath = join(root, "hermes-history-paged");
  const payload = JSON.stringify({
    sessionId: "20260529_100000_history",
    messages: Array.from({ length: 4 }, (_, index) => {
      const seq = index + 1;
      return {
        id: `m${seq}`,
        role: seq % 2 === 0 ? "assistant" : "user",
        content: `message ${seq}`,
        createdAt: new Date(Date.UTC(2026, 4, 29, 2, 0, seq)).toISOString(),
      };
    }),
  });
  writeFileSync(binPath, [
    "#!/bin/sh",
    "if [ \"$1\" = \"sessions\" ] && [ \"$2\" = \"export\" ]; then",
    `  printf '%s\\n' '${payload.replace(/'/g, "'\\''")}'`,
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"sessions\" ] && [ \"$2\" = \"list\" ]; then",
    "  echo 'Title                            Preview          Last Active   ID'",
    "  echo 'History                          visible reply    just now      20260529_100000_history'",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"status\" ]; then exit 0; fi",
    "echo \"unexpected args: $@\" >&2",
    "exit 2",
    "",
  ].join("\n"), "utf8");
  chmodSync(binPath, 0o755);
  assert.equal(existsSync(binPath), true);
  return binPath;
}
export function writeFakeHermesBin(root: string): string {
  const binPath = join(root, "hermes");
  writeFileSync(binPath, [
    "#!/bin/sh",
    "if [ \"$1\" = \"sessions\" ] && [ \"$2\" = \"list\" ]; then",
    "  echo 'Title                            Preview          Last Active   ID'",
    "  echo 'Fresh reply                      fresh reply      just now      20260528_181500_abcd12'",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"sessions\" ] && [ \"$2\" = \"export\" ]; then",
    "  previous=''",
    "  for arg in \"$@\"; do",
    "    if [ \"$previous\" = \"--session-id\" ] && [ \"$arg\" = \"missing\" ]; then",
    "      echo 'Session not found: missing' >&2",
    "      echo 'Use a session ID from a previous CLI run (hermes sessions list).' >&2",
    "      exit 1",
    "    fi",
    "    previous=\"$arg\"",
    "  done",
    "  echo '{\"model\":\"gpt-5.5\",\"input_tokens\":1,\"model_config\":{\"max_input_tokens\":10}}'",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"status\" ]; then",
    "  echo '  Model:        gpt-5.5'",
    "  echo '  Provider:     OpenAI Codex'",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"chat\" ]; then",
    "  printf '%s\\n' \"$@\" > \"$0.args\"",
    "  previous=''",
    "  for arg in \"$@\"; do",
    "    if [ \"$previous\" = \"--resume\" ] && [ \"$arg\" = \"missing\" ]; then",
    "      echo 'Session not found: missing' >&2",
    "      echo 'Use a session ID from a previous CLI run (hermes sessions list).' >&2",
    "      exit 1",
    "    fi",
    "    previous=\"$arg\"",
    "  done",
    "  echo 'fresh reply'",
    "  exit 0",
    "fi",
    "echo \"unexpected args: $@\" >&2",
    "exit 2",
    "",
  ].join("\n"), "utf8");
  chmodSync(binPath, 0o755);
  assert.equal(existsSync(binPath), true);
  return binPath;
}
export function writeTimeoutDeniedHermesBin(root: string): string {
  const binPath = join(root, "hermes-timeout-denied");
  writeFileSync(binPath, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'sessions' && args[1] === 'list') {",
    "  console.log('Title                            Preview          Last Active   ID');",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'chat') {",
    "  console.log('⏱ Timeout – denying command');",
    "  process.on('SIGTERM', () => process.exit(143));",
    "  setInterval(() => {}, 1000);",
    "  return;",
    "}",
    "if (args[0] === 'status') { process.exit(0); }",
    "console.error(`unexpected args: ${args.join(' ')}`);",
    "process.exit(2);",
    "",
  ].join("\n"), "utf8");
  chmodSync(binPath, 0o755);
  assert.equal(existsSync(binPath), true);
  return binPath;
}
export function writeAbortPartialHermesBin(root: string): string {
  const binPath = join(root, "hermes-abort-partial");
  writeFileSync(binPath, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'sessions' && args[1] === 'list') {",
    "  console.log('Title                            Preview          Last Active   ID');",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'chat') {",
    "  process.stdout.write('partial ');",
    "  process.on('SIGTERM', () => process.exit(143));",
    "  setInterval(() => {}, 1000);",
    "  return;",
    "}",
    "if (args[0] === 'status') { process.exit(0); }",
    "console.error(`unexpected args: ${args.join(' ')}`);",
    "process.exit(2);",
    "",
  ].join("\n"), "utf8");
  chmodSync(binPath, 0o755);
  assert.equal(existsSync(binPath), true);
  return binPath;
}
export function writeSlowPartialHermesBin(root: string): string {
  const binPath = join(root, "hermes-slow-partial");
  const partialStartedPath = join(root, "partial-started");
  writeFileSync(binPath, [
    "#!/usr/bin/env node",
    "const fs = require('fs');",
    "const args = process.argv.slice(2);",
    `const partialStartedPath = ${JSON.stringify(partialStartedPath)};`,
    "if (args[0] === 'sessions' && args[1] === 'list') {",
    "  console.log('Title                            Preview          Last Active   ID');",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'chat') {",
    "  fs.writeFileSync(partialStartedPath, '1');",
    "  process.stdout.write('partial ');",
    "  setTimeout(() => {",
    "    console.log('reply');",
    "  }, 1200);",
    "  return;",
    "}",
    "if (args[0] === 'status') { process.exit(0); }",
    "console.error(`unexpected args: ${args.join(' ')}`);",
    "process.exit(2);",
    "",
  ].join("\n"), "utf8");
  chmodSync(binPath, 0o755);
  assert.equal(existsSync(binPath), true);
  return binPath;
}
export async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${path}`);
}
export async function waitForHermesDelta(events: unknown[], expectedText: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (JSON.stringify(events).includes(`"state":"delta"`) && JSON.stringify(events).includes(expectedText)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for Hermes delta containing ${expectedText}`);
}
export function writeHistoryCompletingHermesBin(root: string): string {
  const binPath = join(root, "hermes-history-completion");
  const readyPath = join(root, "history-ready");
  const payload = JSON.stringify({
    sessionId: "20260622_100613_8947a8",
    messages: [
      {
        id: "user-hi",
        role: "user",
        content: "Hi",
        createdAt: "2026-06-22T02:06:26.000Z",
      },
      {
        id: "assistant-hi",
        role: "assistant",
        content: "你好！有什么我能帮你的吗？",
        createdAt: "2026-06-22T02:06:33.000Z",
      },
    ],
  });
  writeFileSync(binPath, [
    "#!/usr/bin/env node",
    "const fs = require('fs');",
    "const args = process.argv.slice(2);",
    `const readyPath = ${JSON.stringify(readyPath)};`,
    `const payload = ${JSON.stringify(payload)};`,
    "if (args[0] === 'sessions' && args[1] === 'list') {",
    "  console.log('Title                            Preview          Last Active   ID');",
    "  if (fs.existsSync(readyPath)) console.log('Greeting                         你好！           just now      20260622_100613_8947a8');",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'sessions' && args[1] === 'export') {",
    "  if (fs.existsSync(readyPath)) { console.log(payload); process.exit(0); }",
    "  console.log(JSON.stringify({ sessionId: '20260622_100613_8947a8', messages: [] }));",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'chat') {",
    "  setTimeout(() => fs.writeFileSync(readyPath, '1'), 100);",
    "  process.on('SIGTERM', () => process.exit(0));",
    "  setInterval(() => {}, 1000);",
    "  return;",
    "}",
    "if (args[0] === 'status') { process.exit(0); }",
    "console.error(`unexpected args: ${args.join(' ')}`);",
    "process.exit(2);",
    "",
  ].join("\n"), "utf8");
  chmodSync(binPath, 0o755);
  assert.equal(existsSync(binPath), true);
  return binPath;
}
export function writeStaleHistoryHermesBin(root: string): string {
  const binPath = join(root, "hermes-stale-history");
  const payload = JSON.stringify({
    sessionId: "20260622_100613_8947a8",
    messages: [
      {
        id: "user-hi",
        role: "user",
        content: "Hi",
        createdAt: "2026-06-22T02:06:26.000Z",
      },
      {
        id: "assistant-hi",
        role: "assistant",
        content: "你好！👋 我在这里，随时准备帮你解决问题。有什么需要我协助的吗？",
        createdAt: "2026-06-22T02:06:33.000Z",
      },
    ],
  });
  writeFileSync(binPath, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    `const payload = ${JSON.stringify(payload)};`,
    "if (args[0] === 'sessions' && args[1] === 'list') {",
    "  console.log('Title                            Preview          Last Active   ID');",
    "  console.log('Greeting                         你好！           just now      20260622_100613_8947a8');",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'sessions' && args[1] === 'export') {",
    "  console.log(payload);",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'chat') {",
    "  setTimeout(() => { console.log('Pong! 🏓'); process.exit(0); }, 2500);",
    "  return;",
    "}",
    "if (args[0] === 'status') { process.exit(0); }",
    "console.error(`unexpected args: ${args.join(' ')}`);",
    "process.exit(2);",
    "",
  ].join("\n"), "utf8");
  chmodSync(binPath, 0o755);
  assert.equal(existsSync(binPath), true);
  return binPath;
}
export function writeRepeatedUserStaleHistoryHermesBin(root: string): string {
  const binPath = join(root, "hermes-repeated-user-stale-history");
  const payload = JSON.stringify({
    sessionId: "20260622_100613_8947a8",
    messages: [
      {
        id: "user-old-hi",
        role: "user",
        content: "Hi",
        createdAt: "2026-06-22T02:06:26.000Z",
      },
      {
        id: "assistant-old-hi",
        role: "assistant",
        content: "old hi reply",
        createdAt: "2026-06-22T02:06:33.000Z",
      },
      {
        id: "user-visible",
        role: "user",
        content: "iOS final visible",
        createdAt: "2026-06-22T06:18:04.000Z",
      },
      {
        id: "assistant-visible",
        role: "assistant",
        content: "stale visible reply",
        createdAt: "2026-06-22T06:18:12.000Z",
      },
    ],
  });
  writeFileSync(binPath, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    `const payload = ${JSON.stringify(payload)};`,
    "if (args[0] === 'sessions' && args[1] === 'list') {",
    "  console.log('Title                            Preview          Last Active   ID');",
    "  console.log('Greeting                         stale           just now      20260622_100613_8947a8');",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'sessions' && args[1] === 'export') {",
    "  console.log(payload);",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'chat') {",
    "  setTimeout(() => { console.log('fresh hi reply'); process.exit(0); }, 2500);",
    "  return;",
    "}",
    "if (args[0] === 'status') { process.exit(0); }",
    "console.error(`unexpected args: ${args.join(' ')}`);",
    "process.exit(2);",
    "",
  ].join("\n"), "utf8");
  chmodSync(binPath, 0o755);
  assert.equal(existsSync(binPath), true);
  return binPath;
}
export function writeConcurrentDetectingHermesBin(root: string): string {
  const binPath = join(root, "hermes-concurrent-detect");
  const activePath = join(root, "active");
  const concurrentPath = join(root, "concurrent");
  writeFileSync(binPath, [
    "#!/usr/bin/env node",
    "const fs = require('fs');",
    "const args = process.argv.slice(2);",
    `const activePath = ${JSON.stringify(activePath)};`,
    `const concurrentPath = ${JSON.stringify(concurrentPath)};`,
    "if (args[0] === 'sessions' && args[1] === 'list') {",
    "  console.log('Title                            Preview          Last Active   ID');",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'chat') {",
    "  const queryIndex = args.indexOf('--query');",
    "  const rawQuery = queryIndex >= 0 ? args[queryIndex + 1] : '';",
    "  const query = rawQuery.split('\\n\\n[ClawConnect mobile bridge]')[0];",
    "  if (fs.existsSync(activePath)) fs.writeFileSync(concurrentPath, '1');",
    "  fs.writeFileSync(activePath, query);",
    "  setTimeout(() => {",
    "    try { fs.unlinkSync(activePath); } catch {}",
    "    console.log(`reply:${query}`);",
    "    process.exit(0);",
    "  }, 200);",
    "  return;",
    "}",
    "if (args[0] === 'status') { process.exit(0); }",
    "console.error(`unexpected args: ${args.join(' ')}`);",
    "process.exit(2);",
    "",
  ].join("\n"), "utf8");
  chmodSync(binPath, 0o755);
  assert.equal(existsSync(binPath), true);
  return binPath;
}
export function writeBarrieredHistoryExportHermesBin(root: string): {
  binPath: string;
  exportActivePath: string;
  allowExportCompletePath: string;
  concurrentPath: string;
} {
  const binPath = join(root, "hermes-history-export-concurrent");
  const exportActivePath = join(root, "history-export-active");
  const allowExportCompletePath = join(root, "history-export-complete");
  const concurrentPath = join(root, "history-export-concurrent");
  const payload = JSON.stringify({
    sessionId: "20260529_100000_history",
    messages: [
      {
        id: "m1",
        role: "user",
        content: "hello",
        createdAt: "2026-05-29T02:00:00.000Z",
      },
      {
        id: "m2",
        role: "assistant",
        content: "visible reply",
        createdAt: "2026-05-29T02:00:01.000Z",
      },
    ],
  });
  writeFileSync(binPath, [
    "#!/usr/bin/env node",
    "const fs = require('fs');",
    "const args = process.argv.slice(2);",
    `const exportActivePath = ${JSON.stringify(exportActivePath)};`,
    `const allowExportCompletePath = ${JSON.stringify(allowExportCompletePath)};`,
    `const concurrentPath = ${JSON.stringify(concurrentPath)};`,
    `const payload = ${JSON.stringify(payload)};`,
    "if (args[0] === 'sessions' && args[1] === 'list') {",
    "  console.log('Title                            Preview          Last Active   ID');",
    "  console.log('History                          visible reply    just now      20260529_100000_history');",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'sessions' && args[1] === 'export') {",
    "  fs.writeFileSync(exportActivePath, '1');",
    "  const interval = setInterval(() => {",
    "    if (!fs.existsSync(allowExportCompletePath)) return;",
    "    clearInterval(interval);",
    "    try { fs.unlinkSync(exportActivePath); } catch {}",
    "    console.log(payload);",
    "    process.exit(0);",
    "  }, 10);",
    "  setTimeout(() => process.exit(3), 5000);",
    "  return;",
    "}",
    "if (args[0] === 'chat') {",
    "  const queryIndex = args.indexOf('--query');",
    "  const rawQuery = queryIndex >= 0 ? args[queryIndex + 1] : '';",
    "  const query = rawQuery.split('\\n\\n[ClawConnect mobile bridge]')[0];",
    "  if (fs.existsSync(exportActivePath)) fs.writeFileSync(concurrentPath, '1');",
    "  console.log(`reply:${query}`);",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'status') { process.exit(0); }",
    "console.error(`unexpected args: ${args.join(' ')}`);",
    "process.exit(2);",
    "",
  ].join("\n"), "utf8");
  chmodSync(binPath, 0o755);
  assert.equal(existsSync(binPath), true);
  return { binPath, exportActivePath, allowExportCompletePath, concurrentPath };
}
export function writeResumeMetadataHermesBin(root: string): string {
  const binPath = join(root, "hermes-resume-metadata");
  writeFileSync(binPath, [
    "#!/bin/sh",
    "if [ \"$1\" = \"sessions\" ] && [ \"$2\" = \"list\" ]; then",
    "  echo 'Title                            Preview          Last Active   ID'",
    "  echo 'Visible reply                    visible reply    just now      20260528_181501_abcd12'",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"chat\" ]; then",
    "  echo '↻ Resumed session 20260525_114940_1cccb9'",
    "  printf \"%s\\n\" \"Error: 'NoneType' object is not iterable\"",
    "  echo 'session_id: 20260525_114940_1cccb9'",
    "  echo 'visible reply'",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"status\" ]; then",
    "  echo '  Model:        gpt-5.5'",
    "  echo '  Provider:     OpenAI Codex'",
    "  exit 0",
    "fi",
    "echo \"unexpected args: $@\" >&2",
    "exit 2",
    "",
  ].join("\n"), "utf8");
  chmodSync(binPath, 0o755);
  assert.equal(existsSync(binPath), true);
  return binPath;
}
export function writeHistoryHermesBin(root: string): string {
  const binPath = join(root, "hermes-history");
  const payload = JSON.stringify({
    sessionId: "20260529_100000_history",
    messages: [
      {
        id: "m1",
        role: "user",
        content: "hello",
        createdAt: "2026-05-29T02:00:00.000Z",
      },
      {
        id: "m2",
        role: "assistant",
        content: [
          { type: "text", text: "↻ Resumed session 20260525_114940_1cccb9" },
          { type: "text", text: "Error: 'NoneType' object is not iterable" },
          { type: "text", text: "session_id: 20260525_114940_1cccb9" },
          { type: "text", text: "visible reply" },
          { type: "file", fileId: "file-history-1", fileName: "report.pdf", mimeType: "application/pdf" },
        ],
        createdAt: "2026-05-29T02:00:01.000Z",
      },
    ],
  });
  writeFileSync(binPath, [
    "#!/bin/sh",
    "if [ \"$1\" = \"sessions\" ] && [ \"$2\" = \"export\" ]; then",
    `  printf '%s\\n' '${payload.replace(/'/g, "'\\''")}'`,
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"sessions\" ] && [ \"$2\" = \"list\" ]; then",
    "  echo 'Title                            Preview          Last Active   ID'",
    "  echo 'History                          visible reply    just now      20260529_100000_history'",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"status\" ]; then exit 0; fi",
    "echo \"unexpected args: $@\" >&2",
    "exit 2",
    "",
  ].join("\n"), "utf8");
  chmodSync(binPath, 0o755);
  assert.equal(existsSync(binPath), true);
  return binPath;
}
export function writeUntimedHistoryHermesBin(root: string): string {
  const binPath = join(root, "hermes-history-untimed");
  const payload = JSON.stringify({
    sessionId: "20260529_100000_history",
    messages: [
      {
        id: "m1",
        role: "user",
        content: "hello",
      },
      {
        id: "m2",
        role: "assistant",
        content: "visible reply",
      },
    ],
  });
  writeFileSync(binPath, [
    "#!/bin/sh",
    "if [ \"$1\" = \"sessions\" ] && [ \"$2\" = \"export\" ]; then",
    `  printf '%s\\n' '${payload.replace(/'/g, "'\\''")}'`,
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"status\" ]; then exit 0; fi",
    "echo \"unexpected args: $@\" >&2",
    "exit 2",
    "",
  ].join("\n"), "utf8");
  chmodSync(binPath, 0o755);
  assert.equal(existsSync(binPath), true);
  return binPath;
}
