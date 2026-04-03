import { readdirSync, statSync, copyFileSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execSync, spawn } from "child_process";
import { createBackup, deleteBackup, listBackups, restoreBackup, updateBackup } from "./backup-manager.js";

const OPENCLAW_DIR    = join(homedir(), ".openclaw");
const OPENCLAW_CONFIG = join(OPENCLAW_DIR, "openclaw.json");

export type LocalResult =
  | { ok: true; payload?: unknown }
  | { ok: false; error: string };

type GatewayRuntimeState = "running" | "stopped" | "unknown";

// ---------------------------------------------------------------------------
// Subprocess environment
//
// launchd services run with a minimal PATH that lacks:
//   - The node binary itself  (breaks #!/usr/bin/env node shebangs)
//   - Homebrew / local bins   (breaks finding `openclaw`)
//
// Fix: build a rich PATH for every subprocess by prepending:
//   1. dirname(process.execPath) — the dir containing the node binary running
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
      console.log(`[clawconnect] openclaw resolved from OPENCLAW_BIN: ${explicitBin}`);
      return explicitBin;
    }
    console.warn(`[clawconnect] OPENCLAW_BIN is set but missing: ${explicitBin}`);
  }

  try {
    const p = execSync("which openclaw", { stdio: "pipe", env: SUBPROCESS_ENV, timeout: 3000 })
      .toString().trim();
    if (p && existsSync(p)) {
      console.log(`[clawconnect] openclaw resolved: ${p}`);
      return p;
    }
  } catch { /* fall through */ }
  console.warn("[clawconnect] could not resolve openclaw path, using bare name");
  return "openclaw";
}

let cachedOpenclawBin: string | null = null;

function getOpenclawBin(): string {
  if (cachedOpenclawBin == null) {
    cachedOpenclawBin = resolveOpenclawBin();
  }
  return cachedOpenclawBin;
}

// ---------------------------------------------------------------------------

