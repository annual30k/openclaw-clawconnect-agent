import assert from "assert/strict";
import test from "node:test";
import { sendVoiceReplyCommand, synthesizeVoiceReplyAudio } from "./voice-reply.js";

test("voice reply audio prefers edge synthesis when available", async () => {
  const calls: string[] = [];

  await synthesizeVoiceReplyAudio(
    {
      text: "你好，OpenClaw。",
      audioPath: "/tmp/openclaw-voice-reply.mp3",
      rate: "+15%",
    },
    {
      synthesizeEdgeTtsImpl: async (opts) => {
        calls.push(`edge:${opts.rate ?? "default"}`);
      },
      synthesizeSystemTtsImpl: async () => {
        calls.push("system");
      },
    },
  );

  assert.deepEqual(calls, ["edge:+15%"]);
});

test("voice reply audio falls back to system TTS when edge synthesis fails", async () => {
  const calls: Array<{ name: string; strict?: boolean }> = [];

  await synthesizeVoiceReplyAudio(
    {
      text: "你好，OpenClaw。",
      audioPath: "/tmp/openclaw-voice-reply.mp3",
      rate: "-20%",
    },
    {
      synthesizeEdgeTtsImpl: async () => {
        calls.push({ name: "edge" });
        throw new Error("edge_tts_unavailable");
      },
      synthesizeSystemTtsImpl: async (opts) => {
        calls.push({ name: "system", strict: opts.strict });
        assert.equal(opts.rate, "-20%");
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
          rate: opts.rate,
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
    rate: undefined,
  });
});

test("send-voice-reply strips markdown formatting and emoji before synthesis", async () => {
  let synthesizedText: string | undefined;
  let sendFileTranscript: string | undefined;
  const input = "这里是 *加粗*，还有 👌 和 [链接](https://example.com) 。";

  await sendVoiceReplyCommand(
    {
      text: input,
      gateway: "gw-1",
      session: "main",
    },
    {
      synthesizeEdgeTtsImpl: async (opts) => {
        synthesizedText = opts.text;
      },
      sendFileCommandImpl: async (opts) => {
        sendFileTranscript = opts.transcript;
        return { ok: true } as never;
      },
    },
  );

  assert.equal(synthesizedText, "这里是 加粗，还有 和 链接 。");
  assert.equal(sendFileTranscript, input);
});
