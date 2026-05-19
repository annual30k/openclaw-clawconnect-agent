import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  extractDeliverablePaths,
  parseHermesSkillsList,
  parseHermesSessionUsageSnapshot,
  parseHermesStatusSnapshot,
  stripHermesSecurityReviewNotices,
  stripHermesSessionResumeNotices,
} from "./hermes-runtime.js";
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
