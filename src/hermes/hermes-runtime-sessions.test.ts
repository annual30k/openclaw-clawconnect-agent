import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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
  readHermesStatusSnapshotAsync,
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
  waitForFile,
  waitForHermesDelta,
  writeHistoryCompletingHermesBin,
  writeHermesStateDb,
  writeStateDbHistoryCompletingHermesBin,
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
    assert.equal(args.includes("--cli"), true);
    assert.equal(args.includes("--tui"), false);
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

test("runHermesChat uses the Hermes API server stream instead of spawning the CLI when configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-api-server-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  const previousApiUrl = process.env.CLAWCONNECT_HERMES_API_URL;
  const previousApiKey = process.env.CLAWCONNECT_HERMES_API_KEY;
  const previousStateDb = process.env.CLAWCONNECT_HERMES_STATE_DB;
  const cliCalledPath = join(root, "cli-called");
  const apiRequests: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: string }> = [];
  const hermesSessionId = "api_session_0701";
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      apiRequests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/sessions") {
        assert.equal(req.headers.authorization, "Bearer test-api-key");
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ session: { id: hermesSessionId, title: "mobile-main" } }));
        return;
      }
      if (req.method === "POST" && req.url === `/api/sessions/${hermesSessionId}/chat/stream`) {
        assert.equal(req.headers.authorization, "Bearer test-api-key");
        assert.equal(req.headers["x-hermes-session-key"], "mobile-main");
        const parsed = JSON.parse(body) as { message?: string; instructions?: string };
        assert.match(parsed.message ?? "", /^hello api/);
        assert.doesNotMatch(parsed.message ?? "", /\[ClawConnect mobile bridge]/);
        assert.doesNotMatch(parsed.message ?? "", /\[Hermes runtime context]/);
        assert.match(parsed.message ?? "", /\[ClawConnect mobile turn]/);
        assert.match(parsed.message ?? "", /sourceRunId: run-api/);
        assert.match(parsed.message ?? "", /sessionKey: mobile-main/);
        assert.match(parsed.instructions ?? "", /\[ClawConnect mobile bridge]/);
        assert.match(parsed.instructions ?? "", /\[Hermes runtime context]/);
        assert.match(parsed.instructions ?? "", /model=gpt-5\.5, provider=openai-codex/);
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        res.write("event: run.started\n");
        res.write(`data: ${JSON.stringify({ run_id: "run-api", session_id: hermesSessionId })}\n\n`);
        res.write("event: assistant.delta\n");
        res.write(`data: ${JSON.stringify({ delta: "api " })}\n\n`);
        res.write("event: assistant.delta\n");
        res.write(`data: ${JSON.stringify({ delta: "reply" })}\n\n`);
        res.write("event: assistant.completed\n");
        res.write(`data: ${JSON.stringify({ session_id: hermesSessionId, content: "api reply" })}\n\n`);
        res.write("event: run.completed\n");
        res.write(`data: ${JSON.stringify({ session_id: hermesSessionId, usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } })}\n\n`);
        res.write("event: done\n");
        res.write("data: {}\n\n");
        res.end();
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });

  try {
    const storePath = join(root, "sessions.json");
    const binPath = join(root, "hermes-should-not-run");
    writeFileSync(binPath, [
      "#!/bin/sh",
      "if [ \"$1\" = \"skills\" ] && [ \"$2\" = \"list\" ]; then exit 0; fi",
      "if [ \"$1\" = \"status\" ]; then",
      "  printf '%s\\n' 'Hermes CLI Status'",
      "  printf '%s\\n' '  Model:        gpt-5.5'",
      "  printf '%s\\n' '  Provider:     openai-codex'",
      "  exit 0",
      "fi",
      `printf '%s\\n' "$@" > '${cliCalledPath.replace(/'/g, "'\\''")}'`,
      "exit 2",
      "",
    ].join("\n"), "utf8");
    chmodSync(binPath, 0o755);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;
    process.env.CLAWCONNECT_HERMES_API_URL = `http://127.0.0.1:${address.port}`;
    process.env.CLAWCONNECT_HERMES_API_KEY = "test-api-key";
    process.env.CLAWCONNECT_HERMES_STATE_DB = join(root, "missing-state.db");
    const publishedEvents: unknown[] = [];
    await readHermesStatusSnapshotAsync();

    const result = await runHermesChat(
      { sessionKey: "mobile-main", message: "hello api" },
      { requestId: "run-api", gatewayId: "gw-hermes", publishEvent: (event) => publishedEvents.push(event) },
    );

    assert.equal(result.output, "api reply");
    assert.equal(result.sessionKey, "mobile-main");
    assert.equal(result.usage?.hermesSessionId, hermesSessionId);
    assert.equal(result.usage?.contextUsage, 3);
    assert.equal(existsSync(cliCalledPath), false);
    assert.equal(apiRequests.some((request) => request.url === "/api/sessions"), true);
    assert.equal(apiRequests.some((request) => request.url === `/api/sessions/${hermesSessionId}/chat/stream`), true);
    assert.equal(JSON.stringify(publishedEvents).includes("api "), true);
    assert.deepEqual(assistantTimelineDeltaTexts(publishedEvents), ["api ", "api reply"]);
    const stored = await listStoredHermesSessions();
    assert.equal(stored[0]?.sessionKey, "mobile-main");
    assert.equal(stored[0]?.hermesSessionId, hermesSessionId);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    restoreEnv("CLAWCONNECT_HERMES_API_URL", previousApiUrl);
    restoreEnv("CLAWCONNECT_HERMES_API_KEY", previousApiKey);
    restoreEnv("CLAWCONNECT_HERMES_STATE_DB", previousStateDb);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChat recovers the unique existing API session after a title conflict", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-api-title-conflict-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousApiUrl = process.env.CLAWCONNECT_HERMES_API_URL;
  const previousApiKey = process.env.CLAWCONNECT_HERMES_API_KEY;
  const previousStateDb = process.env.CLAWCONNECT_HERMES_STATE_DB;
  const hermesSessionId = "api_existing_main";
  const requests: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/sessions") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Title 'main' is already in use" } }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          object: "list",
          data: [{ id: hermesSessionId, source: "api_server", title: "main" }],
        }));
        return;
      }
      if (req.method === "POST" && req.url === `/api/sessions/${hermesSessionId}/chat/stream`) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: assistant.completed\n");
        res.write(`data: ${JSON.stringify({ session_id: hermesSessionId, content: "MIMO_OK" })}\n\n`);
        res.write("event: done\n");
        res.write("data: {}\n\n");
        res.end();
        return;
      }
      res.writeHead(404).end();
    });
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = join(root, "sessions.json");
    process.env.CLAWCONNECT_HERMES_API_URL = `http://127.0.0.1:${address.port}`;
    process.env.CLAWCONNECT_HERMES_API_KEY = "test-api-key";
    process.env.CLAWCONNECT_HERMES_STATE_DB = join(root, "missing-state.db");

    const result = await runHermesChat({ sessionKey: "main", message: "hello" });

    assert.equal(result.output, "MIMO_OK");
    assert.deepEqual(requests.slice(0, 4), [
      "GET /health",
      "POST /api/sessions",
      "GET /api/sessions",
      `POST /api/sessions/${hermesSessionId}/chat/stream`,
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("CLAWCONNECT_HERMES_API_URL", previousApiUrl);
    restoreEnv("CLAWCONNECT_HERMES_API_KEY", previousApiKey);
    restoreEnv("CLAWCONNECT_HERMES_STATE_DB", previousStateDb);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChat recovers empty Hermes API final output from state DB history", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-api-empty-final-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  const previousApiUrl = process.env.CLAWCONNECT_HERMES_API_URL;
  const previousApiKey = process.env.CLAWCONNECT_HERMES_API_KEY;
  const previousStateDb = process.env.CLAWCONNECT_HERMES_STATE_DB;
  const cliCalledPath = join(root, "cli-called");
  const hermesSessionId = "api_empty_final_0701";
  const dbPath = writeHermesStateDb(root);

  const seedCompletedTurn = (userContent: string): void => {
    const script = String.raw`
import sqlite3
import sys
db_path, session_id, user_content = sys.argv[1:4]
conn = sqlite3.connect(db_path)
conn.execute("INSERT OR REPLACE INTO sessions (id, source, model, started_at, title, message_count) VALUES (?, 'api', 'gpt-5.5', 1780000000.0, 'API empty final', 2)", (session_id,))
conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
conn.execute("INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, 'user', ?, 1780000001.0, 1)", (session_id, user_content))
conn.execute("INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, 'assistant', 'state-db api reply', 1780000002.0, 1)", (session_id,))
conn.commit()
conn.close()
`;
    execFileSync("python3", ["-c", script, dbPath, hermesSessionId, userContent], { stdio: "pipe" });
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/sessions") {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ session: { id: hermesSessionId, title: "mobile-empty-final" } }));
        return;
      }
      if (req.method === "POST" && req.url === `/api/sessions/${hermesSessionId}/chat/stream`) {
        const parsed = JSON.parse(body) as { message?: string };
        seedCompletedTurn(parsed.message ?? "");
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        res.write("event: assistant.completed\n");
        res.write(`data: ${JSON.stringify({ session_id: hermesSessionId, content: "" })}\n\n`);
        res.write("event: run.completed\n");
        res.write(`data: ${JSON.stringify({ session_id: hermesSessionId, output: "" })}\n\n`);
        res.end();
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });

  try {
    const storePath = join(root, "sessions.json");
    const binPath = join(root, "hermes-should-not-run");
    writeFileSync(binPath, [
      "#!/bin/sh",
      "if [ \"$1\" = \"skills\" ] && [ \"$2\" = \"list\" ]; then exit 0; fi",
      "if [ \"$1\" = \"status\" ]; then exit 0; fi",
      `printf '%s\\n' "$@" > '${cliCalledPath.replace(/'/g, "'\\''")}'`,
      "exit 2",
      "",
    ].join("\n"), "utf8");
    chmodSync(binPath, 0o755);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;
    process.env.CLAWCONNECT_HERMES_API_URL = `http://127.0.0.1:${address.port}`;
    process.env.CLAWCONNECT_HERMES_API_KEY = "test-api-key";
    process.env.CLAWCONNECT_HERMES_STATE_DB = dbPath;

    const result = await runHermesChat(
      { sessionKey: "mobile-empty-final", message: "hello empty api" },
      { requestId: "run-empty-api", gatewayId: "gw-hermes", publishEvent: () => undefined },
    );

    assert.equal(result.output, "state-db api reply");
    assert.equal(result.sessionKey, "mobile-empty-final");
    assert.equal(result.usage?.hermesSessionId, hermesSessionId);
    assert.equal(existsSync(cliCalledPath), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    restoreEnv("CLAWCONNECT_HERMES_API_URL", previousApiUrl);
    restoreEnv("CLAWCONNECT_HERMES_API_KEY", previousApiKey);
    restoreEnv("CLAWCONNECT_HERMES_STATE_DB", previousStateDb);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChat forwards Hermes preloaded skill prompt to the API server", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-api-skills-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  const previousPython = process.env.HERMES_PYTHON;
  const previousApiUrl = process.env.CLAWCONNECT_HERMES_API_URL;
  const previousApiKey = process.env.CLAWCONNECT_HERMES_API_KEY;
  const previousStateDb = process.env.CLAWCONNECT_HERMES_STATE_DB;
  const cliCalledPath = join(root, "cli-called");
  const apiBodies: unknown[] = [];
  const hermesSessionId = "api_session_with_skill_0701";
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.method === "GET" && req.url === "/v1/toolsets") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          object: "list",
          platform: "api_server",
          data: [
            { name: "terminal", enabled: true, tools: ["terminal"] },
          ],
        }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/sessions") {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ session: { id: hermesSessionId, title: "mobile-main" } }));
        return;
      }
      if (req.method === "POST" && req.url === `/api/sessions/${hermesSessionId}/chat/stream`) {
        const parsed = JSON.parse(body) as { message?: string; instructions?: string };
        apiBodies.push(parsed);
        assert.match(parsed.message ?? "", /^send image file to phone with skill/);
        assert.match(parsed.instructions ?? "", /FILE_TRANSFER_PROMPT/);
        assert.match(parsed.instructions ?? "", /\[ClawConnect mobile bridge]/);
        assert.doesNotMatch(parsed.message ?? "", /\[ClawConnect mobile bridge]/);
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        res.write("event: assistant.completed\n");
        res.write(`data: ${JSON.stringify({ session_id: hermesSessionId, content: "skill api reply" })}\n\n`);
        res.write("event: run.completed\n");
        res.write(`data: ${JSON.stringify({ session_id: hermesSessionId, usage: { input_tokens: 4 } })}\n\n`);
        res.end();
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });

  try {
    const storePath = join(root, "sessions.json");
    const binPath = join(root, "hermes-skills-list");
    writeFileSync(binPath, [
      "#!/bin/sh",
      "if [ \"$1\" = \"skills\" ] && [ \"$2\" = \"list\" ]; then",
      "  printf '%s\\n' '│ file-transfer │ productivity │ local │ local │ enabled │'",
      "  exit 0",
      "fi",
      "if [ \"$1\" = \"chat\" ]; then",
      `  printf '%s\\n' "$@" > '${cliCalledPath.replace(/'/g, "'\\''")}'`,
      "  exit 2",
      "fi",
      "exit 0",
      "",
    ].join("\n"), "utf8");
    chmodSync(binPath, 0o755);
    const pythonPath = join(root, "fake-python");
    writeFileSync(pythonPath, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"prompt\":\"FILE_TRANSFER_PROMPT\",\"loaded\":[\"file-transfer\"],\"missing\":[]}'",
      "",
    ].join("\n"), "utf8");
    chmodSync(pythonPath, 0o755);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;
    process.env.HERMES_PYTHON = pythonPath;
    process.env.CLAWCONNECT_HERMES_API_URL = `http://127.0.0.1:${address.port}`;
    process.env.CLAWCONNECT_HERMES_API_KEY = "test-api-key";
    process.env.CLAWCONNECT_HERMES_STATE_DB = join(root, "missing-state.db");

    const result = await runHermesChat(
      { sessionKey: "mobile-main", message: "send image file to phone with skill" },
      { requestId: "run-api-skill", gatewayId: "gw-hermes" },
    );

    assert.equal(result.output, "skill api reply");
    assert.equal(result.usage?.hermesSessionId, hermesSessionId);
    assert.equal(result.usage?.contextUsage, 4);
    assert.equal(apiBodies.length, 1);
    assert.equal(existsSync(cliCalledPath), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    restoreEnv("HERMES_PYTHON", previousPython);
    restoreEnv("CLAWCONNECT_HERMES_API_URL", previousApiUrl);
    restoreEnv("CLAWCONNECT_HERMES_API_KEY", previousApiKey);
    restoreEnv("CLAWCONNECT_HERMES_STATE_DB", previousStateDb);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChat uses the CLI path for preloaded file-transfer mobile sends when the API server is configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-file-transfer-cli-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  const previousPython = process.env.HERMES_PYTHON;
  const previousApiUrl = process.env.CLAWCONNECT_HERMES_API_URL;
  const previousApiKey = process.env.CLAWCONNECT_HERMES_API_KEY;
  const previousStateDb = process.env.CLAWCONNECT_HERMES_STATE_DB;
  const chatArgsPath = join(root, "chat-args.json");
  const chatQueryPath = join(root, "chat-query.txt");
  const apiChatCalls: string[] = [];
  const hermesSessionId = "api_session_file_transfer_0701";
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/sessions") {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ session: { id: hermesSessionId, title: "main" } }));
        return;
      }
      if (req.method === "POST" && req.url === `/api/sessions/${hermesSessionId}/chat/stream`) {
        apiChatCalls.push(req.url);
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        res.write("event: assistant.completed\n");
        res.write(`data: ${JSON.stringify({ session_id: hermesSessionId, content: "当前这轮没有可用的直接终端/命令工具" })}\n\n`);
        res.write("event: run.completed\n");
        res.write(`data: ${JSON.stringify({ session_id: hermesSessionId })}\n\n`);
        res.end();
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });

  try {
    const storePath = join(root, "sessions.json");
    const binPath = join(root, "hermes-file-transfer-cli");
    writeFileSync(binPath, [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'skills' && args[1] === 'list') {",
      "  console.log('│ file-transfer │ productivity │ local │ local │ enabled │');",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'sessions' && args[1] === 'list') {",
      "  console.log('Title                            Preview          Last Active   ID');",
      "  console.log('File transfer                    发送完成           just now      20260706_093100_filetx');",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'sessions' && args[1] === 'export') {",
      "  console.log(JSON.stringify({ sessionId: '20260706_093100_filetx', messages: [] }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'status') { process.exit(0); }",
      "if (args[0] === 'chat') {",
      `  fs.writeFileSync(${JSON.stringify(chatArgsPath)}, JSON.stringify(args));`,
      "  const query = args[args.indexOf('--query') + 1] || '';",
      `  fs.writeFileSync(${JSON.stringify(chatQueryPath)}, query);`,
      "  console.log('发送完成');",
      "  process.exit(0);",
      "}",
      "process.exit(2);",
      "",
    ].join("\n"), "utf8");
    chmodSync(binPath, 0o755);
    const pythonPath = join(root, "fake-python");
    writeFileSync(pythonPath, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"prompt\":\"FILE_TRANSFER_PROMPT\",\"loaded\":[\"file-transfer\"],\"missing\":[]}'",
      "",
    ].join("\n"), "utf8");
    chmodSync(pythonPath, 0o755);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;
    process.env.HERMES_PYTHON = pythonPath;
    process.env.CLAWCONNECT_HERMES_API_URL = `http://127.0.0.1:${address.port}`;
    process.env.CLAWCONNECT_HERMES_API_KEY = "test-api-key";
    process.env.CLAWCONNECT_HERMES_STATE_DB = join(root, "missing-state.db");

    const result = await runHermesChat(
      { sessionKey: "main", message: "把桌面的微信图片发过来" },
      { requestId: "run-file-transfer-cli", gatewayId: "gw-hermes" },
    );

    assert.equal(result.output, "发送完成");
    assert.deepEqual(apiChatCalls, []);
    const args = JSON.parse(readFileSync(chatArgsPath, "utf8")) as string[];
    assert.equal(args.includes("--skills"), true);
    assert.equal(args.includes("file-transfer"), true);
    assert.equal(args.includes("--yolo"), true);
    assert.match(readFileSync(chatQueryPath, "utf8"), /\[ClawConnect mobile turn\]/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    restoreEnv("HERMES_PYTHON", previousPython);
    restoreEnv("CLAWCONNECT_HERMES_API_URL", previousApiUrl);
    restoreEnv("CLAWCONNECT_HERMES_API_KEY", previousApiKey);
    restoreEnv("CLAWCONNECT_HERMES_STATE_DB", previousStateDb);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChat keeps explicit file-transfer mobile sends off the API path when skills list is unavailable", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-file-transfer-skills-list-failed-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  const previousPython = process.env.HERMES_PYTHON;
  const previousApiUrl = process.env.CLAWCONNECT_HERMES_API_URL;
  const previousApiKey = process.env.CLAWCONNECT_HERMES_API_KEY;
  const previousStateDb = process.env.CLAWCONNECT_HERMES_STATE_DB;
  const chatArgsPath = join(root, "chat-args.json");
  const apiChatCalls: string[] = [];
  const hermesSessionId = "api_session_file_transfer_skills_failed";
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.method === "GET" && req.url === "/v1/toolsets") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          data: [
            { name: "terminal", enabled: false },
            { name: "file", enabled: true },
          ],
        }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/sessions") {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ session: { id: hermesSessionId, title: "main" } }));
        return;
      }
      if (req.method === "POST" && req.url === `/api/sessions/${hermesSessionId}/chat/stream`) {
        apiChatCalls.push(req.url);
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        res.write("event: assistant.completed\n");
        res.write(`data: ${JSON.stringify({ session_id: hermesSessionId, content: "当前这轮没有可用的直接终端/命令工具" })}\n\n`);
        res.write("event: run.completed\n");
        res.write(`data: ${JSON.stringify({ session_id: hermesSessionId })}\n\n`);
        res.end();
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });

  try {
    const storePath = join(root, "sessions.json");
    const binPath = join(root, "hermes-file-transfer-cli");
    writeFileSync(binPath, [
      "#!/usr/bin/env node",
      "const fs = require('fs');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'skills' && args[1] === 'list') {",
      "  process.exit(2);",
      "}",
      "if (args[0] === 'sessions' && args[1] === 'list') {",
      "  console.log('Title                            Preview          Last Active   ID');",
      "  console.log('File transfer                    发送完成           just now      20260706_093100_filetx');",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'sessions' && args[1] === 'export') {",
      "  console.log(JSON.stringify({ sessionId: '20260706_093100_filetx', messages: [] }));",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'status') { process.exit(0); }",
      "if (args[0] === 'chat') {",
      `  fs.writeFileSync(${JSON.stringify(chatArgsPath)}, JSON.stringify(args));`,
      "  console.log('发送完成');",
      "  process.exit(0);",
      "}",
      "process.exit(2);",
      "",
    ].join("\n"), "utf8");
    chmodSync(binPath, 0o755);
    const pythonPath = join(root, "fake-python");
    writeFileSync(pythonPath, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"prompt\":\"FILE_TRANSFER_PROMPT\",\"loaded\":[\"file-transfer\"],\"missing\":[]}'",
      "",
    ].join("\n"), "utf8");
    chmodSync(pythonPath, 0o755);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;
    process.env.HERMES_PYTHON = pythonPath;
    process.env.CLAWCONNECT_HERMES_API_URL = `http://127.0.0.1:${address.port}`;
    process.env.CLAWCONNECT_HERMES_API_KEY = "test-api-key";
    process.env.CLAWCONNECT_HERMES_STATE_DB = join(root, "missing-state.db");

    const result = await runHermesChat(
      { sessionKey: "main", message: "把桌面的蜘蛛侠图片发过来" },
      { requestId: "run-file-transfer-skills-failed", gatewayId: "gw-hermes" },
    );

    assert.equal(result.output, "发送完成");
    assert.deepEqual(apiChatCalls, []);
    const args = JSON.parse(readFileSync(chatArgsPath, "utf8")) as string[];
    assert.equal(args.includes("--skills"), true);
    assert.equal(args.includes("file-transfer"), true);
    assert.equal(args.includes("--yolo"), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    restoreEnv("HERMES_PYTHON", previousPython);
    restoreEnv("CLAWCONNECT_HERMES_API_URL", previousApiUrl);
    restoreEnv("CLAWCONNECT_HERMES_API_KEY", previousApiKey);
    restoreEnv("CLAWCONNECT_HERMES_STATE_DB", previousStateDb);
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

    await waitForFile(join(root, "partial-started"), 1000);
    await waitForHermesDelta(publishedEvents, "partial", 1000);
    const result = await chatPromise;

    assert.match(result.output, /partial reply/);
    assert.deepEqual(assistantTimelineDeltaTexts(publishedEvents), ["partial ", "partial reply\n"]);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});

