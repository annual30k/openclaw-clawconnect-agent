import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleHermesCommand } from "./hermes-runtime.js";
import { rememberHermesSession } from "./hermes-session-store.js";
import { readHermesSessionReasoningLevel } from "./hermes-session-reasoning-store.js";
import { parseHermesModelReasoningSupport } from "./runtime/hermes-runtime-thinking.js";
import { restoreEnv } from "./hermes-runtime-test-support.js";

const THINKING_ENV_NAMES = [
  "HERMES_HOME",
  "HERMES_BIN",
  "CLAWCONNECT_HERMES_REASONING_STORE",
  "CLAWCONNECT_HERMES_SESSION_STORE",
  "CLAWCONNECT_HERMES_RUNTIME_MODE",
  "CLAWCONNECT_HERMES_API_URL",
  "CLAWCONNECT_HERMES_API_KEY",
] as const;

const HERMES_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 为每个用例隔离 Hermes home、两个本地存储与运行模式，结束后恢复环境变量并删除临时目录。 */
async function withThinkingEnv(
  options: { configYaml?: string },
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "hermes-thinking-"));
  const previous = new Map(THINKING_ENV_NAMES.map((name) => [name, process.env[name]]));
  try {
    const hermesHome = join(root, "hermes-home");
    if (options.configYaml !== undefined) {
      writeHermesConfig(hermesHome, options.configYaml);
    }
    process.env.HERMES_HOME = hermesHome;
    process.env.HERMES_BIN = writeSessionDeleteHermesBin(root);
    process.env.CLAWCONNECT_HERMES_REASONING_STORE = join(root, "reasoning-efforts.json");
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = join(root, "sessions.json");
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

function writeHermesConfig(hermesHome: string, content: string): void {
  mkdirSync(hermesHome, { recursive: true });
  writeFileSync(join(hermesHome, "config.yaml"), content, "utf8");
}

function writeSessionDeleteHermesBin(root: string): string {
  const binPath = join(root, "hermes");
  writeFileSync(binPath, [
    "#!/bin/sh",
    "printf '%s\\n' \"$@\" >> \"$0.calls\"",
    "if [ \"$1\" = \"sessions\" ] && [ \"$2\" = \"delete\" ]; then echo 'deleted'; exit 0; fi",
    "echo \"unexpected args: $@\" >&2",
    "exit 2",
    "",
  ].join("\n"), "utf8");
  chmodSync(binPath, 0o755);
  return binPath;
}

async function command(method: string, params: unknown, gatewayId = "gw-hermes") {
  const result = await handleHermesCommand(method, params, { gatewayId });
  assert.ok(result, `${method} must be routed`);
  return result;
}

test("hermes.thinking.get follows agent.reasoning_effort and ignores same-named keys in other blocks", async () => {
  await withThinkingEnv({
    configYaml: [
      "agent:",
      "  verbose: false",
      "  reasoning_effort: high # per-agent default",
      "delegation:",
      "  reasoning_effort: ''",
      "",
    ].join("\n"),
  }, async () => {
    const result = await command("hermes.thinking.get", { sessionKey: "mobile-a" });
    assert.deepEqual(result, {
      ok: true,
      payload: {
        sessionKey: "mobile-a",
        supported: true,
        level: null,
        defaultLevel: "high",
        effectiveLevel: "high",
        levels: HERMES_LEVELS,
      },
    });
  });
});

test("hermes.thinking.get maps disabled config values to off and defaults missing config to medium", async () => {
  for (const [value, expected] of [["none", "off"], ["false", "off"], ["disabled", "off"], ["''", "medium"], ["bogus", "medium"]]) {
    await withThinkingEnv({ configYaml: `agent:\n  reasoning_effort: ${value}\n` }, async () => {
      const result = await command("hermes.thinking.get", { sessionKey: "mobile-a" });
      assert.equal((result as { payload: { defaultLevel: string } }).payload.defaultLevel, expected, value);
    });
  }
  await withThinkingEnv({}, async () => {
    const result = await command("hermes.thinking.get", { sessionKey: "mobile-a" });
    assert.equal((result as { payload: { defaultLevel: string } }).payload.defaultLevel, "medium");
  });
});

test("hermes.thinking.set stores a per-gateway session override and null clears it", async () => {
  await withThinkingEnv({ configYaml: "agent:\n  reasoning_effort: medium\n" }, async (root) => {
    const setResult = await command("hermes.thinking.set", { sessionKey: "mobile-a", level: "off" });
    assert.deepEqual(setResult, {
      ok: true,
      payload: {
        sessionKey: "mobile-a",
        supported: true,
        level: "off",
        defaultLevel: "medium",
        effectiveLevel: "off",
        levels: HERMES_LEVELS,
      },
    });
    // 覆盖只写入 ClawConnect 存储，并按 gatewayId 隔离；Hermes config.yaml 保持不变。
    assert.equal(readFileSync(join(root, "hermes-home", "config.yaml"), "utf8"), "agent:\n  reasoning_effort: medium\n");
    assert.equal(await readHermesSessionReasoningLevel("gw-hermes", "mobile-a"), "off");
    assert.equal(await readHermesSessionReasoningLevel("gw-other", "mobile-a"), undefined);
    assert.equal(await readHermesSessionReasoningLevel("gw-hermes", "mobile-b"), undefined);

    const cleared = await command("hermes.thinking.set", { sessionKey: "mobile-a", level: null });
    assert.equal((cleared as { payload: { level: unknown } }).payload.level, null);
    assert.equal((cleared as { payload: { effectiveLevel: unknown } }).payload.effectiveLevel, "medium");
    assert.equal(await readHermesSessionReasoningLevel("gw-hermes", "mobile-a"), undefined);
  });
});

test("hermes.thinking.set rejects levels outside the Hermes ladder and invalid params", async () => {
  await withThinkingEnv({}, async () => {
    assert.deepEqual(
      await command("hermes.thinking.set", { sessionKey: "mobile-a", level: "ultra" }),
      { ok: false, error: "thinking_level_not_supported:ultra" },
    );
    assert.deepEqual(
      await command("hermes.thinking.set", { sessionKey: "mobile-a", level: "adaptive" }),
      { ok: false, error: "thinking_level_not_supported:adaptive" },
    );
    assert.deepEqual(await command("hermes.thinking.get", {}), { ok: false, error: "session_key_required" });
    assert.deepEqual(
      await command("hermes.thinking.set", { sessionKey: "mobile-a" }),
      { ok: false, error: "thinking_level_required" },
    );
    assert.equal(await readHermesSessionReasoningLevel("gw-hermes", "mobile-a"), undefined);
  });
});

test("Hermes session delete forgets reasoning overrides for every alias of the deleted session", async () => {
  await withThinkingEnv({}, async () => {
    const hermesSessionId = "20261007_120000_abcd12";
    await rememberHermesSession("mobile-a", {
      sessionKey: "mobile-a",
      hermesSessionId,
      kind: "hermes",
    });
    await command("hermes.thinking.set", { sessionKey: "mobile-a", level: "high" });
    await command("hermes.thinking.set", { sessionKey: `hermes:${hermesSessionId}`, level: "low" });
    await command("hermes.thinking.set", { sessionKey: "mobile-b", level: "max" });

    const deleted = await command("hermes.sessions.delete", { sessionId: hermesSessionId });

    assert.equal(deleted.ok, true);
    assert.equal(await readHermesSessionReasoningLevel("gw-hermes", "mobile-a"), undefined);
    assert.equal(await readHermesSessionReasoningLevel("gw-hermes", `hermes:${hermesSessionId}`), undefined);
    assert.equal(await readHermesSessionReasoningLevel("gw-hermes", "mobile-b"), "max");
  });
});

test("Hermes model reasoning capability is read from the exact provider and model", () => {
  const payload = {
    provider: "openrouter",
    model: "vendor/plain-model",
    providers: [
      { slug: "openrouter-legacy", capabilities: { "vendor/plain-model": { reasoning: true } } },
      { slug: "openrouter", capabilities: { "vendor/plain-model": { reasoning: false, fast: false } } },
    ],
  };
  assert.equal(parseHermesModelReasoningSupport(payload), false);
  assert.equal(parseHermesModelReasoningSupport({ ...payload, model: "vendor/other" }), undefined);
  assert.equal(parseHermesModelReasoningSupport({ ...payload, provider: "missing" }), undefined);
  assert.equal(parseHermesModelReasoningSupport({ provider: "openrouter" }), undefined);
  assert.equal(parseHermesModelReasoningSupport({
    ...payload,
    providers: [{ slug: "openrouter", capabilities: { "vendor/plain-model": { reasoning: true } } }],
  }), true);
});

test("hermes.thinking.get probes the API model options and reports unsupported models without levels", async () => {
  const requests: Array<{ url: string; authorization: string | undefined }> = [];
  let reasoning: unknown = false;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push({ url: req.url ?? "", authorization: req.headers.authorization });
    if (req.method === "GET" && req.url === "/api/model/options") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        provider: "custom",
        model: "plain-model",
        providers: [{ slug: "custom", capabilities: { "plain-model": { reasoning, fast: false } } }],
      }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await withThinkingEnv({}, async () => {
      const address = server.address() as AddressInfo;
      process.env.CLAWCONNECT_HERMES_RUNTIME_MODE = "api";
      process.env.CLAWCONNECT_HERMES_API_URL = `http://127.0.0.1:${address.port}`;
      process.env.CLAWCONNECT_HERMES_API_KEY = "test-api-key";

      const unsupported = await command("hermes.thinking.get", { sessionKey: "mobile-a" });
      assert.equal((unsupported as { payload: { supported: boolean } }).payload.supported, false);
      assert.deepEqual((unsupported as { payload: { levels: string[] } }).payload.levels, []);
      assert.deepEqual(
        await command("hermes.thinking.set", { sessionKey: "mobile-a", level: "high" }),
        { ok: false, error: "thinking_level_not_supported:high" },
      );

      reasoning = "unknown";
      const unknown = await command("hermes.thinking.get", { sessionKey: "mobile-a" });
      assert.equal((unknown as { payload: { supported: boolean } }).payload.supported, true);
      assert.deepEqual((unknown as { payload: { levels: string[] } }).payload.levels, HERMES_LEVELS);
      assert.equal(requests[0]?.authorization, "Bearer test-api-key");
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("hermes.thinking.get treats an unreachable API server as supported", async () => {
  await withThinkingEnv({}, async () => {
    process.env.CLAWCONNECT_HERMES_RUNTIME_MODE = "api";
    process.env.CLAWCONNECT_HERMES_API_URL = "http://127.0.0.1:1";
    process.env.CLAWCONNECT_HERMES_API_KEY = "test-api-key";
    const result = await command("hermes.thinking.get", { sessionKey: "mobile-a" });
    assert.equal((result as { payload: { supported: boolean } }).payload.supported, true);
  });
});
