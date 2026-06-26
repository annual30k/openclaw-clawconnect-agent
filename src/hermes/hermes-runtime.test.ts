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

test("runHermesChat exposes current run id to Hermes send-file skills", async () => {
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
      "  console.log(process.env.CLAWCONNECT_SOURCE_RUN_ID || 'missing-source-run');",
      "  process.exit(0);",
      "}",
      "process.exit(2);",
      "",
    ].join("\n"));
    chmodSync(hermesBin, 0o755);
    process.env.HERMES_BIN = hermesBin;

    const result = await runHermesChat(
      { message: "用 file-transfer 发文件", sessionKey: "main" },
      { requestId: "hermes-run-123", publishEvent: () => undefined },
    );

    assert.equal(result.output, "hermes-run-123");
  } finally {
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
