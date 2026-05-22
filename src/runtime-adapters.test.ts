import assert from "node:assert/strict";
import test from "node:test";
import { getGatewayRuntimeAdapter } from "./runtime-adapters.js";

test("gateway runtime adapter registry exposes OpenClaw runtime behavior", () => {
  const adapter = getGatewayRuntimeAdapter("openclaw");

  assert.equal(adapter.type, "openclaw");
  assert.equal(adapter.logsGatewayUrl, true);
});

test("gateway runtime adapter registry exposes Hermes runtime behavior", () => {
  const adapter = getGatewayRuntimeAdapter("hermes");

  assert.equal(adapter.type, "hermes");
  assert.equal(adapter.logsGatewayUrl, false);
});
