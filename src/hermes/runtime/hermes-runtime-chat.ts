
import { randomUUID } from "crypto";
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
import {
  forgetHermesSession,
  getMappedHermesSessionId,
  rememberHermesSession,
} from "../hermes-session-store.js";
import {
  CHAT_TIMEOUT_MS,
  CLAWCONNECT_MOBILE_BRIDGE_HINT,
  HERMES_INBOX_DIR,
  SUBPROCESS_ENV,
  resolveHermesBin,
  isHermesCommandDeniedTimeoutLine,
  isHermesMissingSessionError,
  runHermes,
  sanitizeHermesChatOutput,
  stripAnsi,
  stripHermesSessionResumeNotices,
} from "./hermes-runtime-process.js";
import type { HermesChatResult, HermesToolLogEvent, HermesUsageSnapshot } from "./hermes-runtime-types.js";
import { collectHermesUsageSnapshot, listHermesSessions, readHermesStatusSnapshotAsync } from "./hermes-runtime-usage.js";
import { compactStringArray, sanitizeFileName } from "./hermes-runtime-values.js";
import {
  detectHermesHistoryCompletion,
  selectHermesSessionForCompletedChat,
} from "./hermes-runtime-history-completion.js";
import { tryRunHermesApiChat } from "./hermes-runtime-api-client.js";
import { resolveHermesPreloadedSkillContext } from "./hermes-runtime-preloaded-skills.js";
import {
  createHermesToolLogWatcher,
  hermesToolState,
  parseHermesToolLogLine,
} from "./hermes-runtime-tool-log-watcher.js";
import {
  isHermesSlashCommandMessage,
  runHermesSlashCommand,
} from "./hermes-runtime-slash-command.js";

export { selectHermesSessionForCompletedChat } from "./hermes-runtime-history-completion.js";
export { parseHermesToolLogLine } from "./hermes-runtime-tool-log-watcher.js";
export { isHermesSlashCommandMessage } from "./hermes-runtime-slash-command.js";

const HERMES_ASSISTANT_DELTA_FLUSH_MS = 120;
const HERMES_ASSISTANT_DELTA_MAX_BYTES = 4096;
const HERMES_HISTORY_COMPLETION_GRACE_MS = 2_000;
const HERMES_HISTORY_COMPLETION_POLL_MS = 1_000;
const HERMES_API_EMPTY_OUTPUT_HISTORY_COMPLETION_TIMEOUT_MS = 12_000;
const HERMES_API_EMPTY_OUTPUT_HISTORY_COMPLETION_POLL_MS = 500;
const HERMES_COMMAND_DENIED_TIMEOUT_MESSAGE = "Timeout – denying command";
const hermesChatQueues = new Map<string, Promise<void>>();

