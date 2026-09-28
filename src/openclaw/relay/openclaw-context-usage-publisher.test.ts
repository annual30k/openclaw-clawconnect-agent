import assert from "node:assert/strict";
import test from "node:test";
import { createOpenClawContextUsagePublisher, type ContextUsageEventPayload } from "./openclaw-context-usage-publisher.js";
import { DEFAULT_GATEWAY_SESSION_DEFAULTS } from "./session-context.js";
import type { OpenClawGatewayClient } from "../gateway-client.js";

function fakeGatewayClient(sessions: Array<Record<string, unknown>>, calls: string[] = []): OpenClawGatewayClient {
  return {
    async request(method: string) {
      calls.push(method);
      return { sessions, defaults: { contextTokens: 272_000, model: "gpt-6-luna" } };
    },
  } as unknown as OpenClawGatewayClient;
}

test("context usage publisher deduplicates identical snapshots unless forced", () => {
  const sent: ContextUsageEventPayload[] = [];
  const publisher = createOpenClawContextUsagePublisher({
    getGatewayClient: () => null,
    getSessionDefaults: () => DEFAULT_GATEWAY_SESSION_DEFAULTS,
    sendContextUsage: (payload) => sent.push(payload),
  });

  publisher.emit({ sessionKey: "main", currentModel: "gpt-6-luna", promptTokens: 7_400, contextLimit: 272_000 });
  publisher.emit({ sessionKey: "main", currentModel: "gpt-6-luna", promptTokens: 7_400, contextLimit: 272_000 });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    sessionKey: "main",
    currentModel: "gpt-6-luna",
    contextUsage: 7_400,
    contextLimit: 272_000,
    promptTokens: 7_400,
    maxInputTokens: 272_000,
  });

  publisher.emit({ sessionKey: "main", currentModel: "gpt-6-luna", promptTokens: 7_400, contextLimit: 272_000 }, true);
  assert.equal(sent.length, 2);
  publisher.emit({ sessionKey: "main", currentModel: "gpt-6-luna", promptTokens: 8_000, contextLimit: 272_000 });
  assert.equal(sent.length, 3);
});

test("context usage publisher reads sessions.list through the gateway client and coalesces scheduled refreshes", async () => {
  const sent: ContextUsageEventPayload[] = [];
  const calls: string[] = [];
  const client = fakeGatewayClient([{ key: "agent:main:main", inputTokens: 1_234, contextTokens: 272_000, model: "gpt-6-luna" }], calls);
  const publisher = createOpenClawContextUsagePublisher({
    getGatewayClient: () => client,
    getSessionDefaults: () => DEFAULT_GATEWAY_SESSION_DEFAULTS,
    sendContextUsage: (payload) => sent.push(payload),
  });

  publisher.scheduleRefresh("main", 20);
  publisher.scheduleRefresh("main", 20);
  publisher.scheduleRefresh(undefined, 20);
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.deepEqual(calls, ["sessions.list"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.sessionKey, "agent:main:main");
  assert.equal(sent[0]?.contextUsage, 1_234);
  assert.equal(sent[0]?.contextLimit, 272_000);
});

test("context usage publisher dispose cancels pending refreshes", async () => {
  const calls: string[] = [];
  const publisher = createOpenClawContextUsagePublisher({
    getGatewayClient: () => fakeGatewayClient([], calls),
    getSessionDefaults: () => DEFAULT_GATEWAY_SESSION_DEFAULTS,
    sendContextUsage: () => undefined,
  });
  publisher.scheduleRefresh("main", 20);
  publisher.dispose();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(calls, []);
});
