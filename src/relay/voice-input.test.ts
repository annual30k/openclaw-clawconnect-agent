import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareVoiceSendParams, voiceInputSetupMessage } from "./voice-input.js";

test("prepareVoiceSendParams transcribes inline audio and returns chat.send params", async () => {
  const stagingDir = await mkdtemp(join(tmpdir(), "clawconnect-voice-input-test-"));
  try {
    let audioPath = "";
    const params = await prepareVoiceSendParams(
      {
        sessionKey: "agent:main:main",
        idempotencyKey: "run-1",
        audio: {
          fileName: "prompt.m4a",
          mimeType: "audio/mp4",
          content: Buffer.from("fake-audio", "utf8").toString("base64"),
        },
        languageHint: "zh-CN",
      },
      {
        stagingDir,
        transcribeAudioImpl: async (opts) => {
          audioPath = opts.audioPath;
          assert.equal(opts.mimeType, "audio/mp4");
          assert.equal(opts.languageHint, "zh-CN");
          return "打开最近的项目";
        },
      },
    );

    assert.deepEqual(params, {
      sessionKey: "agent:main:main",
      idempotencyKey: "run-1",
      message: "打开最近的项目",
    });
    assert.equal(await readFile(audioPath, "utf8"), "fake-audio");
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("prepareVoiceSendParams combines typed context with host transcript", async () => {
  const stagingDir = await mkdtemp(join(tmpdir(), "clawconnect-voice-input-test-"));
  try {
    const params = await prepareVoiceSendParams(
      {
        sessionKey: "main",
        message: "请用中文回答。",
        attachments: [
          {
            fileName: "voice.wav",
            mimeType: "audio/wav",
            content: Buffer.from("wav-body", "utf8").toString("base64"),
          },
        ],
      },
      {
        stagingDir,
        transcribeAudioImpl: async () => "总结今天的任务",
      },
    );

    assert.equal((params as Record<string, unknown>).message, "请用中文回答。\n\n总结今天的任务");
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("prepareVoiceSendParams rejects non-audio voice payloads", async () => {
  await assert.rejects(
    () => prepareVoiceSendParams({
      audio: {
        fileName: "note.txt",
        mimeType: "text/plain",
        content: Buffer.from("hello", "utf8").toString("base64"),
      },
    }),
    /voice_audio_required/,
  );
});

test("prepareVoiceSendParams rejects empty transcripts", async () => {
  await assert.rejects(
    () => prepareVoiceSendParams(
      {
        audio: {
          fileName: "voice.mp3",
          mimeType: "audio/mpeg",
          content: Buffer.from("mp3", "utf8").toString("base64"),
        },
      },
      {
        transcribeAudioImpl: async () => "   ",
      },
    ),
    /voice_transcript_empty/,
  );
});

test("voiceInputSetupMessage explains missing ASR skill installation path", () => {
  const message = voiceInputSetupMessage(new Error("voice_asr_not_configured"));
  assert.ok(message?.includes("语音转文字（SenseVoice int8）"));
  assert.ok(message?.includes("OPENCLAW_ASR_COMMAND"));
});
