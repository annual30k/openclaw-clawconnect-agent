
import { randomUUID } from "crypto";
import { readFileSync, statSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";
import type { LocalCommandContext } from "../../core/command-types.js";
import {
  buildMobileAssistantDeltaPayload,
} from "../../core/relay/mobile-chat-run-bridge.js";
import {
  buildToolInvocationUpdatedEvent,
} from "../../core/relay/timeline-event-builder.js";
import type { ToolState } from "../../core/relay/timeline-event-log.js";
import {
  forgetHermesSession,
  getMappedHermesSessionId,
  rememberHermesSession,
  type HermesSessionItem,
} from "../hermes-session-store.js";
import { extractDeliverablePaths } from "./hermes-runtime-artifacts.js";
import { runHermesSessionExport } from "./hermes-runtime-sessions.js";
import {
  CHAT_TIMEOUT_MS,
  CLAWCONNECT_MOBILE_BRIDGE_HINT,
  HERMES_AGENT_LOG_FILE,
  HERMES_INBOX_DIR,
  SUBPROCESS_ENV,
  resolveHermesBin,
  isHermesCommandDeniedTimeoutLine,
  isHermesMissingSessionError,
  runHermes,
  runHermesPython,
  sanitizeHermesChatOutput,
  stripAnsi,
  stripHermesSessionResumeNotices,
} from "./hermes-runtime-process.js";
import type { HermesChatResult, HermesToolLogEvent, HermesUsageSnapshot } from "./hermes-runtime-types.js";
import { collectHermesUsageSnapshot, listHermesSessions, readHermesStatusSnapshot } from "./hermes-runtime-usage.js";
import { compactStringArray, sanitizeFileName, toRecord } from "./hermes-runtime-values.js";

const HERMES_ASSISTANT_DELTA_FLUSH_MS = 120;
const HERMES_ASSISTANT_DELTA_MAX_BYTES = 4096;
const HERMES_HISTORY_COMPLETION_GRACE_MS = 2_000;
const HERMES_HISTORY_COMPLETION_POLL_MS = 1_000;
const HERMES_COMMAND_DENIED_TIMEOUT_MESSAGE = "Timeout – denying command";
const hermesChatQueues = new Map<string, Promise<void>>();
const HERMES_SLASH_COMMAND_SCRIPT = String.raw`
import contextlib
import io
import json
import os
import sys

from rich.console import Console

import cli as cli_mod
from cli import HermesCLI

command = os.environ.get("CLAWCONNECT_HERMES_SLASH_COMMAND", "").strip()
resume = os.environ.get("CLAWCONNECT_HERMES_SLASH_RESUME", "").strip() or None
if command and not command.startswith("/"):
    command = "/" + command

with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    cli = HermesCLI(model=None, compact=True, resume=resume, verbose=False)

buf = io.StringIO()
cli.console = Console(file=buf, force_terminal=True, width=120)

def approve_once(prompt=""):
    if prompt:
        print(prompt, end="")
    return "1"

def approve_once_modal(*args, **kwargs):
    return "once"

try:
    cli._prompt_text_input = approve_once
    cli._prompt_text_input_modal = approve_once_modal
except Exception:
    pass

old_cprint = getattr(cli_mod, "_cprint", None)
if old_cprint is not None:
    cli_mod._cprint = lambda text: print(text)

try:
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        keep_going = cli.process_command(command)
    pending_inputs = []
    pending_queue = getattr(cli, "_pending_input", None)
    if pending_queue is not None:
        while True:
            try:
                pending_inputs.append(pending_queue.get_nowait())
            except Exception:
                break
    payload = {
        "ok": True,
        "output": buf.getvalue().rstrip(),
        "sessionId": getattr(cli, "session_id", None),
        "keepGoing": bool(keep_going),
        "pendingInputs": pending_inputs,
    }
except Exception as exc:
    payload = {
        "ok": False,
        "output": buf.getvalue().rstrip(),
        "error": str(exc),
        "sessionId": getattr(cli, "session_id", None),
    }
finally:
    if old_cprint is not None:
        cli_mod._cprint = old_cprint

sys.stdout.write(json.dumps(payload, ensure_ascii=False))
`;

export async function runHermesChat(
  params: unknown,
  context: LocalCommandContext = {},
): Promise<HermesChatResult> {
  const record = params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
  const rawMessage = typeof record.message === "string" ? record.message : "";
  const sessionKey = typeof record.sessionKey === "string" && record.sessionKey.trim().length > 0
    ? record.sessionKey.trim()
    : "main";
  if (isHermesSlashCommandMessage(rawMessage)) {
    return await runSerializedHermesChat(sessionKey, () => (
      runHermesSlashCommand({ message: rawMessage, sessionKey, hermesSessionId: record.hermesSessionId })
    ));
  }
  const message = await prepareHermesMessage(rawMessage, record.attachments, sessionKey);
  if (!message.trim()) {
    throw new Error("message_required");
  }

  return await runSerializedHermesChat(sessionKey, async () => {
    return await runHermesChatPrepared({
      rawMessage,
      message,
      sessionKey,
      hermesSessionId: record.hermesSessionId,
      context,
    });
  });
}

async function runSerializedHermesChat<T>(
  sessionKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const queueKey = sessionKey.trim() || "main";
  const previous = hermesChatQueues.get(queueKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const stored = current.then(() => undefined, () => undefined);
  hermesChatQueues.set(queueKey, stored);
  try {
    return await current;
  } finally {
    if (hermesChatQueues.get(queueKey) === stored) {
      hermesChatQueues.delete(queueKey);
    }
  }
}

async function runHermesChatPrepared(params: {
  rawMessage: string;
  message: string;
  sessionKey: string;
  hermesSessionId: unknown;
  context: LocalCommandContext;
}): Promise<HermesChatResult> {
  const explicitResume = typeof params.hermesSessionId === "string" && params.hermesSessionId.trim().length > 0
    ? params.hermesSessionId.trim()
    : undefined;
  const mappedResume = explicitResume ? undefined : await getMappedHermesSessionId(params.sessionKey);
  let resume = explicitResume ?? mappedResume;
  const beforeSessions = await listHermesSessions();
  let rawOutput: string;
  try {
    rawOutput = await runHermesChatOnce({
      message: params.message,
      sessionKey: params.sessionKey,
      resume,
      context: params.context,
      historyCompletion: () => detectHermesHistoryCompletion({
        beforeSessions,
        resume,
        sessionKey: params.sessionKey,
        userMessage: params.rawMessage,
      }),
    });
  } catch (error) {
    if (!mappedResume || !isHermesMissingSessionError(error)) {
      throw error;
    }
    await forgetHermesSession(params.sessionKey, mappedResume);
    resume = undefined;
    rawOutput = await runHermesChatOnce({
      message: params.message,
      sessionKey: params.sessionKey,
      context: params.context,
      historyCompletion: () => detectHermesHistoryCompletion({
        beforeSessions,
        sessionKey: params.sessionKey,
        userMessage: params.rawMessage,
      }),
    });
  }
  const output = sanitizeHermesChatOutput(rawOutput).trim();
  const sessions = await listHermesSessions();
  const mappedSession = selectHermesSessionForCompletedChat(sessions, {
    beforeSessions,
    resume,
    userMessage: params.rawMessage,
  });
  if (mappedSession) {
    await rememberHermesSession(params.sessionKey, mappedSession);
  }
  const usage = mappedSession?.hermesSessionId
    ? await collectHermesUsageSnapshot(mappedSession.hermesSessionId)
    : readHermesStatusSnapshot();
  return {
    output,
    sessionKey: params.sessionKey,
    artifactPaths: extractDeliverablePaths(output, { userMessage: params.rawMessage }),
    usage,
  };
}

async function runHermesChatOnce(params: {
  message: string;
  sessionKey: string;
  resume?: string;
  context: LocalCommandContext;
  historyCompletion?: () => Promise<string | undefined>;
}): Promise<string> {
  const args = ["chat", "--query", params.message, "--quiet", "--source", "pocketclaw", "--yolo"];
  if (params.resume) {
    args.push("--resume", params.resume);
  }
  return params.context.publishEvent
    ? await runHermesChatStreaming(args, params.sessionKey, params.context, params.historyCompletion)
    : runHermes(args, CHAT_TIMEOUT_MS);
}

async function detectHermesHistoryCompletion(params: {
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

  return latestAssistantReplyFromHermesExport(exportResult.payload, params.userMessage);
}

function latestAssistantReplyFromHermesExport(payload: unknown, userMessage: string): string | undefined {
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
    const text = sanitizeHermesChatOutput(extractHermesHistoryText(message)).trim();
    if (text) {
      return text;
    }
  }
  return undefined;
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

export function isHermesSlashCommandMessage(message: string): boolean {
  return /^\/[A-Za-z0-9][\w-]*(?:\s|$)/.test(message.trim());
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

function normalizeSessionSelectionText(value: string | undefined): string {
  return value
    ?.replace(/\[Hermes runtime context][\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .toLowerCase() ?? "";
}

export async function runHermesSlashCommand(params: {
  message: string;
  sessionKey: string;
  hermesSessionId?: unknown;
}): Promise<HermesChatResult> {
  const command = params.message.trim();
  const resume = typeof params.hermesSessionId === "string" && params.hermesSessionId.trim().length > 0
    ? params.hermesSessionId.trim()
    : await getMappedHermesSessionId(params.sessionKey);

  const raw = runHermesPython(HERMES_SLASH_COMMAND_SCRIPT, {
    CLAWCONNECT_HERMES_SLASH_COMMAND: command,
    CLAWCONNECT_HERMES_SLASH_RESUME: resume ?? "",
  });

  const payload = parseHermesSlashCommandPayload(raw);
  const output = sanitizeHermesChatOutput(payload.output ?? "").trim();
  if (!payload.ok) {
    const message = [output, payload.error].filter(Boolean).join("\n").trim() || "hermes_slash_command_failed";
    throw new Error(message);
  }

  const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim().length > 0
    ? payload.sessionId.trim()
    : undefined;
  if (sessionId) {
    await rememberHermesSession(params.sessionKey, {
      sessionKey: params.sessionKey,
      hermesSessionId: sessionId,
      displayName: sessionId,
      label: command,
      lastActivityAt: new Date().toISOString(),
      kind: "hermes",
    });
  }
  if (/^\/(?:new|reset)\b/i.test(command) && resume && sessionId && sessionId !== resume) {
    await forgetHermesSession(resume, resume);
  }

  if (payload.pendingInputs && payload.pendingInputs.length > 0) {
    const queuedMessage = payload.pendingInputs.join("\n\n").trim();
    if (queuedMessage) {
      const queued = await runHermesChat({
        message: queuedMessage,
        sessionKey: params.sessionKey,
        ...(sessionId ? { hermesSessionId: sessionId } : {}),
      });
      return {
        ...queued,
        output: [output, queued.output].filter((part) => part && part !== "(no output)").join("\n\n") || queued.output,
      };
    }
  }

  const usage = await collectHermesUsageSnapshot(sessionId);
  return {
    output: output || "(no output)",
    sessionKey: params.sessionKey,
    artifactPaths: [],
    usage,
  };
}

function parseHermesSlashCommandPayload(raw: string): {
  ok: boolean;
  output?: string;
  error?: string;
  sessionId?: string;
  pendingInputs?: string[];
} {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid_hermes_slash_command_payload");
  }
  const record = parsed as Record<string, unknown>;
  return {
    ok: record.ok === true,
    output: typeof record.output === "string" ? record.output : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
    pendingInputs: Array.isArray(record.pendingInputs)
      ? record.pendingInputs.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : undefined,
  };
}

async function runHermesChatStreaming(
  args: string[],
  sessionKey: string,
  context: LocalCommandContext,
  historyCompletion?: () => Promise<string | undefined>,
): Promise<string> {
  const child = spawn(resolveHermesBin(), args, {
    env: SUBPROCESS_ENV,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const runId = context.requestId ?? `hermes-${Date.now()}`;
  let output = "";
  let stderr = "";
  let seq = 0;
  let stdoutLineBuffer = "";
  let pendingAssistantDelta = "";
  let assistantDeltaFlushTimer: NodeJS.Timeout | undefined;
  let inSecurityReview = false;
  let commandDeniedTimeout = false;
  let commandDeniedTimeoutKillTimer: NodeJS.Timeout | undefined;
  const toolCallIdsByName = new Map<string, string>();
  let toolCallCounter = 0;

  const requestCommandDeniedTimeoutFailure = (): void => {
    if (commandDeniedTimeout) {
      return;
    }
    commandDeniedTimeout = true;
    child.kill("SIGTERM");
    commandDeniedTimeoutKillTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    commandDeniedTimeoutKillTimer.unref?.();
  };

  const publishToolLogEvent = (event: HermesToolLogEvent): void => {
    let toolCallId = toolCallIdsByName.get(event.toolName);
    if (!toolCallId) {
      toolCallCounter += 1;
      toolCallId = `${runId}:hermes-tool-${toolCallCounter}`;
      toolCallIdsByName.set(event.toolName, toolCallId);
    }
    if (event.phase === "completed" || event.phase === "failed") {
      toolCallIdsByName.delete(event.toolName);
    }
    context.publishEvent?.({
      type: "event",
      event: "chat",
      payload: {
        runId,
        sessionKey,
        stream: "tool",
        state: event.phase,
        phase: event.phase,
        role: "tool",
        seq: seq += 1,
        ts: Date.now(),
        data: {
          phase: event.phase,
          tool_call_id: toolCallId,
          tool_name: event.toolName,
          text: event.text,
          is_error: event.isError === true,
        },
        timelineEvents: [
          buildToolInvocationUpdatedEvent({
            gatewayId: context.gatewayId ?? "clawconnect",
            sessionKey,
            turnId: runId,
            runId,
            toolInvocationId: toolCallId,
            toolState: hermesToolState(event),
            seq: seq,
            turnSeq: seq,
            content: [{
              type: event.phase === "completed" || event.phase === "failed" ? "tool_result" : "tool_call",
              toolName: event.toolName,
              text: event.text,
              isError: event.isError === true,
            }],
          }),
        ],
      },
    });
  };
  const toolLogWatcher = createHermesToolLogWatcher(publishToolLogEvent);

  const filterChatLine = (line: string): string | null => {
    const clean = stripAnsi(line).trim();
    if (isHermesCommandDeniedTimeoutLine(clean)) {
      requestCommandDeniedTimeoutFailure();
      return null;
    }
    if (/DANGEROUS COMMAND:\s*Security scan/i.test(clean)) {
      inSecurityReview = true;
      return null;
    }
    if (inSecurityReview) {
      if (/Choice\s*\[[^\]]+\]:/i.test(clean) || /(?:^|\s)[✕x]\s*Denied\b/i.test(clean) || /\bDenied\b/i.test(clean)) {
        inSecurityReview = false;
      }
      return null;
    }
    return line;
  };

  const clearAssistantDeltaFlushTimer = (): void => {
    if (!assistantDeltaFlushTimer) {
      return;
    }
    clearTimeout(assistantDeltaFlushTimer);
    assistantDeltaFlushTimer = undefined;
  };

  const flushAssistantDelta = (): void => {
    clearAssistantDeltaFlushTimer();
    if (!pendingAssistantDelta) {
      return;
    }
    const delta = pendingAssistantDelta;
    pendingAssistantDelta = "";
    const timestampMs = Date.now();
    try {
      context.publishEvent?.({
        type: "event",
        event: "chat",
        payload: buildHermesAssistantDeltaPayload({
          runId,
          sessionKey,
          seq: seq += 1,
          timestampMs,
          delta,
        }),
      });
    } catch (error) {
      context.publishEvent?.({
        type: "event",
        event: "maintenance_log",
        payload: {
          gatewayId: context.gatewayId,
          requestId: context.requestId,
          runId,
          stream: "stderr",
          seq: seq += 1,
          ts: Date.now(),
          text: `Hermes stream publish failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  };

  const publishAssistantDelta = (text: string): void => {
    output += text;
    pendingAssistantDelta += text;
    if (Buffer.byteLength(pendingAssistantDelta, "utf8") >= HERMES_ASSISTANT_DELTA_MAX_BYTES) {
      flushAssistantDelta();
      return;
    }
    if (!assistantDeltaFlushTimer) {
      assistantDeltaFlushTimer = setTimeout(flushAssistantDelta, HERMES_ASSISTANT_DELTA_FLUSH_MS);
      assistantDeltaFlushTimer.unref?.();
    }
  };

  const publishText = (text: string): void => {
    stdoutLineBuffer += text;
    const lines = stdoutLineBuffer.split(/\r?\n/);
    stdoutLineBuffer = lines.pop() ?? "";
    const clean = stripHermesSessionResumeNotices(
      lines
        .map(filterChatLine)
        .filter((line): line is string => line !== null)
        .join("\n"),
    );
    if (!clean.trim()) {
      return;
    }
    const chunk = `${clean}\n`;
    publishAssistantDelta(chunk);
  };

  const flushStdoutLineBuffer = (): void => {
    if (!stdoutLineBuffer) {
      return;
    }
    const clean = stripHermesSessionResumeNotices(filterChatLine(stdoutLineBuffer) ?? "");
    stdoutLineBuffer = "";
    if (!clean.trim()) {
      return;
    }
    publishAssistantDelta(clean);
  };

  const publishStderr = (text: string): void => {
    const clean = stripAnsi(text).trimEnd();
    if (!clean) {
      return;
    }
    stderr += `${clean}\n`;
    context.publishEvent?.({
      type: "event",
      event: "maintenance_log",
      payload: {
        gatewayId: context.gatewayId,
        requestId: context.requestId,
        runId,
        stream: "stderr",
        seq: seq += 1,
        ts: Date.now(),
        text: clean,
      },
    });
  };

  const publishTypingMarker = (): void => {
    // The local mobile client already owns the pending placeholder. Do not
    // forward protocol-only typing markers as empty assistant chat events.
  };

  child.stdout?.on("data", (chunk) => publishText(chunk.toString()));
  child.stderr?.on("data", (chunk) => publishStderr(chunk.toString()));
  toolLogWatcher.start();
  publishTypingMarker();

  return await new Promise<string>((resolveOutput, rejectOutput) => {
    const abortSignal = context.abortSignal;
    let abortRequested = abortSignal?.aborted === true;
    let settled = false;
    let historyCompletionTimer: NodeJS.Timeout | undefined;
    let historyCompletionInFlight = false;
    const typingTimer = setInterval(publishTypingMarker, 5000);
    typingTimer.unref?.();
    const cleanup = (): void => {
      clearInterval(typingTimer);
      if (historyCompletionTimer) {
        clearInterval(historyCompletionTimer);
        historyCompletionTimer = undefined;
      }
      abortSignal?.removeEventListener("abort", abortChat);
    };
    const finishResolve = (value: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      clearTimeout(timeout);
      clearAssistantDeltaFlushTimer();
      toolLogWatcher.stop();
      resolveOutput(value);
    };
    const finishReject = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      clearTimeout(timeout);
      clearAssistantDeltaFlushTimer();
      toolLogWatcher.stop();
      rejectOutput(error);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      if (output.trim()) {
        finishResolve(output);
      } else {
        finishReject(new Error("hermes_chat_timeout"));
      }
    }, CHAT_TIMEOUT_MS);
    timeout.unref?.();
    const abortChat = (): void => {
      abortRequested = true;
      stdoutLineBuffer = "";
      pendingAssistantDelta = "";
      clearAssistantDeltaFlushTimer();
      child.kill("SIGTERM");
    };
    const checkHistoryCompletion = (): void => {
      if (!historyCompletion || settled || abortRequested || historyCompletionInFlight) {
        return;
      }
      historyCompletionInFlight = true;
      historyCompletion()
        .then((detectedOutput) => {
          if (!detectedOutput || settled || abortRequested) {
            return;
          }
          output = detectedOutput;
          pendingAssistantDelta = "";
          stdoutLineBuffer = "";
          child.kill("SIGTERM");
          setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
            }
          }, 1000).unref?.();
          finishResolve(detectedOutput);
        })
        .catch(() => {
          // History completion is a best-effort escape hatch for Hermes processes
          // that keep running after the assistant turn is already persisted.
        })
        .finally(() => {
          historyCompletionInFlight = false;
        });
    };
    if (abortRequested) {
      abortChat();
    } else {
      abortSignal?.addEventListener("abort", abortChat, { once: true });
    }
    if (historyCompletion) {
      historyCompletionTimer = setInterval(checkHistoryCompletion, HERMES_HISTORY_COMPLETION_POLL_MS);
      setTimeout(checkHistoryCompletion, HERMES_HISTORY_COMPLETION_GRACE_MS);
    }
    child.once("error", (error) => {
      if (settled) {
        return;
      }
        if (commandDeniedTimeoutKillTimer) {
          clearTimeout(commandDeniedTimeoutKillTimer);
          commandDeniedTimeoutKillTimer = undefined;
        }
      finishReject(error);
    });
    child.once("close", (code, signal) => {
      void (async () => {
        if (settled) {
          return;
        }
        if (commandDeniedTimeoutKillTimer) {
          clearTimeout(commandDeniedTimeoutKillTimer);
          commandDeniedTimeoutKillTimer = undefined;
        }
        if (abortRequested) {
          finishReject(new Error("hermes_chat_aborted"));
          return;
        }
        flushStdoutLineBuffer();
        flushAssistantDelta();
        if (commandDeniedTimeout) {
          finishReject(new Error(HERMES_COMMAND_DENIED_TIMEOUT_MESSAGE));
          return;
        }
        if (code && code !== 0) {
          const reason = stderr.trim() || output.trim() || `hermes chat exited with code ${code}`;
          finishReject(new Error(signal ? `${reason} (${signal})` : reason));
          return;
        }
        finishResolve(output);
      })().catch((error) => finishReject(error instanceof Error ? error : new Error(String(error))));
    });
  });
}

export function buildHermesAssistantDeltaPayload(params: {
  runId: string;
  sessionKey: string;
  seq: number;
  timestampMs: number;
  delta: string;
}) {
  return buildMobileAssistantDeltaPayload({
    run: { runId: params.runId, sessionKey: params.sessionKey },
    seq: params.seq,
    timestampMs: params.timestampMs,
    delta: params.delta,
    includeTimelineEvents: true,
  });
}

function hermesToolState(event: HermesToolLogEvent): ToolState {
  if (event.phase === "completed") {
    return "success";
  }
  if (event.phase === "failed") {
    return "failed";
  }
  return "streaming_output";
}

function createHermesToolLogWatcher(onEvent: (event: HermesToolLogEvent) => void): {
  start: () => void;
  stop: () => void;
} {
  let offset = 0;
  let timer: NodeJS.Timeout | undefined;
  try {
    offset = statSync(HERMES_AGENT_LOG_FILE).size;
  } catch {
    offset = 0;
  }

  const poll = (): void => {
    let content = "";
    try {
      const bytes = readFileSync(HERMES_AGENT_LOG_FILE);
      if (bytes.length < offset) {
        offset = 0;
      }
      if (bytes.length === offset) {
        return;
      }
      content = bytes.subarray(offset).toString("utf8");
      offset = bytes.length;
    } catch {
      return;
    }
    for (const line of content.split(/\r?\n/)) {
      const event = parseHermesToolLogLine(line);
      if (event) {
        onEvent(event);
      }
    }
  };

  return {
    start: () => {
      if (timer) {
        return;
      }
      timer = setInterval(poll, 250);
      timer.unref?.();
    },
    stop: () => {
      poll();
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

export function parseHermesToolLogLine(line: string): HermesToolLogEvent | null {
  const clean = stripAnsi(line).trim();
  if (!clean) {
    return null;
  }

  const executor = clean.match(/\bagent\.tool_executor:\s*tool\s+([A-Za-z0-9_.-]+)\s+(.+)$/i);
  if (executor) {
    const toolName = normalizeHermesToolName(executor[1] ?? "tool");
    const detail = (executor[2] ?? "").trim();
    if (/\b(?:running|started|executing|start)\b/i.test(detail)) {
      return {
        toolName,
        phase: "streaming",
        text: `${toolName} ${detail}`.trim(),
        isError: false,
      };
    }
    const failed = /\b(?:failed|error|errored|denied|aborted)\b/i.test(detail);
    return {
      toolName,
      phase: failed ? "failed" : "completed",
      text: `${toolName} ${detail}`.trim(),
      isError: failed,
    };
  }

  const toolLogger = clean.match(/\btools\.([A-Za-z0-9_.-]+):\s*(.+)$/i);
  if (!toolLogger) {
    return null;
  }
  const loggerName = toolLogger[1] ?? "tool";
  if (!/(?:_tool|_tools)$/i.test(loggerName)) {
    return null;
  }
  let toolName = normalizeHermesToolName(loggerName);
  let detail = (toolLogger[2] ?? "").trim();
  if (/\b(?:Shutting down \d+ remaining sandbox(?:\(es\))?|Manually cleaned up environment|Cleaned \d+ environments?)\b/i.test(detail)) {
    return null;
  }
  const nestedTool = detail.match(/^([A-Za-z0-9_.-]+):\s*(.+)$/);
  if (nestedTool) {
    toolName = normalizeHermesToolName(nestedTool[1] ?? toolName);
    detail = (nestedTool[2] ?? "").trim();
  }
  if (!detail) {
    return null;
  }
  return {
    toolName,
    phase: "streaming",
    text: `${toolName}: ${detail}`,
  };
}

function normalizeHermesToolName(rawName: string): string {
  const normalized = rawName
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/_tools$/i, "")
    .replace(/_tool$/i, "");
  return normalized || "tool";
}

async function prepareHermesMessage(message: string, attachments: unknown, sessionKey: string): Promise<string> {
  const refs: string[] = [];
  if (Array.isArray(attachments)) {
    const safeSession = sessionKey.replace(/[^\w.-]/g, "_") || "main";
    for (const attachment of attachments) {
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
        continue;
      }
      const record = attachment as Record<string, unknown>;
      if (typeof record.content !== "string" || record.content.length === 0) {
        continue;
      }
      const fileName = sanitizeFileName(
        typeof record.fileName === "string" ? record.fileName
          : typeof record.name === "string" ? record.name
            : `attachment-${randomUUID()}`,
      );
      const dir = join(HERMES_INBOX_DIR, safeSession, randomUUID());
      await mkdir(dir, { recursive: true });
      const filePath = join(dir, fileName);
      await writeFile(filePath, Buffer.from(record.content, "base64"));
      const mimeType = typeof record.mimeType === "string" ? record.mimeType : "application/octet-stream";
      refs.push(`[file attached: ${filePath} (${mimeType})]`);
    }
  }
  const sections = [message.trim()];
  if (refs.length > 0) {
    sections.push(refs.join("\n"));
  }
  const runtimeHint = buildHermesRuntimeContextHint(readHermesStatusSnapshot());
  if (runtimeHint) {
    sections.push(runtimeHint);
  }
  sections.push(CLAWCONNECT_MOBILE_BRIDGE_HINT);
  return sections.filter(Boolean).join("\n\n").trim();
}

export function buildHermesRuntimeContextHint(snapshot: HermesUsageSnapshot): string | undefined {
  const details = compactStringArray([
    snapshot.currentModel ? `model=${snapshot.currentModel}` : undefined,
    snapshot.provider ? `provider=${snapshot.provider}` : undefined,
  ]);
  if (details.length === 0) {
    return undefined;
  }
  return [
    "[Hermes runtime context]",
    `Current runtime: ${details.join(", ")}.`,
    "If the user asks which model or provider is currently being used, answer from this runtime context.",
  ].join("\n");
}
