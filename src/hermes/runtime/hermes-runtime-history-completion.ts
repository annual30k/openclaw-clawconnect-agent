import type { HermesSessionItem } from "../hermes-session-store.js";
import { runHermesSessionExport } from "./hermes-runtime-sessions.js";
import { sanitizeHermesChatOutput } from "./hermes-runtime-process.js";
import { listHermesSessions } from "./hermes-runtime-usage.js";
import { toRecord } from "./hermes-runtime-values.js";

export async function detectHermesHistoryCompletion(params: {
  beforeSessions: HermesSessionItem[];
  resume?: string;
  sessionKey: string;
  userMessage: string;
  sourceRunId?: string;
}): Promise<string | undefined> {
  const sessions = await listHermesSessions();
  const mappedSession = selectHermesSessionForCompletedChat(sessions, {
    beforeSessions: params.beforeSessions,
    resume: params.resume,
    userMessage: params.userMessage,
  });
  if (!mappedSession?.hermesSessionId) {
    return undefined;
  }

  const exportResult = await runHermesSessionExport({
    sessionKey: params.sessionKey,
    hermesSessionId: mappedSession.hermesSessionId,
    output: "-",
  });
  if (!exportResult.ok) {
    return undefined;
  }

  // The explicit caller identity is preferred.  During migration, a fresh
  // Hermes export may still be the only place carrying the controlled mobile
  // turn marker; the completion matcher can recover it only when that export
  // contains exactly one such identity.  It never falls back to prompt text.
  return latestTerminalAssistantReplyFromHermesExport(exportResult.payload, params.sourceRunId);
}

export function selectHermesSessionForCompletedChat(
  sessions: HermesSessionItem[],
  options: {
    beforeSessions?: HermesSessionItem[];
    resume?: string;
    userMessage?: string;
  } = {},
): HermesSessionItem | undefined {
  const resume = options.resume?.trim();
  if (resume) {
    return sessions.find((session) => session.hermesSessionId === resume);
  }

  if (options.beforeSessions === undefined) {
    // Without a pre-turn snapshot there is no way to prove which existing
    // Hermes session belongs to this request.  The list order is not an
    // ownership signal.
    return undefined;
  }

  const beforeIds = new Set((options.beforeSessions ?? []).map((session) => session.hermesSessionId));
  const newSessions = sessions.filter((session) => !beforeIds.has(session.hermesSessionId));
  if (newSessions.length === 0) {
    // The newest/first listed session is presentation order, not ownership.
    // Without an explicit resume or a unique newly-created session, fail
    // closed instead of attaching this turn to an existing conversation.
    return undefined;
  }

  // Session titles/previews are presentation text, not ownership evidence.
  // When the provider does not return an explicit resume/session id, accept a
  // single newly-created session only; multiple candidates are ambiguous.
  return newSessions.length === 1 ? newSessions[0] : undefined;
}

export function latestTerminalAssistantReplyFromHermesExport(
  payload: unknown,
  sourceRunId?: string,
): string | undefined {
  const expectedSourceRunId = sourceRunId?.trim() || resolveSingleExportSourceRunId(payload);
  if (!expectedSourceRunId) {
    return undefined;
  }
  const output = toRecord(payload).output;
  const parsed = parseHermesChatExportOutput(output);
  const record = toRecord(parsed);
  const rawMessages = Array.isArray(record.messages)
    ? record.messages
    : Array.isArray(record.items)
      ? record.items
      : Array.isArray(parsed)
        ? parsed
        : [];
  if (rawMessages.length === 0) {
    return undefined;
  }

  // The explicit mobile-turn sourceRunId is the only ownership evidence.  The
  // export can carry it as a typed row field or in the controlled
  // `[ClawConnect mobile turn]` protocol marker on the user row.
  let latestUserIndex = -1;
  for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
    const message = toRecord(rawMessages[index]);
    if (normalizeHistoryRoleValue(message.role) !== "user") {
      continue;
    }
    if (messageSourceRunId(message) === expectedSourceRunId) {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) {
    return undefined;
  }

  let latestTerminalReply: string | undefined;
  for (let index = rawMessages.length - 1; index >= latestUserIndex + 1; index -= 1) {
    const message = toRecord(rawMessages[index]);
    // A subsequent user row begins another turn.  Do not let a later
    // unrelated response attach to the anchored source run.
    if (normalizeHistoryRoleValue(message.role) === "user") {
      break;
    }
    if (normalizeHistoryRoleValue(message.role) !== "assistant") {
      continue;
    }
    const explicitMessageRunId = explicitMessageSourceRunId(message);
    if (explicitMessageRunId && explicitMessageRunId !== expectedSourceRunId) {
      continue;
    }
    // Hermes 会在调用工具前写入带可见正文的 assistant 行，例如
    // “Let me use the browser…”。这类行的 finish_reason=tool_calls，
    // 只是中间步骤，绝不能让移动端提前结束并把它持久化为最终回答。
    if (!isTerminalHermesAssistantMessage(message)) {
      continue;
    }
    const text = sanitizeHermesChatOutput(extractHermesHistoryText(message)).trim();
    if (text) {
      latestTerminalReply = text;
    }
  }
  return latestTerminalReply;
}

