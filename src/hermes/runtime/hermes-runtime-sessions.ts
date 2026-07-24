
import type { LocalResult } from "../../core/command-types.js";
import { forgetHermesSession, getMappedHermesSessionId } from "../hermes-session-store.js";
import { listHermesSessions } from "./hermes-runtime-usage.js";
import { runHermesOutput, runHermesOutputAsync } from "./hermes-runtime-command-utils.js";
import { stringParam, toRecord } from "./hermes-runtime-values.js";
import { errorMessageWithOutput, isHermesMissingSessionError } from "./hermes-runtime-process.js";
import {
  buildEmptyHermesHistoryExport,
  exportHermesSessionFromStateDb,
} from "./hermes-runtime-state-db.js";

const HERMES_HISTORY_CLI_FALLBACK_TIMEOUT_MS = 12_000;

let activeHistoryCliFallback: {
  key: string;
  promise: Promise<LocalResult>;
} | undefined;

export async function runHermesSessionsList(): Promise<LocalResult> {
  try {
    const sessions = await listHermesSessions();
    return { ok: true, payload: { sessions, items: sessions } };
  } catch (error) {
    return { ok: false, error: errorMessageWithOutput(error) };
  }
}

export function runHermesSessionRename(params: unknown): LocalResult {
  const record = toRecord(params);
  const sessionId = stringParam(record, "sessionId", "hermesSessionId", "id");
  const title = stringParam(record, "title", "name");
  if (!sessionId || !title) {
    return { ok: false, error: "session_id_and_title_required" };
  }
  return runHermesOutput(["sessions", "rename", sessionId, title]);
}

export async function runHermesSessionDelete(params: unknown): Promise<LocalResult> {
  const record = toRecord(params);
  const sessionKey = stringParam(record, "sessionKey", "key", "session");
  const sessionId = stringParam(record, "sessionId", "hermesSessionId", "id")
    ?? (await resolveHermesSessionIdFromParams(record)).sessionId;
  if (!sessionId) {
    return { ok: false, error: "session_id_required" };
  }
  const result = runHermesOutput(["sessions", "delete", "--yes", sessionId]);
  if (!result.ok) {
    return result;
  }
  await forgetHermesSession(sessionKey ?? sessionId, sessionId);
  return {
    ok: true,
    payload: {
      ...(toRecord(result.payload)),
      deleted: true,
      sessionId,
      sessionKey,
    },
  };
}

export async function runHermesSessionExport(params: unknown): Promise<LocalResult> {
  const record = toRecord(params);
  const resolved = await resolveHermesSessionIdFromParams(record);
  const sessionId = resolved.sessionId;
  const output = stringParam(record, "output", "outputPath");
  const requireResolvedSession = record.requireResolvedSession === true;
  if (sessionId) {
    if (record.skipStateDb !== true) {
      const stateDbExport = await exportHermesSessionFromStateDb(sessionId);
      if (stateDbExport) {
        return { ok: true, payload: { output: JSON.stringify(stateDbExport) } };
      }
    }
  } else if (requireResolvedSession) {
    return {
      ok: true,
      payload: {
        output: JSON.stringify(buildEmptyHermesHistoryExport(resolved.sessionKey)),
      },
    };
  }
  const args = ["sessions", "export", output ?? "-"];
  if (sessionId) args.push("--session-id", sessionId);
  // chat.history 会和 chat.send 共享同一个 relay manager 事件循环；这里必须异步，避免导出历史时饿死实时消息。
  const runExport = (exportArgs: string[]): Promise<LocalResult> => record.historyFallback === true
    ? runBoundedHermesHistoryCliFallback(exportArgs, sessionId ?? resolved.sessionKey ?? "latest")
    : runHermesOutputAsync(exportArgs, 10 * 60_000);
  const result = await runExport(args);
  if (
    !result.ok
    && resolved.fromMappedSessionKey
    && resolved.sessionKey
    && sessionId
    && isHermesMissingSessionError(result.error)
  ) {
    await forgetHermesSession(resolved.sessionKey, sessionId);
    if (requireResolvedSession) {
      return {
        ok: true,
        payload: {
          output: JSON.stringify(buildEmptyHermesHistoryExport(resolved.sessionKey)),
        },
      };
    }
    return await runExport(["sessions", "export", output ?? "-"]);
  }
  return result;
}

export async function resolveHermesSessionIdFromParams(record: Record<string, unknown>): Promise<{
  sessionId?: string;
  sessionKey?: string;
  fromMappedSessionKey: boolean;
}> {
  const explicitSessionId = stringParam(record, "sessionId", "hermesSessionId", "id");
  if (explicitSessionId) {
    return { sessionId: explicitSessionId, fromMappedSessionKey: false };
  }
  const sessionKey = stringParam(record, "sessionKey", "key", "session");
  if (!sessionKey) {
    return { fromMappedSessionKey: false };
  }
  if (sessionKey.toLowerCase().startsWith("hermes:")) {
    const hermesId = sessionKey.slice("hermes:".length).trim();
    return { sessionId: hermesId || undefined, sessionKey, fromMappedSessionKey: false };
  }
  if (/^[0-9]{8}_[0-9]{6}_[A-Za-z0-9_-]+$/.test(sessionKey)) {
    return { sessionId: sessionKey, sessionKey, fromMappedSessionKey: false };
  }
  return {
    sessionId: await getMappedHermesSessionId(sessionKey),
    sessionKey,
    fromMappedSessionKey: true,
  };
}

async function runBoundedHermesHistoryCliFallback(args: string[], key: string): Promise<LocalResult> {
  const normalizedKey = key.trim() || "latest";
  if (activeHistoryCliFallback) {
    if (activeHistoryCliFallback.key === normalizedKey) {
      return await activeHistoryCliFallback.promise;
    }
    return { ok: false, error: "hermes_history_export_busy" };
  }

  const promise = runHermesOutputAsync(args, hermesHistoryCliFallbackTimeoutMs());
  activeHistoryCliFallback = { key: normalizedKey, promise };
  try {
    return await promise;
  } finally {
    if (activeHistoryCliFallback?.promise === promise) {
      activeHistoryCliFallback = undefined;
    }
  }
}

function hermesHistoryCliFallbackTimeoutMs(): number {
  const configured = Number(process.env.CLAWCONNECT_HERMES_HISTORY_EXPORT_TIMEOUT_MS);
  return Number.isFinite(configured)
    ? Math.max(250, Math.min(HERMES_HISTORY_CLI_FALLBACK_TIMEOUT_MS, Math.floor(configured)))
    : HERMES_HISTORY_CLI_FALLBACK_TIMEOUT_MS;
}
