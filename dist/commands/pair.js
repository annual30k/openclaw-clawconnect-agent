import { copyFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { configExists, getConfigPath, readConfig, writeConfig } from "../config/config.js";
import { installCommand } from "./install.js";
import qrcodeTerminal from "qrcode-terminal";
import { t } from "../i18n/index.js";
import { execSync } from "child_process";
import { hostname } from "os";
import { getServicePlatform } from "../platform/service-manager.js";
import { toRelayHttpBase } from "../core/relay/file-upload-utils.js";
import { getDefaultRelayServerUrl } from "../config/env.js";
import { gatewayCapabilitiesForType, normalizeGatewayType } from "../gateway-profiles.js";
export async function pairCommand(opts) {
    let gatewayId = "";
    let relaySecret = "";
    let accessCode = "";
    let displayName = "";
    let relayServerUrl = "";
    const gatewayType = normalizeGatewayType(opts.gatewayType);
    const capabilities = gatewayCapabilitiesForType(gatewayType);
    const existingConfig = configExists() ? readConfig() : null;
    const existingGatewayType = existingConfig?.gatewayType ?? "openclaw";
    const requestedRelayServerUrl = opts.server ?? getDefaultRelayServerUrl();
    const canReuseExistingConfig = shouldReuseExistingPairing(existingConfig, gatewayType, requestedRelayServerUrl);
    let reRegisterNeeded = false;
    if (existingConfig && canReuseExistingConfig) {
        const config = existingConfig;
        relayServerUrl = requestedRelayServerUrl;
        gatewayId = config.gatewayId;
        relaySecret = config.relaySecret;
        displayName = opts.name ? sanitizeDisplayName(opts.name) : config.displayName;
        console.log(t("pair.alreadyRegistered", gatewayId));
        const httpBase = toRelayHttpBase(relayServerUrl);
        let res;
        try {
            res = await fetch(`${httpBase}/api/relay/accesscode`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ gatewayId, relaySecret }),
            });
        }
        catch (err) {
            throw new Error(t("pair.refreshFailed", "network", String(err)));
        }
        if (res.status === 401) {
            console.log(`Existing gateway credentials (${gatewayId}) unrecognized by relay server (401); re-registering a new gateway…`);
            reRegisterNeeded = true;
        }
        else if (!res.ok) {
            const body = await res.text();
            throw new Error(t("pair.refreshFailed", String(res.status), body));
        }
        else {
            const data = (await res.json());
            accessCode = data.accessCode;
            writeConfig({ ...config, relayServerUrl, displayName, gatewayType: config.gatewayType ?? gatewayType, capabilities: config.capabilities ?? capabilities });
        }
    }
    if (!existingConfig || !canReuseExistingConfig || reRegisterNeeded) {
        if (existingConfig && existingGatewayType !== gatewayType) {
            console.log(`Existing ${existingGatewayType} gateway config found; registering a new ${gatewayType} gateway.`);
        }
        else if (existingConfig && !sameRelayServer(existingConfig.relayServerUrl, requestedRelayServerUrl)) {
            console.log(`Existing ${gatewayType} gateway config is for ${toRelayHttpBase(existingConfig.relayServerUrl)}.`);
            console.log(`Requested relay is ${toRelayHttpBase(requestedRelayServerUrl)}; registering a new ${gatewayType} gateway.`);
        }
        const backupPath = existingConfig ? backupExistingConfig() : undefined;
        if (backupPath) {
            console.log(`Previous config backed up to ${backupPath}`);
        }
        relayServerUrl = requestedRelayServerUrl;
        displayName = opts.name ? sanitizeDisplayName(opts.name) : existingConfig?.displayName ?? getDisplayName();
        console.log(t("pair.registering"));
        const httpBase = toRelayHttpBase(relayServerUrl);
        const res = await fetch(`${httpBase}/api/relay/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ displayName, gatewayType, capabilities }),
        });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(t("pair.registrationFailed", String(res.status), body));
        }
        const data = (await res.json());
        gatewayId = data.gatewayId;
        relaySecret = data.relaySecret;
        accessCode = data.accessCode;
        writeConfig({ relayServerUrl, gatewayId, relaySecret, displayName, gatewayType, capabilities });
        console.log(t("pair.registered", gatewayId));
    }
    const httpBase = toRelayHttpBase(relayServerUrl);
    const qrPayload = JSON.stringify({
        type: "clawlink_pairing",
        version: 1,
        server: httpBase,
        gatewayId,
        accessCode,
        displayName,
        gatewayType,
        capabilities,
    });
    if (opts.codeOnly) {
        console.log(accessCode);
    }
    else {
        console.log(t("pair.scanQR"));
        qrcodeTerminal.generate(qrPayload, { small: true });
        console.log(t("pair.accessCode", accessCode));
    }
    console.log(t("pair.installingService"));
    installCommand();
}
export function sameRelayServer(left, right) {
    return normalizeRelayServerIdentity(left) === normalizeRelayServerIdentity(right);
}
export function shouldReuseExistingPairing(config, gatewayType, requestedRelayServerUrl) {
    if (!config)
        return false;
    return (config.gatewayType ?? "openclaw") === gatewayType
        && sameRelayServer(config.relayServerUrl, requestedRelayServerUrl);
}
export function normalizeRelayServerIdentity(relayServerUrl) {
    const parsed = new URL(toRelayHttpBase(relayServerUrl));
    const protocol = parsed.protocol.toLowerCase();
    const host = normalizeRelayHost(parsed.hostname);
    const port = parsed.port || (protocol === "https:" ? "443" : "80");
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${protocol}//${host}:${port}${pathname}`;
}
function normalizeRelayHost(hostname) {
    const lower = hostname.toLowerCase();
    if (lower === "localhost" || lower === "::1" || lower === "[::1]") {
        return "127.0.0.1";
    }
    return lower;
}
function backupExistingConfig() {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) {
        return undefined;
    }
    const backupPath = join(dirname(configPath), `config.json.server-switch-${formatBackupTimestamp(new Date())}.bak`);
    copyFileSync(configPath, backupPath);
    return backupPath;
}
function formatBackupTimestamp(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        "-",
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
    ].join("");
}
function sanitizeDisplayName(name) {
    // Replace smart quotes and other problematic characters with regular ones
    return name
        .replace(/[\u2018\u2019\u201C\u201D]/g, "'") // Smart quotes -> regular quotes
        .replace(/[\u2013\u2014]/g, "-") // En/em dashes -> regular dash
        .replace(/[\u00A0]/g, " ") // Non-breaking space -> regular space
        .replace(/[\x00-\x1F\x7F]/g, ""); // Remove control characters only
}
function getDisplayName() {
    if (getServicePlatform() !== "macos") {
        return hostname();
    }
    try {
        const raw = execSync("scutil --get ComputerName", { encoding: "utf8" }).trim();
        return sanitizeDisplayName(raw);
    }
    catch {
        return hostname();
    }
}
//# sourceMappingURL=pair.js.map