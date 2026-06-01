import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  resolveOpenClawSessionTranscript,
  type GatewaySessionDefaults,
} from "./session-context.js";

export type ChatSendUserMirrorDedupeRequest = {
  clientRunId: string;
  message: string;
  sessionKey?: string;
  senderId?: string;
  senderName?: string;
};

export type ChatSendUserMirrorDedupeTextResult = {
  text: string;
  changed: boolean;
  removedCount: number;
  rewiredCount: number;
};

export type ChatSendUserMirrorDedupeFileResult = Omit<ChatSendUserMirrorDedupeTextResult, "text"> & {
  transcriptPath?: string;
};

type ParsedLine = {
  line: string;
  parsed?: Record<string, unknown>;
  removed?: boolean;
};

const OPENCLAW_PROMPT_TIMESTAMP_PREFIX =
  /^\[[A-Z][a-z]{2}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+GMT[+-]\d{1,2}(?::?\d{2})?\]\s*/;

export function dedupeChatSendUserMirrorTranscriptText(
  transcriptText: string,
  request: ChatSendUserMirrorDedupeRequest,
): ChatSendUserMirrorDedupeTextResult {
  const normalizedClientRunId = request.clientRunId.trim();
  const normalizedMessage = normalizeDedupeText(request.message);
  if (!normalizedClientRunId || !normalizedMessage) {
    return unchangedTextResult(transcriptText);
  }

  const hasTrailingNewline = transcriptText.endsWith("\n");
  const body = hasTrailingNewline ? transcriptText.slice(0, -1) : transcriptText;
  const entries = parseTranscriptLines(body.length > 0 ? body.split("\n") : []);
  const original = entries.find((entry) => isCanonicalMobileUserMessage(entry.parsed, normalizedClientRunId, normalizedMessage));
  const originalId = typeof original?.parsed?.id === "string" ? original.parsed.id : undefined;
  if (!originalId) {
    return unchangedTextResult(transcriptText);
  }

  const removedParentById = new Map<string, string | undefined>();
  let removedCount = 0;
  for (const entry of entries) {
    if (!entry.parsed || entry === original) {
      continue;
    }
    if (!isDuplicatePromptMirror(entry.parsed, originalId, normalizedMessage, request)) {
      continue;
    }
    const id = typeof entry.parsed.id === "string" ? entry.parsed.id : undefined;
    if (!id) {
      continue;
    }
    entry.removed = true;
    removedParentById.set(id, typeof entry.parsed.parentId === "string" ? entry.parsed.parentId : undefined);
    removedCount += 1;
  }

  if (removedCount === 0) {
    return unchangedTextResult(transcriptText);
  }

  let rewiredCount = 0;
  const retainedLines = entries.flatMap((entry) => {
    if (entry.removed) {
      return [];
    }
    if (!entry.parsed || typeof entry.parsed.parentId !== "string") {
      return [entry.line];
    }
    const rewiredParentId = resolveRewiredParentId(entry.parsed.parentId, removedParentById);
    if (!rewiredParentId || rewiredParentId === entry.parsed.parentId) {
      return [entry.line];
    }
    rewiredCount += 1;
    return [JSON.stringify({ ...entry.parsed, parentId: rewiredParentId })];
  });

  return {
    text: retainedLines.join("\n") + (hasTrailingNewline ? "\n" : ""),
    changed: true,
    removedCount,
    rewiredCount,
  };
}

