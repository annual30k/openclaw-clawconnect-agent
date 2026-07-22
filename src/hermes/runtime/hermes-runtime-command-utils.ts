
import type { LocalResult } from "../../core/command-types.js";
import { DEFAULT_TIMEOUT_MS, errorMessageWithOutput, runHermes, runHermesAsync } from "./hermes-runtime-process.js";
import { readHermesLogTail } from "./hermes-runtime-logs.js";

export function runHermesOutput(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): LocalResult {
  try {
    const output = runHermes(args, timeoutMs);
    return { ok: true, payload: { output } };
  } catch (error) {
    return { ok: false, error: errorMessageWithOutput(error) };
  }
}

export async function runHermesOutputAsync(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<LocalResult> {
  try {
    const output = await runHermesAsync(args, timeoutMs);
    return { ok: true, payload: { output } };
  } catch (error) {
    return { ok: false, error: errorMessageWithOutput(error) };
  }
}

export function runHermesLogs(params: unknown): LocalResult {
  return readHermesLogTail(params);
}
