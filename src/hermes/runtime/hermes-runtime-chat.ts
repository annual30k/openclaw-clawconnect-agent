
import { randomUUID } from "crypto";
import { mkdir, readdir, rm, stat, writeFile } from "fs/promises";
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
  hermesInvocation,
  isHermesCommandDeniedTimeoutLine,
  isHermesMissingSessionError,
  runHermes,
  sanitizeHermesChatOutput,
  stripAnsi,
  stripHermesSessionResumeNotices,
} from "./hermes-runtime-process.js";
import type { HermesChatResult, HermesToolLogEvent, HermesUsageSnapshot } from "./hermes-runtime-types.js";
import {
  collectHermesUsageSnapshot,
  listHermesSessions,
  readCachedHermesStatusSnapshot,
  readHermesStatusSnapshotAsync,
} from "./hermes-runtime-usage.js";
import { compactStringArray, sanitizeFileName, stringValue } from "./hermes-runtime-values.js";
import {
  detectHermesHistoryCompletion,
  hermesSourceRunIdFromMessage,
  selectHermesSessionForCompletedChat,
} from "./hermes-runtime-history-completion.js";
import {
  captureHermesSessionActiveHead,
  readHermesSessionMessages,
  rewindHermesSessionAfterActiveHead,
} from "./hermes-runtime-state-db.js";
import { ensureHermesApiSessionForMobileRoute, tryRunHermesApiChat } from "./hermes-runtime-api-client.js";
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
import {
  clearPendingHermesFileTransfer,
  getPendingHermesFileTransfer,
  recordPendingHermesFileTransfer,
  type PendingHermesFileTransfer,
} from "./hermes-file-transfer-state.js";
import type { HermesFileTransferOutcome } from "../../commands/hermes-file-transfer-outcome.js";
import {
  clearHermesMobileFileRoute,
  registerHermesMobileFileRoute,
} from "./hermes-mobile-file-route-store.js";

export { selectHermesSessionForCompletedChat } from "./hermes-runtime-history-completion.js";
export { latestTerminalAssistantReplyFromHermesExport } from "./hermes-runtime-history-completion.js";
export { parseHermesToolLogLine } from "./hermes-runtime-tool-log-watcher.js";
export { isHermesSlashCommandMessage } from "./hermes-runtime-slash-command.js";

