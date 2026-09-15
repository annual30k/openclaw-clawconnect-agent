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
import {
  extractHistoryMediaContent,
  extractHistoryOutcome,
  type HistoryResponse,
} from "./chat-history.js";
import {
  assistantHistoryReplyMessageId,
  assistantReplyMessageId,
} from "./relay-manager-payload-helpers.js";
import {
  canonicalizeRelayParams,
  canonicalizeOpenClawSessionScope,
  contextUsageSnapshotFromSessionsList,
  extractGatewaySessionDefaults,
  buildContextUsageFingerprint,
  type GatewaySessionDefaults,
} from "./session-context.js";

test("OpenClaw relation scope unifies default dashboard aliases without crossing agents", () => {
  const defaults: GatewaySessionDefaults = {
    mainSessionKey: "agent:main:main",
    mainKey: "main",
    defaultAgentId: "main",
  };

  assert.equal(
    canonicalizeOpenClawSessionScope("dashboard:38ff", defaults),
    "agent:main:dashboard:38ff",
  );
  assert.equal(
    canonicalizeOpenClawSessionScope("agent:main:dashboard:38ff", defaults),
    "agent:main:dashboard:38ff",
  );
  assert.equal(
    canonicalizeOpenClawSessionScope("main", defaults),
    canonicalizeOpenClawSessionScope("agent:main:main", defaults),
  );
  assert.notEqual(
    canonicalizeOpenClawSessionScope("main", defaults),
    canonicalizeOpenClawSessionScope("agent:writer:main", defaults),
  );
  assert.notEqual(
    canonicalizeOpenClawSessionScope("dashboard:38ff", defaults),
    canonicalizeOpenClawSessionScope("agent:writer:dashboard:38ff", defaults),
  );
  assert.equal(
    canonicalizeOpenClawSessionScope("agent:writer:dashboard:38ff", defaults),
    "agent:writer:dashboard:38ff",
  );
});

test("session usage resolves an unqualified mobile key from OpenClaw sessions.list", () => {
  const snapshot = contextUsageSnapshotFromSessionsList(
    {
      defaults: { model: "mimo-v2.5-pro", contextTokens: 1_048_576 },
      sessions: [{
        key: "agent:main:mobile-mt717jco-egmpibpa",
        inputTokens: 1_171,
        contextTokens: 1_048_576,
        model: "mimo-v2.5-pro",
      }],
    },
    "mobile-mt717jco-egmpibpa",
    { mainSessionKey: "agent:main:main", mainKey: "main", defaultAgentId: "main" },
  );

  assert.deepEqual(snapshot, {
    sessionKey: "mobile-mt717jco-egmpibpa",
    currentModel: "mimo-v2.5-pro",
    contextUsage: 1_171,
    promptTokens: 1_171,
    contextLimit: 1_048_576,
  });
});

