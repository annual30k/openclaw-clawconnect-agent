import { existsSync } from "fs";
import { delimiter, dirname, join, resolve } from "path";
import { homedir } from "os";
import { execFileSync, execSync, spawn } from "child_process";

export type LocalResult =
  | { ok: true; payload?: unknown }
  | { ok: false; error: string };

export type GatewayRuntimeState = "running" | "stopped" | "unknown";

export type LocalCommandEventPublisher = (event: {
  type: "event";
  event: string;
  payload: unknown;
}) => void;

export type LocalCommandContext = {
  requestId?: string;
  gatewayId?: string;
  publishEvent?: LocalCommandEventPublisher;
};

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
const IS_WINDOWS = process.platform === "win32";

const SUBPROCESS_ENV: NodeJS.ProcessEnv = (() => {
  // On Windows, environment variables are case-insensitive.  process.env may
  // contain both `PATH` and `Path`, and spreading both into the child-process
  // environment block can lead to unpredictable path resolution.
  // Build the env object by hand, skipping all case variants of PATH.
  const env: NodeJS.ProcessEnv = {};
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (upper === "PATH") continue; // will be set explicitly below
    if (!seen.has(upper)) {
      seen.add(upper);
      env[key] = value;
    }
  }

  env.HOME = homedir();
  if (IS_WINDOWS) {
    env.SystemRoot = process.env.SystemRoot;
  }
  env.PATH = [
    NODE_BIN_DIR,
    join(homedir(), ".openclaw", "bin"),
    join(homedir(), ".local", "bin"),
    join(homedir(), ".npm-global", "bin"),
    process.env.PNPM_HOME,
    join(homedir(), ".local", "share", "pnpm"),
    ...(IS_WINDOWS
      ? []
      : [
          "/opt/homebrew/bin",
          "/opt/homebrew/sbin",
          "/usr/local/bin",
          "/usr/local/sbin",
          "/usr/bin",
          "/bin",
        ]),
    process.env.PATH ?? (IS_WINDOWS ? "" : "/usr/bin:/bin"),
  ]
    .filter(Boolean)
    .join(delimiter);

  return env;
})();

function canRunOpenclawBin(candidate: string): boolean {
  try {
    if (IS_WINDOWS && (candidate.endsWith(".js") || candidate.endsWith(".mjs"))) {
      execFileSync(process.execPath, [candidate, "--version"], { stdio: "pipe", env: SUBPROCESS_ENV, timeout: 3000 });
    } else {
      execFileSync(candidate, ["--version"], { stdio: "pipe", env: SUBPROCESS_ENV, timeout: 3000 });
    }
    return true;
  } catch {
    return false;
  }
}

function bundledOpenclawBin(): string | null {
  const explicitPackageBin = process.env.OPENCLAW_PACKAGE_BIN?.trim();
  if (explicitPackageBin && existsSync(explicitPackageBin)) {
    return explicitPackageBin;
  }

  // On Windows, node_modules might be in a different structure if globally installed.
  const candidate = resolve(NODE_BIN_DIR, "..", "lib", "node_modules", "openclaw", "openclaw.mjs");
  if (existsSync(candidate)) return candidate;
  
  const winCandidate = resolve(NODE_BIN_DIR, "node_modules", "openclaw", "openclaw.mjs");
  if (IS_WINDOWS && existsSync(winCandidate)) return winCandidate;

  // Windows npm global install path: %APPDATA%\npm\node_modules\...
  const winNpmGlobalCandidate = join(process.env.APPDATA ?? homedir(), "npm", "node_modules", "openclaw", "openclaw.mjs");
  if (IS_WINDOWS && existsSync(winNpmGlobalCandidate)) return winNpmGlobalCandidate;

  return null;
}

export function selectOpenclawBinCandidate(
  options: {
    explicitBin?: string;
    pathBin?: string;
    extraBins?: string[];
    packageBin?: string | null;
    exists?: (candidate: string) => boolean;
    canRun?: (candidate: string) => boolean;
  },
): string {
  const exists = options.exists ?? existsSync;
  const canRun = options.canRun ?? canRunOpenclawBin;
  const explicitBin = options.explicitBin?.trim();
  if (explicitBin && exists(explicitBin) && canRun(explicitBin)) {
    return explicitBin;
  }

  const candidates = [
    options.pathBin,
    ...(options.extraBins ?? []),
    options.packageBin ?? undefined,
  ]
    .map((candidate) => candidate?.trim())
    .filter((candidate): candidate is string => Boolean(candidate && exists(candidate)));

  for (const candidate of candidates) {
    if (canRun(candidate)) {
      return candidate;
    }
  }

  return "openclaw";
}

