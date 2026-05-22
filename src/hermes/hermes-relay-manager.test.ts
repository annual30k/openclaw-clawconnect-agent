import assert from "node:assert/strict";
import test from "node:test";
import { resolveHermesVoiceReplyRequest, sendHermesVoiceReply } from "./hermes-relay-manager.js";

test("resolveHermesVoiceReplyRequest keeps mobile voice reply preferences for Hermes chat", () => {
  const request = resolveHermesVoiceReplyRequest({
    id: "request-1",
    method: "chat.send",
    voiceReplyEnabled: true,
    voiceReplyVoiceIdentifier: " zh-CN-XiaoxiaoNeural ",
    voiceReplyRatePercent: 99,
  });

  assert.deepEqual(request, {
    enabled: true,
    voiceIdentifier: "zh-CN-XiaoxiaoNeural",
    ratePercent: 50,
  });
});

test("resolveHermesVoiceReplyRequest ignores non-chat commands", () => {
  assert.equal(
    resolveHermesVoiceReplyRequest({
      id: "request-1",
      method: "hermes.status",
      voiceReplyEnabled: true,
    }),
    undefined,
  );
});

test("sendHermesVoiceReply falls back to text when voice upload fails", async () => {
  let fallbackCalled = false;

  await sendHermesVoiceReply(
    {
      runId: "run-voice-1",
      sessionKey: "main",
      text: "你好，我在。",
      voiceReply: { enabled: true },
      gatewayId: "gw-1",
      fallback: () => {
        fallbackCalled = true;
      },
    },
    {
      sendVoiceReplyCommandImpl: async () => {
        throw new Error("upload_failed");
      },
      warn: () => undefined,
    },
  );

  assert.equal(fallbackCalled, true);
});

test("sendHermesVoiceReply binds uploaded voice file to the original chat run", async () => {
  let sourceRunId: string | undefined;

  await sendHermesVoiceReply(
    {
      runId: "run-voice-2",
      sessionKey: "main",
      text: "你好，我在。",
      voiceReply: { enabled: true },
      gatewayId: "gw-1",
      fallback: () => {
        throw new Error("fallback_should_not_run");
      },
    },
    {
      sendVoiceReplyCommandImpl: async (opts) => {
        sourceRunId = opts.sourceRunId;
        return { ok: true } as never;
      },
    },
  );

  assert.equal(sourceRunId, "run-voice-2");
});
