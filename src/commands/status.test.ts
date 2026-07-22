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

test("readHealth treats Hermes relay reconnection as recovered after stale replacement close", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawconnect-status-"));
  const logPath = join(dir, "clawconnect.log");
  writeFileSync(logPath, [
    "Starting ClawConnect host agent...",
    "  Gateway type: hermes",
    "Connected to relay server (hermes gatewayId=gw_1)",
    "Relay connected.",
    "Hermes relay connection closed: 4000 replaced_by_new_host",
    "Relay disconnected. Reconnecting...",
    "Relay connected.",
  ].join("\n"));

  const health = readHealth(logPath, "hermes");

  assert.deepEqual(health.relay, { kind: "ok", detail: "connected" });
  assert.deepEqual(health.gateway, { kind: "ok", detail: "connected" });
});

test("readHealth recognizes the current Hermes connection log after a stale 1006 close", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawconnect-status-"));
  const logPath = join(dir, "clawconnect.log");
  writeFileSync(logPath, [
    "Connected to relay server (hermes gatewayId=gw_1)",
    "Hermes relay connection closed: 1006",
    "中继已断开，正在重连…",
    "Connected to relay server (hermes gatewayId=gw_1)",
    "中继已连接。",
  ].join("\n"));

  const health = readHealth(logPath, "hermes");

  assert.deepEqual(health.relay, { kind: "ok", detail: "connected" });
  assert.deepEqual(health.gateway, { kind: "ok", detail: "connected" });
});

test("readHealth reports Hermes replacement close when no later relay connection exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawconnect-status-"));
  const logPath = join(dir, "clawconnect.log");
  writeFileSync(logPath, [
    "Starting ClawConnect host agent...",
    "  Gateway type: hermes",
    "Connected to relay server (hermes gatewayId=gw_1)",
    "Relay connected.",
    "Hermes relay connection closed: 4000 replaced_by_new_host",
  ].join("\n"));

  const health = readHealth(logPath, "hermes");

  assert.deepEqual(health.relay, { kind: "error", detail: "4000 replaced_by_new_host" });
  assert.deepEqual(health.gateway, { kind: "error", detail: "4000 replaced_by_new_host" });
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

test("readHealth parses Windows PowerShell UTF-16LE service logs", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawconnect-status-utf16-"));
  const logPath = join(dir, "clawconnect.log");
  const log = ["启动 ClawConnect", "Relay connected.", "Gateway connected."].join("\r\n");
  writeFileSync(logPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(log, "utf16le")]));

  const health = readHealth(logPath, "openclaw");

  assert.deepEqual(health.relay, { kind: "ok", detail: "connected" });
  assert.deepEqual(health.gateway, { kind: "ok", detail: "connected" });
});
