import { readdirSync, statSync, copyFileSync, existsSync, readFileSync, openSync, readSync, closeSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createBackup, deleteBackup, listBackups, restoreBackup, updateBackup } from "./backup-manager.js";
import { errorMessage, execErrorOutput, openclaw, runDoctorFix as runDoctorFixStreaming, requestGatewayRemoteRestart, requestGatewayRestart, } from "./local-runtime.js";
const OPENCLAW_DIR = join(homedir(), ".openclaw");
const CLAWCONNECT_DIR = join(homedir(), ".clawconnect");
const OPENCLAW_CONFIG = join(OPENCLAW_DIR, "openclaw.json");
// ---------------------------------------------------------------------------
export function handleLocalCommand(method, params = undefined, context = {}) {
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
        case "clawconnect.backup.list":
        case "pocketclaw.backup.list":
        case "clawpilot.backup.list": return readBackups();
        case "clawconnect.backup.create":
        case "pocketclaw.backup.create":
        case "clawpilot.backup.create": return createBackupRecord(params);
        case "clawconnect.backup.update":
        case "pocketclaw.backup.update":
        case "clawpilot.backup.update": return updateBackupRecord(params);
        case "clawconnect.backup.delete":
        case "pocketclaw.backup.delete":
        case "clawpilot.backup.delete": return deleteBackupRecord(params);
        case "clawconnect.backup.restore":
        case "pocketclaw.backup.restore":
        case "clawpilot.backup.restore": return restoreBackupRecord(params);
        case "clawconnect.watchskill":
        case "pocketclaw.watchskill":
        case "clawpilot.watchskill": return watchSkill();
        case "clawconnect.doctor":
        case "pocketclaw.doctor":
        case "clawpilot.doctor": return runDoctor();
        case "clawconnect.doctor.fix":
        case "pocketclaw.doctor.fix":
        case "clawpilot.doctor.fix": return runDoctorFixStreaming(context);
        case "clawconnect.logs":
        case "pocketclaw.logs":
        case "clawpilot.logs": return readLogs(params);
        case "clawconnect.gateway.restart":
        case "pocketclaw.gateway.restart":
        case "clawpilot.gateway.restart": return restartGateway(context);
        case "clawconnect.gateway.remoteRestart":
        case "pocketclaw.gateway.remoteRestart":
        case "clawpilot.gateway.remoteRestart": return remoteRestartGateway(context);
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
        return { ok: false, error: errorMessage(err) };
    }
}
async function fixToolsPermissions202632() {
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
            let output = "";
            if (step === "gateway restart") {
                const restart = await requestGatewayRestart("clawconnect");
                if (!restart.ok) {
                    throw new Error(restart.error);
                }
                const payload = restart.payload;
                output = typeof payload?.output === "string" ? payload.output.trim() : "";
            }
            else {
                output = openclaw(step.split(/\s+/)).toString().trim();
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
    }
    catch (err) {
        const output = execErrorOutput(err);
        return output ? { ok: true, payload: { output } } : { ok: false, error: errorMessage(err) };
    }
}
function restoreConfig() {
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
    }
    catch (err) {
        return { ok: false, error: errorMessage(err) };
    }
}
function readBackups() {
    try {
        return { ok: true, payload: listBackups() };
    }
    catch (err) {
        return { ok: false, error: errorMessage(err) };
    }
}
function createBackupRecord(params) {
    try {
        return { ok: true, payload: createBackup(params) };
    }
    catch (err) {
        return { ok: false, error: errorMessage(err) };
    }
}
function updateBackupRecord(params) {
    try {
        return { ok: true, payload: updateBackup(params) };
    }
    catch (err) {
        return { ok: false, error: errorMessage(err) };
    }
}
function deleteBackupRecord(params) {
    try {
        return { ok: true, payload: deleteBackup(params) };
    }
    catch (err) {
        return { ok: false, error: errorMessage(err) };
    }
}
function restoreBackupRecord(params) {
    try {
        return { ok: true, payload: restoreBackup(params) };
    }
    catch (err) {
        return { ok: false, error: errorMessage(err) };
    }
}
function watchSkill() {
    try {
        openclaw(["config", "set", "skills.load.watch", "true"]);
        console.log("[clawconnect] skills.load.watch set to true");
        return { ok: true, payload: { message: "skills.load.watch enabled" } };
    }
    catch (err) {
        return { ok: false, error: errorMessage(err) };
    }
}
function runDoctor() {
    try {
        const output = openclaw(["doctor"]).toString();
        console.log("[clawconnect] doctor completed");
        return { ok: true, payload: { output } };
    }
    catch (err) {
        const output = execErrorOutput(err);
        return output ? { ok: true, payload: { output } } : { ok: false, error: errorMessage(err) };
    }
}
function stripAnsi(text) {
    // CSI sequences: ESC [ <params> <final byte>  (final byte 0x40-0x7E)
    // Covers SGR (m), erase in line/display (K/J), cursor moves, etc.
    text = text.replace(/\x1B\[[\d;]*[A-Za-z@\[\]\\^_`{|}~-]/g, "");
    // OSC sequences: ESC ] <params> ST  (ST = BEL \x07 or ESC \)
    text = text.replace(/\x1B\].*?(?:\x07|\x1B\\)/g, "");
    return text;
}
function readLogs(params = undefined) {
    try {
        const p = params && typeof params === "object" && !Array.isArray(params)
            ? params
            : {};
        const limit = typeof p.limit === "number" ? p.limit : 500;
        const candidates = [];
        // Primary: ~/.clawconnect/ — where the service (Linux systemd/nohup,
        // macOS launchd, Windows schtasks) redirects stdout/stderr.
        if (existsSync(CLAWCONNECT_DIR)) {
            for (const f of readdirSync(CLAWCONNECT_DIR)) {
                if (f.endsWith(".log"))
                    candidates.push(join(CLAWCONNECT_DIR, f));
            }
        }
        // Fallback: ~/.openclaw/logs/ or ~/.openclaw/*.log — for openclaw
        // tool logs or legacy installations.
        const logsDir = join(OPENCLAW_DIR, "logs");
        if (existsSync(logsDir)) {
            for (const f of readdirSync(logsDir)) {
                if (f.endsWith(".log"))
                    candidates.push(join(logsDir, f));
            }
        }
        else if (existsSync(OPENCLAW_DIR)) {
            for (const f of readdirSync(OPENCLAW_DIR)) {
                if (f.endsWith(".log"))
                    candidates.push(join(OPENCLAW_DIR, f));
            }
        }
        if (candidates.length === 0) {
            return { ok: true, payload: { output: "No log files found." } };
        }
        const sorted = candidates
            .map(f => ({ path: f, mtime: statSync(f).mtimeMs }))
            .sort((a, b) => {
            // Prioritize clawconnect.log if mtimes are close (within 1s)
            const aIsMain = a.path.endsWith("clawconnect.log");
            const bIsMain = b.path.endsWith("clawconnect.log");
            if (aIsMain !== bIsMain && Math.abs(a.mtime - b.mtime) < 1000) {
                return aIsMain ? -1 : 1;
            }
            return b.mtime - a.mtime;
        });
        const latest = sorted[0].path;
        const stats = statSync(latest);
        const MAX_READ_SIZE = 1024 * 1024; // 1MB chunk is plenty for the last N lines
        let buffer;
        let isTailOnly = false;
        if (stats.size > MAX_READ_SIZE) {
            const fd = openSync(latest, "r");
            buffer = Buffer.alloc(MAX_READ_SIZE);
            readSync(fd, buffer, 0, MAX_READ_SIZE, stats.size - MAX_READ_SIZE);
            closeSync(fd);
            isTailOnly = true;
        }
        else {
            buffer = readFileSync(latest);
        }
        // Detect text encoding of the log file.
        // ... (rest of the detection logic)
        let rawContent;
        let encoding;
        if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
            // BOM 0xFF 0xFE → UTF-16LE (common on Windows)
            rawContent = buffer.toString("utf16le");
            encoding = "utf16le";
        }
        else {
            // Assume UTF-8 first
            rawContent = buffer.toString("utf-8");
            encoding = "utf-8";
            // Validate by checking for null characters
            let nullCount = 0;
            const checkLength = Math.min(rawContent.length, 200);
            for (let i = 0; i < checkLength; i++) {
                if (rawContent.charCodeAt(i) === 0)
                    nullCount++;
            }
            if (checkLength > 20 && nullCount > checkLength * 0.1) {
                rawContent = buffer.toString("utf16le");
                encoding = "utf16le";
            }
        }
        const allLines = rawContent
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .split("\n");
        if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
            allLines.pop();
        }
        const totalLines = allLines.length;
        const startIndex = Math.max(0, totalLines - limit);
        const lines = allLines.slice(startIndex).map(stripAnsi);
        const returnedLines = lines.length;
        const truncated = startIndex > 0;
        console.log(`[clawconnect] logs read from ${latest} (encoding=${encoding}, limit=${limit}, total=${totalLines})`);
        return {
            ok: true,
            payload: {
                logPath: latest,
                lines,
                totalLines,
                returnedLines,
                truncated,
                output: `[${latest}]\n${lines.join("\n")}`,
            },
        };
    }
    catch (err) {
        return { ok: false, error: errorMessage(err) };
    }
}
function restartGateway(context = {}) {
    return requestGatewayRestart("clawconnect", context);
}
function remoteRestartGateway(context = {}) {
    return requestGatewayRemoteRestart("clawconnect", context);
}
function getOpenclawVersion() {
    const candidates = ["--version", "version"];
    for (const args of candidates) {
        try {
            const output = openclaw([args]).toString().trim();
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
        const output = openclaw(["update"]).toString();
        console.log("[clawconnect] openclaw updated");
        return { ok: true, payload: { output: output || "openclaw updated successfully." } };
    }
    catch (err) {
        const output = execErrorOutput(err);
        return output ? { ok: true, payload: { output } } : { ok: false, error: errorMessage(err) };
    }
}
//# sourceMappingURL=local-handlers.js.map