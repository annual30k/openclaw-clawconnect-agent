import assert from "node:assert/strict";
import test from "node:test";
import { prepareOpenClawVoiceInputCommand } from "./openclaw-voice-input.js";

test("OpenClaw voice input uses the mobile idempotency key as the chat run id", async () => {
  const originalCommand = process.env.OPENCLAW_ASR_COMMAND;
  process.env.OPENCLAW_ASR_COMMAND = "printf '测试语音'";
  try {
    const prepared = await prepareOpenClawVoiceInputCommand({
      sessionKey: "main",
      idempotencyKey: "voice-client-run-1",
      audio: {
        fileName: "voice-input.m4a",
        mimeType: "audio/mp4",
        content: Buffer.from("fake-audio", "utf8").toString("base64"),
      },
    }, {
      requestId: "relay-request-1",
      sessionDefaults: { mainSessionKey: "main", mainKey: "main" },
    });

    assert.equal(prepared.run.runId, "voice-client-run-1");
    assert.equal(prepared.run.sessionKey, "main");
  } finally {
    if (originalCommand === undefined) delete process.env.OPENCLAW_ASR_COMMAND;
    else process.env.OPENCLAW_ASR_COMMAND = originalCommand;
  }
});
