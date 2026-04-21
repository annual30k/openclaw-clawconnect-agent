import assert from "assert/strict";
import test from "node:test";
import { sendVoiceReplyCommand, synthesizeVoiceReplyAudio } from "./voice-reply.js";

test("voice reply audio prefers edge synthesis when available", async () => {
  const calls: string[] = [];

  await synthesizeVoiceReplyAudio(
    {
      text: "你好，OpenClaw。",
      audioPath: "/tmp/openclaw-voice-reply.mp3",
    },
    {
      synthesizeEdgeTtsImpl: async () => {
        calls.push("edge");
      },
      synthesizeSystemTtsImpl: async () => {
        calls.push("system");
      },
    },
  );

  assert.deepEqual(calls, ["edge"]);
});

test("voice reply audio falls back to system TTS when edge synthesis fails", async () => {
  const calls: Array<{ name: string; strict?: boolean }> = [];

  await synthesizeVoiceReplyAudio(
    {
      text: "你好，OpenClaw。",
      audioPath: "/tmp/openclaw-voice-reply.mp3",
    },
    {
      synthesizeEdgeTtsImpl: async () => {
        calls.push({ name: "edge" });
        throw new Error("edge_tts_unavailable");
      },
      synthesizeSystemTtsImpl: async (opts) => {
        calls.push({ name: "system", strict: opts.strict });
      },
    },
  );

  assert.deepEqual(calls, [
    { name: "edge" },
    { name: "system", strict: false },
  ]);
});

test("send-voice-reply uploads the synthesized file after generation", async () => {
  let sendFileArgs: Record<string, unknown> | undefined;

  const result = await sendVoiceReplyCommand(
    {
      text: "Hello, OpenClaw.",
      gateway: "gw-1",
      session: "main",
    },
    {
      synthesizeEdgeTtsImpl: async () => {
        // Do nothing in the test path.
      },
      sendFileCommandImpl: async (opts) => {
        sendFileArgs = {
          filePath: opts.filePath,
          gateway: opts.gateway,
          session: opts.session,
          durationMs: opts.durationMs,
          transcript: opts.transcript,
        };
        return { ok: true } as never;
      },
    },
  );

  assert.ok(result.audioPath.endsWith("reply.mp3"));
  assert.equal(result.durationMs > 0, true);
  assert.ok(sendFileArgs);
  assert.deepEqual(sendFileArgs, {
    filePath: result.audioPath,
    gateway: "gw-1",
    session: "main",
    durationMs: result.durationMs,
    transcript: "Hello, OpenClaw.",
  });
});
