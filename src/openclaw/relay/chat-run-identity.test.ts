import assert from "node:assert/strict";
import test from "node:test";

import { OpenClawChatRunIdentityRegistry } from "./chat-run-identity.js";

test("OpenClaw chat run identity keeps cumulative text across reconnect resolution", () => {
  const registry = new OpenClawChatRunIdentityRegistry();
  const identity = {
    gatewayId: "gw-1",
    providerRunId: "provider-run-1",
    canonicalRunId: "mobile-run-1",
    sessionKey: "main",
  };
  registry.register(identity);
  registry.setAccumulatedText(identity.gatewayId, identity.providerRunId, "hello ");
  registry.ensure({ ...identity, promptText: "event-only update" });

  assert.equal(registry.accumulatedText(identity.gatewayId, identity.providerRunId), "hello ");
  assert.equal(registry.resolve(identity.gatewayId, identity.providerRunId)?.canonicalRunId, "mobile-run-1");
});

test("authoritative registration resets a reused provider run generation", () => {
  const registry = new OpenClawChatRunIdentityRegistry();
  const identity = {
    gatewayId: "gw-1",
    providerRunId: "provider-run-1",
    canonicalRunId: "mobile-run-1",
    sessionKey: "main",
  };
  registry.register(identity);
  registry.setAccumulatedText(identity.gatewayId, identity.providerRunId, "old answer");
  registry.markTerminal(identity.gatewayId, identity.providerRunId);

  assert.equal(registry.isTerminal(identity.gatewayId, identity.providerRunId), true);
  registry.register({ ...identity, canonicalRunId: "mobile-run-2", promptText: "new prompt" });
  assert.equal(registry.isTerminal(identity.gatewayId, identity.providerRunId), false);
  assert.equal(registry.accumulatedText(identity.gatewayId, identity.providerRunId), "");
  assert.equal(registry.resolve(identity.gatewayId, identity.providerRunId)?.canonicalRunId, "mobile-run-2");
  assert.equal(registry.resolveProviderRunId(identity.gatewayId, "mobile-run-1"), undefined);
  assert.equal(registry.resolveProviderRunId(identity.gatewayId, "mobile-run-2"), identity.providerRunId);
});

test("OpenClaw chat run registry evicts least-recently-used runs at its bound", () => {
  const registry = new OpenClawChatRunIdentityRegistry(2);
  const identity = (runId: string) => ({
    gatewayId: "gw-bounded",
    providerRunId: `provider-${runId}`,
    canonicalRunId: `mobile-${runId}`,
    sessionKey: "main",
  });
  registry.register(identity("1"));
  registry.register(identity("2"));
  registry.resolve("gw-bounded", "provider-1");
  registry.register(identity("3"));

  assert.equal(registry.resolve("gw-bounded", "provider-1")?.canonicalRunId, "mobile-1");
  assert.equal(registry.resolve("gw-bounded", "provider-2"), undefined);
  assert.equal(registry.resolveProviderRunId("gw-bounded", "mobile-2"), undefined);
  assert.equal(registry.resolve("gw-bounded", "provider-3")?.canonicalRunId, "mobile-3");
});
