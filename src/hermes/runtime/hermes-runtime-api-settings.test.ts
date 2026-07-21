import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveHermesApiSettings } from "./hermes-runtime-api-settings.js";

test("Hermes API settings follow explicit URL, process port, and Hermes home .env precedence", () => {
  const hermesHome = mkdtempSync(join(tmpdir(), "clawconnect-hermes-api-settings-"));
  writeFileSync(join(hermesHome, ".env"), [
    "API_SERVER_HOST=0.0.0.0",
    "API_SERVER_PORT=9650",
    "API_SERVER_KEY=file-key",
  ].join("\n"));

  assert.deepEqual(resolveHermesApiSettings({ env: {}, hermesHome }), {
    baseUrl: "http://0.0.0.0:9650",
    apiKey: "file-key",
    configured: true,
  });
  assert.deepEqual(resolveHermesApiSettings({
    env: { API_SERVER_PORT: "9750", CLAWCONNECT_HERMES_API_KEY: "process-key" },
    hermesHome,
  }), {
    baseUrl: "http://0.0.0.0:9750",
    apiKey: "process-key",
    configured: true,
  });
  assert.deepEqual(resolveHermesApiSettings({
    env: { CLAWCONNECT_HERMES_API_URL: "http://[::1]:9850/" },
    hermesHome,
  }), {
    baseUrl: "http://[::1]:9850",
    apiKey: "file-key",
    configured: true,
  });

  rmSync(hermesHome, { recursive: true, force: true });
});

test("Hermes API settings validate ports and format IPv6 hosts", () => {
  assert.deepEqual(resolveHermesApiSettings({
    env: { API_SERVER_HOST: "::1", API_SERVER_PORT: "70000" },
    fileEnv: {},
  }), {
    baseUrl: "http://[::1]:8642",
    apiKey: undefined,
    configured: true,
  });
});
