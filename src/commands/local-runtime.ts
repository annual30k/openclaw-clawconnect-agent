import { existsSync } from "fs";
import { dirname } from "path";
import { homedir } from "os";
import { execSync, spawn } from "child_process";

export type LocalResult =
  | { ok: true; payload?: unknown }
  | { ok: false; error: string };

export type GatewayRuntimeState = "running" | "stopped" | "unknown";

// ---------------------------------------------------------------------------
// Subprocess environment
//
// launchd services run with a minimal PATH that lacks:
//   - The node binary itself  (breaks #!/usr/bin/env node shebangs)
//   - Homebrew / local bins   (breaks finding `openclaw`)
//
// Fix: build a rich PATH for every subprocess by prepending:
//   1. dirname(process.execPath) -- the dir containing the node binary running
//      this very process. Guarantees #!/usr/bin/env node always resolves.
//   2. Common package-manager bin dirs (homebrew, /usr/local).
// ---------------------------------------------------------------------------

const NODE_BIN_DIR = dirname(process.execPath);

const SUBPROCESS_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: homedir(),
  PATH: [
    NODE_BIN_DIR,
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    process.env.PATH ?? "/usr/bin:/bin",
  ].join(":"),
};

function resolveOpenclawBin(): string {
  const explicitBin = process.env.OPENCLAW_BIN?.trim();
  if (explicitBin) {
    if (existsSync(explicitBin)) {
      return explicitBin;
    }
  }

  try {
    const p = execSync("which openclaw", { stdio: "pipe", env: SUBPROCESS_ENV, timeout: 3000 })
      .toString().trim();
    if (p && existsSync(p)) {
      return p;
    }
  } catch {
    // fall through
  }
  return "openclaw";
}

let cachedOpenclawBin: string | null = null;

function getOpenclawBin(): string {
  if (cachedOpenclawBin == null) {
    cachedOpenclawBin = resolveOpenclawBin();
  }
  return cachedOpenclawBin;
}

export function execErrorOutput(err: unknown): string {
  const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
  const out = e.stdout?.toString() ?? "";
  const errStr = e.stderr?.toString() ?? "";
  if (out && errStr) return `${out}\n${errStr}`;
  return out || errStr;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/** Run openclaw with the resolved path and the enriched subprocess environment. */
export function openclaw(args: string): Buffer {
  return execSync(`"${getOpenclawBin()}" ${args}`, { stdio: "pipe", env: SUBPROCESS_ENV });
}

function launchGatewayLifecycleCommand(action: "start" | "restart", source = "clawconnect"): LocalResult {
  try {
    const child = spawn(getOpenclawBin(), ["gateway", action], {
      env: SUBPROCESS_ENV,
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });

    child.once("error", (err) => {
      console.warn(`[${source}] gateway ${action} failed to start:`, String(err));
    });
    child.unref();
    return { ok: true, payload: { output: `Gateway ${action} requested.` } };
  } catch (err) {
    const output = execErrorOutput(err);
    return output ? { ok: true, payload: { output } } : { ok: false, error: errorMessage(err) };
  }
}

export function parseGatewayRuntimeState(output: string): GatewayRuntimeState {
  const stripped = output.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
  const runtimeLine = stripped
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^Runtime:/i.test(line));

  if (!runtimeLine) {
    return "unknown";
  }

  const runtime = runtimeLine.replace(/^Runtime:\s*/i, "").trim().toLowerCase();
  if (runtime === "running" || (runtime.includes("running") && !runtime.includes("not running"))) {
    return "running";
  }
  if (runtime === "stopped" || runtime.includes("stopped") || runtime.includes("not running")) {
    return "stopped";
  }
  return "unknown";
}

export function resolveGatewayRemoteRestartAction(runtime: GatewayRuntimeState): "start" | "restart" {
  return runtime === "running" ? "restart" : "start";
}

function readGatewayRuntimeState(): GatewayRuntimeState {
  try {
    const output = openclaw("gateway status --no-probe").toString();
    return parseGatewayRuntimeState(output);
  } catch (err) {
    return parseGatewayRuntimeState(execErrorOutput(err));
  }
}

export function requestGatewayRestart(source = "clawconnect"): LocalResult {
  return launchGatewayLifecycleCommand("restart", source);
}

export function requestGatewayRemoteRestart(source = "clawconnect"): LocalResult {
  const runtime = readGatewayRuntimeState();
  const action = resolveGatewayRemoteRestartAction(runtime);
  return launchGatewayLifecycleCommand(action, source);
}
