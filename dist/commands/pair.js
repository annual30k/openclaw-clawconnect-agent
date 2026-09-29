import { configExists, getConfigPath, readConfig, writeConfig } from "../config/config.js";
import { backupConfigBeforeRegistration } from "../config/config-backups.js";
import { installCommand } from "./install.js";
import qrcodeTerminal from "qrcode-terminal";
import { t } from "../i18n/index.js";
import { execSync } from "child_process";
import { hostname } from "os";
import { getServicePlatform } from "../platform/service-manager.js";
import { normalizeRelayServerIdentity, toRelayHttpBase } from "../core/relay/file-upload-utils.js";
import { getDefaultRelayServerUrl } from "../config/env.js";
import { gatewayCapabilitiesForType, normalizeGatewayType } from "../gateway-profiles.js";
import { clearProfileLogs, getActiveProfile, listProfileNames, normalizeProfileName, profileDisplayName } from "../config/profile.js";
import { pairCommandForProfile, resetCommandForProfile } from "./profile-hints.js";
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
        const res = await postRelayJson(httpBase, "/api/relay/accesscode", { gatewayId, relaySecret });
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
        const conflict = findConflictingRegistration(getActiveProfile(), gatewayType, requestedRelayServerUrl, loadOtherProfileConfigs());
        if (conflict) {
            throw new Error(t("pair.duplicateRegistration", gatewayType, toRelayHttpBase(requestedRelayServerUrl), profileDisplayName(conflict.profile), pairCommandForProfile(conflict.profile), resetCommandForProfile(conflict.profile)));
        }
        const backupPath = existingConfig ? backupConfigBeforeRegistration(getConfigPath()) : undefined;
        if (backupPath) {
            console.log(`Previous config backed up to ${backupPath}`);
        }
        relayServerUrl = requestedRelayServerUrl;
        displayName = opts.name ? sanitizeDisplayName(opts.name) : existingConfig?.displayName ?? getDisplayName();
        console.log(t("pair.registering"));
        const httpBase = toRelayHttpBase(relayServerUrl);
        const res = await postRelayJson(httpBase, "/api/relay/register", { displayName, gatewayType, capabilities });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(t("pair.registrationFailed", String(res.status), body));
        }
        const data = (await res.json());
        gatewayId = data.gatewayId;
        relaySecret = data.relaySecret;
        accessCode = data.accessCode;
        writeConfig({ relayServerUrl, gatewayId, relaySecret, displayName, gatewayType, capabilities });
        clearProfileLogs(opts.profile);
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
/** 配对请求的时间上限：代理/NAT 卡住连接时必须给出明确失败，而不是让命令无限挂起。 */
export const PAIR_REQUEST_TIMEOUT_MS = 20_000;
export async function postRelayJson(httpBase, path, body, fetchImpl = fetch, timeoutMs = PAIR_REQUEST_TIMEOUT_MS) {
    try {
        return await fetchImpl(`${httpBase}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
    }
    catch (err) {
        throw new Error(t("pair.networkFailed", httpBase, describeNetworkError(err, timeoutMs)));
    }
}
// undici 只抛 "fetch failed"，真正原因在 cause.code（如 UND_ERR_CONNECT_TIMEOUT、ENOTFOUND）。
function describeNetworkError(err, timeoutMs) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        return `no response within ${timeoutMs}ms`;
    }
    const cause = err instanceof Error ? err.cause : undefined;
    if (cause && typeof cause === "object") {
        const record = cause;
        const code = typeof record.code === "string" ? record.code : "";
        const message = typeof record.message === "string" ? record.message : "";
        const described = [code, message].filter(Boolean).join(" ");
        if (described)
            return described;
    }
    return err instanceof Error ? err.message : String(err);
}
/**
 * 找出已在同一 Relay 上注册了同类型网关的其他 profile。
 * 同一台主机只有一个本地 OpenClaw/Hermes 运行时，重复注册只会产生两个指向同一运行时的网关。
 * 多个冲突时按 profile 名排序取第一个（default 最前），结果与目录遍历顺序无关。
 */
export function findConflictingRegistration(currentProfile, gatewayType, relayServerUrl, candidates) {
    const current = normalizeProfileName(currentProfile);
    return candidates
        .map((entry) => ({ ...entry, profile: normalizeProfileName(entry.profile) }))
        .filter((entry) => entry.profile !== current)
        .filter((entry) => (entry.config.gatewayType ?? "openclaw") === gatewayType
        && sameRelayServer(entry.config.relayServerUrl, relayServerUrl))
        .sort((left, right) => (left.profile ?? "").localeCompare(right.profile ?? ""))[0];
}
function loadOtherProfileConfigs() {
    const entries = [];
    for (const name of listProfileNames()) {
        const profile = normalizeProfileName(name);
        try {
            entries.push({ profile, config: readConfig(profile) });
        }
        catch {
            // 损坏或不可读的配置无法代表有效注册，不参与冲突判断。
        }
    }
    return entries;
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
export { normalizeRelayServerIdentity } from "../core/relay/file-upload-utils.js";
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