export async function dedupeOpenClawChatSendUserMirrorTranscript(
  request: ChatSendUserMirrorDedupeRequest,
  defaults: GatewaySessionDefaults,
  opts: { maxRetries?: number } = {},
): Promise<ChatSendUserMirrorDedupeFileResult> {
  const transcript = await resolveOpenClawSessionTranscript(request.sessionKey ?? defaults.mainSessionKey, defaults);
  if (!transcript) {
    return { changed: false, removedCount: 0, rewiredCount: 0 };
  }

  const maxRetries = Math.max(1, Math.round(opts.maxRetries ?? 3));
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const before = await stat(transcript.logPath);
    const raw = await readFile(transcript.logPath, "utf8");
    const result = dedupeChatSendUserMirrorTranscriptText(raw, request);
    if (!result.changed) {
      return { ...stripText(result), transcriptPath: transcript.logPath };
    }

    const tmpPath = join(dirname(transcript.logPath), `.${basename(transcript.logPath)}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tmpPath, result.text, { encoding: "utf8", mode: before.mode & 0o777 });
    try {
      const after = await stat(transcript.logPath);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        await rm(tmpPath, { force: true });
        continue;
      }
      await rename(tmpPath, transcript.logPath);
      return { ...stripText(result), transcriptPath: transcript.logPath };
    } catch (error) {
      await rm(tmpPath, { force: true });
      throw error;
    }
  }

  return { changed: false, removedCount: 0, rewiredCount: 0, transcriptPath: transcript.logPath };
}

function parseTranscriptLines(lines: string[]): ParsedLine[] {
  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return { line };
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return isRecord(parsed) ? { line, parsed } : { line };
    } catch {
      return { line };
    }
  });
}

function isCanonicalMobileUserMessage(
  entry: Record<string, unknown> | undefined,
  clientRunId: string,
  normalizedMessage: string,
): boolean {
  const message = transcriptMessage(entry);
  if (!message || message.role !== "user") {
    return false;
  }
  return message.idempotencyKey === `${clientRunId}:user` &&
    normalizeDedupeText(extractMessageText(message.content)) === normalizedMessage;
}

function isDuplicatePromptMirror(
  entry: Record<string, unknown>,
  originalId: string,
  normalizedMessage: string,
  request: ChatSendUserMirrorDedupeRequest,
): boolean {
  if (entry.parentId !== originalId) {
    return false;
  }
  const message = transcriptMessage(entry);
  if (!message || message.role !== "user") {
    return false;
  }
  return isOpenClawPromptMirror(message) &&
    isExpectedClawConnectSender(message, request) &&
    normalizeDedupeText(extractMessageText(message.content)) === normalizedMessage;
}

function transcriptMessage(entry: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!entry || entry.type !== "message") {
    return undefined;
  }
  return isRecord(entry.message) ? entry.message : undefined;
}

function isOpenClawPromptMirror(message: Record<string, unknown>): boolean {
  const idempotencyKey = typeof message.idempotencyKey === "string" ? message.idempotencyKey.trim() : "";
  if (idempotencyKey.startsWith("codex-app-server:") && idempotencyKey.endsWith(":prompt")) {
    return true;
  }
  const openclaw = isRecord(message.__openclaw) ? message.__openclaw : undefined;
  const mirrorIdentity = typeof openclaw?.mirrorIdentity === "string" ? openclaw.mirrorIdentity.trim() : "";
  return mirrorIdentity.endsWith(":prompt");
}

function isExpectedClawConnectSender(
  message: Record<string, unknown>,
  request: ChatSendUserMirrorDedupeRequest,
): boolean {
  const expectedSenderId = request.senderId?.trim();
  const expectedSenderName = request.senderName?.trim();
  if (!expectedSenderId && !expectedSenderName) {
    return false;
  }

  const senderId = typeof message.senderId === "string" ? message.senderId.trim() : "";
  const senderName = typeof message.senderName === "string" ? message.senderName.trim() : "";
  const senderUsername = typeof message.senderUsername === "string" ? message.senderUsername.trim() : "";
  const senderLabel = typeof message.senderLabel === "string" ? message.senderLabel.trim() : "";
  return Boolean(
    (expectedSenderId && (senderId === expectedSenderId || senderLabel.includes(expectedSenderId))) ||
      (expectedSenderName && (
        senderName === expectedSenderName ||
        senderUsername === expectedSenderName ||
        senderLabel.includes(expectedSenderName)
      )),
  );
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (!isRecord(block)) {
        return "";
      }
      if (typeof block.text === "string") {
        return block.text;
      }
      return typeof block.content === "string" ? block.content : "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeDedupeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(OPENCLAW_PROMPT_TIMESTAMP_PREFIX, "").trim();
}

function resolveRewiredParentId(parentId: string, removedParentById: Map<string, string | undefined>): string | undefined {
  let current: string | undefined = parentId;
  const seen = new Set<string>();
  while (current && removedParentById.has(current) && !seen.has(current)) {
    seen.add(current);
    current = removedParentById.get(current);
  }
  return current;
}

function unchangedTextResult(text: string): ChatSendUserMirrorDedupeTextResult {
  return {
    text,
    changed: false,
    removedCount: 0,
    rewiredCount: 0,
  };
}

function stripText(result: ChatSendUserMirrorDedupeTextResult): Omit<ChatSendUserMirrorDedupeTextResult, "text"> {
  return {
    changed: result.changed,
    removedCount: result.removedCount,
    rewiredCount: result.rewiredCount,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
