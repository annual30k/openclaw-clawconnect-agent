import assert from "node:assert/strict";
import test from "node:test";

import {
  isValidRelayHello,
  reliableDeliveryModeFromRelayHello,
  RELAY_RELIABLE_DELIVERY_ACK_CAPABILITY,
} from "./reliable-delivery-protocol.js";

test("Relay hello negotiates ACK mode only with the exact versioned protocol token", () => {
  assert.equal(
    reliableDeliveryModeFromRelayHello({
      protocolCapabilities: [RELAY_RELIABLE_DELIVERY_ACK_CAPABILITY],
    }),
    "acknowledged",
  );
  assert.equal(
    reliableDeliveryModeFromRelayHello({ protocolCapabilities: ["event_ack", "response_ack"] }),
    "legacy_write_confirmed",
  );
});

test("received legacy Relay hello without protocolCapabilities uses write-confirmed mode", () => {
  assert.equal(reliableDeliveryModeFromRelayHello({}), "legacy_write_confirmed");
});

test("Relay hello validation requires relay role, success, and matching gateway", () => {
  const hello = {
    type: "hello",
    role: "relay",
    gatewayId: "gw-1",
    ok: true,
  };
  assert.equal(isValidRelayHello(hello, "gw-1"), true);
  assert.equal(isValidRelayHello({ ...hello, gatewayId: "gw-other" }, "gw-1"), false);
  assert.equal(isValidRelayHello({ ...hello, role: "mobile" }, "gw-1"), false);
  assert.equal(isValidRelayHello({ ...hello, ok: false }, "gw-1"), false);
});
