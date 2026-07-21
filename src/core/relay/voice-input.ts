import { execFile as execFileCb } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { extensionForMimeType } from "./attachment-staging.js";
import { buildShellCommandInvocation, quoteShellArgument } from "../../platform/process-invocation.js";

const execFile = promisify(execFileCb);

export interface VoiceTranscriptionOptions {
  audioPath: string;
  mimeType: string;
  languageHint?: string;
}

export interface VoiceSendParamsOptions {
  stagingDir?: string;
  transcribeAudioImpl?: (opts: VoiceTranscriptionOptions) => Promise<string>;
}

type VoiceAudioPayload = {
  fileName: string;
  mimeType: string;
  content: string;
};

export async function prepareVoiceSendParams(
  rawParams: unknown,
  options: VoiceSendParamsOptions = {},
): Promise<unknown> {
  const record = rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
    ? { ...(rawParams as Record<string, unknown>) }
    : {};
  const audio = resolveVoiceAudioPayload(record);
  if (!audio) {
    throw new Error("voice_audio_required");
  }
  if (!audio.mimeType.toLowerCase().startsWith("audio/")) {
    throw new Error("voice_audio_required");
  }

  const languageHint = stringValue(record.languageHint) ?? stringValue(record.language);
  const stagingRoot = options.stagingDir ?? await mkdtemp(join(tmpdir(), "clawconnect-voice-input-"));
  await mkdir(stagingRoot, { recursive: true });
  const audioPath = join(stagingRoot, resolveVoiceAudioFileName(audio));
  await writeFile(audioPath, Buffer.from(audio.content, "base64"));

  const transcribeAudio = options.transcribeAudioImpl ?? transcribeAudioWithConfiguredCommand;
  const transcript = (await transcribeAudio({
    audioPath,
    mimeType: audio.mimeType,
    languageHint,
  })).trim();
  if (!transcript) {
    throw new Error("voice_transcript_empty");
  }

  const typedMessage = stringValue(record.message);
  const message = typedMessage ? `${typedMessage}\n\n${transcript}` : transcript;
  const next: Record<string, unknown> = {
    ...record,
    message,
  };
  delete next.audio;
  delete next.languageHint;
  delete next.language;
  delete next.attachments;
  return next;
}

export function voiceInputSetupMessage(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("voice_asr_not_configured")) {
    return undefined;
  }
  return [
    "未安装语音输入技能，暂时不能使用语音对话。",
    "安装路径：ClawLink → 技能扩展 → 语音转文字（SenseVoice int8）→ 安装。",
    "安装完成后会写入 CLAWCONNECT_ASR_COMMAND；旧版 OPENCLAW_ASR_COMMAND 仍兼容。然后重启 ClawConnect 再试。",
  ].join("\n");
}

async function transcribeAudioWithConfiguredCommand(opts: VoiceTranscriptionOptions): Promise<string> {
  const command =
    process.env.CLAWCONNECT_ASR_COMMAND?.trim()
    || process.env.OPENCLAW_ASR_COMMAND?.trim();
  if (!command) {
    throw new Error("voice_asr_not_configured");
  }
  const rendered = command
    .replaceAll("{file}", quoteShellArgument(opts.audioPath))
    .replaceAll("{language}", quoteShellArgument(opts.languageHint ?? ""))
    .replaceAll("{mimeType}", quoteShellArgument(opts.mimeType));
  const invocation = buildShellCommandInvocation(rendered);
  const { stdout } = await execFile(invocation.command, invocation.args, {
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
  });
  return stdout.trim();
}

function resolveVoiceAudioPayload(record: Record<string, unknown>): VoiceAudioPayload | undefined {
  const inline = normalizeAudioRecord(record.audio);
  if (inline) {
    return inline;
  }
  const attachments = Array.isArray(record.attachments) ? record.attachments : [];
  for (const attachment of attachments) {
    const normalized = normalizeAudioRecord(attachment);
    if (normalized?.mimeType.toLowerCase().startsWith("audio/")) {
      return normalized;
    }
  }
  return undefined;
}

function normalizeAudioRecord(value: unknown): VoiceAudioPayload | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const content = stringValue(record.content);
  if (!content) {
    return undefined;
  }
  const mimeType = stringValue(record.mimeType) ?? stringValue(record.contentType) ?? stringValue(record.type) ?? "application/octet-stream";
  const fileName = sanitizeFileName(
    stringValue(record.fileName) ?? stringValue(record.name) ?? stringValue(record.filename),
    mimeType,
  );
  return { fileName, mimeType, content };
}

function resolveVoiceAudioFileName(audio: VoiceAudioPayload): string {
  const ext = extname(audio.fileName);
  return ext ? audio.fileName : `${audio.fileName}${extensionForMimeType(audio.mimeType)}`;
}

function sanitizeFileName(value: string | undefined, mimeType: string): string {
  const fallback = `voice-input${extensionForMimeType(mimeType)}`;
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  const leaf = basename(trimmed.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return leaf || fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
