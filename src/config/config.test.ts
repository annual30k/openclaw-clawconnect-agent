import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("writeConfig stores secrets in user-only default and profile config files", async () => {
  const tempHome = await mkdtemp(join(tmpdir(), "clawconnect-config-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tempHome;

  try {
    const { getConfigPath, readConfig, writeConfig } = await import(`./config.js?home=${encodeURIComponent(tempHome)}`);
    writeConfig({
      relayServerUrl: "http://relay.example",
      gatewayId: "gw_1",
      relaySecret: "secret",
      displayName: "Test Gateway",
      gatewayToken: "gateway-token",
    });
    writeConfig({
      relayServerUrl: "http://relay.example",
      gatewayId: "gw_profile",
      relaySecret: "profile-secret",
      displayName: "Profile Gateway",
      gatewayType: "hermes",
    }, "Hermes Agent");

    const configPath = join(tempHome, ".clawconnect", "config.json");
    const profileConfigPath = join(tempHome, ".clawconnect", "profiles", "hermes-agent", "config.json");
    const fileStat = await stat(configPath);
    const profileFileStat = await stat(profileConfigPath);
    assert.equal(fileStat.mode & 0o777, 0o600);
    assert.equal(profileFileStat.mode & 0o777, 0o600);
    assert.equal(getConfigPath("Hermes Agent"), profileConfigPath);
    assert.equal(readConfig("Hermes Agent").gatewayId, "gw_profile");
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("gateway URL and auth follow custom OpenClaw JSON5 config and port overrides", async () => {
  const tempHome = await mkdtemp(join(tmpdir(), "clawconnect-openclaw-config-"));
  const stateDir = join(tempHome, "state");
  const configPath = join(stateDir, "custom-openclaw.json5");
  const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const originalGatewayPort = process.env.OPENCLAW_GATEWAY_PORT;
  const originalGatewayUrl = process.env.CLAWCONNECT_GATEWAY_URL;
  await mkdir(stateDir, { recursive: true });
  await writeFile(configPath, `{
    // OpenClaw uses JSON5 for its active configuration.
    gateway: {
      port: 19001,
      auth: { token: 'custom-token', },
    },
  }`, "utf8");
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  delete process.env.OPENCLAW_GATEWAY_PORT;
  delete process.env.CLAWCONNECT_GATEWAY_URL;

  try {
    const { readGatewayAuth, readGatewayUrl } = await import(`./config.js?custom=${Date.now()}`);
    assert.equal(readGatewayUrl(), "ws://localhost:19001");
    assert.deepEqual(readGatewayAuth({
      relayServerUrl: "https://relay.example",
      gatewayId: "gw_custom",
      relaySecret: "secret",
      displayName: "Custom OpenClaw",
    }), { token: "custom-token", password: undefined });

    process.env.OPENCLAW_GATEWAY_PORT = "19002";
    assert.equal(readGatewayUrl(), "ws://localhost:19002");
    process.env.CLAWCONNECT_GATEWAY_URL = "wss://127.0.0.1:19003";
    assert.equal(readGatewayUrl(), "wss://127.0.0.1:19003");
    delete process.env.CLAWCONNECT_GATEWAY_URL;
    delete process.env.OPENCLAW_GATEWAY_PORT;
    await writeFile(join(stateDir, ".env"), "OPENCLAW_GATEWAY_PORT=19004\n", "utf8");
    assert.equal(readGatewayUrl(), "ws://localhost:19004");
  } finally {
    restoreEnv("OPENCLAW_CONFIG_PATH", originalConfigPath);
    restoreEnv("OPENCLAW_STATE_DIR", originalStateDir);
    restoreEnv("OPENCLAW_GATEWAY_PORT", originalGatewayPort);
    restoreEnv("CLAWCONNECT_GATEWAY_URL", originalGatewayUrl);
    await rm(tempHome, { recursive: true, force: true });
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
