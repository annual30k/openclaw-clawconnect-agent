import assert from "assert/strict";
import test from "node:test";
import {
  appendUniqueSuffix,
  extractChatRole,
  extractChatText,
  normalizeChatEventPayload,
  withMessageText,
} from "./chat-payload.js";
import { extractHistoryOutcome, type HistoryResponse } from "./chat-history.js";
import {
  canonicalizeRelayParams,
  extractGatewaySessionDefaults,
  buildContextUsageFingerprint,
  type GatewaySessionDefaults,
} from "./session-context.js";

test("chat payload helpers normalize event shape and preserve streamed text", () => {
  const normalized = normalizeChatEventPayload({
    phase: "streaming_delta",
    delta: "hello",
    timestamp: "1710000000",
  }) as Record<string, unknown>;

  assert.equal(normalized.state, "delta");
  assert.equal(normalized.ts, 1710000000000);
  assert.equal(extractChatText(normalized), "hello");
  assert.equal(extractChatRole(normalized), "assistant");
  assert.equal(appendUniqueSuffix("hello", "llo world"), "hello world");

  const withText = withMessageText({ ts: 123, message: { role: "assistant" } }, "done") as Record<string, unknown>;
  assert.deepEqual(withText.message, {
    role: "assistant",
    timestamp: 123,
    content: [{ type: "text", text: "done" }],
  });
});

test("history helper resolves final and error assistant outcomes after the matching user message", () => {
  const baseContext = {
    sessionKey: "agent:main:main",
    requestedAtMs: 1_000,
    promptText: "ping",
  };

  const finalHistory: HistoryResponse = {
    messages: [
      { role: "user", timestamp: 1_100, content: [{ type: "text", text: "ping" }] },
      { role: "assistant", timestamp: 1_200, content: [{ type: "text", text: "pong" }] },
    ],
  };
  assert.deepEqual(extractHistoryOutcome(finalHistory, baseContext), { kind: "final", text: "pong" });

  const errorHistory: HistoryResponse = {
    messages: [
      { role: "user", timestamp: 1_100, content: [{ type: "text", text: "ping" }] },
      { role: "assistant", timestamp: 1_200, stopReason: "error", errorMessage: "gateway failed" },
    ],
  };
  assert.deepEqual(extractHistoryOutcome(errorHistory, baseContext), {
    kind: "error",
    errorMessage: "gateway failed",
  });
});

test("history helper does not resolve outcomes across ambiguous consecutive user messages", () => {
  const firstContext = {
    sessionKey: "agent:main:main",
    requestedAtMs: 1_000,
    promptText: "first voice",
  };
  const secondContext = {
    sessionKey: "agent:main:main",
    requestedAtMs: 1_100,
    promptText: "second voice",
  };
  const ambiguousHistory: HistoryResponse = {
    messages: [
      { role: "user", timestamp: 1_050, content: [{ type: "text", text: "first voice" }] },
      { role: "user", timestamp: 1_150, content: [{ type: "text", text: "second voice" }] },
      { role: "assistant", timestamp: 1_250, content: [{ type: "text", text: "first answer" }] },
      { role: "assistant", timestamp: 1_350, content: [{ type: "text", text: "second answer" }] },
    ],
  };

  assert.equal(extractHistoryOutcome(ambiguousHistory, firstContext), null);
  assert.equal(extractHistoryOutcome(ambiguousHistory, secondContext), null);
});

test("session context helpers extract defaults and canonicalize main-session aliases", () => {
  const defaults = extractGatewaySessionDefaults({
    snapshot: {
      sessionDefaults: {
        mainSessionKey: "agent:main:main",
        mainKey: "main",
        defaultAgentId: "main",
      },
    },
  });

  assert.deepEqual(defaults, {
    mainSessionKey: "agent:main:main",
    mainKey: "main",
    defaultAgentId: "main",
  });

  const fallbackDefaults: GatewaySessionDefaults = defaults!;
  assert.deepEqual(
    canonicalizeRelayParams("chat.send", { sessionKey: "main", message: "hello" }, fallbackDefaults),
    { sessionKey: "agent:main:main", message: "hello" },
  );
  assert.deepEqual(
    canonicalizeRelayParams("status.get", { sessionKey: "main" }, fallbackDefaults),
    { sessionKey: "main" },
  );
});

test("context usage fingerprint changes when prompt tokens change", () => {
  const summaryFingerprint = buildContextUsageFingerprint({
    sessionKey: "agent:main:main",
    currentModel: "model-a",
    contextUsage: 200_000,
    contextLimit: 200_000,
  });

  const promptFingerprint = buildContextUsageFingerprint({
    sessionKey: "agent:main:main",
    currentModel: "model-a",
    contextUsage: 200_000,
    contextLimit: 200_000,
    promptTokens: 0,
  });

  assert.notEqual(summaryFingerprint, promptFingerprint);
});