function assistantTimelineDeltaTexts(events: unknown[]): string[] {
  const texts: string[] = [];
  for (const event of events) {
    if (!isRecord(event) || event.type !== "event" || event.event !== "chat" || !isRecord(event.payload)) {
      continue;
    }
    const timelineEvents = Array.isArray(event.payload.timelineEvents) ? event.payload.timelineEvents : [];
    for (const timelineEvent of timelineEvents) {
      if (!isRecord(timelineEvent) || timelineEvent.eventType !== "message.part.delta" || timelineEvent.role !== "assistant") {
        continue;
      }
      const content = Array.isArray(timelineEvent.content) ? timelineEvent.content : [];
      texts.push(content.map((block) => isRecord(block) && typeof block.text === "string" ? block.text : "").join(""));
    }
  }
  return texts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

test("runHermesChat resolves from Hermes state DB without invoking sessions export when the CLI keeps running", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-state-db-completion-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  const previousStateDb = process.env.CLAWCONNECT_HERMES_STATE_DB;
  try {
    const storePath = join(root, "sessions.json");
    const dbPath = writeHermesStateDb(root);
    const hermesBin = writeStateDbHistoryCompletingHermesBin(root);
    const publishedEvents: unknown[] = [];
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.CLAWCONNECT_HERMES_STATE_DB = dbPath;
    process.env.HERMES_BIN = hermesBin.binPath;

    const result = await runHermesChat(
      { sessionKey: "main", message: "Hi" },
      { requestId: "run-state-db-complete", publishEvent: (event) => publishedEvents.push(event) },
    );

    assert.equal(result.output, "direct-db reply");
    assert.equal(existsSync(hermesBin.exportCalledPath), false);
    assert.equal(JSON.stringify(publishedEvents).includes("direct-db reply"), false);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("CLAWCONNECT_HERMES_STATE_DB", previousStateDb);
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
