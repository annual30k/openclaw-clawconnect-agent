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

  return latestTerminalAssistantReplyFromHermesExport(exportResult.payload, params.userMessage);
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

  const beforeIds = new Set((options.beforeSessions ?? []).map((session) => session.hermesSessionId));
  const newSessions = sessions.filter((session) => !beforeIds.has(session.hermesSessionId));
  if (newSessions.length === 0) {
    return sessions[0];
  }

  const normalizedUserMessage = normalizeSessionSelectionText(options.userMessage);
  if (normalizedUserMessage) {
    const matched = newSessions.find((session) => {
      const haystack = normalizeSessionSelectionText([
        session.displayName,
        session.derivedTitle,
        session.label,
      ].filter(Boolean).join(" "));
      return haystack.length > 0
        && (haystack.includes(normalizedUserMessage) || normalizedUserMessage.includes(haystack));
    });
    if (matched) {
      return matched;
    }
  }

  return newSessions[0];
}

export function latestTerminalAssistantReplyFromHermesExport(
  payload: unknown,
  userMessage: string,
): string | undefined {
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

  const normalizedUser = normalizeSessionSelectionText(userMessage);
  if (!normalizedUser) {
    return undefined;
  }
  // Hermes export 可能包含旧轮次和同文案提示，必须先确认最后一个 user 消息属于当前请求，
  // 再取其后的 assistant 回复，避免把历史回复当成当前最终结果。
  let latestUserIndex = -1;
  let latestUserMatchesCurrentRequest = false;
  for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
    const message = toRecord(rawMessages[index]);
    if (normalizeHistoryRoleValue(message.role) !== "user") {
      continue;
    }
    const text = normalizeSessionSelectionText(extractHermesHistoryText(message));
    latestUserIndex = index;
    latestUserMatchesCurrentRequest = text.length > 0
      && (text.includes(normalizedUser) || normalizedUser.includes(text));
    break;
  }
  if (latestUserIndex < 0 || !latestUserMatchesCurrentRequest) {
    return undefined;
  }

  for (let index = rawMessages.length - 1; index >= latestUserIndex + 1; index -= 1) {
    const message = toRecord(rawMessages[index]);
    if (normalizeHistoryRoleValue(message.role) !== "assistant") {
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
      return text;
    }
  }
  return undefined;
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

function normalizeSessionSelectionText(value: string | undefined): string {
  return value
    ?.replace(/\[Hermes runtime context][\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .toLowerCase() ?? "";
}
