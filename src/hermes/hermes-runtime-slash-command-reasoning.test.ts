import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleHermesCommand, runHermesChat } from "./hermes-runtime.js";
import { restoreEnv, writeFakeHermesBin } from "./hermes-runtime-test-support.js";

/**
 * 斜杠命令排队对话的思考等级覆盖测试。
 *
 * Hermes 斜杠命令（如 /queue）可能在 CLI 的 _pending_input 中留下待执行输入，
 * ClawConnect 随后以同一移动会话发起一轮对话；这一轮必须与普通对话一样，
 * 按调用方 gatewayId + sessionKey 解析会话级覆盖，没有覆盖时不附加任何参数。
 */

const ENV_NAMES = [
  "HERMES_HOME",
  "HERMES_BIN",
  "HERMES_PYTHON",
  "CLAWCONNECT_HERMES_REASONING_STORE",
  "CLAWCONNECT_HERMES_SESSION_STORE",
  "CLAWCONNECT_HERMES_RUNTIME_MODE",
  "CLAWCONNECT_HERMES_API_URL",
  "CLAWCONNECT_HERMES_API_KEY",
  "CLAWCONNECT_HERMES_STATE_DB",
] as const;
const QUEUED_MESSAGE = "queued follow-up";
const SLASH_MESSAGE = `/queue ${QUEUED_MESSAGE}`;
const GATEWAY_ID = "gw-hermes";
const SESSION_KEY = "mobile-a";
const TEST_TIMEOUT_MS = 20_000;

async function withSlashCommandEnv(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "hermes-slash-reasoning-"));
  const previous = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
  try {
    process.env.HERMES_HOME = join(root, "hermes-home");
    process.env.HERMES_PYTHON = writeFakeSlashCommandPython(root);
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

/** 模拟 Hermes 斜杠命令脚本：命令执行成功，并在待执行队列中留下一条输入。 */
function writeFakeSlashCommandPython(root: string): string {
  const pythonPath = join(root, "fake-python");
  const payload = JSON.stringify({
    ok: true,
    output: "Queued for the next turn.",
    sessionId: null,
    keepGoing: true,
    pendingInputs: [QUEUED_MESSAGE],
  });
  writeFileSync(pythonPath, ["#!/bin/sh", `printf '%s' '${payload}'`, ""].join("\n"), "utf8");
  chmodSync(pythonPath, 0o755);
  return pythonPath;
}

async function setThinking(level: string | null, gatewayId = GATEWAY_ID): Promise<void> {
  const result = await handleHermesCommand("hermes.thinking.set", { sessionKey: SESSION_KEY, level }, { gatewayId });
  assert.equal(result?.ok, true);
}

function cliArgs(binPath: string): string[] {
  return readFileSync(`${binPath}.args`, "utf8").split("\n").filter(Boolean);
}

function cliReasoning(binPath: string): string | undefined {
  const args = cliArgs(binPath);
  const index = args.indexOf("--reasoning");
  return index >= 0 ? args[index + 1] : undefined;
}

test("Hermes slash-command queued chat passes the session --reasoning override in CLI mode", { timeout: TEST_TIMEOUT_MS }, async () => {
  await withSlashCommandEnv(async (root) => {
    const binPath = writeFakeHermesBin(root);
    process.env.HERMES_BIN = binPath;

    const withoutOverride = await runHermesChat({ sessionKey: SESSION_KEY, message: SLASH_MESSAGE }, { gatewayId: GATEWAY_ID });
    assert.equal(withoutOverride.output, "Queued for the next turn.\n\nfresh reply");
    assert.ok(cliArgs(binPath).some((arg) => arg.includes(QUEUED_MESSAGE)));
    assert.equal(cliReasoning(binPath), undefined);

    await setThinking("high");
    await runHermesChat({ sessionKey: SESSION_KEY, message: SLASH_MESSAGE }, { gatewayId: GATEWAY_ID });
    assert.equal(cliReasoning(binPath), "high");

    // 覆盖只属于 gw-hermes 作用域，其他网关发起的同名会话斜杠命令不能继承。
    await runHermesChat({ sessionKey: SESSION_KEY, message: SLASH_MESSAGE }, { gatewayId: "gw-other" });
    assert.equal(cliReasoning(binPath), undefined);
  });
});

test("Hermes slash-command queued chat sends model_options.reasoning_effort only with a session override in API mode", { timeout: TEST_TIMEOUT_MS }, async () => {
  const streamBodies: Array<Record<string, unknown>> = [];
  const server = startHermesApiStub(streamBodies);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await withSlashCommandEnv(async (root) => {
      process.env.HERMES_BIN = writeStatusOnlyHermesBin(root);
      process.env.CLAWCONNECT_HERMES_RUNTIME_MODE = "api";
      process.env.CLAWCONNECT_HERMES_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      process.env.CLAWCONNECT_HERMES_API_KEY = "test-api-key";

      const withoutOverride = await runHermesChat({ sessionKey: SESSION_KEY, message: SLASH_MESSAGE }, { gatewayId: GATEWAY_ID });
      assert.equal(withoutOverride.output, "Queued for the next turn.\n\napi reply");
      await setThinking("off");
      await runHermesChat({ sessionKey: SESSION_KEY, message: SLASH_MESSAGE }, { gatewayId: GATEWAY_ID });

      assert.equal(streamBodies.length, 2);
      assert.ok(streamBodies.every((body) => String(body.message ?? "").includes(QUEUED_MESSAGE)));
      assert.deepEqual(streamBodies.map((body) => body.model_options), [
        undefined,
        { reasoning_effort: "none" },
      ]);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const API_SESSION_ID = "api_session_slash_reasoning";

function startHermesApiStub(streamBodies: Array<Record<string, unknown>>): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/health") {
        writeJson(res, 200, { status: "ok" });
        return;
      }
      if (req.method === "POST" && req.url === "/api/sessions") {
        writeJson(res, 201, { session: { id: API_SESSION_ID } });
        return;
      }
      if (req.method === "POST" && req.url === `/api/sessions/${API_SESSION_ID}/chat/stream`) {
        streamBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: assistant.completed\n");
        res.write(`data: ${JSON.stringify({ session_id: API_SESSION_ID, content: "api reply" })}\n\n`);
        res.write("event: run.completed\n");
        res.write(`data: ${JSON.stringify({ session_id: API_SESSION_ID })}\n\n`);
        res.write("event: done\ndata: {}\n\n");
        res.end();
        return;
      }
      writeJson(res, 404, { error: "not_found" });
    });
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function writeStatusOnlyHermesBin(root: string): string {
  const binPath = join(root, "hermes-status-only");
  writeFileSync(binPath, [
    "#!/bin/sh",
    "if [ \"$1\" = \"status\" ]; then echo '  Model:        gpt-5.5'; exit 0; fi",
    "if [ \"$1\" = \"skills\" ]; then exit 0; fi",
    "exit 2",
    "",
  ].join("\n"), "utf8");
  chmodSync(binPath, 0o755);
  return binPath;
}
