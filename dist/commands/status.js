import { existsSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { configExists, readConfig, readGatewayUrl } from "../config/config.js";
import { listProfileNames, profileDisplayName } from "../config/profile.js";
import { t } from "../i18n/index.js";
import { getServiceStatus } from "../platform/service-manager.js";
import { decodeTextBuffer } from "../platform/text-file-decoder.js";
import { resolveOpenClawConfigPath, resolveOpenClawStateDir } from "../openclaw/runtime/openclaw-paths.js";
import { resolveHermesHomeDir } from "../hermes/runtime/hermes-runtime-paths.js";
import { resolveHermesApiSettings, resolveHermesRuntimeExecutionMode, } from "../hermes/runtime/hermes-runtime-api-settings.js";
const WINDOWS_LOG_READ_TIMEOUT_MS = 5_000;
export function statusCommand(opts = {}) {
    if (opts.profile === "all") {
        const profiles = listProfileNames();
        if (profiles.length === 0) {
            statusCommand({ profile: undefined });
            return;
        }
        profiles.forEach((profile, index) => {
            if (index > 0)
                console.log("");
            statusOne(profile === "default" ? undefined : profile);
        });
        return;
    }
    statusOne(opts.profile);
}
function statusOne(profile) {
    console.log(t("status.title"));
    console.log(`Profile:  ${profileDisplayName(profile)}`);
    let gatewayType = "openclaw";
    if (!configExists(profile)) {
        console.log(t("status.notPaired"));
    }
    else {
        try {
            const config = readConfig(profile);
            gatewayType = config.gatewayType === "hermes" ? "hermes" : "openclaw";
            console.log(t("status.paired"));
            console.log(t("status.displayName", config.displayName));
            console.log(t("status.gatewayId", config.gatewayId));
            console.log(t("status.gatewayType", gatewayType));
            console.log(t("status.relayServer", config.relayServerUrl));
        }
        catch {
            console.log(t("status.configCorrupted"));
        }
    }
    if (gatewayType === "openclaw") {
        console.log(t("status.gateway", readGatewayUrl()));
        console.log(`OpenClaw state:  ${resolveOpenClawStateDir()}`);
        console.log(`OpenClaw config: ${resolveOpenClawConfigPath()}`);
        const openClawInstall = process.env.OPENCLAW_BIN?.trim()
            || process.env.OPENCLAW_PACKAGE_BIN?.trim()
            || process.env.OPENCLAW_INSTALL_DIR?.trim();
        if (openClawInstall) {
            console.log(`OpenClaw runtime: ${openClawInstall}`);
        }
    }
    else {
        console.log(`Hermes home: ${resolveHermesHomeDir()}`);
        const hermesRuntimeMode = resolveHermesRuntimeExecutionMode();
        const hermesRuntimeLabel = hermesRuntimeMode === "local"
            ? "host-local CLI/runtime"
            : "API Server compatibility";
        console.log(`Hermes runtime: ${hermesRuntimeLabel}`);
        const hermesApi = resolveHermesApiSettings();
        if (hermesRuntimeMode === "api" && hermesApi.configured) {
            console.log(`Hermes API:  ${hermesApi.baseUrl}`);
        }
    }
    const service = getServiceStatus(profile);
    if (service.platform === "unsupported") {
        console.log(t("status.serviceUnsupported", process.platform));
        console.log("");
        return;
    }
    console.log(t("status.servicePlatform", service.manager));
    if (!service.installed) {
        console.log(t("status.serviceNotInstalled"));
    }
    else if (service.running) {
        console.log(t("status.serviceRunning", service.manager));
        console.log(t("status.serviceLog", service.logPath));
        const health = readHealth(service.logPath, gatewayType);
        console.log(formatHealthLine("status.relayHealth", health.relay));
        console.log(formatHealthLine(gatewayType === "openclaw" ? "status.gatewayHealth" : "status.agentHealth", health.gateway));
    }
    else {
        console.log(t("status.serviceNotRunning"));
        if (service.servicePath) {
            console.log(t("status.serviceFile", service.servicePath));
        }
        if (service.startHint) {
            console.log(t("status.serviceStart", service.startHint));
        }
    }
    console.log("");
}
export function readHealth(logPath, gatewayType = "openclaw") {
    if (!existsSync(logPath)) {
        return {
            relay: { kind: "unknown", detail: "log missing" },
            gateway: { kind: "unknown", detail: "log missing" },
        };
    }
    const lines = readTailLines(logPath, 400);
    return {
        relay: parseRelayHealth(lines, gatewayType),
        gateway: parseGatewayHealth(lines, gatewayType),
    };
}
function readTailLines(path, maxLines) {
    let raw;
    try {
        raw = decodeTextBuffer(readFileSync(path)).text;
    }
    catch {
        // Windows 兜底通过环境变量传路径并返回 Base64，避免 cmd 路径转义和控制台代码页污染日志内容。
        if (process.platform === "win32") {
            try {
                const base64 = execFileSync("powershell.exe", [
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "[Convert]::ToBase64String([IO.File]::ReadAllBytes($env:CLAWCONNECT_LOG_PATH))",
                ], {
                    encoding: "utf8",
                    env: { ...process.env, CLAWCONNECT_LOG_PATH: path },
                    stdio: "pipe",
                    timeout: WINDOWS_LOG_READ_TIMEOUT_MS,
                    windowsHide: true,
                }).trim();
                raw = decodeTextBuffer(Buffer.from(base64, "base64")).text;
            }
            catch {
                return [];
            }
        }
        else {
            return [];
        }
    }
    const lines = raw.split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines);
}
function parseRelayHealth(lines, gatewayType) {
    const connectedIndex = findLastIndex(lines, (line) => line.includes("Relay connected.")
        || line.includes("Connected to relay server (gatewayId=")
        || (gatewayType === "hermes" && line.includes("Connected to relay server (hermes gatewayId=")));
    const disconnectedIndex = findLastIndex(lines, (line) => line.includes("Relay disconnected.") ||
        line.includes("Relay connection closed:") ||
        (gatewayType === "hermes" && line.includes("Hermes relay connection closed:")));
    if (connectedIndex === -1 && disconnectedIndex === -1) {
        return { kind: "unknown", detail: "no relay events yet" };
    }
    if (connectedIndex > disconnectedIndex) {
        return { kind: "ok", detail: "connected" };
    }
    const line = disconnectedIndex >= 0 ? lines[disconnectedIndex] : "";
    const detail = line.includes("Relay connection closed:") || line.includes("Hermes relay connection closed:")
        ? line.replace(/^.*(?:Hermes relay connection closed:|Relay connection closed:)\s*/, "").trim()
        : "disconnected";
    return { kind: "error", detail };
}
function parseGatewayHealth(lines, gatewayType) {
    if (gatewayType === "hermes") {
        return parseHermesAgentHealth(lines);
    }
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (line.includes("Gateway connected.")) {
            return { kind: "ok", detail: "connected" };
        }
        if (line.includes("Gateway disconnected:")) {
            return {
                kind: classifyGatewayDetail(line),
                detail: line.replace(/^.*Gateway disconnected:\s*/, "").trim(),
            };
        }
        if (line.includes("[gateway-client] connect failed:")) {
            return {
                kind: "error",
                detail: line.replace(/^.*connect failed:\s*/, "").trim(),
            };
        }
        if (line.includes("[gateway-client] ws error:")) {
            return {
                kind: "error",
                detail: line.replace(/^.*ws error:\s*/, "").trim(),
            };
        }
    }
    return { kind: "unknown", detail: "no gateway events yet" };
}
function parseHermesAgentHealth(lines) {
    const connectedIndex = findLastIndex(lines, (line) => line.includes("Connected to relay server (hermes gatewayId=") ||
        line.includes("Relay connected."));
    const closedIndex = findLastIndex(lines, (line) => line.includes("Hermes relay connection closed:"));
    if (connectedIndex === -1 && closedIndex === -1) {
        return { kind: "unknown", detail: "no Hermes agent events yet" };
    }
    if (connectedIndex > closedIndex) {
        return { kind: "ok", detail: "connected" };
    }
    const detail = closedIndex >= 0
        ? lines[closedIndex].replace(/^.*Hermes relay connection closed:\s*/, "").trim() || "disconnected"
        : "disconnected";
    return { kind: "error", detail };
}
function classifyGatewayDetail(line) {
    const detail = line.toLowerCase();
    if (detail.includes("unauthorized") || detail.includes("mismatch") || detail.includes("not allowed")) {
        return "error";
    }
    if (detail.includes("tick timeout") || detail.includes("service restart")) {
        return "warn";
    }
    return "warn";
}
function findLastIndex(lines, predicate) {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (predicate(lines[i]))
            return i;
    }
    return -1;
}
function formatHealthLine(key, state) {
    const icon = state.kind === "ok" ? "✓"
        : state.kind === "warn" ? "⚠"
            : state.kind === "error" ? "✗"
                : "-";
    return t(key, icon, state.detail ?? "");
}
//# sourceMappingURL=status.js.map