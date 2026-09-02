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
  latestTerminalAssistantReplyFromHermesExport,
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
  hermesModelAssignmentScript,
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
  mergeHermesLiveAndSessionUsage,
  readHermesContextLimitFromModelsDevCacheRecord,
} from "./runtime/hermes-runtime-usage.js";

import {
  restoreEnv,
  writeMutableHistoryHermesBin,
  writePagedHistoryHermesBin,
  writeFakeHermesBin,
  writeTimeoutDeniedHermesBin,
  writeAbortPartialHermesBin,
  writeSlowPartialHermesBin,
  waitForHermesDelta,
  writeHistoryCompletingHermesBin,
  writeStaleHistoryHermesBin,
  writeRepeatedUserStaleHistoryHermesBin,
  writeConcurrentDetectingHermesBin,
  writeResumeMetadataHermesBin,
  writeHistoryHermesBin,
  writeUntimedHistoryHermesBin,
} from "./hermes-runtime-test-support.js";

test("runHermesChat leaves final-answer local paths as text without send-file skill delivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-no-path-scan-"));
  const previousHermesBin = process.env.HERMES_BIN;
  try {
    const imagePath = join(dir, "reply.png");
    const hermesBin = join(dir, "hermes");
    writeFileSync(imagePath, "png");
    writeFileSync(hermesBin, [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'sessions' && args[1] === 'list') {",
      "  console.log('Title                            Preview          Last Active   ID');",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'sessions' && args[1] === 'export') {",
      "  console.log(JSON.stringify({ sessionId: 's1', messages: [] }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'status') { process.exit(0); }",
      "if (args[0] === 'chat') {",
      `  console.log(${JSON.stringify(`截图好了：${imagePath}`)});`,
      "  process.exit(0);",
      "}",
      "process.exit(2);",
      "",
    ].join("\n"));
    chmodSync(hermesBin, 0o755);
    process.env.HERMES_BIN = hermesBin;

    const result = await runHermesChat({ message: "把这张图片发给我", sessionKey: "main" });

    assert.equal(result.output, `截图好了：${imagePath}`);
    assert.deepEqual(result.artifactPaths, []);
  } finally {
    restoreEnv("HERMES_BIN", previousHermesBin);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runHermesChat exposes current run and session ids to Hermes send-file skills", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-send-file-env-"));
  const previousHermesBin = process.env.HERMES_BIN;
  try {
    const hermesBin = join(dir, "hermes");
    writeFileSync(hermesBin, [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'sessions' && args[1] === 'list') {",
      "  console.log('Title                            Preview          Last Active   ID');",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'sessions' && args[1] === 'export') {",
      "  console.log(JSON.stringify({ sessionId: 's1', messages: [] }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'status') { process.exit(0); }",
      "if (args[0] === 'chat') {",
      "  console.log(JSON.stringify({",
      "    sourceRunId: process.env.CLAWCONNECT_SOURCE_RUN_ID || 'missing-source-run',",
      "    sessionKey: process.env.CLAWCONNECT_SESSION_KEY || 'missing-session',",
      "    chatSessionKey: process.env.CLAWCONNECT_CHAT_SESSION_KEY || 'missing-chat-session',",
      "  }));",
      "  process.exit(0);",
      "}",
      "process.exit(2);",
      "",
    ].join("\n"));
    chmodSync(hermesBin, 0o755);
    process.env.HERMES_BIN = hermesBin;

    const result = await runHermesChat(
      { message: "用 file-transfer 发文件", sessionKey: "ios-current-session" },
      { requestId: "hermes-run-123", publishEvent: () => undefined },
    );

    assert.deepEqual(JSON.parse(result.output), {
      sourceRunId: "hermes-run-123",
      sessionKey: "ios-current-session",
      chatSessionKey: "ios-current-session",
    });
  } finally {
    restoreEnv("HERMES_BIN", previousHermesBin);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runHermesChat passes stable mobile turn metadata and preloads file-transfer when installed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-mobile-turn-metadata-"));
  const previousHermesBin = process.env.HERMES_BIN;
  try {
    const hermesBin = join(dir, "hermes");
    writeFileSync(hermesBin, [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'skills' && args[1] === 'list') {",
      "  console.log('│ file-transfer │ productivity │ local │ local │ enabled │');",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'sessions' && args[1] === 'list') {",
      "  console.log('Title                            Preview          Last Active   ID');",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'sessions' && args[1] === 'export') {",
      "  console.log(JSON.stringify({ sessionId: 's1', messages: [] }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'status') { process.exit(0); }",
      "if (args[0] === 'chat') {",
      "  const query = args[args.indexOf('--query') + 1];",
      "  console.log(JSON.stringify({ args, query }));",
      "  process.exit(0);",
      "}",
      "process.exit(2);",
      "",
    ].join("\n"));
    chmodSync(hermesBin, 0o755);
    process.env.HERMES_BIN = hermesBin;

    const result = await runHermesChat(
      { message: "把桌面上的图片发到手机", sessionKey: "main" },
      { requestId: "client-run-file-1", publishEvent: () => undefined },
    );
    const payload = JSON.parse(result.output) as { args: string[]; query: string };

    assert.ok(payload.args.includes("--skills"));
    assert.ok(payload.args.includes("file-transfer"));
    assert.match(payload.query, /\[ClawConnect mobile turn\]/);
    assert.match(payload.query, /sourceRunId: client-run-file-1/);
    assert.match(payload.query, /sessionKey: main/);
  } finally {
    restoreEnv("HERMES_BIN", previousHermesBin);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runHermesChat starts ordinary text chat without preflight status or skills list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-ordinary-chat-fast-start-"));
  const previousHermesBin = process.env.HERMES_BIN;
  try {
    const hermesBin = join(dir, "hermes");
    const callsPath = join(dir, "calls.log");
    writeFileSync(hermesBin, [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      "const args = process.argv.slice(2);",
      `fs.appendFileSync(${JSON.stringify(callsPath)}, (args[0] || '') + ':' + (args[1] || '') + '\\n');`,
      "if (args[0] === 'status') {",
      "  console.log('  Model:        gpt-5.5');",
      "  console.log('  Provider:     OpenAI Codex');",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'skills' && args[1] === 'list') {",
      "  console.log('│ file-transfer │ productivity │ local │ local │ enabled │');",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'sessions' && args[1] === 'list') {",
      "  console.log('Title                            Preview          Last Active   ID');",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'sessions' && args[1] === 'export') {",
      "  console.log(JSON.stringify({ sessionId: 's1', messages: [] }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'chat') {",
      "  console.log('plain reply');",
      "  process.exit(0);",
      "}",
      "process.exit(2);",
      "",
    ].join("\n"));
    chmodSync(hermesBin, 0o755);
    process.env.HERMES_BIN = hermesBin;

    const result = await runHermesChat({ message: "hello", sessionKey: "main" });
    const calls = readFileSync(callsPath, "utf8").trim().split(/\r?\n/);
    const chatIndex = calls.findIndex((call) => call.startsWith("chat:"));

    assert.equal(result.output, "plain reply");
    assert.notEqual(chatIndex, -1);
    assert.equal(calls.slice(0, chatIndex).includes("status:"), false);
    assert.equal(calls.slice(0, chatIndex).includes("skills:list"), false);
  } finally {
    restoreEnv("HERMES_BIN", previousHermesBin);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runHermesChat rejects an empty successful Hermes response", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-empty-response-"));
  const previousHermesBin = process.env.HERMES_BIN;
  try {
    const hermesBin = join(dir, "hermes");
    writeFileSync(hermesBin, [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'sessions' && args[1] === 'list') process.exit(0);",
      "if (args[0] === 'status') process.exit(0);",
      "if (args[0] === 'chat') process.exit(0);",
      "process.exit(2);",
      "",
    ].join("\n"));
    chmodSync(hermesBin, 0o755);
    process.env.HERMES_BIN = hermesBin;

    await assert.rejects(
      runHermesChat({ message: "ping", sessionKey: "main" }),
      /Hermes 未返回可见回复.*模型额度.*Provider 凭据/,
    );
  } finally {
    restoreEnv("HERMES_BIN", previousHermesBin);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runHermesChat rejects provider failure text returned with exit zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-provider-failure-"));
  const previousHermesBin = process.env.HERMES_BIN;
  try {
    const hermesBin = join(dir, "hermes");
    writeFileSync(hermesBin, [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'sessions' && args[1] === 'list') process.exit(0);",
      "if (args[0] === 'status') process.exit(0);",
      "if (args[0] === 'chat') {",
      "  console.log('API call failed after 3 retries: HTTP 429: Token Plan usage limit reached');",
      "  process.exit(0);",
      "}",
      "process.exit(2);",
      "",
    ].join("\n"));
    chmodSync(hermesBin, 0o755);
    process.env.HERMES_BIN = hermesBin;

    await assert.rejects(
      runHermesChat({ message: "ping", sessionKey: "main" }),
      /API call failed after 3 retries: HTTP 429/,
    );
  } finally {
    restoreEnv("HERMES_BIN", previousHermesBin);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runHermesChatHistory extracts stable mobile turn metadata from Hermes export", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-history-turn-metadata-"));
  const previousHermesBin = process.env.HERMES_BIN;
  try {
    const hermesBin = join(dir, "hermes");
    const exported = {
      sessionId: "s1",
      messages: [
        {
          id: "history-user-1",
          role: "user",
          createdAt: "2026-06-26T09:00:00.000Z",
          content: [
            "帮把桌面上的图片发过来",
            "",
            "[ClawConnect mobile bridge] You are connected to a mobile chat client through ClawConnect.",
            "",
            "[ClawConnect mobile turn]",
            "sourceRunId: client-run-file-1",
            "sessionKey: main",
          ].join("\n"),
        },
        {
          id: "history-assistant-1",
          role: "assistant",
          createdAt: "2026-06-26T09:00:01.000Z",
          content: "已经发到手机。",
        },
      ],
    };
    writeFileSync(hermesBin, [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'sessions' && args[1] === 'export') {",
      `  console.log(${JSON.stringify(JSON.stringify(exported))});`,
      "  process.exit(0);",
      "}",
      "process.exit(2);",
      "",
    ].join("\n"));
    chmodSync(hermesBin, 0o755);
    process.env.HERMES_BIN = hermesBin;

    const result = await runHermesChatHistory({ sessionKey: "main", limit: 10 });
    assert.equal(result.ok, true);
    const payload = result.payload as {
      timelineSnapshot: { messages: Array<{ role: string; content: Array<{ text?: string }>; turnId?: string; runId?: string; idempotencyKey?: string; clientMessageId?: string }> };
    };
    const user = payload.timelineSnapshot.messages.find((message) => message.role === "user");
    const assistant = payload.timelineSnapshot.messages.find((message) => message.role === "assistant");

    assert.equal(user?.turnId, "client-run-file-1");
    assert.equal(user?.runId, "client-run-file-1");
    assert.equal(user?.idempotencyKey, "client-run-file-1");
    assert.equal(user?.clientMessageId, "client-run-file-1");
    assert.equal(user?.content[0]?.text, "帮把桌面上的图片发过来");
    assert.equal(assistant?.turnId, "client-run-file-1");
    assert.equal(assistant?.runId, "client-run-file-1");
  } finally {
    restoreEnv("HERMES_BIN", previousHermesBin);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runHermesChatHistory excludes tool-call assistant interims and keeps the terminal reply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-history-terminal-assistant-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousHermesBin = process.env.HERMES_BIN;
  try {
    const hermesBin = join(dir, "hermes");
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = join(dir, "sessions.json");
    const exported = {
      sessionId: "s1",
      messages: [
        {
          id: "history-user-1",
          role: "user",
          createdAt: "2026-07-23T10:00:00.000Z",
          content: [
            "你帮我看看明天福州的天气返回表格",
            "",
            "[ClawConnect mobile turn]",
            "sourceRunId: mobile-weather-run",
            "sessionKey: qa-no-cli-stream",
          ].join("\n"),
        },
        {
          id: "history-assistant-interim",
          role: "assistant",
          createdAt: "2026-07-23T10:00:01.000Z",
          content: "Let me use the browser to fetch the weather data.",
          finish_reason: "tool_calls",
          tool_calls: [{ id: "tool-weather-1", type: "function" }],
        },
        {
          id: "history-tool-1",
          role: "tool",
          createdAt: "2026-07-23T10:00:02.000Z",
          content: "weather result",
        },
        {
          id: "history-assistant-final",
          role: "assistant",
          createdAt: "2026-07-23T10:00:03.000Z",
          content: "福州明日天气完整表格",
          finish_reason: "stop",
        },
      ],
    };
    writeFileSync(hermesBin, [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'sessions' && args[1] === 'export') {",
      `  console.log(${JSON.stringify(JSON.stringify(exported))});`,
      "  process.exit(0);",
      "}",
      "process.exit(2);",
      "",
    ].join("\n"));
    chmodSync(hermesBin, 0o755);
    process.env.HERMES_BIN = hermesBin;
    await rememberHermesSession("qa-no-cli-stream", {
      sessionKey: "qa-no-cli-stream",
      hermesSessionId: "s1",
      kind: "hermes",
    });

    const result = await runHermesChatHistory({ sessionKey: "qa-no-cli-stream", limit: 10 });
    assert.equal(result.ok, true);
    const payload = result.payload as {
      timelineSnapshot: {
        messages: Array<{
          messageId: string;
          role: string;
          runId?: string;
          content: Array<{ text?: string }>;
        }>;
      };
    };
    const assistantMessages = payload.timelineSnapshot.messages.filter((message) => message.role === "assistant");

    assert.deepEqual(assistantMessages.map((message) => message.messageId), ["history-assistant-final"]);
    assert.equal(assistantMessages[0]?.runId, "mobile-weather-run");
    assert.equal(assistantMessages[0]?.content[0]?.text, "福州明日天气完整表格");
    assert.equal(
      JSON.stringify(payload.timelineSnapshot).includes("Let me use the browser"),
      false,
    );
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousHermesBin);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runHermesChatHistory returns an empty page for unmapped mobile sessions instead of exporting the latest Hermes session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-history-unmapped-session-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousHermesBin = process.env.HERMES_BIN;
  try {
    const storePath = join(dir, "sessions.json");
    const hermesBin = join(dir, "hermes");
    const latestSession = {
      sessionId: "cron_a0c123e0163e_20260701_070044",
      messages: [
        {
          id: "cron-user",
          role: "user",
          createdAt: "2026-07-01T07:00:44.000Z",
          content: "cron weather prompt",
        },
        {
          id: "cron-assistant",
          role: "assistant",
          createdAt: "2026-07-01T07:02:22.000Z",
          content: "cron weather answer",
        },
      ],
    };
    writeFileSync(hermesBin, [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'sessions' && args[1] === 'export') {",
      `  console.log(${JSON.stringify(JSON.stringify(latestSession))});`,
      "  process.exit(0);",
      "}",
      "if (args[0] === 'sessions' && args[1] === 'list') {",
      "  console.log('Title                            Preview          Last Active   ID');",
      "  console.log('福州每日天气简报 · Jul 01 07:02          cron weather prompt  3h ago        cron_a0c123e0163e_20260701_070044');",
      "  process.exit(0);",
      "}",
      "process.exit(2);",
      "",
    ].join("\n"));
    chmodSync(hermesBin, 0o755);
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = hermesBin;

    const result = await runHermesChatHistory({ sessionKey: "mobile-new-session", limit: 10 });

    assert.equal(result.ok, true);
    const payload = result.payload as { messages: unknown[]; timelineSnapshot: { messages: unknown[] } };
    assert.deepEqual(payload.messages, []);
    assert.deepEqual(payload.timelineSnapshot.messages, []);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousHermesBin);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Hermes assistant stream payload mirrors OpenClaw chat delta shape", () => {
  const payload = buildHermesAssistantDeltaPayload({
    runId: "run-1",
    sessionKey: "main",
    seq: 7,
    timestampMs: 123456,
    delta: "hello",
  });

  assert.equal(payload.runId, "run-1");
  assert.equal(payload.sessionKey, "main");
  assert.equal(payload.state, "delta");
  assert.equal(payload.role, "assistant");
  assert.equal(payload.seq, 7);
  assert.equal(payload.ts, 123456);
  assert.equal(payload.delta, "hello");
  assert.deepEqual(payload.message, {
    role: "assistant",
    timestamp: 123456,
    content: [{ type: "text", text: "hello" }],
  });
  assert.equal(payload.timelineEvents?.[0]?.eventType, "message.part.delta");
  assert.equal(payload.timelineEvents?.[0]?.turnId, "run-1");
  assert.equal(payload.timelineEvents?.[0]?.messageId, "assistant-run-1");
  assert.deepEqual(payload.timelineEvents?.[0]?.content, [{ type: "text", text: "hello" }]);
});

