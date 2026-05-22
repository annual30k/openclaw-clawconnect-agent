import assert from "node:assert/strict";
import test from "node:test";
import { getGatewayProfile, gatewayCapabilitiesForType } from "./gateway-profiles.js";

test("gateway profiles keep OpenClaw and Hermes capabilities isolated", () => {
  const openclaw = getGatewayProfile("openclaw");
  const hermes = getGatewayProfile("hermes");

  assert.deepEqual(openclaw.capabilities, ["chat", "skills", "schedules", "logs", "files", "voice_input"]);
  assert.deepEqual(hermes.capabilities, ["chat", "files", "logs", "restart", "sessions", "skills", "gateway_service", "voice_input"]);
  assert.equal(openclaw.capabilities.includes("gateway_service"), false);
  assert.equal(hermes.capabilities.includes("schedules"), false);
});

test("gateway profile capabilities are returned as fresh arrays", () => {
  const capabilities = gatewayCapabilitiesForType("hermes");
  capabilities.push("mutated");

  assert.equal(gatewayCapabilitiesForType("hermes").includes("mutated"), false);
});
