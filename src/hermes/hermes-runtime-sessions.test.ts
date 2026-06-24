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
