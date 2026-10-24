import assert from "node:assert/strict";
import test from "node:test";
import { formatLogTimestamp, installTimestampedConsole } from "./timestamped-console.js";

type Calls = unknown[][];

function createFakeConsole(): { target: Pick<Console, "log" | "info" | "warn" | "error" | "debug">; calls: Calls } {
  const calls: Calls = [];
  const record = (...args: unknown[]): void => { calls.push(args); };
  return { target: { log: record, info: record, warn: record, error: record, debug: record }, calls };
}

const FIXED_NOW = new Date(2026, 9, 22, 11, 55, 3, 7);

test("formatLogTimestamp 输出带本地时区偏移的 ISO 8601", () => {
  assert.match(
    formatLogTimestamp(FIXED_NOW),
    /^2026-10-22T11:55:03\.007[+-]\d{2}:\d{2}$/,
  );
});

test("installTimestampedConsole 把时间戳拼进首个字符串并保留格式化参数", () => {
  const { target, calls } = createFakeConsole();
  installTimestampedConsole(target, () => FIXED_NOW);

  target.log("Relay connection closed: %s", "1006");
  target.error("[gateway-client] connect failed: AggregateError");

  const stamp = formatLogTimestamp(FIXED_NOW);
  assert.deepEqual(calls[0], [`[${stamp}] Relay connection closed: %s`, "1006"]);
  assert.deepEqual(calls[1], [`[${stamp}] [gateway-client] connect failed: AggregateError`]);
});

test("installTimestampedConsole 首个参数不是字符串时前缀作为独立参数", () => {
  const { target, calls } = createFakeConsole();
  installTimestampedConsole(target, () => FIXED_NOW);

  const payload = { code: 1006 };
  target.warn(payload);

  assert.deepEqual(calls[0], [`[${formatLogTimestamp(FIXED_NOW)}]`, payload]);
});

test("installTimestampedConsole 重复安装不会叠加前缀", () => {
  const { target, calls } = createFakeConsole();
  installTimestampedConsole(target, () => FIXED_NOW);
  installTimestampedConsole(target, () => FIXED_NOW);

  target.info("Gateway connected.");

  assert.deepEqual(calls[0], [`[${formatLogTimestamp(FIXED_NOW)}] Gateway connected.`]);
});
