import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDefaultDisplayName,
  findConflictingRegistration,
  normalizeRelayServerIdentity,
  postRelayJson,
  resolvePairProfile,
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
  assert.equal(
    shouldReuseExistingPairing(baseConfig, "openclaw", "https://clawlinks.cn", true),
    false
  );
});

test("resolvePairProfile eliminates accidental default profile creation", () => {
  assert.equal(resolvePairProfile({ gatewayType: "openclaw" }), "openclaw");
  assert.equal(resolvePairProfile({ gatewayType: "hermes" }), "hermes");
  assert.equal(resolvePairProfile({}), "openclaw");
  assert.equal(resolvePairProfile({ gatewayType: "openclaw", local: true }), "openclaw-local");
  assert.equal(resolvePairProfile({ gatewayType: "hermes", local: true }), "hermes-local");
  assert.equal(resolvePairProfile({ local: true }), "openclaw-local");
  assert.equal(resolvePairProfile({ profile: "custom-dev", gatewayType: "openclaw", local: true }), "custom-dev");
  assert.equal(resolvePairProfile({ profile: "custom-gw", gatewayType: "hermes" }), "custom-gw");
  assert.equal(resolvePairProfile({ profile: "default", gatewayType: "openclaw" }), undefined);
});

test("buildDefaultDisplayName avoids hardcoded Mac labels across platforms", () => {
  assert.equal(buildDefaultDisplayName("openclaw", "linux-box"), "linux-box OpenClaw");
  assert.equal(buildDefaultDisplayName("hermes", "linux-box"), "linux-box Hermes");
  assert.equal(buildDefaultDisplayName("openclaw", "linux-box", true), "linux-box OpenClaw (Local)");
  assert.equal(buildDefaultDisplayName("hermes", "linux-box", true), "linux-box Hermes (Local)");
  assert.equal(buildDefaultDisplayName("openclaw", "Mac OpenClaw"), "Mac OpenClaw");
  assert.equal(buildDefaultDisplayName("hermes", "My Hermes Node"), "My Hermes Node");
});

test("remote and local relay servers are not interchangeable", () => {
  assert.equal(sameRelayServer("https://clawlinks.cn", "http://127.0.0.1:8080"), false);
  assert.equal(sameRelayServer("https://clawlinks.cn/", "https://clawlinks.cn"), true);
});

test("postRelayJson surfaces the underlying network cause instead of a bare fetch failure", async () => {
  const connectTimeout = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
  });
  const failingFetch = (async () => {
    throw connectTimeout;
  }) as typeof fetch;

  await assert.rejects(
    postRelayJson("https://relay.example", "/api/relay/register", {}, failingFetch),
    (error: Error) => error.message.includes("https://relay.example")
      && error.message.includes("UND_ERR_CONNECT_TIMEOUT Connect Timeout Error"),
  );
});

test("postRelayJson aborts a relay request that never responds", async () => {
  const hangingFetch = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const failIfNotAborted = setTimeout(() => reject(new Error("mock request was not aborted")), 1_000);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(failIfNotAborted);
      reject(init.signal?.reason);
    }, { once: true });
  })) as typeof fetch;

  await assert.rejects(
    postRelayJson("https://relay.example", "/api/relay/accesscode", {}, hangingFetch, 50),
    /no response within 50ms/,
  );
});

test("findConflictingRegistration blocks a second gateway of the same type on the same relay", () => {
  const conflict = findConflictingRegistration("openclaw", "openclaw", "https://clawlinks.cn/", [
    { profile: "openclaw", config: { ...baseConfig, gatewayId: "gw_self" } },
    { profile: "default", config: { ...baseConfig, gatewayId: "gw_default", relayServerUrl: "https://clawlinks.cn" } },
  ]);

  assert.equal(conflict?.profile, undefined);
  assert.equal(conflict?.config.gatewayId, "gw_default");
});

test("findConflictingRegistration allows other gateway types, other relays, and the profile itself", () => {
  const candidates = [
    { profile: "openclaw", config: { ...baseConfig, gatewayId: "gw_self" } },
    { profile: "hermes", config: { ...baseConfig, gatewayId: "gw_hermes", gatewayType: "hermes" as const } },
    { profile: "local", config: { ...baseConfig, gatewayId: "gw_local", relayServerUrl: "http://127.0.0.1:8080" } },
  ];

  assert.equal(findConflictingRegistration("openclaw", "openclaw", "https://clawlinks.cn", candidates), undefined);
});

test("findConflictingRegistration picks the conflict deterministically regardless of listing order", () => {
  const candidates = [
    { profile: "zeta", config: { ...baseConfig, gatewayId: "gw_zeta" } },
    { profile: "alpha", config: { ...baseConfig, gatewayId: "gw_alpha" } },
  ];

  assert.equal(findConflictingRegistration(undefined, "openclaw", "https://clawlinks.cn", candidates)?.profile, "alpha");
  assert.equal(findConflictingRegistration(undefined, "openclaw", "https://clawlinks.cn", [...candidates].reverse())?.profile, "alpha");
});
