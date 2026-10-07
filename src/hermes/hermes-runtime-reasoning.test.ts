import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleHermesCommand, runHermesChat } from "./hermes-runtime.js";
import {
  buildHermesApiReasoningBody,
  buildHermesCliReasoningArgs,
  hermesReasoningEffortForLevel,
  thinkingLevelFromHermesReasoningConfig,
} from "./runtime/hermes-runtime-reasoning.js";
import { restoreEnv, writeFakeHermesBin } from "./hermes-runtime-test-support.js";

const CHAT_ENV_NAMES = [
  "HERMES_HOME",
  "HERMES_BIN",
  "CLAWCONNECT_HERMES_REASONING_STORE",
  "CLAWCONNECT_HERMES_SESSION_STORE",
  "CLAWCONNECT_HERMES_RUNTIME_MODE",
  "CLAWCONNECT_HERMES_API_URL",
  "CLAWCONNECT_HERMES_API_KEY",
  "CLAWCONNECT_HERMES_STATE_DB",
] as const;

async function withChatEnv(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "hermes-reasoning-chat-"));
  const previous = new Map(CHAT_ENV_NAMES.map((name) => [name, process.env[name]]));
  try {
    process.env.HERMES_HOME = join(root, "hermes-home");
    process.env.CLAWCONNECT_HERMES_REASONING_STORE = join(root, "reasoning-efforts.json");
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = join(root, "sessions.json");
    process.env.CLAWCONNECT_HERMES_STATE_DB = join(root, "missing-state.db");
    process.env.CLAWCONNECT_HERMES_RUNTIME_MODE = "local";
    delete process.env.CLAWCONNECT_HERMES_API_URL;
    delete process.env.CLAWCONNECT_HERMES_API_KEY;
    await run(root);
  } finally {
    for (const [name, value] of previous) {
      restoreEnv(name, value);
    }
    rmSync(root, { recursive: true, force: true });
  }
}

async function setThinking(sessionKey: string, level: string | null, gatewayId = "gw-hermes"): Promise<void> {
  const result = await handleHermesCommand("hermes.thinking.set", { sessionKey, level }, { gatewayId });
  assert.equal(result?.ok, true);
}

function cliArgs(binPath: string): string[] {
  return readFileSync(`${binPath}.args`, "utf8").split("\n").filter(Boolean);
}

test("Hermes reasoning mapping converts off to none and mirrors Hermes config parsing", () => {
  assert.equal(hermesReasoningEffortForLevel("off"), "none");
  assert.equal(hermesReasoningEffortForLevel("xhigh"), "xhigh");
  assert.equal(thinkingLevelFromHermesReasoningConfig(" None "), "off");
  assert.equal(thinkingLevelFromHermesReasoningConfig("ULTRA"), "ultra");
  assert.equal(thinkingLevelFromHermesReasoningConfig(undefined), "medium");
  assert.deepEqual(buildHermesApiReasoningBody(undefined), {});
  assert.deepEqual(buildHermesApiReasoningBody("none"), { model_options: { reasoning_effort: "none" } });
  assert.deepEqual(buildHermesCliReasoningArgs(undefined), []);
  assert.deepEqual(buildHermesCliReasoningArgs("high"), ["--reasoning", "high"]);
});

test("Hermes CLI chat passes --reasoning only for sessions with an explicit override", async () => {
  await withChatEnv(async (root) => {
    const binPath = writeFakeHermesBin(root);
    process.env.HERMES_BIN = binPath;

    await runHermesChat({ sessionKey: "mobile-a", message: "first" }, { gatewayId: "gw-hermes" });
    assert.equal(cliArgs(binPath).includes("--reasoning"), false);

    await setThinking("mobile-a", "off");
    await runHermesChat({ sessionKey: "mobile-a", message: "second" }, { gatewayId: "gw-hermes" });
    const overridden = cliArgs(binPath);
    assert.equal(overridden[overridden.indexOf("--reasoning") + 1], "none");

    // 另一个会话、另一个网关作用域都不能继承该覆盖。
    await runHermesChat({ sessionKey: "mobile-b", message: "third" }, { gatewayId: "gw-hermes" });
    assert.equal(cliArgs(binPath).includes("--reasoning"), false);
    await runHermesChat({ sessionKey: "mobile-a", message: "fourth" }, { gatewayId: "gw-other" });
    assert.equal(cliArgs(binPath).includes("--reasoning"), false);

    await setThinking("mobile-a", null);
    await runHermesChat({ sessionKey: "mobile-a", message: "fifth" }, { gatewayId: "gw-hermes" });
    assert.equal(cliArgs(binPath).includes("--reasoning"), false);
  });
});

test("Hermes API chat sends model_options.reasoning_effort only for sessions with an explicit override", async () => {
  const streamBodies: Array<Record<string, unknown>> = [];
  const hermesSessionId = "api_session_reasoning";
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
      if (req.method === "GET" && req.url === "/api/model/options") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unavailable" }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/sessions") {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ session: { id: hermesSessionId } }));
        return;
      }
      if (req.method === "POST" && req.url === `/api/sessions/${hermesSessionId}/chat/stream`) {
        streamBodies.push(JSON.parse(body) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: assistant.completed\n");
        res.write(`data: ${JSON.stringify({ session_id: hermesSessionId, content: "api reply" })}\n\n`);
        res.write("event: run.completed\n");
        res.write(`data: ${JSON.stringify({ session_id: hermesSessionId })}\n\n`);
        res.write("event: done\ndata: {}\n\n");
        res.end();
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await withChatEnv(async (root) => {
      const binPath = join(root, "hermes-status-only");
      writeFileSync(binPath, [
        "#!/bin/sh",
        "if [ \"$1\" = \"status\" ]; then echo '  Model:        gpt-5.5'; exit 0; fi",
        "if [ \"$1\" = \"skills\" ]; then exit 0; fi",
        "exit 2",
        "",
      ].join("\n"), "utf8");
      chmodSync(binPath, 0o755);
      const address = server.address() as AddressInfo;
      process.env.HERMES_BIN = binPath;
      process.env.CLAWCONNECT_HERMES_RUNTIME_MODE = "api";
      process.env.CLAWCONNECT_HERMES_API_URL = `http://127.0.0.1:${address.port}`;
      process.env.CLAWCONNECT_HERMES_API_KEY = "test-api-key";

      const first = await runHermesChat({ sessionKey: "mobile-a", message: "first" }, { gatewayId: "gw-hermes" });
      assert.equal(first.output, "api reply");
      await setThinking("mobile-a", "xhigh");
      await runHermesChat({ sessionKey: "mobile-a", message: "second" }, { gatewayId: "gw-hermes" });
      await setThinking("mobile-a", "off");
      await runHermesChat({ sessionKey: "mobile-a", message: "third" }, { gatewayId: "gw-hermes" });

      assert.deepEqual(streamBodies.map((body) => body.model_options), [
        undefined,
        { reasoning_effort: "xhigh" },
        { reasoning_effort: "none" },
      ]);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
