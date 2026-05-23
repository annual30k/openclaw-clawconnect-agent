import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
} from "./hermes-runtime.js";
import {
  hermesModelListResultFromPayload,
  modelItemsFromHermesModelOptionsPayload,
} from "./models/hermes-runtime-models.js";
import { mergeLiveHermesSessionsWithStoredAliases, parseHermesSessionsList } from "./hermes-session-store.js";

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
    const docPath = join(dir, "vue_component_progressive_introduction.docx");
    writeFileSync(imagePath, "jpg");
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
});

test("stripHermesSessionResumeNotices removes Hermes resume banners", () => {
  const output = stripHermesSessionResumeNotices([
    "↻ Resumed session 20260519_015943_72d864 (3 user messages, 6 total messages)",
    "OK",
  ].join("\n")).trim();

  assert.equal(output, "OK");
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
  const start = parseHermesToolLogLine(
    "2026-05-21 09:06:53,185 INFO [session] tools.terminal_tool: Creating new local environment for task default...",
  );
  const completed = parseHermesToolLogLine(
    "2026-05-21 09:06:53,871 INFO [session] agent.tool_executor: tool terminal completed (0.69s, 62 chars)",
  );

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
