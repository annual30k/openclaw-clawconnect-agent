import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
