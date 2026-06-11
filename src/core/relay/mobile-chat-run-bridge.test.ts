import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCanonicalMobileAssistantDeltaPayload,
  buildCanonicalMobileAssistantErrorPayload,
  buildCanonicalMobileAssistantFinalPayload,
  buildCanonicalMobileAssistantStreamingPayload,
  buildMobileAssistantDeltaPayload,
  buildMobileAssistantErrorPayload,
  buildMobileAssistantFinalPayload,
  buildMobileAssistantStreamingPayload,
  buildMobileAssistantAbortedPayload,
  canonicalizeMobileAssistantText,
  isCanonicalMobileChatControlError,
  resolveMobileChatRun,
} from "./mobile-chat-run-bridge.js";

test("mobile chat run bridge builds gateway-neutral assistant events", () => {
  const run = resolveMobileChatRun({
    preferredRunId: "mobile-run-1",
    requestId: "relay-request-1",
    sessionKey: "main",
    fallbackPrefix: "hermes",
  });

  assert.deepEqual(run, { runId: "mobile-run-1", sessionKey: "main" });

  assert.deepEqual(
    buildMobileAssistantStreamingPayload({
      run,
      seq: 1,
      text: "typing",
    }),
    {
      runId: "mobile-run-1",
      sessionKey: "main",
      state: "streaming",
      role: "assistant",
      seq: 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "typing" }],
      },
    },
  );

  assert.deepEqual(
    buildMobileAssistantDeltaPayload({
      run,
      seq: 2,
      timestampMs: 123456,
      delta: "hello",
    }),
    {
      runId: "mobile-run-1",
      sessionKey: "main",
      state: "delta",
      role: "assistant",
      seq: 2,
      ts: 123456,
      delta: "hello",
      message: {
        role: "assistant",
        timestamp: 123456,
        content: [{ type: "text", text: "hello" }],
      },
    },
  );

  assert.deepEqual(
    buildMobileAssistantFinalPayload({
      run,
      text: "done",
      currentModel: "gpt-5.5",
      provider: "openai",
      contextUsage: 27,
      contextLimit: 100,
    }),
    {
      runId: "mobile-run-1",
      sessionKey: "main",
      state: "final",
      role: "assistant",
      currentModel: "gpt-5.5",
      provider: "openai",
      contextUsage: 27,
      contextLimit: 100,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      },
    },
  );

  assert.deepEqual(
    buildMobileAssistantFinalPayload({
      run,
      text: "done",
      contentBlocks: [{
        type: "image",
        fileId: "file-image-1",
        fileName: "reply.png",
        mimeType: "image/png",
        downloadPath: "/api/mobile/files/file-image-1",
      }],
    }),
    {
      runId: "mobile-run-1",
      sessionKey: "main",
      state: "final",
      role: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "done" },
          {
            type: "image",
            fileId: "file-image-1",
            fileName: "reply.png",
            mimeType: "image/png",
            downloadPath: "/api/mobile/files/file-image-1",
          },
        ],
      },
    },
  );

  assert.deepEqual(
    buildMobileAssistantErrorPayload({
      run,
      errorMessage: "failed",
    }),
    {
      runId: "mobile-run-1",
      sessionKey: "main",
      state: "error",
      role: "assistant",
      errorMessage: "failed",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "failed" }],
      },
    },
  );
});

test("canonical mobile assistant text drops protocol-only typing markers", () => {
  assert.deepEqual(canonicalizeMobileAssistantText("[[clawlink:typing]]"), {
    text: "",
    shouldPublish: false,
  });
  assert.deepEqual(canonicalizeMobileAssistantText("[[clawlink:typing]]\n[[clawlink:typing]]"), {
    text: "",
    shouldPublish: false,
  });
});

test("canonical mobile assistant text strips Hermes resume metadata", () => {
  assert.deepEqual(
    canonicalizeMobileAssistantText([
      "↻ Resumed session 20260525_114940_1cccb9",
      "Error: 'NoneType' object is not iterable",
      "session_id: 20260525_114940_1cccb9",
      "",
      "visible reply",
    ].join("\n")),
    {
      text: "visible reply",
      shouldPublish: true,
    },
  );
});

test("canonical mobile assistant text classifies timeout-denied control output", () => {
  assert.equal(isCanonicalMobileChatControlError("Timeout – denying command"), true);
  assert.deepEqual(canonicalizeMobileAssistantText("Timeout – denying command"), {
    text: "",
    shouldPublish: false,
    controlError: "Timeout – denying command",
  });
});

