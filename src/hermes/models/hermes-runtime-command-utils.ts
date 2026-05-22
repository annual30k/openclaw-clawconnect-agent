
import type { LocalResult } from "../../commands/local-runtime.js";
import { DEFAULT_TIMEOUT_MS, errorMessageWithOutput, runHermes } from "./hermes-runtime-process.js";

export function runHermesOutput(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): LocalResult {
  try {
    const output = runHermes(args, timeoutMs);
    return { ok: true, payload: { output } };
  } catch (error) {
    return { ok: false, error: errorMessageWithOutput(error) };
  }
}

export function runHermesLogs(params: unknown): LocalResult {
  const record = params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
  const logName = typeof record.logName === "string" && record.logName.trim().length > 0 ? record.logName.trim() : "gateway";
  const limit = typeof record.limit === "number" && Number.isFinite(record.limit) ? Math.max(1, Math.min(2000, Math.floor(record.limit))) : 100;
  return runHermesOutput(["logs", logName, "-n", String(limit)]);
}
