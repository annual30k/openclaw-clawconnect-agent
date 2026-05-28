
import type { LocalResult } from "../../core/command-types.js";
import { forgetHermesSession, getMappedHermesSessionId } from "../hermes-session-store.js";
import { listHermesSessions } from "./hermes-runtime-usage.js";
import { runHermesOutput } from "./hermes-runtime-command-utils.js";
import { stringParam, toRecord } from "./hermes-runtime-values.js";
import { errorMessageWithOutput } from "./hermes-runtime-process.js";

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
    ?? await resolveHermesSessionIdFromParams(record);
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
  const sessionId = stringParam(record, "sessionId", "hermesSessionId", "id")
    ?? await resolveHermesSessionIdFromParams(record);
  const output = stringParam(record, "output", "outputPath");
  const args = ["sessions", "export", output ?? "-"];
  if (sessionId) args.push("--session-id", sessionId);
  return runHermesOutput(args, 10 * 60_000);
}

async function resolveHermesSessionIdFromParams(record: Record<string, unknown>): Promise<string | undefined> {
  const sessionKey = stringParam(record, "sessionKey", "key", "session");
  if (!sessionKey) {
    return undefined;
  }
  if (sessionKey.toLowerCase().startsWith("hermes:")) {
    const hermesId = sessionKey.slice("hermes:".length).trim();
    return hermesId || undefined;
  }
  if (/^[0-9]{8}_[0-9]{6}_[A-Za-z0-9_-]+$/.test(sessionKey)) {
    return sessionKey;
  }
  return await getMappedHermesSessionId(sessionKey);
}