test("Hermes assistant stream payload is canonicalized before publishing", () => {
  const payload = buildHermesAssistantDeltaPayload({
    runId: "run-1",
    sessionKey: "main",
    seq: 8,
    timestampMs: 123456,
    delta: [
      "↻ Resumed session 20260525_114940_1cccb9",
      "Error: 'NoneType' object is not iterable",
      "session_id: 20260525_114940_1cccb9",
      "visible reply",
    ].join("\n"),
  });

  assert.equal(payload.delta, "visible reply");
  assert.deepEqual(payload.message, {
    role: "assistant",
    timestamp: 123456,
    content: [{ type: "text", text: "visible reply" }],
  });
  assert.deepEqual(payload.timelineEvents?.[0]?.content, [{ type: "text", text: "visible reply" }]);
});

test("stripHermesSessionResumeNotices removes Hermes resume banners", () => {
  const output = stripHermesSessionResumeNotices([
    "↻ Resumed session 20260519_015943_72d864 (3 user messages, 6 total messages)",
    "OK",
  ].join("\n")).trim();

  assert.equal(output, "OK");
});

test("stripHermesSessionResumeNotices removes Hermes resume error metadata", () => {
  const output = stripHermesSessionResumeNotices([
    "hello",
    "\r↻ Resumed session 20260525_114940_1cccb9 (10 user messages, 37 total messages) Error: 'NoneType' object is not iterable",
    "",
    "session_id: 20260525_114940_1cccb9",
  ].join("\n")).trim();

  assert.equal(output, "hello");
});

