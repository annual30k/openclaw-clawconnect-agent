import { execFile as execFileCb, execFileSync } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { sendFileCommand, type SendFileCommandOptions, type SendFileCommandDependencies } from "./send-file.js";

const execFile = promisify(execFileCb);

export interface VoiceReplyCommandOptions extends Pick<SendFileCommandOptions, "gateway" | "session"> {
  text: string;
  voice?: string;
  rate?: string;
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
  const originalText = normalizeVoiceText(opts.text);
  if (!originalText) {
    throw new Error("voice_reply_text_required");
  }
  const spokenText = stripVoiceReplyFormatting(originalText).replace(/\s+/g, " ").trim();
  if (!spokenText) {
    throw new Error("voice_reply_text_required");
  }

  const durationMs = estimateSpeechDurationMs(spokenText);
  const tempDir = await mkdtemp(join(tmpdir(), "clawconnect-voice-reply-"));
  const audioPath = join(tempDir, "reply.mp3");

  try {
    await synthesizeVoiceReplyAudio(
      {
        text: spokenText,
        audioPath,
        voice: opts.voice,
        rate: opts.rate,
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
        transcript: originalText,
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
    rate?: string;
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
        rate: opts.rate,
        strict: true,
      });
      return;
    }

  if (opts.speaker === "system") {
      await synthesizeSystemTts({
        text: opts.text,
        audioPath: opts.audioPath,
        voice: opts.voice,
        rate: opts.rate,
        strict: true,
      });
      return;
    }

  try {
    await synthesizeEdgeTts({
      text: opts.text,
      audioPath: opts.audioPath,
      voice: opts.voice,
      rate: opts.rate,
    });
    return;
  } catch (edgeError) {
    console.warn(`[voice-reply] edge-tts-universal failed, falling back to system TTS: ${String(edgeError)}`);
  }

  await synthesizeSystemTts({
    text: opts.text,
    audioPath: opts.audioPath,
    voice: opts.voice,
    rate: opts.rate,
    strict: false,
  });
}

async function synthesizeWithEdgeTts(opts: {
  text: string;
  audioPath: string;
  voice?: string;
  rate?: string;
}): Promise<void> {
  const { EdgeTTS } = await import("edge-tts-universal");
  const tts = new EdgeTTS(opts.text, resolveEdgeVoice(opts.text, opts.voice), resolveEdgeProsody(opts.rate));
  const result = await tts.synthesize();
  const audioBuffer = Buffer.from(await result.audio.arrayBuffer());
  await writeFile(opts.audioPath, audioBuffer);
}

async function synthesizeWithSystemTts(opts: {
  text: string;
  audioPath: string;
  voice?: string;
  rate?: string;
  strict?: boolean;
}): Promise<void> {
  if (process.platform === "darwin") {
    try {
      await synthesizeWithSay(
        opts.text,
        opts.audioPath,
        resolveSystemVoice(opts.text, opts.voice),
        resolveSystemSpeechRate(opts.rate),
      );
      return;
    } catch (error) {
      if (opts.strict) {
        throw error;
      }
    }
  }

  await synthesizeWithEspeak(opts.text, opts.audioPath, resolveSystemSpeechRate(opts.rate));
}

async function synthesizeWithSay(text: string, audioPath: string, voice?: string, rate?: number): Promise<void> {
  const args = ["-o", audioPath];
  if (voice && voice.trim()) {
    args.push("-v", voice.trim());
  }
  if (typeof rate === "number" && Number.isFinite(rate)) {
    args.push("-r", String(Math.max(80, Math.min(500, Math.round(rate)))));
  }
  args.push(text);
  await execFile("say", args);
}

async function synthesizeWithEspeak(text: string, audioPath: string, rate?: number): Promise<void> {
  try {
    const args = ["-w", audioPath];
    if (typeof rate === "number" && Number.isFinite(rate)) {
      args.push("-s", String(Math.max(80, Math.min(450, Math.round(rate)))));
    }
    args.push(text);
    await execFile("espeak-ng", args);
    return;
  } catch {
    const args = ["-w", audioPath];
    if (typeof rate === "number" && Number.isFinite(rate)) {
      args.push("-s", String(Math.max(80, Math.min(450, Math.round(rate)))));
    }
    args.push(text);
    await execFile("espeak", args);
  }
}

