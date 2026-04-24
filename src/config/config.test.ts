import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("writeConfig stores secrets in a user-only config file", async () => {
  const tempHome = await mkdtemp(join(tmpdir(), "clawconnect-config-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tempHome;

  try {
    const { writeConfig } = await import(`./config.js?home=${encodeURIComponent(tempHome)}`);
    writeConfig({
      relayServerUrl: "http://relay.example",
      gatewayId: "gw_1",
      relaySecret: "secret",
      displayName: "Test Gateway",
      gatewayToken: "gateway-token",
    });

    const configPath = join(tempHome, ".clawconnect", "config.json");
    const fileStat = await stat(configPath);
    assert.equal(fileStat.mode & 0o777, 0o600);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(tempHome, { recursive: true, force: true });
  }
});