test("canonical mobile assistant builders sanitize outgoing text", () => {
  const run = { runId: "run-1", sessionKey: "main" };

  assert.deepEqual(
    buildCanonicalMobileAssistantStreamingPayload({
      run,
      seq: 1,
      text: "[[clawlink:typing]]",
    }),
    {
      runId: "run-1",
      sessionKey: "main",
      state: "streaming",
      role: "assistant",
      seq: 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "" }],
      },
    },
  );

  assert.deepEqual(
    buildCanonicalMobileAssistantDeltaPayload({
      run,
      seq: 2,
      timestampMs: 123,
      delta: "↻ Resumed session 20260525_114940_1cccb9\nhello",
    }),
    {
      runId: "run-1",
      sessionKey: "main",
      state: "delta",
      role: "assistant",
      seq: 2,
      ts: 123,
      delta: "hello",
      message: {
        role: "assistant",
        timestamp: 123,
        content: [{ type: "text", text: "hello" }],
      },
    },
  );

  assert.deepEqual(
    buildCanonicalMobileAssistantDeltaPayload({
      run,
      seq: 3,
      timestampMs: 124,
      delta: "hello ",
    }),
    {
      runId: "run-1",
      sessionKey: "main",
      state: "delta",
      role: "assistant",
      seq: 3,
      ts: 124,
      delta: "hello ",
      message: {
        role: "assistant",
        timestamp: 124,
        content: [{ type: "text", text: "hello " }],
      },
    },
  );

  assert.deepEqual(
    buildCanonicalMobileAssistantFinalPayload({ run, text: "[[clawlink:typing]]" }),
    {
      runId: "run-1",
      sessionKey: "main",
      state: "final",
      role: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "" }],
      },
    },
  );

  assert.deepEqual(
    buildCanonicalMobileAssistantErrorPayload({ run, errorMessage: "Timeout – denying command" }),
    {
      runId: "run-1",
      sessionKey: "main",
      state: "error",
      role: "assistant",
      errorMessage: "Timeout – denying command",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Timeout – denying command" }],
      },
    },
  );
});

test("mobile assistant builders can include canonical timeline events during migration", () => {
  const run = { runId: "client-run-1", sessionKey: "main" };

  const deltaPayload = buildMobileAssistantDeltaPayload({
    run,
    seq: 7,
    timestampMs: 123456,
    delta: "streaming",
    includeTimelineEvents: true,
  } as Parameters<typeof buildMobileAssistantDeltaPayload>[0] & { includeTimelineEvents: true });
  assert.equal(deltaPayload.timelineEvents?.[0]?.eventType, "message.part.delta");
  assert.equal(deltaPayload.timelineEvents?.[0]?.turnId, "client-run-1");
  assert.equal(deltaPayload.timelineEvents?.[0]?.runId, "client-run-1");
  assert.equal(deltaPayload.timelineEvents?.[0]?.messageId, "assistant-client-run-1");
  assert.equal(deltaPayload.timelineEvents?.[0]?.seq, 7);
  assert.deepEqual(deltaPayload.timelineEvents?.[0]?.content, [{ type: "text", text: "streaming" }]);

  const streamingPayload = buildMobileAssistantStreamingPayload({
    run,
    seq: 8,
    text: "partial",
    includeTimelineEvents: true,
  } as Parameters<typeof buildMobileAssistantStreamingPayload>[0] & { includeTimelineEvents: true });
  assert.equal(streamingPayload.timelineEvents?.[0]?.eventType, "message.part.delta");
  assert.equal(streamingPayload.timelineEvents?.[0]?.seq, 8);
  assert.deepEqual(streamingPayload.timelineEvents?.[0]?.content, [{ type: "text", text: "partial" }]);

  const finalPayload = buildMobileAssistantFinalPayload({
    run,
    text: "done",
    includeTimelineEvents: true,
  });
  assert.equal(finalPayload.timelineEvents?.[0]?.eventType, "message.completed");
  assert.equal(finalPayload.timelineEvents?.[1]?.eventType, "run.completed");
  assert.equal(finalPayload.timelineEvents?.[0]?.turnId, "client-run-1");

  const errorPayload = buildMobileAssistantErrorPayload({
    run,
    errorMessage: "failed",
    includeTimelineEvents: true,
  });
  assert.equal(errorPayload.timelineEvents?.[0]?.eventType, "run.failed");
  assert.deepEqual(errorPayload.timelineEvents?.[0]?.error, { userMessage: "failed" });

  const abortedPayload = buildMobileAssistantAbortedPayload({
    run,
    includeTimelineEvents: true,
  });
  assert.equal(abortedPayload.state, "aborted");
  assert.equal(abortedPayload.timelineEvents?.[0]?.eventType, "run.aborted");
  assert.equal(abortedPayload.timelineEvents?.[0]?.runState, "aborted");
});