function resolveOpenclawBin(): string {
  let pathBin: string | undefined;
  try {
    const whichCmd = IS_WINDOWS ? "where openclaw" : "which openclaw";
    const p = execSync(whichCmd, { stdio: "pipe", env: SUBPROCESS_ENV, timeout: 3000 })
      .toString().trim();
    // 'where' might return multiple lines, take the first one.
    pathBin = p.split(/\r?\n/)[0] || undefined;
  } catch {
    // fall through
  }

  const extraBins = [
    join(homedir(), ".openclaw", "bin", IS_WINDOWS ? "openclaw.cmd" : "openclaw"),
    join(homedir(), ".openclaw", "bin", "openclaw"),
    join(homedir(), ".local", "bin", "openclaw"),
    join(homedir(), ".npm-global", "bin", "openclaw"),
    ...(process.env.PNPM_HOME ? [join(process.env.PNPM_HOME, "openclaw")] : []),
    join(homedir(), ".local", "share", "pnpm", "openclaw"),
  ];

  return selectOpenclawBinCandidate({
    explicitBin: process.env.OPENCLAW_BIN,
    pathBin,
    extraBins,
    packageBin: bundledOpenclawBin(),
  });
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
export function openclaw(args: string[]): Buffer {
  const bin = getOpenclawBin();
  if (IS_WINDOWS && (bin.endsWith(".js") || bin.endsWith(".mjs"))) {
    return execFileSync(process.execPath, [bin, ...args], { stdio: "pipe", env: SUBPROCESS_ENV });
  }
  return execFileSync(bin, args, { stdio: "pipe", env: SUBPROCESS_ENV });
}

function launchGatewayLifecycleCommand(action: "start" | "restart", source = "clawconnect"): LocalResult {
  try {
    const openclawBin = getOpenclawBin();
    const spawnArgs = IS_WINDOWS && (openclawBin.endsWith(".js") || openclawBin.endsWith(".mjs"))
      ? [openclawBin, "gateway", action]
      : ["gateway", action];
    const spawnExe = IS_WINDOWS && (openclawBin.endsWith(".js") || openclawBin.endsWith(".mjs"))
      ? process.execPath
      : openclawBin;

    const child = spawn(spawnExe, spawnArgs, {
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
    const output = openclaw(["gateway", "status", "--no-probe"]).toString();
    return parseGatewayRuntimeState(output);
  } catch (err) {
    return parseGatewayRuntimeState(execErrorOutput(err));
  }
}

export function requestGatewayRestart(source = "clawconnect", context: LocalCommandContext = {}): LocalResult | Promise<LocalResult> {
  if (context.publishEvent && context.requestId) {
    return runGatewayLifecycleStreaming("restart", context);
  }
  return launchGatewayLifecycleCommand("restart", source);
}

export function requestGatewayRemoteRestart(source = "clawconnect", context: LocalCommandContext = {}): LocalResult | Promise<LocalResult> {
  const runtime = readGatewayRuntimeState();
  const action = resolveGatewayRemoteRestartAction(runtime);
  if (context.publishEvent && context.requestId) {
    return runGatewayLifecycleStreaming(action, context);
  }
  return launchGatewayLifecycleCommand(action, source);
}

export async function runGatewayLifecycleStreaming(
  action: "start" | "restart",
  context: LocalCommandContext = {}
): Promise<LocalResult> {
  const openclawBin = getOpenclawBin();
  const spawnArgs = IS_WINDOWS && (openclawBin.endsWith(".js") || openclawBin.endsWith(".mjs"))
    ? [openclawBin, "gateway", action]
    : ["gateway", action];
  const spawnExe = IS_WINDOWS && (openclawBin.endsWith(".js") || openclawBin.endsWith(".mjs"))
    ? process.execPath
    : openclawBin;

  const child = spawn(spawnExe, spawnArgs, {
    env: SUBPROCESS_ENV,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let output = "";
  let sequence = 0;
  const buffers: Record<"stdout" | "stderr", string> = {
    stdout: "",
    stderr: "",
  };
  const publishEvent = context.publishEvent;
  const requestId = context.requestId;
  const gatewayId = context.gatewayId;

  const emitLine = (stream: "stdout" | "stderr", line: string): void => {
    const trimmed = line.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "").replace(/\r$/, "");
    if (!trimmed && stream !== "stderr") {
      return;
    }
    const timestamp = new Date().toISOString();
    if (publishEvent) {
      publishEvent({
        type: "event",
        event: "doctor_fix_log",
        payload: {
          gatewayId,
          requestId,
          runId: requestId,
          stream,
          seq: sequence += 1,
          ts: Date.parse(timestamp),
          text: trimmed,
        },
      });
    }
  };

  const pump = (stream: NodeJS.ReadableStream | null, label: "stdout" | "stderr"): void => {
    if (!stream) {
      return;
    }
    stream.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString();
      if (!text.trim()) {
        return;
      }
      const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      buffers[label] += normalized;
      const parts = buffers[label].split("\n");
      buffers[label] = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "").trimEnd();
        output += `${line}\n`;
        emitLine(label, line);
      }
    });
    stream.once("end", () => {
      const trailing = buffers[label].replace(/\u001B\[[0-9;]*[A-Za-z]/g, "").trimEnd();
      if (trailing) {
        output += `${trailing}\n`;
        emitLine(label, trailing);
      }
    });
  };

  pump(child.stdout, "stdout");
  pump(child.stderr, "stderr");

  emitLine("stdout", `Running: openclaw gateway ${action}...`);

  return await new Promise<LocalResult>((resolve) => {
    let settled = false;
    const finish = (result: LocalResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    child.once("error", (error) => {
      if (publishEvent) {
        publishEvent({
          type: "event",
          event: "doctor_fix_log",
          payload: {
            gatewayId,
            requestId,
            runId: requestId,
            stream: "stderr",
            seq: sequence += 1,
            ts: Date.now(),
            text: `failed to start gateway ${action}: ${String(error)}`,
          },
        });
      }
      finish({ ok: false, error: errorMessage(error) });
    });

    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      const exitSummary =
        typeof code === "number"
          ? `openclaw gateway ${action} exited with code ${code}`
          : `openclaw gateway ${action} exited${signal ? ` with signal ${signal}` : ""}`;
      if (publishEvent) {
        publishEvent({
          type: "event",
          event: "doctor_fix_log",
          payload: {
            gatewayId,
            requestId,
            runId: requestId,
            stream: "status",
            seq: sequence += 1,
            ts: Date.now(),
            text: exitSummary,
          },
        });
      }

      if (code && code !== 0) {
        finish({
          ok: false,
          error: output.trim() ? `${exitSummary}\n${output.trim()}` : exitSummary,
        });
        return;
      }

      finish({
        ok: true,
        payload: { output: output.trim() || `openclaw gateway ${action} completed.` },
      });
    });
  });
}