test("chat payload helpers normalize event shape and preserve streamed text", () => {
  const normalized = normalizeChatEventPayload({
    phase: "streaming_delta",
    delta: "hello",
    timestamp: "1710000000",
  }) as Record<string, unknown>;

  assert.equal(normalized.state, "delta");
  assert.equal(normalized.ts, 1710000000000);
  assert.equal(extractChatText(normalized), "hello");
  assert.equal(extractChatRole(normalized), "");
  assert.equal(extractChatRole({ state: "delta", message: { role: "assistant" } }), "assistant");
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

test("assistant reply identity separates message-tool media replies within one run", () => {
  const runId = "wx_1789001045035_bpqhtc2v";
  const first = {
    runId,
    message: {
      role: "assistant",
      idempotencyKey: `${runId}:message-tool:delivery-first:call_first`,
      content: [{ type: "thinking", thinking: "send the first image" }],
      openclawDelivery: { mediaUrls: ["/tmp/openclaw-first.png"] },
    },
  };
  const second = {
    runId,
    message: {
      role: "assistant",
      idempotencyKey: `${runId}:message-tool:delivery-second:call_second`,
      content: [{ type: "thinking", thinking: "send the second image" }],
      openclawDelivery: { mediaUrls: ["/tmp/openclaw-second.png"] },
    },
  };

  const firstId = assistantReplyMessageId(first, runId);
  const secondId = assistantReplyMessageId(second, runId);
  assert.ok(firstId);
  assert.ok(secondId);
  assert.notEqual(firstId, secondId);
  assert.equal(firstId, assistantReplyMessageId(first, runId));
  assert.equal(assistantReplyMessageId({ runId, message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, runId), undefined);
});

test("assistant reply identity reads live OpenClaw message-tool idempotency from the event envelope", () => {
  const runId = "wx_1789006339130_dbpxspy3";
  const first = assistantReplyMessageId({
    runId,
    idempotencyKey: `${runId}:message-tool:Cp622XVN1tDdguziNglRlNcd:call_2fb1eb81dfc448358202a3c9`,
    message: { role: "assistant", content: [{ type: "text", text: "Codex 图片 1" }] },
  }, runId);
  const second = assistantReplyMessageId({
    runId,
    idempotencyKey: `${runId}:message-tool:Ah1_ya8xJbNsE_I8k1XSvohg:call_3e8cedb899124d78aff95e7c`,
    message: { role: "assistant", content: [{ type: "text", text: "Codex 图片 2" }] },
  }, runId);

  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first, second);
});

test("history media delivery rows retain distinct identities when live terminals omit them", () => {
  const runId = "wx_1789011744225_6790c501";
  const first = assistantHistoryReplyMessageId({
    id: "5214452e-964d-416b-b46c-eee4904bf21a",
    role: "assistant",
    runId,
    content: [{ type: "text", text: "Codex 图片 1" }, {
      type: "image",
      artifactId: "artifact_managed_image_42717b12-9102-448f-aad4-ebeaada77578",
    }],
  }, runId);
  const second = assistantHistoryReplyMessageId({
    id: "0e476fe7-2263-4ca3-aad0-6673938d3db8",
    role: "assistant",
    runId,
    content: [{ type: "text", text: "Codex 图片 2" }, {
      type: "image",
      artifactId: "artifact_managed_image_7430a625-b11f-4ab2-9752-5acfbaf3dbcb",
    }],
  }, runId);

  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first, second);
  assert.equal(assistantHistoryReplyMessageId({
    id: "ordinary-assistant",
    role: "assistant",
    runId,
    content: [{ type: "text", text: "done" }],
  }, runId), undefined);
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

test("history helper selects the latest assistant reply in a multi-message-tool run", () => {
  const context = {
    sessionKey: "agent:main:main",
    canonicalRunId: "turn-multi-image",
    promptText: "send both images",
  };
  const history: HistoryResponse = {
    messages: [
      { role: "user", idempotencyKey: "turn-multi-image:user", content: "send both images" },
      {
        role: "assistant",
        id: "reply-first",
        idempotencyKey: "turn-multi-image:message-tool:first:call_first",
        content: [{ type: "image", fileId: "file-first" }],
      },
      {
        role: "assistant",
        id: "reply-second",
        idempotencyKey: "turn-multi-image:message-tool:second:call_second",
        content: [{ type: "image", fileId: "file-second" }],
      },
    ],
  };

  const outcome = extractHistoryOutcome(history, context);
  assert.equal(outcome?.kind, "final");
  assert.equal((outcome as Extract<typeof outcome, { kind: "final" }>).message, history.messages?.[2]);
});

test("history helper never uses live assistant text as a media-row identity", () => {
  const context = {
    sessionKey: "agent:main:main",
    canonicalRunId: "turn-live-media",
    promptText: "send both images",
  };
  const history: HistoryResponse = {
    messages: [
      { role: "user", idempotencyKey: "turn-live-media:user", content: "send both images" },
      {
        role: "assistant",
        id: "reply-first",
        idempotencyKey: "turn-live-media:message-tool:first:call_first",
        content: [{ type: "text", text: "first" }, { type: "image", fileId: "file-first" }],
      },
      {
        role: "assistant",
        id: "reply-second",
        idempotencyKey: "turn-live-media:message-tool:second:call_second",
        content: [{ type: "text", text: "second" }, { type: "image", fileId: "file-second" }],
      },
      {
        role: "assistant",
        id: "run-commentary",
        idempotencyKey: "turn-live-media",
        content: [{ type: "text", text: "both sent" }],
      },
    ],
  };

  const outcome = extractHistoryOutcome(history, context, "second");
  assert.equal(outcome?.kind, "final");
  assert.equal((outcome as Extract<typeof outcome, { kind: "final" }>).message, history.messages?.[3]);
});

test("history helper collects every media delivery in the matched turn", () => {
  const context = {
    sessionKey: "agent:main:main",
    canonicalRunId: "turn-history-all-media",
  };
  const history: HistoryResponse = {
    messages: [
      { role: "user", idempotencyKey: "turn-history-all-media:user", content: "send images" },
      { role: "assistant", id: "reply-first", content: [{ type: "image", fileId: "file-first" }] },
      { role: "assistant", id: "reply-second", content: [{ type: "image", fileId: "file-second" }] },
      { role: "user", idempotencyKey: "later:user", content: "next" },
      { role: "assistant", id: "later-reply", content: [{ type: "image", fileId: "file-later" }] },
    ],
  };

  assert.deepEqual(extractHistoryMediaContent(history, context).map((block) => block.fileId), [
    "file-first",
    "file-second",
  ]);
});

test("history helper reconciles a paginated page that starts after the user row by stable run id", () => {
  const runId = "turn-paginated-media";
  const context = {
    sessionKey: "agent:main:main",
    canonicalRunId: runId,
  };
  const history: HistoryResponse = {
    // This is the same shape as the live enrichment page when a busy
    // OpenClaw turn has more than ten rows after its user message: the user
    // row is outside the page, while every delivery row retains runId.
    messages: [
      { role: "assistant", runId, content: [{ type: "thinking", thinking: "send files" }] },
      { role: "assistant", runId, id: "reply-first", content: [{ type: "text", text: "first" }, { type: "image", fileId: "file-first" }] },
      { role: "assistant", runId, id: "reply-second", content: [{ type: "text", text: "second" }, { type: "image", fileId: "file-second" }] },
      { role: "toolResult", runId, content: [{ type: "text", text: "sent" }] },
    ],
  };

  const outcome = extractHistoryOutcome(history, context, "second");
  assert.equal(outcome?.kind, "final");
  assert.equal((outcome as Extract<typeof outcome, { kind: "final" }>).text, "second");
  assert.deepEqual(extractHistoryMediaContent(history, context).map((block) => block.fileId), [
    "file-first",
    "file-second",
  ]);
});

test("history helper does not guess when repeated message-tool text is ambiguous", () => {
  const context = {
    sessionKey: "agent:main:main",
    canonicalRunId: "turn-live-ambiguous",
  };
  const history: HistoryResponse = {
    messages: [
      { role: "user", idempotencyKey: "turn-live-ambiguous:user", content: "send both" },
      {
        role: "assistant",
        idempotencyKey: "turn-live-ambiguous:message-tool:first:call_first",
        content: [{ type: "text", text: "done" }, { type: "image", fileId: "file-first" }],
      },
      {
        role: "assistant",
        idempotencyKey: "turn-live-ambiguous:message-tool:second:call_second",
        content: [{ type: "text", text: "done" }, { type: "image", fileId: "file-second" }],
      },
      {
        role: "assistant",
        idempotencyKey: "turn-live-ambiguous",
        content: [{ type: "text", text: "both sent" }],
      },
    ],
  };

  const outcome = extractHistoryOutcome(history, context, "done");
  assert.equal(outcome?.kind, "final");
  assert.equal((outcome as Extract<typeof outcome, { kind: "final" }>).message, history.messages?.[3]);
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

  const explicitOwnershipWithoutSnapshotAgent = extractGatewaySessionDefaults({
    snapshot: {
      sessionDefaults: {
        mainSessionKey: "main",
        mainKey: "main",
      },
    },
  });
  assert.deepEqual(explicitOwnershipWithoutSnapshotAgent, {
    mainSessionKey: "agent:main:main",
    mainKey: "main",
    defaultAgentId: "main",
  });
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
