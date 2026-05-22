
import { spawn } from "child_process";
import type { LocalCommandContext, LocalResult } from "../../commands/local-runtime.js";
import { SUBPROCESS_ENV, resolveHermesBin, stripAnsi } from "./hermes-runtime-process.js";

export async function runHermesLifecycle(
  action: "start" | "stop" | "restart",
  context: LocalCommandContext,
): Promise<LocalResult> {
  const args = ["gateway", action];
  const publishEvent = context.publishEvent;
  const requestId = context.requestId;
  const gatewayId = context.gatewayId;
  const child = spawn(resolveHermesBin(), args, {
    env: SUBPROCESS_ENV,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  let seq = 0;

  const emit = (stream: "stdout" | "stderr" | "status", text: string): void => {
    const clean = stripAnsi(text).trimEnd();
    if (!clean) {
      return;
    }
    output += `${clean}\n`;
    publishEvent?.({
      type: "event",
      event: "maintenance_log",
      payload: {
        gatewayId,
        requestId,
        runId: requestId,
        stream,
        seq: seq += 1,
        ts: Date.now(),
        text: clean,
      },
    });
  };

  child.stdout?.on("data", (chunk) => emit("stdout", chunk.toString()));
  child.stderr?.on("data", (chunk) => emit("stderr", chunk.toString()));
  emit("status", `Running: hermes gateway ${action}`);

  return await new Promise<LocalResult>((resolveResult) => {
    child.once("error", (error) => resolveResult({ ok: false, error: String(error) }));
    child.once("close", (code, signal) => {
      const summary = typeof code === "number"
        ? `hermes gateway ${action} exited with code ${code}`
        : `hermes gateway ${action} exited${signal ? ` with signal ${signal}` : ""}`;
      emit("status", summary);
      if (code && code !== 0) {
        resolveResult({ ok: false, error: output.trim() || summary });
        return;
      }
      resolveResult({ ok: true, payload: { output: output.trim() || summary } });
    });
  });
}
