
import { randomUUID } from "crypto";
import { readFileSync, statSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";
import type { LocalCommandContext } from "../../commands/local-runtime.js";
import {
  buildMobileAssistantDeltaPayload,
  buildMobileAssistantStreamingPayload,
} from "../../relay/mobile-chat-run-bridge.js";
import {
  forgetHermesSession,
  getMappedHermesSessionId,
  rememberHermesSession,
  type HermesSessionItem,
} from "../hermes-session-store.js";
import { extractDeliverablePaths } from "./hermes-runtime-artifacts.js";
import {
  CHAT_TIMEOUT_MS,
  CLAWCONNECT_MOBILE_BRIDGE_HINT,
  HERMES_AGENT_LOG_FILE,
  HERMES_INBOX_DIR,
  HERMES_TYPING_MARKER,
  SUBPROCESS_ENV,
  resolveHermesBin,
  runHermes,
  runHermesPython,
  sanitizeHermesChatOutput,
  stripAnsi,
  stripHermesSessionResumeNotices,
} from "./hermes-runtime-process.js";
import type { HermesChatResult, HermesToolLogEvent, HermesUsageSnapshot } from "./hermes-runtime-types.js";
import { collectHermesUsageSnapshot, listHermesSessions, readHermesStatusSnapshot } from "./hermes-runtime-usage.js";
import { compactStringArray, sanitizeFileName } from "./hermes-runtime-values.js";

const HERMES_ASSISTANT_DELTA_FLUSH_MS = 120;
const HERMES_ASSISTANT_DELTA_MAX_BYTES = 4096;
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
    return await runHermesSlashCommand({ message: rawMessage, sessionKey, hermesSessionId: record.hermesSessionId });
  }
  const message = await prepareHermesMessage(rawMessage, record.attachments, sessionKey);
  if (!message.trim()) {
    throw new Error("message_required");
  }

  const args = ["chat", "--query", message, "--quiet", "--source", "pocketclaw"];
  const resume = typeof record.hermesSessionId === "string" && record.hermesSessionId.trim().length > 0
    ? record.hermesSessionId.trim()
    : await getMappedHermesSessionId(sessionKey);
  if (resume) {
    args.push("--resume", resume);
  }
  const beforeSessions = await listHermesSessions();

  const rawOutput = context.publishEvent
    ? await runHermesChatStreaming(args, sessionKey, context)
    : runHermes(args, CHAT_TIMEOUT_MS);
  const output = sanitizeHermesChatOutput(rawOutput).trim();
  const sessions = await listHermesSessions();
  const mappedSession = selectHermesSessionForCompletedChat(sessions, {
    beforeSessions,
    resume,
    userMessage: rawMessage,
  });
  if (mappedSession) {
    await rememberHermesSession(sessionKey, mappedSession);
  }
  const usage = mappedSession?.hermesSessionId
    ? await collectHermesUsageSnapshot(mappedSession.hermesSessionId)
    : readHermesStatusSnapshot();
  return {
    output,
    sessionKey,
    artifactPaths: extractDeliverablePaths(output, { userMessage: rawMessage }),
    usage,
  };
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
  let hasPublishedAssistantText = false;
  const toolCallIdsByName = new Map<string, string>();
  let toolCallCounter = 0;

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
      },
    });
  };
  const toolLogWatcher = createHermesToolLogWatcher(publishToolLogEvent);

  const filterChatLine = (line: string): string | null => {
    const clean = stripAnsi(line).trim();
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
    hasPublishedAssistantText = true;
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
    if (hasPublishedAssistantText) {
      return;
    }
    context.publishEvent?.({
      type: "event",
      event: "chat",
      payload: buildMobileAssistantStreamingPayload({
        run: { runId, sessionKey },
        seq: seq += 1,
        text: HERMES_TYPING_MARKER,
      }),
    });
  };

  child.stdout?.on("data", (chunk) => publishText(chunk.toString()));
  child.stderr?.on("data", (chunk) => publishStderr(chunk.toString()));
  toolLogWatcher.start();
  publishTypingMarker();

  return await new Promise<string>((resolveOutput, rejectOutput) => {
    const typingTimer = setInterval(publishTypingMarker, 5000);
    typingTimer.unref?.();
    const timeout = setTimeout(() => {
      clearInterval(typingTimer);
      clearAssistantDeltaFlushTimer();
      toolLogWatcher.stop();
      child.kill("SIGTERM");
      rejectOutput(new Error("hermes_chat_timeout"));
    }, CHAT_TIMEOUT_MS);
    timeout.unref?.();
    child.once("error", (error) => {
      clearInterval(typingTimer);
      clearTimeout(timeout);
      clearAssistantDeltaFlushTimer();
      toolLogWatcher.stop();
      rejectOutput(error);
    });
    child.once("close", (code, signal) => {
      void (async () => {
        clearInterval(typingTimer);
        clearTimeout(timeout);
        toolLogWatcher.stop();
        flushStdoutLineBuffer();
        flushAssistantDelta();
        if (code && code !== 0) {
          const reason = stderr.trim() || output.trim() || `hermes chat exited with code ${code}`;
          rejectOutput(new Error(signal ? `${reason} (${signal})` : reason));
          return;
        }
        resolveOutput(output);
      })().catch(rejectOutput);
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
  });
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
  if (/\b(?:Manually cleaned up environment|Cleaned \d+ environments?)\b/i.test(detail)) {
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