const HERMES_HISTORY_COMPLETION_GRACE_MS = 2_000;
const HERMES_HISTORY_COMPLETION_POLL_MS = 1_000;
const HERMES_API_EMPTY_OUTPUT_HISTORY_COMPLETION_TIMEOUT_MS = 12_000;
const HERMES_API_EMPTY_OUTPUT_HISTORY_COMPLETION_POLL_MS = 500;
const HERMES_RUNTIME_CONTEXT_CACHE_MAX_AGE_MS = 5 * 60_000;
const HERMES_COMMAND_DENIED_TIMEOUT_MESSAGE = "Timeout – denying command";
const HERMES_EMPTY_RESPONSE_MESSAGE = "Hermes 未返回可见回复，请检查当前模型额度或 Provider 凭据后重试。";
const HERMES_INBOX_TTL_MS = 24 * 60 * 60 * 1000;
const USER_FILE_MARKER_PREFIX_RE = /\[file attached:/gi;
const hermesChatQueues = new Map<string, Promise<void>>();
const EMPTY_PRELOADED_SKILL_CONTEXT = {
  cliArgs: [] as string[],
  requiredToolsets: [] as string[],
  skillNames: [] as string[],
};

type PreparedHermesMessage = {
  apiMessage: string;
  apiInstructions?: string;
  cliMessage: string;
};

type HermesChatPreparationPlan = {
  preloadFileTransferSkill: boolean;
  fileTransferMode: "continuation" | undefined;
  pendingFileTransfer?: PendingHermesFileTransfer;
};

const HERMES_FILE_TRANSFER_NOT_SENT_MESSAGE =
  "文件尚未发送：没有检测到可验证的 clawconnect send-file 成功结果，请补充或确认要发送的文件后重试。";
const HERMES_FILE_TRANSFER_CONTENT_MISSING_MESSAGE =
  "本轮没有可显示的结构化回答。";
const HERMES_FILE_TRANSFER_CANCELLED_MESSAGE = "文件发送已取消。";

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
      sourceRunId,
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
  sourceRunId: string | undefined;
  hermesSessionId: unknown;
  context: LocalCommandContext;
}): Promise<HermesChatResult> {
  const explicitResume = typeof params.hermesSessionId === "string" && params.hermesSessionId.trim().length > 0
    ? params.hermesSessionId.trim()
    : undefined;
  const mappedResume = explicitResume ? undefined : await getMappedHermesSessionId(params.sessionKey);
  let resume = explicitResume ?? mappedResume;
  const preparationPlan = await planHermesChatPreparation({
    message: params.rawMessage,
    gatewayId: params.context.gatewayId ?? "clawconnect",
    sessionKey: params.sessionKey,
    sessionId: resume,
    sourceRunId: params.sourceRunId,
    fileTransferCapability: params.context.hermesFileTransferCapability,
  });
  const preloadedSkillContext = preparationPlan.preloadFileTransferSkill
    ? await resolveHermesPreloadedSkillContext({ forceFileTransfer: true })
    : EMPTY_PRELOADED_SKILL_CONTEXT;
  if (preparationPlan.preloadFileTransferSkill && !resume && params.sourceRunId) {
    const ensuredSessionId = await ensureHermesApiSessionForMobileRoute(params.sessionKey);
    if (ensuredSessionId) {
      resume = ensuredSessionId;
      await rememberHermesSession(params.sessionKey, {
        sessionKey: params.sessionKey,
        hermesSessionId: ensuredSessionId,
        displayName: params.sessionKey,
        kind: "hermes",
      });
    }
  }
  try {
    // File delivery is fail-closed and must be backed by the local
    // clawconnect send-file tool.  The API stream publishes assistant deltas
    // before its final tool evidence is persisted, so route these turns
    // through the CLI path where the answer is buffered until verification.
    const apiChat = preparationPlan.preloadFileTransferSkill
      ? undefined
      : await tryRunHermesApiChat({
        message: params.preparedMessage.apiMessage,
        instructions: params.preparedMessage.apiInstructions,
        sessionKey: params.sessionKey,
        resume,
        preloadedSkillNames: preloadedSkillContext.skillNames,
        requiredToolsets: preloadedSkillContext.requiredToolsets,
        context: params.context,
      });
    if (apiChat) {
      const recoveredOutput = await recoverEmptyHermesApiOutputFromHistory({
        output: apiChat.output,
        hermesSessionId: apiChat.hermesSessionId,
        sessionKey: params.sessionKey,
        userMessage: params.rawMessage,
        sourceRunId: params.sourceRunId,
        abortSignal: params.context.abortSignal,
      });
      const visibleOutput = requireVisibleHermesOutput(recoveredOutput || apiChat.output);
      return {
        ...apiChat,
        output: visibleOutput,
        ...(await verifyHermesFileTransferIfRequired({
          plan: preparationPlan,
          gatewayId: params.context.gatewayId ?? "clawconnect",
          sessionKey: params.sessionKey,
          sessionId: apiChat.hermesSessionId,
          sourceRunId: params.sourceRunId,
          output: visibleOutput,
        })),
      };
    }
  } catch (error) {
    if (isHermesChatAbortedError(error)) {
      // API Server owns its cancellation transaction. Retaining the mapping
      // preserves every previously completed turn for the next request.
      throw error;
    }
    if (!mappedResume || !isHermesMissingSessionError(error)) {
      throw error;
    }
    await forgetHermesSession(params.sessionKey, mappedResume);
    resume = undefined;
    const retryApiChat = preparationPlan.preloadFileTransferSkill
      ? undefined
      : await tryRunHermesApiChat({
        message: params.preparedMessage.apiMessage,
        instructions: params.preparedMessage.apiInstructions,
        sessionKey: params.sessionKey,
        preloadedSkillNames: preloadedSkillContext.skillNames,
        requiredToolsets: preloadedSkillContext.requiredToolsets,
        context: params.context,
      });
    if (retryApiChat) {
      const recoveredOutput = await recoverEmptyHermesApiOutputFromHistory({
        output: retryApiChat.output,
        hermesSessionId: retryApiChat.hermesSessionId,
        sessionKey: params.sessionKey,
        userMessage: params.rawMessage,
        sourceRunId: params.sourceRunId,
        abortSignal: params.context.abortSignal,
      });
      const visibleOutput = requireVisibleHermesOutput(recoveredOutput || retryApiChat.output);
      return {
        ...retryApiChat,
        output: visibleOutput,
        ...(await verifyHermesFileTransferIfRequired({
          plan: preparationPlan,
          gatewayId: params.context.gatewayId ?? "clawconnect",
          sessionKey: params.sessionKey,
          sessionId: retryApiChat.hermesSessionId,
          sourceRunId: params.sourceRunId,
          output: visibleOutput,
        })),
      };
    }
  }
  const beforeSessions = await listHermesSessions();
  let cliActiveHead = resume
    ? await captureHermesSessionActiveHead(resume)
    : undefined;
  let rawOutput: string;
  try {
    rawOutput = await runHermesChatOnceWithMobileFileRoute({
      message: params.preparedMessage.cliMessage,
      sessionKey: params.sessionKey,
      resume,
      context: params.context,
      preloadedSkillArgs: preloadedSkillContext.cliArgs,
      enableFileTransferRoute: preparationPlan.preloadFileTransferSkill,
      gatewayId: params.context.gatewayId ?? "clawconnect",
      sourceRunId: params.sourceRunId,
      historyCompletion: () => detectHermesHistoryCompletion({
        beforeSessions,
        resume,
        sessionKey: params.sessionKey,
        userMessage: params.rawMessage,
        sourceRunId: params.sourceRunId,
      }),
    });
  } catch (error) {
    if (isHermesChatAbortedError(error)) {
      await recoverHermesCliSessionAfterAbort({
        sessionKey: params.sessionKey,
        resume,
        mappedResume,
        activeHead: cliActiveHead,
        sourceRunId: params.sourceRunId,
      });
      throw error;
    }
    if (!mappedResume || !isHermesMissingSessionError(error)) {
      throw error;
    }
    await forgetHermesSession(params.sessionKey, mappedResume);
    resume = undefined;
    cliActiveHead = undefined;
    rawOutput = await runHermesChatOnceWithMobileFileRoute({
      message: params.preparedMessage.cliMessage,
      sessionKey: params.sessionKey,
      context: params.context,
      preloadedSkillArgs: preloadedSkillContext.cliArgs,
      enableFileTransferRoute: preparationPlan.preloadFileTransferSkill,
      gatewayId: params.context.gatewayId ?? "clawconnect",
      sourceRunId: params.sourceRunId,
      historyCompletion: () => detectHermesHistoryCompletion({
        beforeSessions,
        sessionKey: params.sessionKey,
        userMessage: params.rawMessage,
        sourceRunId: params.sourceRunId,
      }),
    });
  }
  const output = sanitizeHermesChatOutput(rawOutput).trim();
  requireVisibleHermesOutput(output);
  const sessions = await listHermesSessions();
  const mappedSession = selectHermesSessionForCompletedChat(sessions, {
    beforeSessions,
    resume,
    userMessage: params.rawMessage,
  });
  if (mappedSession) {
    await rememberHermesSession(params.sessionKey, mappedSession);
  }
  const verifiedFileTransfer = await verifyHermesFileTransferIfRequired({
    plan: preparationPlan,
    gatewayId: params.context.gatewayId ?? "clawconnect",
    sessionKey: params.sessionKey,
    sessionId: resume ?? mappedSession?.hermesSessionId,
    sourceRunId: params.sourceRunId,
    output,
  });
  const usage = mappedSession?.hermesSessionId
    ? await collectHermesUsageSnapshot(mappedSession.hermesSessionId)
    : await readHermesStatusSnapshotAsync();
  return {
    output,
    sessionKey: params.sessionKey,
    artifactPaths: [],
    usage,
    ...verifiedFileTransfer,
  };
}

