// Hermes 对话输出校验与恢复：可见输出约束、Provider 失败识别、API 空输出的历史回补以及 CLI 中止后的会话回卷。
import { forgetHermesSession } from "../hermes-session-store.js";
import { sanitizeHermesChatOutput } from "./hermes-runtime-process.js";
import { detectHermesHistoryCompletion } from "./hermes-runtime-history-completion.js";
import { rewindHermesSessionAfterActiveHead } from "./hermes-runtime-state-db.js";

const HERMES_API_EMPTY_OUTPUT_HISTORY_COMPLETION_TIMEOUT_MS = 12_000;
const HERMES_API_EMPTY_OUTPUT_HISTORY_COMPLETION_POLL_MS = 500;
const HERMES_EMPTY_RESPONSE_MESSAGE = "Hermes 未返回可见回复，请检查当前模型额度或 Provider 凭据后重试。";

export function isHermesChatAbortedError(error: unknown): boolean {
  return error instanceof Error && error.message === "hermes_chat_aborted";
}

export async function recoverHermesCliSessionAfterAbort(params: {
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

export function requireVisibleHermesOutput(output: string): string {
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

export async function recoverEmptyHermesApiOutputFromHistory(params: {
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
