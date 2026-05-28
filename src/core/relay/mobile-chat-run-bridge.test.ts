import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMobileAssistantDeltaPayload,
  buildMobileAssistantErrorPayload,
  buildMobileAssistantFinalPayload,
  buildMobileAssistantStreamingPayload,
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