function isHermesChatAbortedError(error: unknown): boolean {
  return error instanceof Error && error.message === "hermes_chat_aborted";
}

async function recoverHermesCliSessionAfterAbort(params: {
  sessionKey: string;
  resume: string | undefined;
  mappedResume: string | undefined;
  activeHead: number | undefined;
  sourceRunId: string | undefined;
}): Promise<void> {
  if (!params.resume) {
    return;
  }
  // Hermes CLI writes the new user row before it reacts to SIGTERM. Rewind
  // only rows beyond the stable pre-run head so completed context remains
  // resumable and the canceled row cannot be answered on the next request.
  if (params.activeHead !== undefined && params.sourceRunId) {
    const recovered = await rewindHermesSessionAfterActiveHead(
      params.resume,
      params.activeHead,
      params.sourceRunId,
    );
    if (recovered) {
      return;
    }
  }

  // Old/unavailable state.db schemas cannot provide a safe row boundary. For
  // an implicit alias, fail closed by dropping only that alias instead of
  // risking a replay of the canceled prompt. Explicit Hermes session ids are
  // never silently deleted or remapped.
  if (params.mappedResume !== params.resume) {
    return;
  }
  try {
    await forgetHermesSession(params.sessionKey, params.mappedResume);
  } catch {
    // Abort delivery must not be replaced by a best-effort recovery failure.
  }
}