test("stripHermesSecurityReviewNotices removes denied command review blocks", () => {
  const output = stripHermesSecurityReviewNotices([
    "⚠️ DANGEROUS COMMAND: Security scan — [HIGH] Pipe to interpreter: curl | python3",
    "Command pipes output from 'curl' directly to interpreter 'python3'.",
    "  Safer: vet https://wttr.in/Fuzhou?format=j1",
    "date '+%Y-%m-%d %H:%M:%S %Z' &&",
    "curl -s 'https://wttr.in/Fuzhou?format=j1' |",
    "python3 - <<'PY'",
    "print('unsafe')",
    "PY",
    "",
    "[o]nce | [s]ession | [d]eny",
    "",
    "Choice [o/s/D]:   ✕ Denied",
    "福州今天天气（数据源：wttr.in，日期：2026-05-19）",
    "",
    "| 项目 | 天气信息 |",
    "| --- | --- |",
    "| 当前天气 | Partly Cloudy / 局部多云 |",
  ].join("\n")).trim();

  assert.equal(output, [
    "福州今天天气（数据源：wttr.in，日期：2026-05-19）",
    "",
    "| 项目 | 天气信息 |",
    "| --- | --- |",
    "| 当前天气 | Partly Cloudy / 局部多云 |",
  ].join("\n"));
});

