import assert from "node:assert/strict";
import test from "node:test";
import { parseGatewayRuntimeState, resolveGatewayRemoteRestartAction } from "./local-runtime.js";

test("parseGatewayRuntimeState handles running/stopped/unknown", () => {
  assert.equal(parseGatewayRuntimeState("Runtime: running\n"), "running");
  assert.equal(parseGatewayRuntimeState("Runtime: stopped\n"), "stopped");
  assert.equal(parseGatewayRuntimeState("Runtime: not running\n"), "stopped");
  assert.equal(parseGatewayRuntimeState("Runtime: UNKNOWN\n"), "unknown");
  assert.equal(parseGatewayRuntimeState("no runtime here"), "unknown");
});

test("parseGatewayRuntimeState ignores ANSI escapes", () => {
  const output = "\u001b[31mRuntime:\u001b[0m running\n";
  assert.equal(parseGatewayRuntimeState(output), "running");
});

test("resolveGatewayRemoteRestartAction maps runtime to action", () => {
  assert.equal(resolveGatewayRemoteRestartAction("running"), "restart");
  assert.equal(resolveGatewayRemoteRestartAction("stopped"), "start");
  assert.equal(resolveGatewayRemoteRestartAction("unknown"), "start");
});
