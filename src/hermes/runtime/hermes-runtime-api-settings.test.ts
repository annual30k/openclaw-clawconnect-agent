import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  resolveHermesApiSettings,
  resolveHermesRuntimeExecutionMode,
} from "./hermes-runtime-api-settings.js";

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
    executionReady: true,
  });
  assert.deepEqual(resolveHermesApiSettings({
    env: { API_SERVER_PORT: "9750", CLAWCONNECT_HERMES_API_KEY: "process-key" },
    hermesHome,
  }), {
    baseUrl: "http://0.0.0.0:9750",
    apiKey: "process-key",
    configured: true,
    executionReady: true,
  });
  assert.deepEqual(resolveHermesApiSettings({
    env: { CLAWCONNECT_HERMES_API_URL: "http://[::1]:9850/" },
    hermesHome,
  }), {
    baseUrl: "http://[::1]:9850",
    apiKey: "file-key",
    configured: true,
    executionReady: true,
  });

  rmSync(hermesHome, { recursive: true, force: true });
});

test("Hermes API settings auto-discover the active config.yaml endpoint", () => {
  const hermesHome = mkdtempSync(join(tmpdir(), "clawconnect-hermes-api-config-"));
  writeFileSync(join(hermesHome, ".env"), [
    "API_SERVER_HOST=127.0.0.1",
    "API_SERVER_PORT=9650",
    "API_SERVER_KEY=stale-file-key",
  ].join("\n"));
  writeFileSync(join(hermesHome, "config.yaml"), [
    "platforms:",
    "  api_server:",
    "    enabled: true",
    "    extra:",
    "      host: \"::1\" # bind address",
    "      port: 9765",
    "      key: 'active-config-key'",
  ].join("\n"));

  assert.deepEqual(resolveHermesApiSettings({
    env: { API_SERVER_PORT: "9750", API_SERVER_KEY: "stale-process-key" },
    hermesHome,
  }), {
    baseUrl: "http://[::1]:9765",
    apiKey: "active-config-key",
    configured: true,
    executionReady: true,
  });
  assert.equal(resolveHermesRuntimeExecutionMode({ env: {}, hermesHome }), "api");

  rmSync(hermesHome, { recursive: true, force: true });
});

test("explicit ClawConnect API overrides remain above Hermes auto-discovery", () => {
  const hermesHome = mkdtempSync(join(tmpdir(), "clawconnect-hermes-api-override-"));
  writeFileSync(join(hermesHome, "config.yaml"), [
    "platforms:",
    "  api_server:",
    "    extra:",
    "      host: 127.0.0.1",
    "      port: 9765",
    "      key: config-key",
  ].join("\n"));

  assert.deepEqual(resolveHermesApiSettings({
    env: {
      CLAWCONNECT_HERMES_API_URL: "http://127.0.0.1:9865/",
      CLAWCONNECT_HERMES_API_KEY: "override-key",
    },
    hermesHome,
  }), {
    baseUrl: "http://127.0.0.1:9865",
    apiKey: "override-key",
    configured: true,
    executionReady: true,
  });

  rmSync(hermesHome, { recursive: true, force: true });
});

test("Hermes API settings validate ports and format IPv6 hosts", () => {
  const hermesHome = mkdtempSync(join(tmpdir(), "clawconnect-hermes-api-validation-"));
  assert.deepEqual(resolveHermesApiSettings({
    env: { API_SERVER_HOST: "::1", API_SERVER_PORT: "70000" },
    hermesHome,
    fileEnv: {},
  }), {
    baseUrl: "http://[::1]:8642",
    apiKey: undefined,
    configured: true,
    executionReady: false,
  });
  rmSync(hermesHome, { recursive: true, force: true });
});

test("Hermes runtime mode uses the same process and Hermes home settings as API execution", () => {
  const hermesHome = mkdtempSync(join(tmpdir(), "clawconnect-hermes-api-mode-"));
  writeFileSync(join(hermesHome, ".env"), [
    "API_SERVER_HOST=127.0.0.1",
    "API_SERVER_PORT=9642",
    "API_SERVER_KEY=file-key",
  ].join("\n"));

  assert.equal(resolveHermesRuntimeExecutionMode({ env: {}, hermesHome }), "api");
  assert.equal(resolveHermesRuntimeExecutionMode({
    env: { CLAWCONNECT_HERMES_RUNTIME_MODE: "local" },
    hermesHome,
  }), "local");
  assert.equal(resolveHermesRuntimeExecutionMode({
    env: { CLAWCONNECT_HERMES_RUNTIME_MODE: "api" },
    hermesHome,
  }), "api");

  rmSync(hermesHome, { recursive: true, force: true });
});

test("Hermes runtime mode does not infer API from partial configuration", () => {
  const hermesHome = mkdtempSync(join(tmpdir(), "clawconnect-hermes-partial-api-mode-"));
  assert.equal(resolveHermesRuntimeExecutionMode({
    env: { API_SERVER_KEY: "key-only" },
    hermesHome,
    fileEnv: {},
  }), "local");
  assert.equal(resolveHermesRuntimeExecutionMode({
    env: { HERMES_API_SERVER_URL: "http://127.0.0.1:8642" },
    hermesHome,
    fileEnv: {},
  }), "local");
  assert.equal(resolveHermesRuntimeExecutionMode({
    env: {
      HERMES_API_SERVER_URL: "http://127.0.0.1:8642",
      API_SERVER_KEY: "complete",
    },
    hermesHome,
    fileEnv: {},
  }), "api");
  rmSync(hermesHome, { recursive: true, force: true });
});