test("stripHermesSecurityReviewNotices removes timeout-denied command control lines", () => {
  const output = stripHermesSecurityReviewNotices([
    "⏱ Timeout – denying command",
    "assistant answer",
  ].join("\n")).trim();

  assert.equal(output, "assistant answer");
});

test("parseHermesStatusSnapshot reads model and provider", () => {
  const snapshot = parseHermesStatusSnapshot([
    "◆ Environment",
    "  Model:        gpt-5.5",
    "  Provider:     OpenAI Codex",
  ].join("\n"));

  assert.equal(snapshot.currentModel, "gpt-5.5");
  assert.equal(snapshot.provider, "OpenAI Codex");
});

test("parseHermesSessionUsageSnapshot reads session token usage", () => {
  const snapshot = parseHermesSessionUsageSnapshot(JSON.stringify({
    model: "gpt-5.5",
    input_tokens: 4527,
    output_tokens: 957,
    cache_read_tokens: 9728,
    model_config: { max_input_tokens: 128000 },
  }));

  assert.equal(snapshot.currentModel, "gpt-5.5");
  assert.equal(snapshot.contextUsage, 4527);
  assert.equal(snapshot.contextLimit, 128000);
});

test("parseHermesSessionUsageSnapshot reads compact context window values", () => {
  const snapshot = parseHermesSessionUsageSnapshot(JSON.stringify({
    model: "mimo-v2.5-pro",
    input_tokens: 671800,
    model_config: { contextWindow: "1m" },
  }));

  assert.equal(snapshot.currentModel, "mimo-v2.5-pro");
  assert.equal(snapshot.contextUsage, 671800);
  assert.equal(snapshot.contextLimit, 1000000);
});

