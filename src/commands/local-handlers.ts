import { readdirSync, statSync, copyFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createBackup, deleteBackup, listBackups, restoreBackup, updateBackup } from "./backup-manager.js";
import { readConfig, updateVoiceReplyConfig } from "../config/config.js";
import {
  LocalCommandContext,
  LocalResult,
  errorMessage,
  execErrorOutput,
  openclaw,
  runDoctorFix as runDoctorFixStreaming,
  requestGatewayRemoteRestart,
  requestGatewayRestart,
} from "./local-runtime.js";

const OPENCLAW_DIR = join(homedir(), ".openclaw");
const OPENCLAW_CONFIG = join(OPENCLAW_DIR, "openclaw.json");

// ---------------------------------------------------------------------------

export function handleLocalCommand(
  method: string,
  params: unknown = undefined,
  context: LocalCommandContext = {},
): LocalResult | Promise<LocalResult> | null {
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
    case "clawconnect.doctor.fix":
    case "pocketclaw.doctor.fix":
    case "clawpilot.doctor.fix":          return runDoctorFixStreaming(context);
    case "clawconnect.logs":
    case "pocketclaw.logs":
    case "clawpilot.logs":                return readLogs(params);
    case "clawconnect.gateway.restart":
    case "pocketclaw.gateway.restart":
    case "clawpilot.gateway.restart":     return restartGateway(context);
    case "clawconnect.gateway.remoteRestart":
    case "pocketclaw.gateway.remoteRestart":
    case "clawpilot.gateway.remoteRestart": return remoteRestartGateway(context);
    case "clawconnect.voiceReply.setConfig":
    case "pocketclaw.voiceReply.setConfig":
    case "clawpilot.voiceReply.setConfig": return updateVoiceReplySettings(params);
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

async function fixToolsPermissions202632(): Promise<LocalResult> {
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
        const restart = await requestGatewayRestart("clawconnect");
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

function updateVoiceReplySettings(params: unknown): LocalResult {
  try {
    const config = readConfig();
    const p = params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
    const voiceIdentifier = typeof p.voiceReplyVoiceIdentifier === "string" ? p.voiceReplyVoiceIdentifier : undefined;
    const ratePercent = typeof p.voiceReplyRatePercent === "number" ? p.voiceReplyRatePercent : undefined;
    const updated = updateVoiceReplyConfig(config, {
      voiceIdentifier,
      ratePercent,
    });
    return {
      ok: true,
      payload: {
        assistantVoiceReplyVoiceIdentifier: updated.assistantVoiceReplyVoiceIdentifier ?? null,
        assistantVoiceReplyRatePercent: updated.assistantVoiceReplyRatePercent ?? null,
      },
    };
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

function readLogs(_params: unknown = undefined): LocalResult {
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
    const allLines = readFileSync(latest, "utf-8")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n");
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
      allLines.pop();
    }

    console.log(`[clawconnect] logs read from ${latest}`);
    return {
      ok: true,
      payload: {
        logPath: latest,
        lines: allLines,
        totalLines: allLines.length,
        returnedLines: allLines.length,
        truncated: false,
        output: `[${latest}]\n${allLines.join("\n")}`,
      },
    };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function restartGateway(context: LocalCommandContext = {}): LocalResult | Promise<LocalResult> {
  return requestGatewayRestart("clawconnect", context);
}

function remoteRestartGateway(context: LocalCommandContext = {}): LocalResult | Promise<LocalResult> {
  return requestGatewayRemoteRestart("clawconnect", context);
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
