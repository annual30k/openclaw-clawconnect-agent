import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildHermesAssistantDeltaPayload,
  buildHermesRuntimeContextHint,
  extractDeliverablePaths,
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

test("extractDeliverablePaths returns existing supported artifact paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-artifacts-"));
  try {
    const imagePath = join(dir, "chart.png");
    const sourcePath = join(dir, "secret.ts");
    writeFileSync(imagePath, "png");
    writeFileSync(sourcePath, "source");

    const paths = extractDeliverablePaths(`Created ${imagePath} and ${sourcePath} plus /missing/report.pdf`);

    assert.deepEqual(paths, [imagePath]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extractDeliverablePaths requires the latest user to ask for sending files", () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-artifacts-intent-"));
  try {
    const imagePath = join(dir, "微信图片_20260427092438_279_84.jpg");
    const spacedImagePath = join(dir, "ChatGPT Image 2026年4月24日 02_12_21.png");
    const docPath = join(dir, "vue_component_progressive_introduction.docx");
    writeFileSync(imagePath, "jpg");
    writeFileSync(spacedImagePath, "png");
    writeFileSync(docPath, "docx");

    const answerWithOldPaths = [
      "我现在有这些技能。",
      `之前提到过 ${imagePath}`,
      `也提到过 ${docPath}`,
    ].join("\n");

    assert.deepEqual(
      extractDeliverablePaths(answerWithOldPaths, { userMessage: "你现在有什么技能" }),
      [],
    );
    assert.deepEqual(
      extractDeliverablePaths(answerWithOldPaths, { userMessage: "这些文件在哪里，只告诉我文件名和路径" }),
      [],
    );
    assert.deepEqual(
      extractDeliverablePaths(answerWithOldPaths, { userMessage: "不要发送文件，只给我文件名或者路径" }),
      [],
    );
    assert.deepEqual(
      extractDeliverablePaths(`图片路径：${imagePath}`, { userMessage: "把这张图片发给我" }),
      [imagePath],
    );
    assert.deepEqual(
      extractDeliverablePaths(`文件路径：${docPath}`, { userMessage: "只要把这个文件发给我" }),
      [docPath],
    );
    assert.deepEqual(
      extractDeliverablePaths(`图片路径：${imagePath}`, { userMessage: "发图片" }),
      [imagePath],
    );
    assert.deepEqual(
      extractDeliverablePaths(`图片路径：${imagePath}`, { userMessage: "发送这张图到手机" }),
      [imagePath],
    );
    assert.deepEqual(
      extractDeliverablePaths(`图片路径：${spacedImagePath}`, { userMessage: "把这张图片发给我" }),
      [spacedImagePath],
    );
    assert.deepEqual(
      extractDeliverablePaths(`图片路径：${imagePath}`, { userMessage: "发过来了吗" }),
      [imagePath],
    );
    assert.deepEqual(
      extractDeliverablePaths(`Path: ${imagePath}`, { userMessage: `send ${imagePath} to my phone` }),
      [imagePath],
    );
    assert.deepEqual(
      extractDeliverablePaths(`图片路径：${imagePath}`, { userMessage: "你能发图片吗" }),
      [],
    );
  } finally {
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

test("parseHermesSkillsList enriches rows from SKILL.md frontmatter", () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-skills-"));
  const previousSkillsDir = process.env.HERMES_SKILLS_DIR;
  process.env.HERMES_SKILLS_DIR = root;
  try {
    const skillDir = join(root, "productivity", "airtable");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), [
      "---",
      "name: airtable",
      "description: Airtable REST API via curl. Records CRUD, filters, upserts.",
      "version: 1.1.0",
      "author: community",
      "platforms: [linux, macos, windows]",
      "prerequisites:",
      "  env_vars: [AIRTABLE_API_KEY]",
      "  commands: [curl]",
      "metadata:",
      "  hermes:",
      "    homepage: https://airtable.com/developers/web/api/introduction",
      "---",
      "",
    ].join("\n"));

    const skills = parseHermesSkillsList([
      "┏━━━━━━━━━━┳━━━━━━━━━━━━━━┳━━━━━━━━━┳━━━━━━━━━┳━━━━━━━━━┓",
      "┃ Name     ┃ Category     ┃ Source  ┃ Trust   ┃ Status  ┃",
      "┡━━━━━━━━━━╇━━━━━━━━━━━━━━╇━━━━━━━━━╇━━━━━━━━━╇━━━━━━━━━┩",
      "│ airtable │ productivity │ builtin │ builtin │ enabled │",
    ].join("\n"));

    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.skillKey, "airtable");
    assert.equal(skills[0]?.description, "Airtable REST API via curl. Records CRUD, filters, upserts.");
    assert.equal(skills[0]?.homepage, "https://airtable.com/developers/web/api/introduction");
    assert.deepEqual((skills[0]?.requirements as { bins?: string[]; env?: string[] })?.bins, ["curl"]);
    assert.deepEqual((skills[0]?.requirements as { bins?: string[]; env?: string[] })?.env, ["AIRTABLE_API_KEY"]);
  } finally {
    if (previousSkillsDir === undefined) {
      delete process.env.HERMES_SKILLS_DIR;
    } else {
      process.env.HERMES_SKILLS_DIR = previousSkillsDir;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("parseHermesSessionsList normalizes Hermes table output", () => {
  const now = new Date("2026-05-19T01:40:00.000Z");
  const items = parseHermesSessionsList(
    [
      "Title                            Preview                                  Last Active   ID",
      "──────────────────────────────────────────────────────────────────────────────────────────────────────────────",
      "询问当前模型信息                         你好，你现在用的是什么模型                            19m ago       20260519_011955_df243a",
      "—                                请只回复 OK                                  just now      20260519_010900_de2de9",
    ].join("\n"),
    now,
  );

  assert.equal(items.length, 2);
  assert.equal(items[0]?.sessionKey, "hermes:20260519_011955_df243a");
  assert.equal(items[0]?.displayName, "询问当前模型信息");
  assert.equal(items[0]?.label, "你好，你现在用的是什么模型");
  assert.equal(items[0]?.lastActivityAt, "2026-05-19T01:21:00.000Z");
  assert.equal(items[1]?.displayName, "请只回复 OK");
  assert.equal(items[1]?.lastActivityAt, now.toISOString());
});

test("mergeLiveHermesSessionsWithStoredAliases keeps one row per live Hermes session", () => {
  const live = [
    {
      sessionKey: "hermes:20260519_015943_72d864",
      hermesSessionId: "20260519_015943_72d864",
      displayName: "移动端附件",
      lastActivityAt: "2026-05-19T02:00:00.000Z",
      kind: "hermes" as const,
    },
    {
      sessionKey: "hermes:20260519_095114_3c5672",
      hermesSessionId: "20260519_095114_3c5672",
      displayName: "模型信息",
      lastActivityAt: "2026-05-19T03:00:00.000Z",
      kind: "hermes" as const,
    },
  ];
  const stored = [
    {
      sessionKey: "smoke-mpbidw6c",
      hermesSessionId: "20260519_015943_72d864",
      displayName: "旧 smoke 别名",
      kind: "hermes" as const,
    },
    {
      sessionKey: "hermes:20260519_015943_72d864",
      hermesSessionId: "20260519_015943_72d864",
      displayName: "旧 canonical 别名",
      kind: "hermes" as const,
    },
    {
      sessionKey: "deleted-alias",
      hermesSessionId: "20260519_020359_903cc6",
      displayName: "已删除会话",
      kind: "hermes" as const,
    },
    {
      sessionKey: "main",
      hermesSessionId: "20260519_095114_3c5672",
      displayName: "旧 main 别名",
      kind: "hermes" as const,
    },
  ];

  const merged = mergeLiveHermesSessionsWithStoredAliases(live, stored);

  assert.deepEqual(merged.map((item) => item.sessionKey), ["main", "smoke-mpbidw6c"]);
  assert.deepEqual(merged.map((item) => item.hermesSessionId), [
    "20260519_095114_3c5672",
    "20260519_015943_72d864",
  ]);
});

test("Hermes session store quarantines corrupt JSON and recovers empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-session-store-corrupt-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  try {
    const storePath = join(root, "sessions.json");
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    writeFileSync(storePath, '{"version":1,"sessions":{}}\ntrailing-garbage', "utf8");

    assert.deepEqual(await listStoredHermesSessions(), []);
    const quarantined = readdirSync(root).filter((name) => name.startsWith("sessions.json.corrupt-"));
    assert.equal(quarantined.length, 1);
    assert.equal(readFileSync(join(root, quarantined[0]!), "utf8").includes("trailing-garbage"), true);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes session store serializes concurrent writes into valid JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-session-store-concurrent-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  try {
    const storePath = join(root, "sessions.json");
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;

    await Promise.all(Array.from({ length: 16 }, async (_, index) => {
      await rememberHermesSession(`session-${index}`, {
        sessionKey: `session-${index}`,
        hermesSessionId: `20260528_1800${String(index).padStart(2, "0")}_abcd${index}`,
        displayName: `Session ${index}`,
        kind: "hermes",
      });
    }));

    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as { sessions?: Record<string, unknown> };
    assert.equal(Object.keys(parsed.sessions ?? {}).length, 16);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChat forgets stale mapped sessions and retries without resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-stale-resume-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  try {
    const storePath = join(root, "sessions.json");
    const binPath = writeFakeHermesBin(root);
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;
    await rememberHermesSession("main", {
      sessionKey: "main",
      hermesSessionId: "missing",
      displayName: "Missing",
      kind: "hermes",
    });

    const result = await runHermesChat({ sessionKey: "main", message: "hello" });

    assert.equal(result.output, "fresh reply");
    const stored = await listStoredHermesSessions();
    assert.equal(stored[0]?.hermesSessionId, "20260528_181500_abcd12");
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChat bypasses interactive command approvals for mobile bridge queries", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-mobile-yolo-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  try {
    const storePath = join(root, "sessions.json");
    const binPath = writeFakeHermesBin(root);
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;

    const result = await runHermesChat({ sessionKey: "main", message: "hello" });

    assert.equal(result.output, "fresh reply");
    const args = readFileSync(`${binPath}.args`, "utf8").trim().split(/\n/);
    assert.equal(args[0], "chat");
    assert.equal(args.includes("--quiet"), true);
    assert.equal(args.includes("--source"), true);
    assert.equal(args.includes("pocketclaw"), true);
    assert.equal(args.includes("--yolo"), true);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChat treats timeout-denied command output as a terminal error", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-timeout-denied-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  try {
    const storePath = join(root, "sessions.json");
    const binPath = writeTimeoutDeniedHermesBin(root);
    const publishedEvents: unknown[] = [];
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;

    await assert.rejects(
      () => runHermesChat(
        { sessionKey: "main", message: "hello" },
        { requestId: "run-timeout", publishEvent: (event) => publishedEvents.push(event) },
      ),
      /Timeout – denying command/,
    );

    assert.equal(JSON.stringify(publishedEvents).includes("Timeout – denying command"), false);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChat drops buffered assistant output when aborted", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-abort-partial-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  try {
    const storePath = join(root, "sessions.json");
    const binPath = writeAbortPartialHermesBin(root);
    const publishedEvents: unknown[] = [];
    const controller = new AbortController();
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;

    const chatPromise = runHermesChat(
      { sessionKey: "main", message: "abort me" },
      {
        requestId: "run-abort",
        abortSignal: controller.signal,
        publishEvent: (event) => publishedEvents.push(event),
      },
    );
    setTimeout(() => controller.abort(), 20);

    await assert.rejects(() => chatPromise, /hermes_chat_aborted/);
    const serializedEvents = JSON.stringify(publishedEvents);
    assert.equal(serializedEvents.includes("partial"), false);
    assert.equal(serializedEvents.includes("\"state\":\"delta\""), false);
    assert.equal(serializedEvents.includes("[[clawlink:typing]]"), false);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChat publishes assistant output before a newline arrives", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-partial-stream-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  try {
    const storePath = join(root, "sessions.json");
    const binPath = writeSlowPartialHermesBin(root);
    const publishedEvents: unknown[] = [];
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;

    const chatPromise = runHermesChat(
      { sessionKey: "main", message: "stream slowly" },
      {
        requestId: "run-partial-stream",
        publishEvent: (event) => publishedEvents.push(event),
      },
    );

    await waitForHermesDelta(publishedEvents, "partial", 600);
    const result = await chatPromise;

    assert.match(result.output, /partial reply/);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChat resolves from exported history when Hermes keeps running after answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-history-completion-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  try {
    const storePath = join(root, "sessions.json");
    const binPath = writeHistoryCompletingHermesBin(root);
    const publishedEvents: unknown[] = [];
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;

    const result = await runHermesChat(
      { sessionKey: "main", message: "Hi" },
      { requestId: "run-history-complete", publishEvent: (event) => publishedEvents.push(event) },
    );

    assert.equal(result.output, "你好！有什么我能帮你的吗？");
    assert.equal(JSON.stringify(publishedEvents).includes("你好！有什么我能帮你的吗？"), false);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChat ignores exported history until it contains the current user turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-history-current-turn-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  try {
    const storePath = join(root, "sessions.json");
    const binPath = writeStaleHistoryHermesBin(root);
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;

    const result = await runHermesChat(
      { sessionKey: "main", message: "Ping" },
      { requestId: "run-history-current-turn", publishEvent: () => undefined },
    );

    assert.equal(result.output, "Pong! 🏓");
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChat does not complete from an older repeated user prompt in exported history", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-history-repeated-user-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  try {
    const storePath = join(root, "sessions.json");
    const binPath = writeRepeatedUserStaleHistoryHermesBin(root);
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;

    const result = await runHermesChat(
      { sessionKey: "main", message: "Hi" },
      { requestId: "run-history-repeated-user", publishEvent: () => undefined },
    );

    assert.equal(result.output, "fresh hi reply");
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChat serializes concurrent requests for the same Hermes session", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-serialized-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  try {
    const storePath = join(root, "sessions.json");
    const binPath = writeConcurrentDetectingHermesBin(root);
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;

    const [first, second] = await Promise.all([
      runHermesChat({ sessionKey: "main", message: "Ping" }),
      runHermesChat({ sessionKey: "main", message: "Hi" }),
    ]);

    assert.equal(first.output, "reply:Ping");
    assert.equal(second.output, "reply:Hi");
    assert.equal(existsSync(join(root, "concurrent")), false);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChat strips Hermes resume metadata from streaming events and final output", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-resume-metadata-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  try {
    const storePath = join(root, "sessions.json");
    const binPath = writeResumeMetadataHermesBin(root);
    const publishedEvents: unknown[] = [];
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;

    const result = await runHermesChat(
      { sessionKey: "main", message: "hello" },
      { requestId: "run-resume", publishEvent: (event) => publishedEvents.push(event) },
    );

    assert.equal(result.output, "visible reply");
    const serializedEvents = JSON.stringify(publishedEvents);
    assert.equal(serializedEvents.includes("Resumed session"), false);
    assert.equal(serializedEvents.includes("NoneType"), false);
    assert.equal(serializedEvents.includes("session_id:"), false);
    assert.equal(serializedEvents.includes("visible reply"), true);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesSessionExport clears stale mapped sessions and retries without session id", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-export-stale-session-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  try {
    const storePath = join(root, "sessions.json");
    const binPath = writeFakeHermesBin(root);
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;
    await rememberHermesSession("main", {
      sessionKey: "main",
      hermesSessionId: "missing",
      displayName: "Missing",
      kind: "hermes",
    });

    const result = await runHermesSessionExport({ sessionKey: "main", output: "-" });

    assert.equal(result.ok, true);
    assert.deepEqual(result.payload, { output: "{\"model\":\"gpt-5.5\",\"input_tokens\":1,\"model_config\":{\"max_input_tokens\":10}}\n" });
    assert.deepEqual(await listStoredHermesSessions(), []);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChatHistory returns OpenClaw-shaped canonical history", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-history-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  try {
    const storePath = join(root, "sessions.json");
    const binPath = writeHistoryHermesBin(root);
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;
    await rememberHermesSession("main", {
      sessionKey: "main",
      hermesSessionId: "20260529_100000_history",
      displayName: "History",
      kind: "hermes",
    });

    const result = await runHermesChatHistory({ sessionKey: "main", limit: 10 });

    assert.equal(result.ok, true);
    assert.deepEqual(result.payload, {
      sessionKey: "main",
      sessionId: "20260529_100000_history",
      messages: [
        {
          id: "m1",
          role: "user",
          content: [{ type: "text", text: "hello" }],
          createdAt: "2026-05-29T02:00:00.000Z",
          seq: 1,
        },
        {
          id: "m2",
          role: "assistant",
          content: [
            { type: "text", text: "visible reply" },
            {
              type: "file",
              attachmentId: "file-history-1",
              fileId: "file-history-1",
              fileName: "report.pdf",
              mimeType: "application/pdf",
              transferState: "available",
            },
          ],
          createdAt: "2026-05-29T02:00:01.000Z",
          seq: 2,
        },
      ],
      items: [
        {
          id: "m1",
          role: "user",
          content: [{ type: "text", text: "hello" }],
          createdAt: "2026-05-29T02:00:00.000Z",
          seq: 1,
        },
        {
          id: "m2",
          role: "assistant",
          content: [
            { type: "text", text: "visible reply" },
            {
              type: "file",
              attachmentId: "file-history-1",
              fileId: "file-history-1",
              fileName: "report.pdf",
              mimeType: "application/pdf",
              transferState: "available",
            },
          ],
          createdAt: "2026-05-29T02:00:01.000Z",
          seq: 2,
        },
      ],
      hasMore: false,
      newestCursor: "seq:2",
      timelineSnapshot: {
        protocolVersion: 2,
        eventType: "history.snapshot.page",
        gatewayId: "clawconnect",
        sessionKey: "main",
        source: "history",
        cursor: null,
        hasMore: false,
        nextCursor: null,
        newestCursor: "seq:2",
        extensions: {
          orderPolicy: "transcript",
        },
        messages: [
          {
            turnId: "history-main-1-user",
            messageId: "m1",
            role: "user",
            messageState: "completed",
            createdAt: "2026-05-29T02:00:00.000Z",
            content: [{ type: "text", text: "hello" }],
            partId: "part-text-1",
            runId: "history-main-1-user",
            seq: 1,
            turnSeq: 1,
          },
          {
            turnId: "history-main-2-assistant",
            messageId: "m2",
            role: "assistant",
            messageState: "completed",
            createdAt: "2026-05-29T02:00:01.000Z",
            content: [
              { type: "text", text: "visible reply" },
              {
                type: "file",
                attachmentId: "file-history-1",
                fileId: "file-history-1",
                fileName: "report.pdf",
                mimeType: "application/pdf",
                transferState: "available",
              },
            ],
            attachmentIds: ["file-history-1"],
            partId: "part-text-1",
            runId: "history-main-2-assistant",
            seq: 2,
            turnSeq: 2,
          },
        ],
        attachments: [],
      },
    });
    assert.equal(JSON.stringify(result.payload).includes("Resumed session"), false);
    assert.equal(JSON.stringify(result.payload).includes("NoneType"), false);
    assert.equal(JSON.stringify(result.payload).includes("session_id:"), false);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChatHistory does not emit epoch timestamps when export omits message times", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-history-untimed-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  try {
    const storePath = join(root, "sessions.json");
    const binPath = writeUntimedHistoryHermesBin(root);
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;
    await rememberHermesSession("main", {
      sessionKey: "main",
      hermesSessionId: "20260529_100000_history",
      displayName: "History",
      kind: "hermes",
    });

    const result = await runHermesChatHistory({ sessionKey: "main", limit: 10 });

    assert.equal(result.ok, true);
    const payload = result.payload as {
      messages: Array<{ createdAt: string }>;
      timelineSnapshot: { messages: Array<{ createdAt: string }> };
    };
    assert.deepEqual(payload.messages.map((message) => message.createdAt), [
      "2026-05-29T02:00:00.000Z",
      "2026-05-29T02:00:00.001Z",
    ]);
    assert.deepEqual(payload.timelineSnapshot.messages.map((message) => message.createdAt), [
      "2026-05-29T02:00:00.000Z",
      "2026-05-29T02:00:00.001Z",
    ]);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes command router handles chat.history canonically", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-history-router-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  try {
    const storePath = join(root, "sessions.json");
    const binPath = writeHistoryHermesBin(root);
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;

    const result = await handleHermesCommand("chat.history", { sessionKey: "hermes:20260529_100000_history", limit: 1 });

    assert.equal(result?.ok, true);
    assert.deepEqual((result as { payload?: Record<string, unknown> }).payload?.messages, [
      {
        id: "m2",
        role: "assistant",
        content: [
          { type: "text", text: "visible reply" },
          {
            type: "file",
            attachmentId: "file-history-1",
            fileId: "file-history-1",
            fileName: "report.pdf",
            mimeType: "application/pdf",
            transferState: "available",
          },
        ],
        createdAt: "2026-05-29T02:00:01.000Z",
        seq: 2,
      },
    ]);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChatHistory reuses normalized history for the same session export hash", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-history-cache-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  try {
    const storePath = join(root, "sessions.json");
    const binPath = writePagedHistoryHermesBin(root);
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;
    await rememberHermesSession("main", {
      sessionKey: "main",
      hermesSessionId: "20260529_100000_history",
      displayName: "History",
      kind: "hermes",
    });

    const newest = await runHermesChatHistory({ sessionKey: "main", limit: 2 });
    const older = await runHermesChatHistory({
      sessionKey: "main",
      limit: 2,
      cursor: (newest.payload as { nextCursor?: string }).nextCursor,
      direction: "older",
    });

    assert.equal(newest.ok, true);
    assert.equal(older.ok, true);
    assert.deepEqual((newest.payload as { messages?: Array<{ seq: number }> }).messages?.map((message) => message.seq), [3, 4]);
    assert.deepEqual((older.payload as { messages?: Array<{ seq: number }> }).messages?.map((message) => message.seq), [1, 2]);
    const newestThirdMessage = (newest.payload as { messages?: unknown[] }).messages?.[0];
    const newerFromOlderPage = await runHermesChatHistory({
      sessionKey: "main",
      limit: 1,
      cursor: (older.payload as { newestCursor?: string }).newestCursor,
      direction: "newer",
    });
    assert.equal(newerFromOlderPage.ok, true);
    assert.equal((newerFromOlderPage.payload as { messages?: unknown[] }).messages?.[0], newestThirdMessage);

    const explicitSessionIdPage = await runHermesChatHistory({
      sessionKey: "main",
      sessionId: "20260529_100000_history",
      limit: 1,
      cursor: "seq:2",
      direction: "newer",
    });
    assert.equal(explicitSessionIdPage.ok, true);
    assert.equal((explicitSessionIdPage.payload as { messages?: unknown[] }).messages?.[0], newestThirdMessage);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChatHistory invalidates normalized history when the export hash changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-history-cache-invalidate-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  try {
    const storePath = join(root, "sessions.json");
    const payloadPath = join(root, "history-payload.json");
    const binPath = writeMutableHistoryHermesBin(root, payloadPath);
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;
    await rememberHermesSession("main", {
      sessionKey: "main",
      hermesSessionId: "20260529_100000_history",
      displayName: "History",
      kind: "hermes",
    });
    writeFileSync(payloadPath, JSON.stringify({
      sessionId: "20260529_100000_history",
      messages: [{ id: "m1", role: "assistant", content: "first", createdAt: "2026-05-29T02:00:01.000Z" }],
    }));

    const first = await runHermesChatHistory({ sessionKey: "main", limit: 1 });
    writeFileSync(payloadPath, JSON.stringify({
      sessionId: "20260529_100000_history",
      messages: [{ id: "m1", role: "assistant", content: "second", createdAt: "2026-05-29T02:00:01.000Z" }],
    }));
    const second = await runHermesChatHistory({ sessionKey: "main", limit: 1 });

    const firstMessage = (first.payload as { messages?: Array<{ content: unknown }> }).messages?.[0];
    const secondMessage = (second.payload as { messages?: Array<{ content: unknown }> }).messages?.[0];
    assert.deepEqual(firstMessage?.content, [{ type: "text", text: "first" }]);
    assert.deepEqual(secondMessage?.content, [{ type: "text", text: "second" }]);
    assert.notEqual(secondMessage, firstMessage);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});

function restoreEnv(name: string, previousValue: string | undefined): void {
  if (previousValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previousValue;
  }
}

function writeMutableHistoryHermesBin(root: string, payloadPath: string): string {
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

function writePagedHistoryHermesBin(root: string): string {
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

function writeFakeHermesBin(root: string): string {
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

function writeTimeoutDeniedHermesBin(root: string): string {
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

function writeAbortPartialHermesBin(root: string): string {
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

function writeSlowPartialHermesBin(root: string): string {
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

async function waitForHermesDelta(events: unknown[], expectedText: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (JSON.stringify(events).includes(`"state":"delta"`) && JSON.stringify(events).includes(expectedText)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for Hermes delta containing ${expectedText}`);
}

function writeHistoryCompletingHermesBin(root: string): string {
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

function writeStaleHistoryHermesBin(root: string): string {
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

function writeRepeatedUserStaleHistoryHermesBin(root: string): string {
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

function writeConcurrentDetectingHermesBin(root: string): string {
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

function writeResumeMetadataHermesBin(root: string): string {
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

function writeHistoryHermesBin(root: string): string {
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

function writeUntimedHistoryHermesBin(root: string): string {
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