export async function runDoctorFix(context: LocalCommandContext = {}): Promise<LocalResult> {
  const openclawBin = getOpenclawBin();
  const spawnArgs = IS_WINDOWS && (openclawBin.endsWith(".js") || openclawBin.endsWith(".mjs"))
    ? [openclawBin, "doctor", "--fix"]
    : ["doctor", "--fix"];
  const spawnExe = IS_WINDOWS && (openclawBin.endsWith(".js") || openclawBin.endsWith(".mjs"))
    ? process.execPath
    : openclawBin;

  const child = spawn(spawnExe, spawnArgs, {
    env: SUBPROCESS_ENV,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let output = "";
  let sequence = 0;
  const buffers: Record<"stdout" | "stderr", string> = {
    stdout: "",
    stderr: "",
  };
  const publishEvent = context.publishEvent;
  const requestId = context.requestId;
  const gatewayId = context.gatewayId;

  const emitLine = (stream: "stdout" | "stderr", line: string): void => {
    const trimmed = line.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "").replace(/\r$/, "");
    if (!trimmed && stream !== "stderr") {
      return;
    }
    const timestamp = new Date().toISOString();
    if (publishEvent) {
      publishEvent({
        type: "event",
        event: "doctor_fix_log",
        payload: {
          gatewayId,
          requestId,
          runId: requestId,
          stream,
          seq: sequence += 1,
          ts: Date.parse(timestamp),
          text: trimmed,
        },
      });
    }
  };

  const pump = (stream: NodeJS.ReadableStream | null, label: "stdout" | "stderr"): void => {
    if (!stream) {
      return;
    }
    stream.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString();
      if (!text.trim()) {
        return;
      }
      const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      buffers[label] += normalized;
      const parts = buffers[label].split("\n");
      buffers[label] = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "").trimEnd();
        output += `${line}\n`;
        emitLine(label, line);
      }
    });
    stream.once("end", () => {
      const trailing = buffers[label].replace(/\u001B\[[0-9;]*[A-Za-z]/g, "").trimEnd();
      if (trailing) {
        output += `${trailing}\n`;
        emitLine(label, trailing);
      }
    });
  };

  pump(child.stdout, "stdout");
  pump(child.stderr, "stderr");

  return await new Promise<LocalResult>((resolve) => {
    let settled = false;
    const finish = (result: LocalResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    child.once("error", (error) => {
      if (publishEvent) {
        publishEvent({
          type: "event",
          event: "doctor_fix_log",
          payload: {
            gatewayId,
            requestId,
            runId: requestId,
            stream: "stderr",
            seq: sequence += 1,
            ts: Date.now(),
            text: `failed to start: ${String(error)}`,
          },
        });
      }
      finish({ ok: false, error: errorMessage(error) });
    });

    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      const exitSummary =
        typeof code === "number"
          ? `openclaw doctor --fix exited with code ${code}`
          : `openclaw doctor --fix exited${signal ? ` with signal ${signal}` : ""}`;
      if (publishEvent) {
        publishEvent({
          type: "event",
          event: "doctor_fix_log",
          payload: {
            gatewayId,
            requestId,
            runId: requestId,
            stream: "status",
            seq: sequence += 1,
            ts: Date.now(),
            text: exitSummary,
          },
        });
      }

      if (code && code !== 0) {
        finish({
          ok: false,
          error: output.trim() ? `${exitSummary}\n${output.trim()}` : exitSummary,
        });
        return;
      }

      finish({
        ok: true,
        payload: { output: output.trim() || "openclaw doctor --fix completed." },
      });
    });
  });
}