type PreparedHermesMessage = {
  apiMessage: string;
  apiInstructions?: string;
  cliMessage: string;
};

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
      runHermesSlashCommand({
        message: rawMessage,
        sessionKey,
        hermesSessionId: record.hermesSessionId,
        runQueuedChat: (queuedMessage, hermesSessionId) => runHermesChat({
          message: queuedMessage,
          sessionKey,
          ...(hermesSessionId ? { hermesSessionId } : {}),
        }),
      })
    ));
  }
  const sourceRunId = typeof context.requestId === "string" && context.requestId.trim().length > 0
    ? context.requestId.trim()
    : undefined;
  const preparedMessage = await prepareHermesMessage(rawMessage, record.attachments, sessionKey, sourceRunId);
  if (!preparedMessage.cliMessage.trim()) {
    throw new Error("message_required");
  }

  return await runSerializedHermesChat(sessionKey, async () => {
    return await runHermesChatPrepared({
      rawMessage,
      preparedMessage,
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
  preparedMessage: PreparedHermesMessage;
  sessionKey: string;
  hermesSessionId: unknown;
  context: LocalCommandContext;
}): Promise<HermesChatResult> {
  const explicitResume = typeof params.hermesSessionId === "string" && params.hermesSessionId.trim().length > 0
    ? params.hermesSessionId.trim()
    : undefined;
  const mappedResume = explicitResume ? undefined : await getMappedHermesSessionId(params.sessionKey);
  let resume = explicitResume ?? mappedResume;
  const preloadedSkillContext = await resolveHermesPreloadedSkillContext();
  try {
    const apiChat = await tryRunHermesApiChat({
      message: params.preparedMessage.apiMessage,
      instructions: params.preparedMessage.apiInstructions,
      sessionKey: params.sessionKey,
      resume,
      preloadedSkillNames: preloadedSkillContext.skillNames,
      context: params.context,
    });
    if (apiChat) {
      const recoveredOutput = await recoverEmptyHermesApiOutputFromHistory({
        output: apiChat.output,
        hermesSessionId: apiChat.hermesSessionId,
        sessionKey: params.sessionKey,
        userMessage: params.rawMessage,
        abortSignal: params.context.abortSignal,
      });
      return recoveredOutput ? { ...apiChat, output: recoveredOutput } : apiChat;
    }
  } catch (error) {
    if (!mappedResume || !isHermesMissingSessionError(error)) {
      throw error;
    }
    await forgetHermesSession(params.sessionKey, mappedResume);
    resume = undefined;
    const retryApiChat = await tryRunHermesApiChat({
      message: params.preparedMessage.apiMessage,
      instructions: params.preparedMessage.apiInstructions,
      sessionKey: params.sessionKey,
      preloadedSkillNames: preloadedSkillContext.skillNames,
      context: params.context,
    });
    if (retryApiChat) {
      const recoveredOutput = await recoverEmptyHermesApiOutputFromHistory({
        output: retryApiChat.output,
        hermesSessionId: retryApiChat.hermesSessionId,
        sessionKey: params.sessionKey,
        userMessage: params.rawMessage,
        abortSignal: params.context.abortSignal,
      });
      return recoveredOutput ? { ...retryApiChat, output: recoveredOutput } : retryApiChat;
    }
  }
  const beforeSessions = await listHermesSessions();
  let rawOutput: string;
  try {
    rawOutput = await runHermesChatOnce({
      message: params.preparedMessage.cliMessage,
      sessionKey: params.sessionKey,
      resume,
      context: params.context,
      preloadedSkillArgs: preloadedSkillContext.cliArgs,
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
      message: params.preparedMessage.cliMessage,
      sessionKey: params.sessionKey,
      context: params.context,
      preloadedSkillArgs: preloadedSkillContext.cliArgs,
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
    : await readHermesStatusSnapshotAsync();
  return {
    output,
    sessionKey: params.sessionKey,
    artifactPaths: [],
    usage,
  };
}

async function recoverEmptyHermesApiOutputFromHistory(params: {
  output: string;
  hermesSessionId?: string;
  sessionKey: string;
  userMessage: string;
  abortSignal?: AbortSignal;
}): Promise<string | undefined> {
  if (sanitizeHermesChatOutput(params.output).trim()) {
    return undefined;
  }
  if (!params.hermesSessionId?.trim()) {
    return undefined;
  }

  const deadline = Date.now() + HERMES_API_EMPTY_OUTPUT_HISTORY_COMPLETION_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    if (params.abortSignal?.aborted) {
      throw new Error("hermes_chat_aborted");
    }
    const detectedOutput = await detectHermesHistoryCompletion({
      beforeSessions: [],
      resume: params.hermesSessionId,
      sessionKey: params.sessionKey,
      userMessage: params.userMessage,
    });
    if (detectedOutput) {
      return detectedOutput;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(HERMES_API_EMPTY_OUTPUT_HISTORY_COMPLETION_POLL_MS, remainingMs));
  }
  return undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function runHermesChatOnce(params: {
  message: string;
  sessionKey: string;
  resume?: string;
  context: LocalCommandContext;
  preloadedSkillArgs?: string[];
  historyCompletion?: () => Promise<string | undefined>;
}): Promise<string> {
  const args = [
    "chat",
    "--query",
    params.message,
    "--quiet",
    "--source",
    "pocketclaw",
    ...(params.preloadedSkillArgs ?? []),
    "--yolo",
  ];
  if (params.resume) {
    args.push("--resume", params.resume);
  }
  const runId = params.context.requestId ?? `hermes-${Date.now()}`;
  const env = hermesChatSubprocessEnv(runId, params.sessionKey);
  return params.context.publishEvent
    ? await runHermesChatStreaming(args, params.sessionKey, params.context, runId, env, params.historyCompletion)
    : runHermes(args, CHAT_TIMEOUT_MS, env);
}

async function runHermesChatStreaming(
  args: string[],
  sessionKey: string,
  context: LocalCommandContext,
  runId: string,
  env: NodeJS.ProcessEnv,
  historyCompletion?: () => Promise<string | undefined>,
): Promise<string> {
  const child = spawn(resolveHermesBin(), args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  let stderr = "";
  let seq = 0;
  let stdoutLineBuffer = "";
  let stdoutLineFlushTimer: NodeJS.Timeout | undefined;
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

  const clearStdoutLineFlushTimer = (): void => {
    if (!stdoutLineFlushTimer) {
      return;
    }
    clearTimeout(stdoutLineFlushTimer);
    stdoutLineFlushTimer = undefined;
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

  const flushStdoutLineBuffer = (): void => {
    clearStdoutLineFlushTimer();
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

  const scheduleStdoutLineFlush = (): void => {
    if (!stdoutLineBuffer.trim()) {
      clearStdoutLineFlushTimer();
      return;
    }
    if (stdoutLineFlushTimer) {
      return;
    }
    stdoutLineFlushTimer = setTimeout(flushStdoutLineBuffer, HERMES_ASSISTANT_DELTA_FLUSH_MS);
    stdoutLineFlushTimer.unref?.();
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
      scheduleStdoutLineFlush();
      return;
    }
    const chunk = `${clean}\n`;
    publishAssistantDelta(chunk);
    scheduleStdoutLineFlush();
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
      clearStdoutLineFlushTimer();
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
      clearStdoutLineFlushTimer();
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
      clearStdoutLineFlushTimer();
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
          clearStdoutLineFlushTimer();
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

function hermesChatSubprocessEnv(runId: string, sessionKey: string): NodeJS.ProcessEnv {
  return {
    ...SUBPROCESS_ENV,
    CLAWCONNECT_SOURCE_RUN_ID: runId,
    CLAWCONNECT_SESSION_KEY: sessionKey,
    CLAWCONNECT_CHAT_SESSION_KEY: sessionKey,
  };
}

const CLAWCONNECT_MOBILE_TURN_INSTRUCTION =
  "Use [ClawConnect mobile turn] metadata only for ClawConnect file-transfer attribution and message identity. Do not mention it in the answer.";

function buildClawConnectMobileTurnMetadata(sourceRunId: string | undefined, sessionKey: string): string | undefined {
  if (!sourceRunId) {
    return undefined;
  }
  // 这个块是 ClawConnect 和 Hermes history 的稳定身份合同；客户端展示时会剥离它。
  return [
    "[ClawConnect mobile turn]",
    `sourceRunId: ${sourceRunId}`,
    `sessionKey: ${sessionKey}`,
  ].join("\n");
}

async function prepareHermesMessage(
  message: string,
  attachments: unknown,
  sessionKey: string,
  sourceRunId?: string,
): Promise<PreparedHermesMessage> {
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
  const userSections = [message.trim()];
  if (refs.length > 0) {
    userSections.push(refs.join("\n"));
  }
  const runtimeHint = buildHermesRuntimeContextHint(await readHermesStatusSnapshotAsync());
  const turnMetadata = buildClawConnectMobileTurnMetadata(sourceRunId, sessionKey);
  const apiMessageSections = [...userSections];
  if (turnMetadata) {
    apiMessageSections.push(turnMetadata);
  }
  const apiInstructionSections = [
    runtimeHint,
    CLAWCONNECT_MOBILE_BRIDGE_HINT,
    turnMetadata ? CLAWCONNECT_MOBILE_TURN_INSTRUCTION : undefined,
  ];
  const cliMessageSections = [
    ...userSections,
    runtimeHint,
    CLAWCONNECT_MOBILE_BRIDGE_HINT,
    turnMetadata
      ? [turnMetadata, CLAWCONNECT_MOBILE_TURN_INSTRUCTION].join("\n")
      : undefined,
  ];
  return {
    apiMessage: apiMessageSections.filter(Boolean).join("\n\n").trim(),
    apiInstructions: apiInstructionSections.filter(Boolean).join("\n\n").trim() || undefined,
    cliMessage: cliMessageSections.filter(Boolean).join("\n\n").trim(),
  };
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
