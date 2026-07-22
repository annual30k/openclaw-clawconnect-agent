import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readHermesLogTail } from "./hermes-runtime-logs.js";

test("readHermesLogTail returns a structured bounded gateway log tail", () => {
  const root = mkdtempSync(join(tmpdir(), "clawconnect-hermes-logs-"));
  const logs = join(root, "logs");
  try {
    mkdirSync(logs);
    writeFileSync(join(logs, "gateway.log"), [
      "2026-07-21 10:00:00 INFO started",
      "\u001b[33m2026-07-21 10:00:01 WARNING retry\u001b[0m",
      "2026-07-21 10:00:02 ERROR stopped",
      "",
    ].join("\n"));

    const result = readHermesLogTail({ logName: "gateway", limit: 2 }, logs);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const payload = result.payload as Record<string, unknown>;
    assert.equal(payload.source, "connection");
    assert.equal(payload.logPath, join(logs, "gateway.log"));
    assert.deepEqual(payload.lines, [
      "2026-07-21 10:00:01 WARNING retry",
      "2026-07-21 10:00:02 ERROR stopped",
    ]);
    assert.equal(payload.totalLines, 3);
    assert.equal(payload.returnedLines, 2);
    assert.equal(payload.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readHermesLogTail reads Hermes Windows UTF-8 CRLF logs with Chinese paths and content", () => {
  const root = mkdtempSync(join(tmpdir(), "ClawConnect 测试-"));
  try {
    writeFileSync(join(root, "gateway.log"), Buffer.from([
      "2026-07-21 10:00:00 INFO Windows 网关已启动",
      "2026-07-21 10:00:01 INFO 微信客户端已连接",
      "",
    ].join("\r\n"), "utf8"));

    const result = readHermesLogTail({ logName: "gateway", limit: 100 }, root);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const payload = result.payload as Record<string, unknown>;
    assert.equal(payload.logPath, join(root, "gateway.log"));
    assert.deepEqual(payload.lines, [
      "2026-07-21 10:00:00 INFO Windows 网关已启动",
      "2026-07-21 10:00:01 INFO 微信客户端已连接",
    ]);
    assert.equal(payload.totalLines, 2);
    assert.equal(payload.returnedLines, 2);
    assert.equal(payload.truncated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readHermesLogTail tolerates legacy Windows UTF-16LE log files", () => {
  const root = mkdtempSync(join(tmpdir(), "clawconnect-hermes-windows-utf16-"));
  try {
    const text = [
      "2026-07-21 10:00:00 INFO Hermes 已启动",
      "2026-07-21 10:00:01 ERROR 连接失败",
      "",
    ].join("\r\n");
    writeFileSync(join(root, "gateway.log"), Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(text, "utf16le"),
    ]));

    const result = readHermesLogTail({ logName: "gateway", limit: 1 }, root);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const payload = result.payload as Record<string, unknown>;
    assert.deepEqual(payload.lines, ["2026-07-21 10:00:01 ERROR 连接失败"]);
    assert.equal(payload.totalLines, 2);
    assert.equal(payload.returnedLines, 1);
    assert.equal(payload.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readHermesLogTail returns an empty report when Hermes has not created the log yet", () => {
  const root = mkdtempSync(join(tmpdir(), "clawconnect-hermes-empty-"));
  try {
    const connectionLogPath = join(root, "clawconnect.log");
    const result = readHermesLogTail(
      { logName: "gateway", limit: 300 },
      root,
      connectionLogPath,
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.payload, {
      source: "connection",
      logPath: join(root, "gateway.log"),
      lines: [],
      totalLines: 0,
      returnedLines: 0,
      truncated: false,
      output: `[${join(root, "gateway.log")}]`,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readHermesLogTail falls back to the active profile connection log when gateway.log is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "clawconnect-hermes-connection-fallback-"));
  const logs = join(root, "hermes-logs");
  const connectionLogPath = join(root, "profiles", "hermes", "clawconnect.log");
  try {
    mkdirSync(logs, { recursive: true });
    mkdirSync(join(root, "profiles", "hermes"), { recursive: true });
    writeFileSync(connectionLogPath, [
      "Starting ClawConnect host agent...",
      "Connected to relay server (hermes gatewayId=gw_windows)",
      "Agent connected.",
      "",
    ].join("\r\n"));

    const result = readHermesLogTail(
      { logName: "gateway", limit: 2 },
      logs,
      connectionLogPath,
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const payload = result.payload as Record<string, unknown>;
    assert.equal(payload.source, "connection");
    assert.equal(payload.logPath, connectionLogPath);
    assert.deepEqual(payload.lines, [
      "Connected to relay server (hermes gatewayId=gw_windows)",
      "Agent connected.",
    ]);
    assert.equal(payload.totalLines, 3);
    assert.equal(payload.returnedLines, 2);
    assert.equal(payload.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readHermesLogTail reports the full line count for logs larger than its read window", () => {
  const root = mkdtempSync(join(tmpdir(), "clawconnect-hermes-large-log-"));
  try {
    const lines = Array.from(
      { length: 25_000 },
      (_, index) => `entry-${String(index + 1).padStart(5, "0")} ${"payload ".repeat(6)}`,
    );
    writeFileSync(join(root, "gateway.log"), `${lines.join("\n")}\n`);

    const result = readHermesLogTail({ logName: "gateway", limit: 2 }, root);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const payload = result.payload as Record<string, unknown>;
    assert.equal(payload.totalLines, 25_000);
    assert.equal(payload.returnedLines, 2);
    assert.equal(payload.truncated, true);
    assert.deepEqual(payload.lines, lines.slice(-2));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readHermesLogTail rejects log names outside the fixed allowlist", () => {
  const result = readHermesLogTail({ logName: "../../private", limit: 20 }, "/tmp");

  assert.deepEqual(result, { ok: false, error: "invalid_log_name" });
});