test("live Hermes status keeps old session model metadata from replacing the current model", () => {
  const snapshot = mergeHermesLiveAndSessionUsage({
    currentModel: "gpt-5.6-luna",
    provider: "OpenAI Codex",
    contextLimit: 1000000,
  }, {
    currentModel: "hermes-agent",
    contextUsage: 237603,
    contextLimit: 400000,
  }, "api_1782874930_1ddb81e1");

  assert.deepEqual(snapshot, {
    currentModel: "gpt-5.6-luna",
    provider: "OpenAI Codex",
    contextUsage: 237603,
    contextLimit: 1000000,
    hermesSessionId: "api_1782874930_1ddb81e1",
  });
});

test("Hermes context limit falls back to model id across provider cache entries", () => {
  const cache = {
    "future-provider": {
      models: {
        "vendor/new-model-pro": {
          limit: { context: 456000 },
        },
      },
    },
  };

  assert.equal(
    readHermesContextLimitFromModelsDevCacheRecord("new-model-pro", "Future Display Name", cache),
    456000,
  );
});

test("Hermes context limit matches provider display names to provider cache keys", () => {
  const cache = {
    xiaomi: {
      models: {
        "mimo-v2.5-pro": {
          limit: { context: 1048576 },
        },
      },
    },
    "other-provider": {
      models: {
        "mimo-v2.5-pro": {
          limit: { context: 272000 },
        },
      },
    },
  };

  assert.equal(
    readHermesContextLimitFromModelsDevCacheRecord("mimo-v2.5-pro", "Xiaomi MiMo", cache),
    1048576,
  );
});