function resolveEdgeVoice(text: string, voice?: string): string {
  const preferredVoice = voice?.trim();
  if (preferredVoice && looksLikeEdgeVoice(preferredVoice)) {
    return preferredVoice;
  }
  return defaultEdgeVoice(text);
}

function resolveEdgeProsody(rate?: string): { rate?: string; volume?: string; pitch?: string } | undefined {
  const percent = parseRatePercent(rate);
  if (percent === undefined || percent === 0) {
    return undefined;
  }
  return {
    rate: formatRatePercent(percent),
    volume: "+0%",
    pitch: "+0Hz",
  };
}

function resolveSystemVoice(text: string, voice?: string): string | undefined {
  const preferredVoice = voice?.trim();
  if (preferredVoice && !looksLikeEdgeVoice(preferredVoice)) {
    return preferredVoice;
  }
  if (preferredVoice) {
    const mappedVoice = mapEdgeVoiceToSystemVoice(preferredVoice);
    if (mappedVoice) {
      return mappedVoice;
    }
  }
  return defaultMacVoice(text);
}

function resolveSystemSpeechRate(rate?: string): number | undefined {
  const percent = parseRatePercent(rate);
  if (percent === undefined || percent === 0) {
    return undefined;
  }
  const baseRate = 200;
  return Math.max(80, Math.min(500, Math.round(baseRate * (1 + percent / 100))));
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

function mapEdgeVoiceToSystemVoice(voice: string): string | undefined {
  const normalized = voice.trim().toLowerCase();
  if (normalized.includes("yunxi")) {
    return findSystemVoice([
      "Eddy (中文（中国大陆）)",
      "Eddy (中文（台湾）)",
      "Grandpa (中文（中国大陆）)",
      "Grandpa (中文（台湾）)",
      "Daniel",
      "Fred",
      "Aman",
      "Albert",
    ]);
  }
  if (normalized.includes("xiaoxiao")) {
    return findSystemVoice([
      "Flo (中文（中国大陆）)",
      "Flo (中文（台湾）)",
      "Grandma (中文（中国大陆）)",
      "Grandma (中文（台湾）)",
      "Samantha",
      "Moira",
      "Victoria",
    ]);
  }
  if (normalized.includes("andrew")) {
    return findSystemVoice([
      "Fred",
      "Daniel",
      "Aman",
      "Albert",
      "Eddy (英语（美国）)",
      "Grandpa (英语（美国）)",
    ]);
  }
  if (normalized.includes("emma")) {
    return findSystemVoice([
      "Samantha",
      "Victoria",
      "Flo (英语（美国）)",
      "Flo (英语（英国）)",
      "Flo",
      "Grandma (英语（美国）)",
    ]);
  }
  return undefined;
}

function findSystemVoice(candidates: string[]): string | undefined {
  const available = getSystemVoiceNames();
  for (const candidate of candidates) {
    if (available.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

let systemVoiceNamesCache: Set<string> | null = null;

function getSystemVoiceNames(): Set<string> {
  if (systemVoiceNamesCache) {
    return systemVoiceNamesCache;
  }

  if (process.platform !== "darwin") {
    systemVoiceNamesCache = new Set<string>();
    return systemVoiceNamesCache;
  }

  try {
    const output = execFileSync("say", ["-v", "?"], { encoding: "utf-8" }) as string;
    const names = new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.split(/\s{2,}/)[0]?.trim())
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    );
    systemVoiceNamesCache = names;
    return names;
  } catch {
    systemVoiceNamesCache = new Set<string>();
    return systemVoiceNamesCache;
  }
}

function normalizeVoiceText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripVoiceReplyFormatting(text: string): string {
  return stripMarkdownFormatting(stripEmoji(text));
}

function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\((?:[^()\\]|\\.|(?:\([^()]*\)))*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^()\\]|\\.|(?:\([^()]*\)))*\)/g, "$1")
    .replace(/```([\s\S]*?)```/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/[>*_`~]/g, "");
}

function stripEmoji(text: string): string {
  return text.replace(
    /(?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*)|(?:[\u{1F1E6}-\u{1F1FF}]{2})/gu,
    "",
  );
}

function parseRatePercent(rate?: string): number | undefined {
  const trimmed = rate?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.endsWith("%") ? trimmed.slice(0, -1).trim() : trimmed;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

function formatRatePercent(ratePercent: number): string {
  if (ratePercent > 0) {
    return `+${ratePercent}%`;
  }
  return `${ratePercent}%`;
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
