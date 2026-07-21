import { readdir, readFile } from "fs/promises";
import { basename, isAbsolute, join, resolve } from "path";
import { resolveOpenClawStateDir } from "./runtime/openclaw-paths.js";

export async function inferLatestOpenClawSessionKey(sessionStoreRoot = resolveOpenClawStateDir()): Promise<string | undefined> {
  const agentsDir = join(sessionStoreRoot, "agents");
  let agentEntries;
  try {
    agentEntries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  let latestSessionKey: string | undefined;
  let latestUpdatedAt = -1;

  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) {
      continue;
    }

    const sessionsPath = join(agentsDir, agentEntry.name, "sessions", "sessions.json");
    let rawStore: string;
    try {
      rawStore = await readFile(sessionsPath, "utf8");
    } catch {
      continue;
    }

    let parsedStore: unknown;
    try {
      parsedStore = JSON.parse(rawStore);
    } catch {
      continue;
    }
    if (!parsedStore || typeof parsedStore !== "object" || Array.isArray(parsedStore)) {
      continue;
    }

    for (const [sessionKey, value] of Object.entries(parsedStore as Record<string, unknown>)) {
      if (!sessionKey.startsWith(`agent:${agentEntry.name}:`)) {
        continue;
      }

      const updatedAt = extractSessionUpdatedAt(value);
      if (updatedAt === undefined || updatedAt <= latestUpdatedAt) {
        continue;
      }

      latestSessionKey = sessionKey;
      latestUpdatedAt = updatedAt;
    }
  }

  return latestSessionKey;
}

export async function inferLatestOpenClawSendFileSourceRunId(input: {
  sessionKey: string;
  filePath?: string;
  sessionStoreRoot?: string;
}): Promise<string | undefined> {
  const logPath = await resolveOpenClawSessionLogPath(input.sessionKey, input.sessionStoreRoot);
  if (!logPath) {
    return undefined;
  }

  let rawTranscript: string;
  try {
    rawTranscript = await readFile(logPath, "utf8");
  } catch {
    return undefined;
  }

  const expectedPath = input.filePath ? resolve(input.filePath) : undefined;
  const expectedBasename = expectedPath ? basename(expectedPath) : undefined;
  const lines = rawTranscript.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const parsed = parseJsonRecord(lines[index]);
    if (!parsed || parsed.type !== "message") {
      continue;
    }
    const message = asRecord(parsed.message);
    if (!message || message.role !== "assistant") {
      continue;
    }
    if (!messageContainsSendFileToolCall(message, expectedPath, expectedBasename)) {
      continue;
    }

    // OpenClaw 文件回传必须绑定触发工具调用的用户 turn；assistant/tool id 只作为旧 transcript 的兜底。
    return findNearestUserTurnRunId(lines, index) ?? assistantToolRunId(message, parsed);
  }

  return undefined;
}

function findNearestUserTurnRunId(lines: string[], beforeIndex: number): string | undefined {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const parsed = parseJsonRecord(lines[index]);
    if (!parsed || parsed.type !== "message") {
      continue;
    }
    const message = asRecord(parsed.message);
    if (!message || message.role !== "user") {
      continue;
    }
    const runId = userTurnRunId(message, parsed);
    if (runId) {
      return runId;
    }
  }

  return undefined;
}

function userTurnRunId(message: Record<string, unknown>, parsed: Record<string, unknown>): string | undefined {
  const explicitRunId = normalizeRunId(firstString(
    message.sourceRunId,
    message.source_run_id,
    message.idempotencyKey,
    message.idempotency_key,
    message.clientRunId,
    message.client_run_id,
    message.clientMessageId,
    message.client_message_id,
    message.runId,
    message.run_id,
    message.turnId,
    message.turn_id,
  ));
  if (explicitRunId) {
    return explicitRunId;
  }

  return normalizeRunId(firstString(
    message.messageId,
    message.message_id,
    message.id,
    parsed.id,
  ));
}

function assistantToolRunId(message: Record<string, unknown>, parsed: Record<string, unknown>): string | undefined {
  return normalizeRunId(firstString(
    message.sourceRunId,
    message.source_run_id,
    message.runId,
    message.run_id,
    message.turnId,
    message.turn_id,
    message.messageId,
    message.message_id,
    message.id,
    parsed.id,
  ));
}

async function resolveOpenClawSessionLogPath(
  sessionKey: string,
  sessionStoreRoot = resolveOpenClawStateDir(),
): Promise<string | undefined> {
  const trimmedSessionKey = sessionKey.trim();
  if (!trimmedSessionKey) {
    return undefined;
  }
  const agentId = resolveAgentId(trimmedSessionKey);
  const sessionsDir = join(sessionStoreRoot, "agents", agentId, "sessions");
  let rawStore: string;
  try {
    rawStore = await readFile(join(sessionsDir, "sessions.json"), "utf8");
  } catch {
    return undefined;
  }

  const parsedStore = parseJsonRecord(rawStore);
  if (!parsedStore) {
    return undefined;
  }
  const entry =
    asRecord(parsedStore[trimmedSessionKey])
    ?? (trimmedSessionKey.startsWith("agent:")
      ? undefined
      : asRecord(parsedStore[`agent:${agentId}:${trimmedSessionKey}`]));
  if (!entry) {
    return undefined;
  }

  const candidate = firstString(entry.sessionFile, entry.transcriptPath);
  if (candidate) {
    return isAbsolute(candidate) ? candidate : resolve(sessionsDir, candidate);
  }
  const sessionId = firstString(entry.sessionId, entry.id);
  return sessionId ? join(sessionsDir, sessionId.endsWith(".jsonl") ? sessionId : `${sessionId}.jsonl`) : undefined;
}

function resolveAgentId(sessionKey: string): string {
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return match?.[1]?.trim() || "main";
}

function messageContainsSendFileToolCall(
  message: Record<string, unknown>,
  expectedPath: string | undefined,
  expectedBasename: string | undefined,
): boolean {
  const content = Array.isArray(message.content) ? message.content : [];
  return content.some((block) => {
    const record = asRecord(block);
    if (!record) {
      return false;
    }
    const name = firstString(record.name, record.toolName, record.tool_name);
    const type = firstString(record.type)?.toLowerCase();
    if (name && name !== "exec") {
      return false;
    }
    if (type && !["toolcall", "tool_call", "tool-use", "tooluse"].includes(type)) {
      return false;
    }
    const command = toolCallCommand(record);
    if (!command || !/\bclawconnect\s+send-file\b/.test(command)) {
      return false;
    }
    if (!expectedPath && !expectedBasename) {
      return true;
    }
    return Boolean(
      (expectedPath && command.includes(expectedPath))
        || (expectedBasename && command.includes(expectedBasename)),
    );
  });
}

function toolCallCommand(record: Record<string, unknown>): string | undefined {
  const args = asRecord(record.arguments);
  const direct = firstString(record.command, args?.command);
  if (direct) {
    return direct;
  }
  const partialArgs = firstString(record.partialArgs, record.partial_args);
  const parsedPartialArgs = partialArgs ? parseJsonRecord(partialArgs) : undefined;
  return firstString(parsedPartialArgs?.command);
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function normalizeRunId(value: string | undefined): string | undefined {
  let trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  for (const suffix of [":user", ":assistant", ":tool", ":system"]) {
    if (trimmed.endsWith(suffix)) {
      trimmed = trimmed.slice(0, -suffix.length);
      break;
    }
  }
  return trimmed || undefined;
}

function extractSessionUpdatedAt(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const candidateValues = [record.updatedAt, record.startedAt];
  for (const candidate of candidateValues) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string") {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}
