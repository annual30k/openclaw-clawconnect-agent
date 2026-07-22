import assert from "node:assert/strict";
import test from "node:test";
import { prepareHermesVoiceInputCommand } from "./hermes-voice-input.js";

test("Hermes voice input uses the mobile idempotency key as the chat run id", async () => {
  const originalCommand = process.env.CLAWCONNECT_ASR_COMMAND;
  process.env.CLAWCONNECT_ASR_COMMAND = "printf '你可以做什么？'";
  try {
    const prepared = await prepareHermesVoiceInputCommand(
      {
        sessionKey: "main",
        idempotencyKey: "voice-client-run-1",
        audio: {
          fileName: "voice-input.m4a",
          mimeType: "audio/mp4",
          content: Buffer.from("fake-audio", "utf8").toString("base64"),
        },
      },
      { requestId: "relay-request-1" },
    );

    assert.equal(prepared.method, "chat.send");
    assert.deepEqual(prepared.run, {
      runId: "voice-client-run-1",
      sessionKey: "main",
    });
    assert.equal((prepared.params as Record<string, unknown>).message, "你可以做什么？");
  } finally {
    if (originalCommand === undefined) {
      delete process.env.CLAWCONNECT_ASR_COMMAND;
    } else {
      process.env.CLAWCONNECT_ASR_COMMAND = originalCommand;
    }
  }
});
