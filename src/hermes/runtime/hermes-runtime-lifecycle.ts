
import { spawn } from "child_process";
import type { LocalCommandContext, LocalResult } from "../../core/command-types.js";
import { getActiveProfile, profileDisplayName } from "../../config/profile.js";
import { SUBPROCESS_ENV, resolveHermesBin, stripAnsi } from "./hermes-runtime-process.js";

export function buildClawConnectProfileRestartArgs(profile: string | undefined | null, entrypoint = process.argv[1]): string[] {
  const args = [entrypoint, "restart"].filter((arg): arg is string => Boolean(arg));
  if (profile) {
    args.push("--profile", profile);
  }
  return args;
}

export function runClawConnectProfileRestart(
  context: LocalCommandContext,
  options: {
    profile?: string | null;
    entrypoint?: string;
    nodePath?: string;
    delaySeconds?: number;
  } = {},
): LocalResult {
  const profile = options.profile ?? getActiveProfile();
  const profileName = profileDisplayName(profile);
  const entrypoint = options.entrypoint ?? process.argv[1];
  if (!entrypoint) {
    return { ok: false, error: "Unable to resolve clawconnect entrypoint for service restart." };
  }

  const nodePath = options.nodePath ?? process.execPath;
  const restartArgs = buildClawConnectProfileRestartArgs(profile, entrypoint);
  const delaySeconds = options.delaySeconds ?? 0.5;
  const child = process.platform === "win32"
    ? spawn(nodePath, restartArgs, {
        env: SUBPROCESS_ENV,
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      })
    : spawn("/bin/sh", [
        "-c",
        "sleep \"$1\"; shift; exec \"$@\"",
        "clawconnect-profile-restart",
        String(delaySeconds),
        nodePath,
        ...restartArgs,
      ], {
        env: SUBPROCESS_ENV,
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });

  child.once("error", (error) => {
    console.warn(`[hermes] failed to schedule ClawConnect ${profileName} restart:`, String(error));
  });
  child.unref();

  const text = `ClawConnect ${profileName} profile restart requested.`;
  context.publishEvent?.({
    type: "event",
    event: "maintenance_log",
    payload: {
      gatewayId: context.gatewayId,
      requestId: context.requestId,
      runId: context.requestId,
      stream: "status",
      seq: 1,
      ts: Date.now(),
      text,
    },
  });

  return { ok: true, payload: { output: text } };
}

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
