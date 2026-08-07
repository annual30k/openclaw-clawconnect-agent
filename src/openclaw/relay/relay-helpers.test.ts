import assert from "assert/strict";
import test from "node:test";
import {
  appendUniqueSuffix,
  extractChatRole,
  extractChatText,
  normalizeChatState,
  normalizeChatEventPayload,
  withMessageText,
} from "../../core/relay/chat-payload.js";
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
  assert.equal(normalizeChatState({ state: "completed" }), "final");
  assert.equal((normalizeChatEventPayload({ state: "completed" }) as Record<string, unknown>).state, "final");

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
    canonicalRunId: "turn-ping",
    promptText: "ping",
  };

  const finalHistory: HistoryResponse = {
    messages: [
      { role: "user", idempotencyKey: "turn-ping:user", timestamp: 1_100, content: [{ type: "text", text: "ping" }] },
      { role: "assistant", timestamp: 1_200, content: [{ type: "text", text: "pong" }] },
    ],
  };
  assert.deepEqual(extractHistoryOutcome(finalHistory, baseContext), {
    kind: "final",
    text: "pong",
    message: finalHistory.messages?.[1],
  });

  const errorHistory: HistoryResponse = {
    messages: [
      { role: "user", idempotencyKey: "turn-ping:user", timestamp: 1_100, content: [{ type: "text", text: "ping" }] },
      { role: "assistant", timestamp: 1_200, stopReason: "error", errorMessage: "gateway failed" },
    ],
  };
  assert.deepEqual(extractHistoryOutcome(errorHistory, baseContext), {
    kind: "error",
    errorMessage: "gateway failed",
  });
});

test("history helper resolves media-only assistant outcomes after the matching user message", () => {
  const context = {
    sessionKey: "agent:main:main",
    canonicalRunId: "turn-image",
    promptText: "send the image",
  };
  const history: HistoryResponse = {
    messages: [
      { role: "user", idempotencyKey: "turn-image:user", timestamp: 1_100, content: [{ type: "text", text: "send the image" }] },
      {
        role: "assistant",
        timestamp: 1_200,
        content: [
          {
            type: "image",
            fileId: "file-1",
            downloadUrl: "/api/mobile/files/file-1",
          },
        ],
      },
    ],
  };

  assert.deepEqual(extractHistoryOutcome(history, context), {
    kind: "final",
    text: "",
    message: history.messages?.[1],
  });
});

test("history helper ignores empty assistant text blocks while waiting for a real reply", () => {
  const context = {
    sessionKey: "agent:main:main",
    canonicalRunId: "turn-empty",
    promptText: "ping",
  };
  const history: HistoryResponse = {
    messages: [
      { role: "user", idempotencyKey: "turn-empty:user", timestamp: 1_100, content: [{ type: "text", text: "ping" }] },
      { role: "assistant", timestamp: 1_200, content: [{ type: "text", text: "" }] },
    ],
  };

  assert.equal(extractHistoryOutcome(history, context), null);
});

test("history helper skips empty assistant placeholders and resolves later text", () => {
  const context = {
    sessionKey: "agent:main:main",
    canonicalRunId: "turn-later",
    promptText: "ping",
  };
  const history: HistoryResponse = {
    messages: [
      { role: "user", idempotencyKey: "turn-later:user", timestamp: 1_100, content: [{ type: "text", text: "ping" }] },
      { role: "assistant", timestamp: 1_200, content: [{ type: "text", text: "" }] },
      { role: "assistant", timestamp: 1_300, content: [{ type: "text", text: "pong" }] },
    ],
  };

  assert.deepEqual(extractHistoryOutcome(history, context), {
    kind: "final",
    text: "pong",
    message: history.messages?.[2],
  });
});

test("history helper waits through tool-only assistant blocks until user-visible final content", () => {
  const context = {
    sessionKey: "agent:main:main",
    canonicalRunId: "turn-tool-final",
    promptText: "read the file",
  };
  const history: HistoryResponse = {
    messages: [
      { role: "user", idempotencyKey: "turn-tool-final:user", timestamp: 1_100, content: [{ type: "text", text: "read the file" }] },
      {
        role: "assistant",
        timestamp: 1_150,
        content: [
          {
            type: "tool_call",
            name: "read_file",
            toolCallId: "tool-1",
            arguments: { path: "report.pdf" },
          },
        ],
      },
      {
        role: "assistant",
        timestamp: 1_200,
        content: [
          {
            type: "tool_result",
            toolCallId: "tool-1",
            result: { ok: true },
          },
        ],
      },
      { role: "assistant", timestamp: 1_300, content: [{ type: "text", text: "report.pdf is ready" }] },
    ],
  };

  assert.deepEqual(extractHistoryOutcome(history, context), {
    kind: "final",
    text: "report.pdf is ready",
    message: history.messages?.[3],
  });
});