test("Hermes context limit stays unknown when global model matches conflict", () => {
  const cache = {
    "provider-a": {
      models: {
        "shared-model": {
          limit: { context: 128000 },
        },
      },
    },
    "provider-b": {
      models: {
        "shared-model": {
          limit: { context: 256000 },
        },
      },
    },
  };

  assert.equal(
    readHermesContextLimitFromModelsDevCacheRecord("shared-model", "Unknown Provider", cache),
    undefined,
  );
});

test("buildHermesRuntimeContextHint includes current model and provider", () => {
  const hint = buildHermesRuntimeContextHint({
    currentModel: "gpt-5.4",
    provider: "OpenAI Codex",
  });

  assert.equal(hint, [
    "[Hermes runtime context]",
    "Current runtime: model=gpt-5.4, provider=OpenAI Codex.",
    "If the user asks which model or provider is currently being used, answer from this runtime context.",
  ].join("\n"));
});

test("buildHermesRuntimeContextHint omits empty snapshots", () => {
  assert.equal(buildHermesRuntimeContextHint({}), undefined);
});

test("Hermes slash command detection matches terminal command input", () => {
  assert.equal(isHermesSlashCommandMessage("/new"), true);
  assert.equal(isHermesSlashCommandMessage(" /model openai/gpt-5.5 "), true);
  assert.equal(isHermesSlashCommandMessage("/reload-mcp"), true);
  assert.equal(isHermesSlashCommandMessage("/tmp/report.txt"), false);
  assert.equal(isHermesSlashCommandMessage("please run /new"), false);
});

test("selectHermesSessionForCompletedChat ignores unrelated latest existing session", () => {
  const oldWeather = {
    sessionKey: "ios-old",
    hermesSessionId: "20260521_080012_48f5ae",
    displayName: "每天早上查看中国福建省福州市当天的天气预报",
    lastActivityAt: "2026-05-23T06:33:00.000Z",
    kind: "hermes" as const,
  };
  const newHello = {
    sessionKey: "hermes:20260523_143347_e56b96",
    hermesSessionId: "20260523_143347_e56b96",
    displayName: "你好 [Hermes runtime context]",
    label: "你好",
    lastActivityAt: "2026-05-23T06:32:59.000Z",
    kind: "hermes" as const,
  };

  const selected = selectHermesSessionForCompletedChat([oldWeather, newHello], {
    beforeSessions: [oldWeather],
    userMessage: "你好",
  });

  assert.equal(selected?.hermesSessionId, "20260523_143347_e56b96");
});

test("selectHermesSessionForCompletedChat keeps explicit resume binding", () => {
  const resumed = {
    sessionKey: "ios-current",
    hermesSessionId: "20260521_080012_48f5ae",
    displayName: "继续旧会话",
    kind: "hermes" as const,
  };
  const otherLatest = {
    sessionKey: "hermes:20260523_143347_e56b96",
    hermesSessionId: "20260523_143347_e56b96",
    displayName: "别的新会话",
    kind: "hermes" as const,
  };

  const selected = selectHermesSessionForCompletedChat([otherLatest, resumed], {
    resume: "20260521_080012_48f5ae",
    beforeSessions: [resumed],
    userMessage: "继续",
  });

  assert.equal(selected?.hermesSessionId, "20260521_080012_48f5ae");
});

test("Hermes history completion ignores visible tool-call assistants and waits for terminal final", () => {
  const payload = {
    output: JSON.stringify({
      messages: [
        {
          id: "user-weather",
          role: "user",
          content: "你帮我看看明天福州的天气返回表格",
        },
        {
          id: "assistant-tool-call",
          role: "assistant",
          content: "Let me use the browser to fetch the weather data.",
          finish_reason: "tool_calls",
          tool_calls: JSON.stringify([{ id: "call-browser" }]),
        },
        {
          id: "tool-weather",
          role: "tool",
          content: "weather data",
        },
        {
          id: "assistant-final",
          role: "assistant",
          content: "福州明日天气\n\n| 时间 | 天气 |\n|---|---|",
          finish_reason: "stop",
          tool_calls: null,
        },
      ],
    }),
  };

  assert.equal(
    latestTerminalAssistantReplyFromHermesExport(
      payload,
      "你帮我看看明天福州的天气返回表格",
    ),
    "福州明日天气\n\n| 时间 | 天气 |\n|---|---|",
  );
});

