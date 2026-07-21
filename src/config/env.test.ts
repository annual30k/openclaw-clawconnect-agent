import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_ENV_TEMPLATE,
  ensureUserEnvFile,
  getConfiguredGatewayPort,
  getDefaultRelayServerUrl,
  loadAgentEnv,
  parseEnvFile,
} from "./env.js";

test("parseEnvFile handles comments, exports, and quotes", () => {
  assert.deepEqual(
    parseEnvFile(`
# ignored
CLAWCONNECT_RELAY_SERVER_URL=https://relay.example # inline comment
export CLAWCONNECT_GATEWAY_URL="ws://localhost:19000"
OPENCLAW_ASR_COMMAND='transcribe {file}'
`),
    {
      CLAWCONNECT_RELAY_SERVER_URL: "https://relay.example",
      CLAWCONNECT_GATEWAY_URL: "ws://localhost:19000",
      OPENCLAW_ASR_COMMAND: "transcribe {file}",
    }
  );
});

test("loadAgentEnv reads env files without overriding shell env", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "clawconnect-env-"));
  const envPath = join(tempDir, ".env");
  await writeFile(
    envPath,
    [
      "CLAWCONNECT_RELAY_SERVER_URL=https://file.example",
      "CLAWCONNECT_GATEWAY_URL=ws://localhost:19000",
    ].join("\n"),
    "utf-8"
  );

  const env: Record<string, string | undefined> = {
    CLAWCONNECT_RELAY_SERVER_URL: "https://shell.example",
  };

  try {
    const loaded = loadAgentEnv({ env, paths: [envPath] });
    assert.deepEqual(loaded, [envPath]);
    assert.equal(env.CLAWCONNECT_RELAY_SERVER_URL, "https://shell.example");
    assert.equal(env.CLAWCONNECT_GATEWAY_URL, "ws://localhost:19000");
    assert.equal(getDefaultRelayServerUrl(env), "https://shell.example");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("getConfiguredGatewayPort accepts only valid TCP ports", () => {
  assert.equal(getConfiguredGatewayPort({ OPENCLAW_GATEWAY_PORT: "19001" }), 19001);
  assert.equal(getConfiguredGatewayPort({ OPENCLAW_GATEWAY_PORT: "0" }), undefined);
  assert.equal(getConfiguredGatewayPort({ OPENCLAW_GATEWAY_PORT: "65536" }), undefined);
  assert.equal(getConfiguredGatewayPort({ OPENCLAW_GATEWAY_PORT: "abc" }), undefined);
});

test("ensureUserEnvFile creates the full commented env template without overwriting", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "clawconnect-user-env-"));
  const envPath = join(tempDir, ".clawconnect", ".env");

  try {
    assert.equal(ensureUserEnvFile(envPath), true);
    assert.equal(await readFile(envPath, "utf-8"), AGENT_ENV_TEMPLATE);
    assert.equal((await stat(envPath)).mode & 0o777, 0o600);
    assert.equal(ensureUserEnvFile(envPath), false);
    assert.equal(await readFile(envPath, "utf-8"), AGENT_ENV_TEMPLATE);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
