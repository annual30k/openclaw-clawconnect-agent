// Hermes CLI 对话执行：构建 chat 参数、派生子进程、过滤展示输出并把工具/stderr 事件发布给 Relay。
import { spawn } from "child_process";
import type { LocalCommandContext } from "../../core/command-types.js";
import {
  buildToolInvocationUpdatedEvent,
} from "../../core/relay/timeline-event-builder.js";
import {
  CHAT_TIMEOUT_MS,
  SUBPROCESS_ENV,
  hermesInvocation,
  isHermesCommandDeniedTimeoutLine,
  runHermes,
  stripAnsi,
  stripHermesSessionResumeNotices,
} from "./hermes-runtime-process.js";
import type { HermesToolLogEvent } from "./hermes-runtime-types.js";
import { buildHermesCliReasoningArgs } from "./hermes-runtime-reasoning.js";
import {
  createHermesToolLogWatcher,
  hermesToolState,
} from "./hermes-runtime-tool-log-watcher.js";
import {
  clearHermesMobileFileRoute,
  registerHermesMobileFileRoute,
} from "./hermes-mobile-file-route-store.js";

const HERMES_HISTORY_COMPLETION_GRACE_MS = 2_000;
const HERMES_HISTORY_COMPLETION_POLL_MS = 1_000;
const HERMES_COMMAND_DENIED_TIMEOUT_MESSAGE = "Timeout – denying command";

async function runHermesChatOnce(params: {
  message: string;
  sessionKey: string;
  resume?: string;
  context: LocalCommandContext;
  preloadedSkillArgs?: string[];
  reasoningEffort?: string;
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
    ...buildHermesCliReasoningArgs(params.reasoningEffort),
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

export async function runHermesChatOnceWithMobileFileRoute(params: Parameters<typeof runHermesChatOnce>[0] & {
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

function hermesChatSubprocessEnv(runId: string, sessionKey: string): NodeJS.ProcessEnv {
  return {
    ...SUBPROCESS_ENV,
    CLAWCONNECT_SOURCE_RUN_ID: runId,
    CLAWCONNECT_SESSION_KEY: sessionKey,
    CLAWCONNECT_CHAT_SESSION_KEY: sessionKey,
  };
}