test("Hermes history completion does not resolve while only a tool-call assistant exists", () => {
  const payload = {
    output: JSON.stringify({
      messages: [
        { role: "user", content: "查天气" },
        {
          role: "assistant",
          content: "Let me check.",
          finishReason: "tool-calls",
          toolCalls: [{ id: "call-weather" }],
        },
      ],
    }),
  };

  assert.equal(
    latestTerminalAssistantReplyFromHermesExport(payload, "查天气"),
    undefined,
  );
});

test("Hermes history completion keeps compatibility with legacy terminal rows without finish reason", () => {
  const payload = {
    output: JSON.stringify({
      messages: [
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好！", tool_calls: "[]" },
      ],
    }),
  };

  assert.equal(latestTerminalAssistantReplyFromHermesExport(payload, "你好"), "你好！");
});

test("isDuplicateHermesCronJob treats equivalent daily weather jobs as duplicates", () => {
  const existing = {
    name: "福州每日天气简报",
    schedule: { kind: "cron", expr: "0 7 * * *" },
    payload: {
      message: [
        "每天执行一次天气简报任务。请查询中国福建省福州市当天最新可获取的天气预报，并用中文简要汇报，适合手机阅读。",
        "要求：天气状况、最高/最低温、降雨概率、风力、空气质量、出门建议。",
      ].join("\n"),
    },
    raw: {
      name: "福州每日天气简报",
      prompt: [
        "每天执行一次天气简报任务。请查询中国福建省福州市当天最新可获取的天气预报，并用中文简要汇报，适合手机阅读。",
        "要求：天气状况、最高/最低温、降雨概率、风力、空气质量、出门建议。",
      ].join("\n"),
      schedule_display: "0 7 * * *",
    },
  };

  assert.equal(isDuplicateHermesCronJob(existing, {
    name: "福州每日天气简报",
    prompt: [
      "你是每日天气简报任务。请查询中国福建省福州市当天最新可获取的天气预报，并用中文简要汇报，适合手机阅读。",
      "要求：天气状况、最高/最低温、降雨概率、风力、空气质量、出门建议。仅输出最终中文简报。",
    ].join("\n"),
    schedule: "every 1440m",
  }), true);
});

