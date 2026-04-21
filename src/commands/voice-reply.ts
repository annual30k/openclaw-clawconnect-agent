import { execFile as execFileCb } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
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

export interface VoiceReplyCommandDependencies extends SendFileCommandDependencies {
  sendFileCommandImpl?: typeof sendFileCommand;
  synthesizeEdgeTtsImpl?: typeof synthesizeWithEdgeTts;
  synthesizeSystemTtsImpl?: typeof synthesizeWithSystemTts;
}

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
  const audioPath = join(tempDir, "reply.mp3");

  try {
    await synthesizeVoiceReplyAudio(
      {
        text,
        audioPath,
        voice: opts.voice,
        speaker: opts.speaker,
      },
      deps,
    );
    const sendFileResult = await (deps.sendFileCommandImpl ?? sendFileCommand)(
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
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function synthesizeVoiceReplyAudio(
  opts: {
    text: string;
    audioPath: string;
    voice?: string;
    speaker?: "system" | "espeak";
  },
  deps: Pick<VoiceReplyCommandDependencies, "synthesizeEdgeTtsImpl" | "synthesizeSystemTtsImpl"> = {},
): Promise<void> {
  const synthesizeEdgeTts = deps.synthesizeEdgeTtsImpl ?? synthesizeWithEdgeTts;
  const synthesizeSystemTts = deps.synthesizeSystemTtsImpl ?? synthesizeWithSystemTts;

  if (opts.speaker === "espeak") {
    await synthesizeSystemTts({
      text: opts.text,
      audioPath: opts.audioPath,
      voice: opts.voice,
      strict: true,
    });
    return;
  }

  if (opts.speaker === "system") {
    await synthesizeSystemTts({
      text: opts.text,
      audioPath: opts.audioPath,
      voice: opts.voice,
      strict: true,
    });
    return;
  }

  try {
    await synthesizeEdgeTts({
      text: opts.text,
      audioPath: opts.audioPath,
      voice: opts.voice,
    });
    return;
  } catch (edgeError) {
    console.warn(`[voice-reply] edge-tts-universal failed, falling back to system TTS: ${String(edgeError)}`);
  }

  await synthesizeSystemTts({
    text: opts.text,
    audioPath: opts.audioPath,
    voice: opts.voice,
    strict: false,
  });
}

async function synthesizeWithEdgeTts(opts: {
  text: string;
  audioPath: string;
  voice?: string;
}): Promise<void> {
  const { EdgeTTS } = await import("edge-tts-universal");
  const tts = new EdgeTTS(opts.text, resolveEdgeVoice(opts.text, opts.voice));
  const result = await tts.synthesize();
  const audioBuffer = Buffer.from(await result.audio.arrayBuffer());
  await writeFile(opts.audioPath, audioBuffer);
}

async function synthesizeWithSystemTts(opts: {
  text: string;
  audioPath: string;
  voice?: string;
  strict?: boolean;
}): Promise<void> {
  if (process.platform === "darwin") {
    try {
      await synthesizeWithSay(opts.text, opts.audioPath, resolveSystemVoice(opts.text, opts.voice));
      return;
    } catch (error) {
      if (opts.strict) {
        throw error;
      }
    }
  }

  await synthesizeWithEspeak(opts.text, opts.audioPath);
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

function resolveEdgeVoice(text: string, voice?: string): string {
  const preferredVoice = voice?.trim();
  if (preferredVoice && looksLikeEdgeVoice(preferredVoice)) {
    return preferredVoice;
  }
  return defaultEdgeVoice(text);
}

function resolveSystemVoice(text: string, voice?: string): string | undefined {
  const preferredVoice = voice?.trim();
  if (preferredVoice && !looksLikeEdgeVoice(preferredVoice)) {
    return preferredVoice;
  }
  return defaultMacVoice(text);
}

function looksLikeEdgeVoice(voice: string): boolean {
  return /Neural$/i.test(voice);
}

function defaultEdgeVoice(text: string): string {
  if (containsCjk(text)) {
    return "zh-CN-XiaoxiaoNeural";
  }
  return "en-US-EmmaMultilingualNeural";
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
