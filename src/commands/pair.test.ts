import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRelayServerIdentity,
  sameRelayServer,
  shouldReuseExistingPairing,
} from "./pair.js";
import type { ClawConnectConfig } from "../config/config.js";

const baseConfig: ClawConnectConfig = {
  relayServerUrl: "https://clawlinks.cn",
  gatewayId: "gw_existing",
  relaySecret: "secret",
  displayName: "Mac OpenClaw",
  gatewayType: "openclaw",
  capabilities: ["chat"],
};

test("relay server identity normalizes local http/ws aliases", () => {
  assert.equal(
    normalizeRelayServerIdentity("ws://localhost:8080/"),
    normalizeRelayServerIdentity("http://127.0.0.1:8080")
  );
  assert.equal(
    normalizeRelayServerIdentity("127.0.0.1:8080/"),
    normalizeRelayServerIdentity("http://localhost:8080")
  );
});

test("existing pairing is reused only for same gateway type and same relay server", () => {
  assert.equal(
    shouldReuseExistingPairing(baseConfig, "openclaw", "https://clawlinks.cn"),
    true
  );
  assert.equal(
    shouldReuseExistingPairing(baseConfig, "openclaw", "http://127.0.0.1:8080"),
    false
  );
  assert.equal(
    shouldReuseExistingPairing(baseConfig, "hermes", "https://clawlinks.cn"),
    false
  );
});

test("remote and local relay servers are not interchangeable", () => {
  assert.equal(sameRelayServer("https://clawlinks.cn", "http://127.0.0.1:8080"), false);
  assert.equal(sameRelayServer("https://clawlinks.cn/", "https://clawlinks.cn"), true);
});