test("model options use Hermes provider payload without Codex fallback", () => {
  const items = modelItemsFromHermesModelOptionsPayload({
    provider: "minimax-oauth",
    model: "MiniMax-M2.7",
    providers: [
      {
        slug: "minimax-oauth",
        name: "MiniMax",
        is_current: true,
        source: "hermes",
        models: ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
      },
    ],
  });

  assert.deepEqual(items.map((item) => item.providerId), ["minimax-oauth", "minimax-oauth"]);
  assert.deepEqual(items.map((item) => item.modelId), ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"]);
  assert.equal(items[0]?.isSelected, true);
  assert.equal(items.some((item) => item.providerId === "openai-codex"), false);
});

test("model options expose Hermes model context windows", () => {
  const items = modelItemsFromHermesModelOptionsPayload({
    provider: "minimax-oauth",
    model: "mimo-v2.5-pro",
    providers: [
      {
        slug: "minimax-oauth",
        name: "Xiaomi MiMo",
        is_current: true,
        source: "hermes",
        models: [
          { id: "mimo-v2.5-pro", name: "mimo-v2.5-pro", limit: { context: 1000000 } },
          { id: "MiniMax-M2.7", context_window: "272k" },
        ],
      },
    ],
  });

  assert.deepEqual(items.map((item) => item.modelId), ["mimo-v2.5-pro", "MiniMax-M2.7"]);
  assert.equal(items[0]?.contextWindow, "1000000");
  assert.equal(items[1]?.contextWindow, "272000");
  assert.equal(items[0]?.isSelected, true);
});

test("Codex provider models come from Hermes payload rather than fixed fallback list", () => {
  const items = modelItemsFromHermesModelOptionsPayload({
    provider: "openai-codex",
    model: "custom-codex-from-hermes",
    providers: [
      {
        slug: "openai-codex",
        name: "OpenAI Codex",
        is_current: true,
        source: "hermes",
        models: ["custom-codex-from-hermes"],
      },
    ],
  });

  assert.deepEqual(items.map((item) => item.modelId), ["custom-codex-from-hermes"]);
  assert.equal(items[0]?.isSelected, true);
});

test("model options prefer current Hermes status when picker context is stale", () => {
  const items = modelItemsFromHermesModelOptionsPayload({
    provider: "xiaomi",
    model: "mimo-v2.5-pro",
    providers: [
      {
        slug: "xiaomi",
        name: "Xiaomi",
        is_current: true,
        models: ["mimo-v2.5-pro"],
      },
      {
        slug: "openai-codex",
        name: "OpenAI Codex",
        models: ["gpt-5.6-luna"],
      },
    ],
  }, {
    provider: "openai-codex",
    currentModel: "gpt-5.6-luna",
  });

  assert.equal(items.find((item) => item.modelId === "mimo-v2.5-pro")?.isSelected, false);
  assert.equal(items.find((item) => item.modelId === "gpt-5.6-luna")?.isSelected, true);
});

test("Hermes model assignment uses the official provider-aware config path", () => {
  const script = hermesModelAssignmentScript("openai-api", "gpt-4o-mini");

  assert.match(script, /_apply_model_assignment_sync/);
  assert.match(script, /resolve_provider_full/);
  assert.match(script, /provider = "openai-api"/);
  assert.match(script, /provider, "gpt-4o-mini", "", base_url/);
});

test("Hermes model list does not synthesize fallback models when Hermes returns none", () => {
  const result = hermesModelListResultFromPayload(
    { provider: "openai-codex", model: "gpt-5.5", providers: [] },
    { provider: "openai-codex", currentModel: "gpt-5.5" },
    { provider: "openai-codex", model: "gpt-5.5" },
  );

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Hermes.*model/i);
});

test("parseHermesToolLogLine converts terminal tool logs to tool stream events", () => {
  const running = parseHermesToolLogLine(
    "2026-05-21 09:06:53,100 INFO [session] agent.tool_executor: tool terminal running"
  );
  const start = parseHermesToolLogLine(
    "2026-05-21 09:06:53,185 INFO [session] tools.terminal_tool: Creating new local environment for task default...",
  );
  const completed = parseHermesToolLogLine(
    "2026-05-21 09:06:53,871 INFO [session] agent.tool_executor: tool terminal completed (0.69s, 62 chars)",
  );

  assert.deepEqual(running, {
    toolName: "terminal",
    phase: "streaming",
    text: "terminal running",
    isError: false,
  });
  assert.deepEqual(start, {
    toolName: "terminal",
    phase: "streaming",
    text: "terminal: Creating new local environment for task default...",
  });
  assert.deepEqual(completed, {
    toolName: "terminal",
    phase: "completed",
    text: "terminal completed (0.69s, 62 chars)",
    isError: false,
  });
});

test("parseHermesToolLogLine converts nested vision tool logs", () => {
  const event = parseHermesToolLogLine(
    "2026-05-21 11:11:42,993 INFO [session] tools.vision_tools: vision_analyze: native fast path enabled",
  );

  assert.deepEqual(event, {
    toolName: "vision_analyze",
    phase: "streaming",
    text: "vision_analyze: native fast path enabled",
  });
});

test("parseHermesToolLogLine marks tool executor errors as failed", () => {
  const event = parseHermesToolLogLine(
    "2026-05-21 09:00:00,000 ERROR [session] agent.tool_executor: tool browser_navigate returned error: browser unavailable",
  );

  assert.deepEqual(event, {
    toolName: "browser_navigate",
    phase: "failed",
    text: "browser_navigate returned error: browser unavailable",
    isError: true,
  });
});

test("parseHermesToolLogLine ignores internal environment maintenance logs", () => {
  assert.equal(
    parseHermesToolLogLine(
      "2026-05-21 09:06:53,407 INFO [session] tools.environments.base: Session snapshot created (session=7f5745625abe, cwd=/)",
    ),
    null,
  );
  assert.equal(
    parseHermesToolLogLine(
      "2026-05-21 09:06:54,000 INFO [session] tools.terminal_tool: Manually cleaned up environment for task: default",
    ),
    null,
  );
  assert.equal(
    parseHermesToolLogLine(
      "2026-06-01 21:04:04,859 INFO [session] tools.terminal_tool: Shutting down 1 remaining sandbox(es)...",
    ),
    null,
  );
});
