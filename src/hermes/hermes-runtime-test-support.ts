import assert from "node:assert/strict";
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
  writeFileSync(binPath, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'sessions' && args[1] === 'list') {",
    "  console.log('Title                            Preview          Last Active   ID');",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'chat') {",
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
