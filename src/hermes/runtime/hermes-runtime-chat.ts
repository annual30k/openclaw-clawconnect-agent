
import type { LocalCommandContext } from "../../core/command-types.js";
import {
  buildMobileAssistantDeltaPayload,
} from "../../core/relay/mobile-chat-run-bridge.js";
import {
  forgetHermesSession,
  getMappedHermesSessionId,
  rememberHermesSession,
} from "../hermes-session-store.js";
import {
  isHermesMissingSessionError,
  sanitizeHermesChatOutput,
} from "./hermes-runtime-process.js";
import type { HermesChatResult } from "./hermes-runtime-types.js";
import {
  collectHermesUsageSnapshot,
  listHermesSessions,
  readHermesStatusSnapshotAsync,
} from "./hermes-runtime-usage.js";
import {
  detectHermesHistoryCompletion,
  selectHermesSessionForCompletedChat,
} from "./hermes-runtime-history-completion.js";
import { captureHermesSessionActiveHead } from "./hermes-runtime-state-db.js";
import { ensureHermesApiSessionForMobileRoute, tryRunHermesApiChat } from "./hermes-runtime-api-client.js";
import { resolveHermesPreloadedSkillContext } from "./hermes-runtime-preloaded-skills.js";
import { resolveHermesSessionReasoningEffort } from "./hermes-runtime-reasoning.js";
import {
  isHermesSlashCommandMessage,
  runHermesSlashCommand,
} from "./hermes-runtime-slash-command.js";
import { runSerializedHermesChat } from "./hermes-runtime-chat-queue.js";
import {
  prepareRequiredHermesMessage,
  type PreparedHermesMessage,
} from "./hermes-runtime-chat-message.js";
import {
  planHermesChatPreparation,
  verifyHermesFileTransferIfRequired,
} from "./hermes-runtime-chat-file-transfer.js";
import {
  isHermesChatAbortedError,
  recoverEmptyHermesApiOutputFromHistory,
  recoverHermesCliSessionAfterAbort,
  requireVisibleHermesOutput,
} from "./hermes-runtime-chat-output.js";
import { runHermesChatOnceWithMobileFileRoute } from "./hermes-runtime-chat-cli.js";

export { selectHermesSessionForCompletedChat } from "./hermes-runtime-history-completion.js";
export { latestTerminalAssistantReplyFromHermesExport } from "./hermes-runtime-history-completion.js";
export { parseHermesToolLogLine } from "./hermes-runtime-tool-log-watcher.js";
export { isHermesSlashCommandMessage } from "./hermes-runtime-slash-command.js";
export {
  buildHermesRuntimeContextHint,
  cleanupExpiredHermesInbox,
  sanitizeHermesUserAttachmentMarkers,
} from "./hermes-runtime-chat-message.js";
export {
  collectHermesFileTransferEvidence,
  collectHermesFileTransferOutcome,
  planHermesChatPreparation,
  verifyHermesFileTransferIfRequired,
} from "./hermes-runtime-chat-file-transfer.js";

const EMPTY_PRELOADED_SKILL_CONTEXT = {
  cliArgs: [] as string[],
  requiredToolsets: [] as string[],
  skillNames: [] as string[],
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
        gatewayId: context.gatewayId,
        // 排队对话在斜杠命令持有的会话串行槽位内执行，不能再次进入 runSerializedHermesChat，
        // 否则会等待自身所在的槽位完成而永久死锁。
        // 上下文只携带显式传递的 gatewayId：本轮不是移动端发起的独立请求，不能复用原请求的 requestId。
        runQueuedChat: (queued) => runUnserializedHermesChatTurn({
          rawMessage: queued.message,
          attachments: undefined,
          sessionKey: queued.sessionKey,
          hermesSessionId: queued.hermesSessionId,
          context: { gatewayId: queued.gatewayId },
        }),
      })
    ));
  }
  const sourceRunId = resolveHermesSourceRunId(context);
  const preparedMessage = await prepareRequiredHermesMessage(rawMessage, record.attachments, sessionKey, sourceRunId);

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

/** 调用方必须已持有该 sessionKey 的串行槽位。 */
async function runUnserializedHermesChatTurn(params: {
  rawMessage: string;
  attachments: unknown;
  sessionKey: string;
  hermesSessionId: string | undefined;
  context: LocalCommandContext;
}): Promise<HermesChatResult> {
  const sourceRunId = resolveHermesSourceRunId(params.context);
  const preparedMessage = await prepareRequiredHermesMessage(
    params.rawMessage,
    params.attachments,
    params.sessionKey,
    sourceRunId,
  );
  return await runHermesChatPrepared({
    rawMessage: params.rawMessage,
    preparedMessage,
    sessionKey: params.sessionKey,
    sourceRunId,
    hermesSessionId: params.hermesSessionId,
    context: params.context,
  });
}

function resolveHermesSourceRunId(context: LocalCommandContext): string | undefined {
  return typeof context.requestId === "string" && context.requestId.trim().length > 0
    ? context.requestId.trim()
    : undefined;
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
  // 会话级思考等级覆盖在本轮开始时一次性解析，API 与 CLI（含重试）使用同一值。
  const reasoningEffort = await resolveHermesSessionReasoningEffort(params.context.gatewayId, params.sessionKey);
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
        reasoningEffort,
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
        reasoningEffort,
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
      reasoningEffort,
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
      reasoningEffort,
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
