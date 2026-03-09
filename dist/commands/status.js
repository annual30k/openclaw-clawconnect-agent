import { existsSync, readFileSync } from "fs";
import { configExists, readConfig, readGatewayUrl } from "../config/config.js";
import { t } from "../i18n/index.js";
import { getServiceStatus } from "../platform/service-manager.js";
export function statusCommand() {
    console.log(t("status.title"));
    if (!configExists()) {
        console.log(t("status.notPaired"));
    }
    else {
        try {
            const config = readConfig();
            console.log(t("status.paired"));
            console.log(t("status.displayName", config.displayName));
            console.log(t("status.gatewayId", config.gatewayId));
            console.log(t("status.relayServer", config.relayServerUrl));
        }
        catch {
            console.log(t("status.configCorrupted"));
        }
    }
    console.log(t("status.gateway", readGatewayUrl()));
    const service = getServiceStatus();
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
        const health = readHealth(service.logPath);
        console.log(formatHealthLine("status.relayHealth", health.relay));
        console.log(formatHealthLine("status.gatewayHealth", health.gateway));
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
function readHealth(logPath) {
    if (!existsSync(logPath)) {
        return {
            relay: { kind: "unknown", detail: "log missing" },
            gateway: { kind: "unknown", detail: "log missing" },
        };
    }
    const lines = readTailLines(logPath, 400);
    return {
        relay: parseRelayHealth(lines),
        gateway: parseGatewayHealth(lines),
    };
}
function readTailLines(path, maxLines) {
    const raw = readFileSync(path, "utf-8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines);
}
function parseRelayHealth(lines) {
    const connectedIndex = findLastIndex(lines, (line) => line.includes("Relay connected."));
    const disconnectedIndex = findLastIndex(lines, (line) => line.includes("Relay disconnected.") || line.includes("Relay connection closed:"));
    if (connectedIndex === -1 && disconnectedIndex === -1) {
        return { kind: "unknown", detail: "no relay events yet" };
    }
    if (connectedIndex > disconnectedIndex) {
        return { kind: "ok", detail: "connected" };
    }
    const line = disconnectedIndex >= 0 ? lines[disconnectedIndex] : "";
    const detail = line.includes("Relay connection closed:")
        ? line.replace(/^.*Relay connection closed:\s*/, "").trim()
        : "disconnected";
    return { kind: "error", detail };
}
function parseGatewayHealth(lines) {
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