function requireVisibleHermesOutput(output: string): string {
  const visibleOutput = sanitizeHermesChatOutput(output).trim();
  if (!visibleOutput) {
    // 空完成会让移动端永久留下无内容回复；没有可见文本时必须走显式失败事件。
    throw new Error(HERMES_EMPTY_RESPONSE_MESSAGE);
  }
  if (isHermesProviderFailureOutput(visibleOutput)) {
    // Hermes 某些 Provider 会以 exit 0 返回错误文本；这仍是失败，不能渲染成正常 assistant 回复。
    throw new Error(visibleOutput);
  }
  return visibleOutput;
}

function isHermesProviderFailureOutput(output: string): boolean {
  const firstLine = output.split(/\r?\n/, 1)[0]?.trim() || "";
  return /^(?:[❌✕x]\s*)?API call failed(?: after \d+ retries)?\s*:/i.test(firstLine)
    || /^(?:[❌✕x]\s*)?HTTP\s+(?:401|402|403|429|5\d\d)\b/i.test(firstLine)
    || /^Error code:\s*(?:401|402|403|429|5\d\d)\b/i.test(firstLine);
}

async function recoverEmptyHermesApiOutputFromHistory(params: {
  output: string;
  hermesSessionId?: string;
  sessionKey: string;
  userMessage: string;
  sourceRunId?: string;
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
      sourceRunId: params.sourceRunId,
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
    // Hermes 会按 display.interface 自动切到 TUI；移动端桥接必须强制经典 CLI，
    // 再由 --quiet 只输出最终回答。Tools 过程仍由 agent.log watcher 独立发布。
    "--cli",
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

async function runHermesChatOnceWithMobileFileRoute(params: Parameters<typeof runHermesChatOnce>[0] & {
  enableFileTransferRoute: boolean;
  gatewayId: string;
  sourceRunId?: string;
}): Promise<string> {
  const hermesSessionId = params.resume?.trim();
  const sourceRunId = params.sourceRunId?.trim();
  if (!params.enableFileTransferRoute || !hermesSessionId || !sourceRunId) {
    return await runHermesChatOnce(params);
  }
  await registerHermesMobileFileRoute({
    hermesSessionId,
    gatewayId: params.gatewayId,
    sessionKey: params.sessionKey,
    sourceRunId,
  });
  try {
    return await runHermesChatOnce(params);
  } finally {
    await clearHermesMobileFileRoute(hermesSessionId, sourceRunId);
  }
}

async function runHermesChatStreaming(
  args: string[],
  sessionKey: string,
  context: LocalCommandContext,
  runId: string,
  env: NodeJS.ProcessEnv,
  historyCompletion?: () => Promise<string | undefined>,
): Promise<string> {
  const invocation = hermesInvocation(args);
  const child = spawn(invocation.command, invocation.args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  let stderr = "";
  let seq = 0;
  let stdoutLineBuffer = "";
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

  const appendStdout = (text: string): void => {
    // Hermes CLI stdout is a presentation stream, not a semantic assistant stream.
    // Some Windows builds emit transient TUI frames (Reasoning boxes, spinners, etc.)
    // even with --cli --quiet. Buffer it for terminal completion, but never expose it
    // as message.part.delta. The API path has typed assistant.delta events and remains
    // the only Hermes path allowed to stream assistant text.
    output += text;
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
    appendStdout(clean);
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
    appendStdout(chunk);
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
        if (commandDeniedTimeout) {
          finishReject(new Error(HERMES_COMMAND_DENIED_TIMEOUT_MESSAGE));
          return;
        }
        if (code && code !== 0) {
          const reason = stderr.trim() || output.trim() || `hermes chat exited with code ${code}`;
          finishReject(new Error(signal ? `${reason} (${signal})` : reason));
          return;
        }
        if (historyCompletion) {
          try {
            // Prefer the persisted assistant message over CLI presentation stdout.
            // Hermes writes the semantic answer before a normal process exit, while
            // stdout may still contain transient TUI frames on Windows.
            const persistedOutput = await historyCompletion();
            if (persistedOutput) {
              output = persistedOutput;
            }
          } catch {
            // Older/test Hermes installations may not expose readable history.
            // In that case --cli --quiet stdout remains the compatibility fallback.
          }
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
    await cleanupExpiredHermesInbox();
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
  const userSections = [sanitizeHermesUserAttachmentMarkers(message).trim()];
  if (refs.length > 0) {
    userSections.push(refs.join("\n"));
  }
  const runtimeHint = buildHermesRuntimeContextHint(
    readCachedHermesStatusSnapshot(HERMES_RUNTIME_CONTEXT_CACHE_MAX_AGE_MS),
  );
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

export function sanitizeHermesUserAttachmentMarkers(message: string): string {
  // Hermes 的本地文件提示只能由桥接层生成；让用户输入的同形标记失活，
  // 避免把任意 Host 路径伪装成移动端附件交给运行时读取。
  return message.replace(USER_FILE_MARKER_PREFIX_RE, "［file attached:");
}

export async function cleanupExpiredHermesInbox(
  inboxDir = HERMES_INBOX_DIR,
  nowMs = Date.now(),
  ttlMs = HERMES_INBOX_TTL_MS,
): Promise<void> {
  let sessions;
  try {
    sessions = await readdir(inboxDir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(sessions.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map(async (session) => {
    const sessionDir = join(inboxDir, session.name);
    let runs;
    try {
      runs = await readdir(sessionDir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(runs.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map(async (run) => {
      const runDir = join(sessionDir, run.name);
      try {
        const metadata = await stat(runDir);
        if (nowMs - metadata.mtimeMs >= Math.max(0, ttlMs)) {
          await rm(runDir, { recursive: true, force: true });
        }
      } catch {
        // 清理失败不能阻断当前聊天；下一轮发送会再次尝试。
      }
    }));
  }));
}

export async function planHermesChatPreparation(params: {
  message: string;
  gatewayId: string;
  sessionKey: string;
  sessionId?: string;
  sourceRunId?: string;
  fileTransferCapability?: "cli";
}): Promise<HermesChatPreparationPlan> {
  // A continuation is enabled only by a durable host-side pending state from
  // the same gateway/mobile/Hermes session.  The user's wording is deliberately
  // opaque to this router; Hermes receives the full history and decides what it
  // means (including any language, selection, or clarification).
  const pending = params.sessionId
    ? await getPendingHermesFileTransfer({
      gatewayId: params.gatewayId,
      sessionKey: params.sessionKey,
      hermesSessionId: params.sessionId,
      sourceRunId: params.sourceRunId,
    })
    : undefined;
  return {
    // The mobile relay explicitly grants the typed CLI file-transfer
    // capability on every turn. The model/tool protocol, rather than a
    // language-specific intent table, decides whether a send is needed. This
    // deliberately trades the API fast path for a buffered CLI path on mobile
    // turns, where send-file receipts are persisted atomically.
    preloadFileTransferSkill: params.fileTransferCapability === "cli" || pending !== undefined,
    fileTransferMode: pending ? "continuation" : undefined,
    ...(pending ? { pendingFileTransfer: pending } : {}),
  };
}

function normalizeHermesRole(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export async function verifyHermesFileTransferIfRequired(params: {
  plan: HermesChatPreparationPlan;
  gatewayId: string;
  sessionKey: string;
  sessionId?: string;
  sourceRunId?: string;
  output?: string;
}): Promise<{ verifiedFileTransferCount?: number; output?: string }> {
  if (!params.plan.preloadFileTransferSkill) {
    return {};
  }
  const messages = params.sessionId ? await readHermesSessionMessages(params.sessionId) : undefined;
  const evidence = params.sourceRunId
    ? collectHermesFileTransferEvidence(messages, params.sourceRunId)
    : [];
  if (evidence.length > 0) {
    await clearPendingHermesFileTransfer(
      params.gatewayId,
      params.sessionKey,
      params.plan.pendingFileTransfer?.sourceRunId,
    );
    return {
      verifiedFileTransferCount: evidence.length,
      output: `已发送 ${evidence.length} 个文件，请查收。`,
    };
  }
  const outcome = params.sourceRunId
    ? collectHermesFileTransferOutcome(messages, params.sourceRunId)
    : undefined;
  if (outcome?.kind === "clarification") {
    if (params.sessionId && params.sourceRunId) {
      await recordPendingHermesFileTransfer({
        gatewayId: params.gatewayId,
        sessionKey: params.sessionKey,
        hermesSessionId: params.sessionId,
        sourceRunId: params.sourceRunId,
        continuation: false,
      });
    }
    // Only the typed content field is displayable. Raw assistant prose is
    // deliberately discarded, and this outcome is never delivery evidence.
    return {
      output: outcome.assistantText ?? HERMES_FILE_TRANSFER_CONTENT_MISSING_MESSAGE,
    };
  }
  if (outcome?.kind === "cancelled") {
    await clearPendingHermesFileTransfer(
      params.gatewayId,
      params.sessionKey,
      params.plan.pendingFileTransfer?.sourceRunId,
    );
    return {
      output: outcome.assistantText ?? HERMES_FILE_TRANSFER_CANCELLED_MESSAGE,
    };
  }
  if (outcome?.kind === "ordinary") {
    await clearPendingHermesFileTransfer(
      params.gatewayId,
      params.sessionKey,
      params.plan.pendingFileTransfer?.sourceRunId,
    );
    // Ordinary chat is shown only through the typed assistantText field. The
    // model's ordinary label is routing metadata, never proof of delivery.
    return {
      output: outcome.assistantText ?? HERMES_FILE_TRANSFER_CONTENT_MISSING_MESSAGE,
    };
  }
  if (outcome?.kind === "attempted") {
    await clearPendingHermesFileTransfer(
      params.gatewayId,
      params.sessionKey,
      params.plan.pendingFileTransfer?.sourceRunId,
    );
    return {
      verifiedFileTransferCount: 0,
      output: HERMES_FILE_TRANSFER_NOT_SENT_MESSAGE,
    };
  }
  if (params.sourceRunId && hasHermesSendFileAttempt(messages, params.sourceRunId)) {
    return {
      verifiedFileTransferCount: 0,
      output: HERMES_FILE_TRANSFER_NOT_SENT_MESSAGE,
    };
  }
  // File-transfer capability is available on every mobile turn, but capability
  // alone does not turn ordinary chat into a file operation. Preserve the Host
  // answer unless this exact turn emitted a typed outcome or actually invoked
  // the first-party terminal command. This keeps failure closed around a real
  // send attempt without replacing unrelated Hermes replies.
  return {};
}

function hasHermesSendFileAttempt(
  messages: Array<Record<string, unknown>> | undefined,
  sourceRunId: string,
): boolean {
  const currentIndex = currentHermesTurnIndex(messages, sourceRunId);
  if (currentIndex < 0 || !messages) return false;
  for (const message of messages.slice(currentIndex + 1)) {
    if (normalizeHermesRole(message.role) === "user") break;
    if (normalizeHermesRole(message.role) !== "assistant") continue;
    const rawToolCalls = typeof message.tool_calls === "string"
      ? parseJsonValue(message.tool_calls)
      : message.tool_calls;
    if (!Array.isArray(rawToolCalls)) continue;
    for (const rawToolCall of rawToolCalls) {
      const toolCall = rawToolCall && typeof rawToolCall === "object" && !Array.isArray(rawToolCall)
        ? rawToolCall as Record<string, unknown>
        : undefined;
      const fn = toolCall?.function && typeof toolCall.function === "object" && !Array.isArray(toolCall.function)
        ? toolCall.function as Record<string, unknown>
        : undefined;
      const functionName = normalizeHermesRole(fn?.name);
      if (functionName === "clawconnect_send_file") return true;
      if (functionName !== "terminal") continue;
      const rawArguments = typeof fn?.arguments === "string"
        ? parseJsonValue(fn.arguments)
        : fn?.arguments;
      const args = rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)
        ? rawArguments as Record<string, unknown>
        : undefined;
      if (typeof args?.command === "string" && isClawConnectSendFileCommand(args.command)) {
        return true;
      }
    }
  }
  return false;
}

function isClawConnectSendFileCommand(command: string): boolean {
  return /(?:^|[\s;&|])(?:["'][^"']*clawconnect["']|[^\s;&|]*clawconnect)\s+send-file(?:\s|$)/i.test(command);
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** Read only first-party terminal outcome records for the exact current turn. */
export function collectHermesFileTransferOutcome(
  messages: Array<Record<string, unknown>> | undefined,
  sourceRunId: string,
): HermesFileTransferOutcome | undefined {
  const currentIndex = currentHermesTurnIndex(messages, sourceRunId);
  if (currentIndex < 0 || !messages) return undefined;
  const outcomes: HermesFileTransferOutcome[] = [];
  for (const message of messages.slice(currentIndex + 1)) {
    if (normalizeHermesRole(message.role) === "user") break;
    if (normalizeHermesRole(message.role) !== "tool" || normalizeHermesRole(message.tool_name) !== "terminal") continue;
    for (const record of terminalResultRecords(message)) {
      if (
        record.protocol !== "clawconnect.hermes-file-transfer-outcome.v1"
        || record.sourceRunId !== sourceRunId
        || record.sourceRole !== "assistant"
        || record.status !== "completed"
        || record.exit_code !== 0
        || (record.kind !== "ordinary" && record.kind !== "clarification" && record.kind !== "attempted" && record.kind !== "cancelled")
      ) continue;
      const assistantText = typeof record.assistantText === "string" ? record.assistantText.trim() : "";
      if (record.kind !== "attempted" && !assistantText) continue;
      outcomes.push({
        protocol: "clawconnect.hermes-file-transfer-outcome.v1",
        kind: record.kind,
        sourceRunId,
        sourceRole: "assistant",
        status: "completed",
        ...(assistantText ? { assistantText } : {}),
      });
    }
  }
  if (outcomes.length !== 1) return undefined;
  return outcomes[0];
}

export function collectHermesFileTransferEvidence(
  messages: Array<Record<string, unknown>> | undefined,
  sourceRunId: string,
): string[] {
  if (!messages) {
    return [];
  }
  const currentIndex = currentHermesTurnIndex(messages, sourceRunId);
  if (currentIndex < 0) {
    return [];
  }
  const ids = new Set<string>();
  for (const message of messages.slice(currentIndex + 1)) {
    if (normalizeHermesRole(message.role) === "user") {
      break;
    }
    if (normalizeHermesRole(message.role) !== "tool") continue;
    const toolName = normalizeHermesRole(message.tool_name);
    if (toolName === "clawconnect_send_file") {
      const receipt = parseJsonRecord(stringValue(message.content) ?? "");
      if (receipt?.ok === true
        && receipt.sourceRunId === sourceRunId
        && receipt.status === "completed"
        && typeof receipt.fileId === "string"
        && /^file_[a-z0-9]+$/i.test(receipt.fileId)) {
        ids.add(receipt.fileId);
      }
      continue;
    }
    // Only the legacy first-party terminal result is additional evidence. A
    // delegate summary, wrapper output, or assistant claim cannot manufacture
    // an attachment by repeating the command name and a success word.
    if (toolName !== "terminal") continue;
    for (const record of terminalResultRecords(message)) {
      if (record.sourceRunId !== sourceRunId
        || record.sourceRole !== "assistant"
        || record.status !== "completed"
        || record.exit_code !== 0
        || typeof record.fileId !== "string"
        || !/^file_[a-z0-9]+$/i.test(record.fileId)) {
        continue;
      }
      ids.add(record.fileId);
    }
  }
  return [...ids];
}

function currentHermesTurnIndex(
  messages: Array<Record<string, unknown>> | undefined,
  sourceRunId: string,
): number {
  if (!messages || !sourceRunId.trim()) return -1;
  let currentIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (normalizeHermesRole(message?.role) === "user" && hermesSourceRunIdFromMessage(message) === sourceRunId) {
      currentIndex = index;
    }
  }
  return currentIndex;
}

function terminalResultRecords(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = stringValue(message.content);
  if (!content) {
    return [];
  }
  const outer = parseJsonRecord(content);
  if (!outer) {
    return [];
  }
  const records: Array<Record<string, unknown>> = [outer];
  const output = stringValue(outer.output);
  if (output) {
    for (const fragment of extractJsonObjects(output)) {
      const record = parseJsonRecord(fragment);
      if (record) {
        // Hermes stores the command envelope's exit_code beside the textual
        // send-file JSON payload; the payload itself carries the Relay fields.
        records.push(record.exit_code === undefined && outer.exit_code !== undefined
          ? { ...record, exit_code: outer.exit_code }
          : record);
      }
    }
  }
  return records;
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function extractJsonObjects(value: string): string[] {
  const fragments: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        fragments.push(value.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return fragments;
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
