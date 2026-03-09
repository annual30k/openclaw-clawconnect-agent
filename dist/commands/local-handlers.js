import { readdirSync, statSync, copyFileSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
const OPENCLAW_DIR = join(homedir(), ".openclaw");
const OPENCLAW_CONFIG = join(OPENCLAW_DIR, "openclaw.json");
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
const SUBPROCESS_ENV = {
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
function resolveOpenclawBin() {
    try {
        const p = execSync("which openclaw", { stdio: "pipe", env: SUBPROCESS_ENV, timeout: 3000 })
            .toString().trim();
        if (p && existsSync(p)) {
            console.log(`[clawconnect] openclaw resolved: ${p}`);
            return p;
        }
    }
    catch { /* fall through */ }
    console.warn("[clawconnect] could not resolve openclaw path, using bare name");
    return "openclaw";
}
let cachedOpenclawBin = null;
function getOpenclawBin() {
    if (cachedOpenclawBin == null) {
        cachedOpenclawBin = resolveOpenclawBin();
    }
    return cachedOpenclawBin;
}
// ---------------------------------------------------------------------------
export function handleLocalCommand(method) {
    switch (method) {
        case "clawconnect.config":
        case "pocketclaw.config":
        case "clawpilot.config": return readOpenclawConfig();
        case "clawconnect.fix.tools.2026_3_2":
        case "pocketclaw.fix.tools.2026_3_2":
        case "clawpilot.fix.tools.2026_3_2": return fixToolsPermissions202632();
        case "clawconnect.restore.config":
        case "pocketclaw.restore.config":
        case "clawpilot.restore.config": return restoreConfig();
        case "clawconnect.watchskill":
        case "pocketclaw.watchskill":
        case "clawpilot.watchskill": return watchSkill();
        case "clawconnect.doctor":
        case "pocketclaw.doctor":
        case "clawpilot.doctor": return runDoctor();
        case "clawconnect.logs":
        case "pocketclaw.logs":
        case "clawpilot.logs": return readLogs();
        case "clawconnect.gateway.restart":
        case "pocketclaw.gateway.restart":
        case "clawpilot.gateway.restart": return restartGateway();
        case "clawconnect.version":
        case "pocketclaw.version":
        case "clawpilot.version": return getOpenclawVersion();
        case "clawconnect.update":
        case "pocketclaw.update":
        case "clawpilot.update": return updateOpenclaw();
        default: return null;
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function execErrorOutput(err) {
    const e = err;
    const out = e.stdout?.toString() ?? "";
    const errStr = e.stderr?.toString() ?? "";
    if (out && errStr)
        return `${out}\n${errStr}`;
    return out || errStr;
}
/** Run openclaw with the resolved path and the enriched subprocess environment. */
function openclaw(args) {
    return execSync(`"${getOpenclawBin()}" ${args}`, { stdio: "pipe", env: SUBPROCESS_ENV });
}
function maskSensitive(value, parentKey) {
    if (Array.isArray(value)) {
        return value.map(item => maskSensitive(item));
    }
    if (value && typeof value === "object") {
        const out = {};
        for (const [key, child] of Object.entries(value)) {
            const normalized = key.toLowerCase();
            if (normalized.includes("token")
                || normalized.includes("secret")
                || normalized.includes("password")
                || normalized == "apikey"
                || normalized == "api_key") {
                out[key] = maskString(typeof child === "string" ? child : String(child ?? ""));
            }
            else {
                out[key] = maskSensitive(child, key);
            }
        }
        return out;
    }
    if (typeof value === "string" && parentKey) {
        const normalized = parentKey.toLowerCase();
        if (normalized.includes("token")
            || normalized.includes("secret")
            || normalized.includes("password")
            || normalized == "apikey"
            || normalized == "api_key") {
            return maskString(value);
        }
    }
    return value;
}
function maskString(value) {
    if (!value)
        return value;
    if (value.length <= 8)
        return "******";
    return `${value.slice(0, 4)}******${value.slice(-2)}`;
}
// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------
function readOpenclawConfig() {
    try {
        if (!existsSync(OPENCLAW_CONFIG)) {
            return { ok: false, error: `openclaw config not found: ${OPENCLAW_CONFIG}` };
        }
        const raw = readFileSync(OPENCLAW_CONFIG, "utf-8");
        const parsed = JSON.parse(raw);
        const masked = maskSensitive(parsed);
        const output = JSON.stringify(masked, null, 2);
        return { ok: true, payload: { output: `[${OPENCLAW_CONFIG}]\n${output}` } };
    }
    catch (err) {
        return { ok: false, error: String(err) };
    }
}
function fixToolsPermissions202632() {
    const steps = [
        "config set tools.profile full",
        "config set tools.sessions.visibility all",
        "config set tools.exec.security full",
        "config set tools.exec.ask off",
        "gateway restart",
    ];
    try {
        const outputs = [];
        for (const step of steps) {
            const output = openclaw(step).toString().trim();
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
            "Gateway restarted.",
        ].join("\n");
        const output = outputs.length > 0 ? `${summary}\n\n${outputs.join("\n\n")}` : summary;
        return { ok: true, payload: { output } };
    }
    catch (err) {
        const output = execErrorOutput(err);
        return output ? { ok: true, payload: { output } } : { ok: false, error: String(err) };
    }
}
function restoreConfig() {
    try {
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
    }
    catch (err) {
        return { ok: false, error: String(err) };
    }
}
function watchSkill() {
    try {
        openclaw("config set skills.load.watch true");
        console.log("[clawconnect] skills.load.watch set to true");
        return { ok: true, payload: { message: "skills.load.watch enabled" } };
    }
    catch (err) {
        return { ok: false, error: String(err) };
    }
}
function runDoctor() {
    try {
        const output = openclaw("doctor").toString();
        console.log("[clawconnect] doctor completed");
        return { ok: true, payload: { output } };
    }
    catch (err) {
        const output = execErrorOutput(err);
        return output ? { ok: true, payload: { output } } : { ok: false, error: String(err) };
    }
}
function readLogs() {
    try {
        const logsDir = join(OPENCLAW_DIR, "logs");
        let logFiles = [];
        if (existsSync(logsDir)) {
            logFiles = readdirSync(logsDir)
                .filter(f => f.endsWith(".log"))
                .map(f => join(logsDir, f));
        }
        else {
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
    }
    catch (err) {
        return { ok: false, error: String(err) };
    }
}
function restartGateway() {
    try {
        const output = openclaw("gateway restart").toString();
        console.log("[clawconnect] gateway restarted");
        return { ok: true, payload: { output: output || "Gateway restarted successfully." } };
    }
    catch (err) {
        const output = execErrorOutput(err);
        return output ? { ok: true, payload: { output } } : { ok: false, error: String(err) };
    }
}
function getOpenclawVersion() {
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
        }
        catch (err) {
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
function updateOpenclaw() {
    try {
        const output = openclaw("update").toString();
        console.log("[clawconnect] openclaw updated");
        return { ok: true, payload: { output: output || "openclaw updated successfully." } };
    }
    catch (err) {
        const output = execErrorOutput(err);
        return output ? { ok: true, payload: { output } } : { ok: false, error: String(err) };
    }
}
//# sourceMappingURL=local-handlers.js.map