export function handleLocalCommand(method: string, params: unknown = undefined): LocalResult | null {
  switch (method) {
    case "clawconnect.config":
    case "pocketclaw.config":
    case "clawpilot.config":              return readOpenclawConfig();
    case "clawconnect.fix.tools.2026_3_2":
    case "pocketclaw.fix.tools.2026_3_2":
    case "clawpilot.fix.tools.2026_3_2":  return fixToolsPermissions202632();
    case "clawconnect.restore.config":
    case "pocketclaw.restore.config":
    case "clawpilot.restore.config":      return restoreConfig();
    case "clawconnect.backup.list":
    case "pocketclaw.backup.list":
    case "clawpilot.backup.list":         return readBackups();
    case "clawconnect.backup.create":
    case "pocketclaw.backup.create":
    case "clawpilot.backup.create":       return createBackupRecord(params);
    case "clawconnect.backup.update":
    case "pocketclaw.backup.update":
    case "clawpilot.backup.update":       return updateBackupRecord(params);
    case "clawconnect.backup.delete":
    case "pocketclaw.backup.delete":
    case "clawpilot.backup.delete":       return deleteBackupRecord(params);
    case "clawconnect.backup.restore":
    case "pocketclaw.backup.restore":
    case "clawpilot.backup.restore":      return restoreBackupRecord(params);
    case "clawconnect.watchskill":
    case "pocketclaw.watchskill":
    case "clawpilot.watchskill":          return watchSkill();
    case "clawconnect.doctor":
    case "pocketclaw.doctor":
    case "clawpilot.doctor":              return runDoctor();
    case "clawconnect.logs":
    case "pocketclaw.logs":
    case "clawpilot.logs":                return readLogs();
    case "clawconnect.gateway.restart":
    case "pocketclaw.gateway.restart":
    case "clawpilot.gateway.restart":     return restartGateway();
    case "clawconnect.gateway.remoteRestart":
    case "pocketclaw.gateway.remoteRestart":
    case "clawpilot.gateway.remoteRestart": return remoteRestartGateway();
    case "clawconnect.version":
    case "pocketclaw.version":
    case "clawpilot.version":             return getOpenclawVersion();
    case "clawconnect.update":
    case "pocketclaw.update":
    case "clawpilot.update":              return updateOpenclaw();
    default:                          return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function execErrorOutput(err: unknown): string {
  const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
  const out = e.stdout?.toString() ?? "";
  const errStr = e.stderr?.toString() ?? "";
  if (out && errStr) return `${out}\n${errStr}`;
  return out || errStr;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/** Run openclaw with the resolved path and the enriched subprocess environment. */
function openclaw(args: string): Buffer {
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

    console.log(`[${source}] gateway ${action} requested`);
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
  if (action === "restart") {
    console.log(`[${source}] gateway runtime is running, restarting OpenClaw gateway`);
    return launchGatewayLifecycleCommand("restart", source);
  }

  if (runtime === "stopped") {
    console.log(`[${source}] gateway runtime is stopped, starting OpenClaw gateway`);
  } else {
    console.log(`[${source}] gateway runtime is unknown, starting OpenClaw gateway`);
  }
  return launchGatewayLifecycleCommand("start", source);
}

function maskSensitive(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    return value.map(item => maskSensitive(item));
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalized = key.toLowerCase();
      if (
        normalized.includes("token")
        || normalized.includes("secret")
        || normalized.includes("password")
        || normalized == "apikey"
        || normalized == "api_key"
      ) {
        out[key] = maskString(typeof child === "string" ? child : String(child ?? ""));
      } else {
        out[key] = maskSensitive(child, key);
      }
    }
    return out;
  }

  if (typeof value === "string" && parentKey) {
    const normalized = parentKey.toLowerCase();
    if (
      normalized.includes("token")
      || normalized.includes("secret")
      || normalized.includes("password")
      || normalized == "apikey"
      || normalized == "api_key"
    ) {
      return maskString(value);
    }
  }

  return value;
}

function maskString(value: string): string {
  if (!value) return value;
  if (value.length <= 8) return "******";
  return `${value.slice(0, 4)}******${value.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

function readOpenclawConfig(): LocalResult {
  try {
    if (!existsSync(OPENCLAW_CONFIG)) {
      return { ok: false, error: `openclaw config not found: ${OPENCLAW_CONFIG}` };
    }

    const raw = readFileSync(OPENCLAW_CONFIG, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const masked = maskSensitive(parsed);
    const output = JSON.stringify(masked, null, 2);

    return { ok: true, payload: { output: `[${OPENCLAW_CONFIG}]\n${output}` } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function fixToolsPermissions202632(): LocalResult {
  const steps = [
    "config set tools.profile full",
    "config set tools.sessions.visibility all",
    "config set tools.exec.security full",
    "config set tools.exec.ask off",
    "gateway restart",
  ];

  try {
    const outputs: string[] = [];

    for (const step of steps) {
      let output = "";
      if (step === "gateway restart") {
        const restart = requestGatewayRestart("clawconnect");
        if (!restart.ok) {
          throw new Error(restart.error);
        }
        const payload = restart.payload as { output?: unknown } | undefined;
        output = typeof payload?.output === "string" ? payload.output.trim() : "";
      } else {
        output = openclaw(step).toString().trim();
      }
      if (output) {
        outputs.push(output);
      }
    }

    const summary = [
      "Applied OpenClaw 2026.3.2 tool permission fix.",
      "Configured:",
      "- tools.profile = full",
      "- tools.sessions.visibility = all",
      "- tools.exec.security = full",
      "- tools.exec.ask = off",
      "",
      "Gateway restart requested.",
    ].join("\n");

    const output = outputs.length > 0 ? `${summary}\n\n${outputs.join("\n\n")}` : summary;
    return { ok: true, payload: { output } };
  } catch (err) {
    const output = execErrorOutput(err);
    return output ? { ok: true, payload: { output } } : { ok: false, error: errorMessage(err) };
  }
}

function restoreConfig(): LocalResult {
  try {
    const backups = listBackups().backups;
    if (backups.length > 0) {
      restoreBackup({ backupId: backups[0].id });
      return { ok: true, payload: { restoredFrom: backups[0].filename } };
    }

    if (!existsSync(OPENCLAW_DIR)) {
      return { ok: false, error: `openclaw config dir not found: ${OPENCLAW_DIR}` };
    }

    const bakFiles = readdirSync(OPENCLAW_DIR)
      .filter(name => name.startsWith("openclaw.json.bak"))
      .map(name => {
        const path = join(OPENCLAW_DIR, name);
        return { name, path, mtime: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (bakFiles.length === 0) {
      return { ok: false, error: "No backup files found in ~/.openclaw/" };
    }
    const latest = bakFiles[0];
    copyFileSync(latest.path, OPENCLAW_CONFIG);
    console.log(`[clawconnect] Config restored from ${latest.name}`);
    return { ok: true, payload: { restoredFrom: latest.name } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function readBackups(): LocalResult {
  try {
    return { ok: true, payload: listBackups() };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function createBackupRecord(params: unknown): LocalResult {
  try {
    return { ok: true, payload: createBackup(params) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function updateBackupRecord(params: unknown): LocalResult {
  try {
    return { ok: true, payload: updateBackup(params) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function deleteBackupRecord(params: unknown): LocalResult {
  try {
    return { ok: true, payload: deleteBackup(params) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function restoreBackupRecord(params: unknown): LocalResult {
  try {
    return { ok: true, payload: restoreBackup(params) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function watchSkill(): LocalResult {
  try {
    openclaw("config set skills.load.watch true");
    console.log("[clawconnect] skills.load.watch set to true");
    return { ok: true, payload: { message: "skills.load.watch enabled" } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function runDoctor(): LocalResult {
  try {
    const output = openclaw("doctor").toString();
    console.log("[clawconnect] doctor completed");
    return { ok: true, payload: { output } };
  } catch (err) {
    const output = execErrorOutput(err);
    return output ? { ok: true, payload: { output } } : { ok: false, error: errorMessage(err) };
  }
}

function readLogs(): LocalResult {
  try {
    const logsDir = join(OPENCLAW_DIR, "logs");
    let logFiles: string[] = [];

    if (existsSync(logsDir)) {
      logFiles = readdirSync(logsDir)
        .filter(f => f.endsWith(".log"))
        .map(f => join(logsDir, f));
    } else {
      logFiles = readdirSync(OPENCLAW_DIR)
        .filter(f => f.endsWith(".log"))
        .map(f => join(OPENCLAW_DIR, f));
    }

    if (logFiles.length === 0) {
      return { ok: true, payload: { output: "No log files found." } };
    }

    const logFilesWithMtime = logFiles.map(f => ({ path: f, mtime: statSync(f).mtimeMs }));
    logFilesWithMtime.sort((a, b) => b.mtime - a.mtime);
    const latest = logFilesWithMtime[0].path;
    const allLines = readFileSync(latest, "utf-8").split("\n");
    const last100 = allLines.slice(-100).join("\n");

    console.log(`[clawconnect] logs read from ${latest}`);
    return { ok: true, payload: { output: `[${latest}]\n${last100}` } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function restartGateway(): LocalResult {
  return requestGatewayRestart("clawconnect");
}

function remoteRestartGateway(): LocalResult {
  return requestGatewayRemoteRestart("clawconnect");
}

function getOpenclawVersion(): LocalResult {
  const candidates = ["--version", "version"];

  for (const args of candidates) {
    try {
      const output = openclaw(args).toString().trim();
      const version = output
        .split("\n")
        .map(line => line.trim())
        .find(line => line.length > 0);

      if (version) {
        console.log(`[clawconnect] openclaw version detected via "${args}": ${version}`);
        return { ok: true, payload: { version, output } };
      }
    } catch (err) {
      const output = execErrorOutput(err).trim();
      const version = output
        .split("\n")
        .map(line => line.trim())
        .find(line => /^v?\d+\./.test(line) || /openclaw/i.test(line));

      if (version) {
        console.log(`[clawconnect] openclaw version parsed from error output via "${args}": ${version}`);
        return { ok: true, payload: { version, output } };
      }
    }
  }

  return { ok: false, error: "Unable to determine openclaw version." };
}

function updateOpenclaw(): LocalResult {
  try {
    const output = openclaw("update").toString();
    console.log("[clawconnect] openclaw updated");
    return { ok: true, payload: { output: output || "openclaw updated successfully." } };
  } catch (err) {
    const output = execErrorOutput(err);
    return output ? { ok: true, payload: { output } } : { ok: false, error: errorMessage(err) };
  }
}
