import { execFile as execFileCb } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { sendFileCommand, type SendFileCommandOptions, type SendFileCommandDependencies } from "./send-file.js";

const execFile = promisify(execFileCb);

export interface VoiceReplyCommandOptions extends Pick<SendFileCommandOptions, "gateway" | "session"> {
  text: string;
  voice?: string;
  speaker?: "system" | "espeak";
}

export interface VoiceReplyCommandDependencies extends SendFileCommandDependencies {}

export interface VoiceReplyCommandResult {
  audioPath: string;
  durationMs: number;
  sendFileResult: Awaited<ReturnType<typeof sendFileCommand>>;
}

export async function sendVoiceReplyCommand(
  opts: VoiceReplyCommandOptions,
  deps: VoiceReplyCommandDependencies = {},
): Promise<VoiceReplyCommandResult> {
  const text = normalizeVoiceText(opts.text);
  if (!text) {
    throw new Error("voice_reply_text_required");
  }

  const durationMs = estimateSpeechDurationMs(text);
  const tempDir = await mkdtemp(join(tmpdir(), "clawconnect-voice-reply-"));
  const extension = process.platform === "darwin" ? "aiff" : "wav";
  const audioPath = join(tempDir, `reply.${extension}`);

  try {
    await synthesizeAudio(text, audioPath, opts.voice, opts.speaker);
    const sendFileResult = await sendFileCommand(
      {
        filePath: audioPath,
        gateway: opts.gateway,
        session: opts.session,
        durationMs,
        transcript: opts.text,
      },
      deps,
    );
    return {
      audioPath,
      durationMs,
      sendFileResult,
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function synthesizeAudio(
  text: string,
  audioPath: string,
  voice?: string,
  speaker?: "system" | "espeak",
): Promise<void> {
  if (speaker === "espeak") {
    await synthesizeWithEspeak(text, audioPath);
    return;
  }

  if (process.platform === "darwin") {
    try {
      await synthesizeWithSay(text, audioPath, voice ?? defaultMacVoice(text));
      return;
    } catch (error) {
      if (speaker === "system") {
        throw error;
      }
    }
  }

  await synthesizeWithEspeak(text, audioPath);
}

async function synthesizeWithSay(text: string, audioPath: string, voice?: string): Promise<void> {
  const args = ["-o", audioPath];
  if (voice && voice.trim()) {
    args.push("-v", voice.trim());
  }
  args.push(text);
  await execFile("say", args);
}

async function synthesizeWithEspeak(text: string, audioPath: string): Promise<void> {
  try {
    await execFile("espeak-ng", ["-w", audioPath, text]);
    return;
  } catch {
    await execFile("espeak", ["-w", audioPath, text]);
  }
}

function defaultMacVoice(text: string): string | undefined {
  if (!containsCjk(text)) {
    return undefined;
  }
  return process.env.OPENCLAW_TTS_VOICE?.trim() || "Ting-Ting";
}

function normalizeVoiceText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

function estimateSpeechDurationMs(text: string): number {
  const normalized = normalizeVoiceText(text);
  if (!normalized) {
    return 0;
  }
  return Math.max(1200, Math.round(normalized.length * 180));
}