test("history helper does not treat tool-only assistant blocks as final content", () => {
  const context = {
    sessionKey: "agent:main:main",
    canonicalRunId: "turn-tool-only",
    promptText: "read the file",
  };
  const history: HistoryResponse = {
    messages: [
      { role: "user", idempotencyKey: "turn-tool-only:user", timestamp: 1_100, content: [{ type: "text", text: "read the file" }] },
      {
        role: "assistant",
        timestamp: 1_150,
        content: [
          {
            type: "tool_use",
            name: "read_file",
            toolUseId: "tool-1",
            args: { path: "report.pdf" },
          },
        ],
      },
    ],
  };

  assert.equal(extractHistoryOutcome(history, context), null);
});

test("history helper does not terminate a run for OpenClaw thinking plus toolCall preamble", () => {
  const context = {
    sessionKey: "agent:main:main",
    canonicalRunId: "turn-thinking-tool",
    promptText: "wait before replying",
  };
  const history: HistoryResponse = {
    messages: [
      {
        role: "user",
        idempotencyKey: "turn-thinking-tool:user",
        timestamp: 1_100,
        content: [{ type: "text", text: "wait before replying" }],
      },
      {
        role: "assistant",
        timestamp: 1_150,
        content: [
          {
            type: "thinking",
            thinking: "I should call the waiting tool before answering.",
          },
          {
            type: "toolCall",
            id: "tool-wait-1",
            name: "exec",
            arguments: { command: "sleep 60" },
          },
        ],
      },
    ],
  };

  assert.equal(extractHistoryOutcome(history, context), null);
});

test("history helper matches OpenClaw string user content", () => {
  const context = {
    sessionKey: "session_1",
    canonicalRunId: "turn-string-content",
    promptText: "你可以做什么呢",
  };
  const history: HistoryResponse = {
    messages: [
      { role: "user", idempotencyKey: "turn-string-content:user", timestamp: 1_100, content: "你可以做什么呢" },
      { role: "assistant", timestamp: 1_200, content: [{ type: "text", text: "我可以帮你处理文件。" }] },
    ],
  };

  assert.deepEqual(extractHistoryOutcome(history, context), {
    kind: "final",
    text: "我可以帮你处理文件。",
    message: history.messages?.[1],
  });
});

test("history helper refuses text and timestamp matching without stable user identity", () => {
  const context = {
    sessionKey: "session_1",
    canonicalRunId: "missing-stable-turn",
    promptText: "OPENCLAW_E2E_1 reply exactly OPENCLAW_OK_1",
  };
  const history: HistoryResponse = {
    messages: [
      {
        role: "user",
        timestamp: 1_100,
        content: "[Sun 2026-05-31 13:42 GMT+8] OPENCLAW_E2E_1 reply exactly OPENCLAW_OK_1",
      },
      { role: "assistant", timestamp: 1_200, content: [{ type: "text", text: "OPENCLAW_OK_1" }] },
    ],
  };

  assert.equal(extractHistoryOutcome(history, context), null);
});

test("history helper does not resolve outcomes across ambiguous consecutive user messages", () => {
  const firstContext = {
    sessionKey: "agent:main:main",
    canonicalRunId: "turn-first-voice",
    promptText: "first voice",
  };
  const secondContext = {
    sessionKey: "agent:main:main",
    canonicalRunId: "turn-second-voice",
    promptText: "second voice",
  };
  const ambiguousHistory: HistoryResponse = {
    messages: [
      { role: "user", idempotencyKey: "turn-first-voice:user", timestamp: 1_050, content: [{ type: "text", text: "first voice" }] },
      { role: "user", idempotencyKey: "turn-second-voice:user", timestamp: 1_150, content: [{ type: "text", text: "second voice" }] },
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
