import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { readHealth } from "./status.js";

test("readHealth recognizes Hermes relay manager connection as agent health", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawconnect-status-"));
  const logPath = join(dir, "clawconnect.log");
  writeFileSync(logPath, [
    "Starting ClawConnect host agent...",
    "  Gateway type: hermes",
    "Connected to relay server (hermes gatewayId=gw_1)",
    "Relay connected.",
  ].join("\n"));

  const health = readHealth(logPath, "hermes");

  assert.deepEqual(health.relay, { kind: "ok", detail: "connected" });
  assert.deepEqual(health.gateway, { kind: "ok", detail: "connected" });
});

test("readHealth keeps OpenClaw gateway event parsing for OpenClaw configs", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawconnect-status-"));
  const logPath = join(dir, "clawconnect.log");
  writeFileSync(logPath, [
    "Relay connected.",
    "Gateway connected.",
  ].join("\n"));

  const health = readHealth(logPath, "openclaw");

  assert.deepEqual(health.relay, { kind: "ok", detail: "connected" });
  assert.deepEqual(health.gateway, { kind: "ok", detail: "connected" });
});
