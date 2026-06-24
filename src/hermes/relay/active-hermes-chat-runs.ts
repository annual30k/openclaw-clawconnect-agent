import type { MobileChatRun } from "../../core/relay/mobile-chat-run-bridge.js";

export type ActiveHermesChatRun = {
  controller: AbortController;
  run: MobileChatRun;
};

export function rememberActiveHermesChatRun(
  activeChatRuns: Map<string, ActiveHermesChatRun>,
  run: MobileChatRun,
  params: unknown,
  requestId: string | undefined,
  controller: AbortController,
): void {
  const entry = { controller, run };
  for (const key of [run.runId, requestId, readStringParam(params, "idempotencyKey")]) {
    if (key) {
      activeChatRuns.set(key, entry);
    }
  }
}

export function forgetActiveHermesChatRun(
  activeChatRuns: Map<string, ActiveHermesChatRun>,
  run: { runId: string; sessionKey: string },
): void {
  for (const [key, entry] of activeChatRuns) {
    if (entry.run.runId === run.runId && entry.run.sessionKey === run.sessionKey) {
      activeChatRuns.delete(key);
    }
  }
}

export function resolveHermesAbortRun(
  params: unknown,
  activeChatRuns: Map<string, ActiveHermesChatRun>,
): ActiveHermesChatRun | undefined {
  const runId = readStringParam(params, "runId")
    ?? readStringParam(params, "run_id")
    ?? readStringParam(params, "idempotencyKey");
  if (runId) {
    return activeChatRuns.get(runId);
  }
  const sessionKey = readStringParam(params, "sessionKey") ?? readStringParam(params, "session_key");
  if (sessionKey) {
    return [...activeChatRuns.values()].find((entry) => entry.run.sessionKey === sessionKey);
  }
  return undefined;
}

export function resolveHermesChatPreferredRunId(params: unknown, voiceInputRun?: MobileChatRun): string | undefined {
  return voiceInputRun?.runId
    ?? readStringParam(params, "runId")
    ?? readStringParam(params, "run_id")
    ?? readStringParam(params, "idempotencyKey");
}

function readStringParam(params: unknown, key: string): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