export function isTerminalHermesAssistantMessage(message: Record<string, unknown>): boolean {
  const finishReason = normalizeHistoryFinishReason(
    message.finish_reason ?? message.finishReason,
  );
  if (finishReason === "tool_calls" || finishReason === "function_call") {
    return false;
  }
  if (hasHermesToolCalls(message.tool_calls ?? message.toolCalls)) {
    return false;
  }
  // 新版 Hermes 的最终行通常是 stop/length/content_filter；旧版导出没有
  // finish_reason，因此在明确没有 tool_calls 时继续兼容。
  return true;
}

/**
 * Read the stable source identity from a Hermes message's typed field or the
 * exact ClawConnect protocol marker.  This intentionally does not search
 * arbitrary prose for a run-id-shaped substring.
 */
export function hermesSourceRunIdFromMessage(message: Record<string, unknown>): string | undefined {
  return messageSourceRunId(message);
}

function normalizeHistoryFinishReason(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
}

function hasHermesToolCalls(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "[]" || trimmed === "{}" || trimmed === "null") {
      return false;
    }
    try {
      return hasHermesToolCalls(JSON.parse(trimmed) as unknown);
    } catch {
      return true;
    }
  }
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return true;
}

function parseHermesChatExportOutput(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const firstObjectBrace = trimmed.indexOf("{");
    const lastObjectBrace = trimmed.lastIndexOf("}");
    if (firstObjectBrace >= 0 && lastObjectBrace > firstObjectBrace) {
      try {
        return JSON.parse(trimmed.slice(firstObjectBrace, lastObjectBrace + 1)) as unknown;
      } catch {
        return {};
      }
    }
    return {};
  }
}

function normalizeHistoryRoleValue(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace("_", "") : "";
}

function extractHermesHistoryText(record: Record<string, unknown>): string {
  const content = record.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .flatMap((block) => {
        const blockRecord = toRecord(block);
        const type = typeof blockRecord.type === "string" ? blockRecord.type.trim().toLowerCase() : "";
        if (type && type !== "text" && type !== "output_text" && type !== "input_text") {
          return [];
        }
        return typeof blockRecord.text === "string" ? [blockRecord.text] : [];
      })
      .filter((text) => text.trim().length > 0)
      .join("\n\n");
  }
  for (const key of ["text", "message", "output"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

function messageSourceRunId(message: Record<string, unknown>): string | undefined {
  return explicitMessageSourceRunId(message)
    ?? sourceRunIdFromMobileTurnMarker(message);
}

function explicitMessageSourceRunId(message: Record<string, unknown>): string | undefined {
  for (const key of ["sourceRunId", "source_run_id", "runId", "run_id", "turnId", "turn_id"]) {
    const value = message[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function sourceRunIdFromMobileTurnMarker(message: Record<string, unknown>): string | undefined {
  if (normalizeHistoryRoleValue(message.role) !== "user") {
    return undefined;
  }
  const content = extractHermesHistoryText(message);
  // The agent appends the protocol block after user text. Use the final line
  // whose complete trimmed value is the marker so a user-supplied look-alike
  // or the explanatory instruction text cannot become the turn identity.
  const lines = content.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim() !== "[ClawConnect mobile turn]") {
      continue;
    }
    for (const line of lines.slice(index + 1)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) break;
      if (!trimmed.startsWith("sourceRunId:")) continue;
      const value = trimmed.slice("sourceRunId:".length).trim();
      return value || undefined;
    }
  }
  return undefined;
}

function resolveSingleExportSourceRunId(payload: unknown): string | undefined {
  const output = toRecord(payload).output;
  const parsed = parseHermesChatExportOutput(output);
  const record = toRecord(parsed);
  const rawMessages = Array.isArray(record.messages)
    ? record.messages
    : Array.isArray(record.items)
      ? record.items
      : Array.isArray(parsed)
        ? parsed
        : [];
  const ids = rawMessages.flatMap((entry) => {
    const message = toRecord(entry);
    const sourceRunId = normalizeHistoryRoleValue(message.role) === "user"
      ? messageSourceRunId(message)
      : undefined;
    return sourceRunId ? [sourceRunId] : [];
  });
  const uniqueIds = [...new Set(ids)];
  return uniqueIds.length === 1 ? uniqueIds[0] : undefined;
}
