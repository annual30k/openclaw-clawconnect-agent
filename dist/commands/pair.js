import { configExists, readConfig, writeConfig } from "../config/config.js";
import { installCommand } from "./install.js";
import qrcodeTerminal from "qrcode-terminal";
import { t } from "../i18n/index.js";
import { execSync } from "child_process";
import { hostname } from "os";
import { getServicePlatform } from "../platform/service-manager.js";
import { toRelayHttpBase } from "./send-file-utils.js";
import { getDefaultRelayServerUrl } from "../config/env.js";
export async function pairCommand(opts) {
    let gatewayId;
    let relaySecret;
    let accessCode;
    let displayName;
    let relayServerUrl;
    if (configExists()) {
        const config = readConfig();
        relayServerUrl = opts.server ?? config.relayServerUrl ?? getDefaultRelayServerUrl();
        gatewayId = config.gatewayId;
        relaySecret = config.relaySecret;
        displayName = opts.name ? sanitizeDisplayName(opts.name) : config.displayName;
        console.log(t("pair.alreadyRegistered", gatewayId));
        const httpBase = toRelayHttpBase(relayServerUrl);
        const res = await fetch(`${httpBase}/api/relay/accesscode`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gatewayId, relaySecret }),
        });
        if (!res.ok) {
            const body = await res.text();
            if (res.status === 401) {
                throw new Error(t("pair.invalidCredentials"));
            }
            throw new Error(t("pair.refreshFailed", String(res.status), body));
        }
        const data = (await res.json());
        accessCode = data.accessCode;
        writeConfig({ ...config, relayServerUrl, displayName });
    }
    else {
        relayServerUrl = opts.server ?? getDefaultRelayServerUrl();
        displayName = opts.name ? sanitizeDisplayName(opts.name) : getDisplayName();
        console.log(t("pair.registering"));
        const httpBase = toRelayHttpBase(relayServerUrl);
        const res = await fetch(`${httpBase}/api/relay/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ displayName }),
        });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(t("pair.registrationFailed", String(res.status), body));
        }
        const data = (await res.json());
        gatewayId = data.gatewayId;
        relaySecret = data.relaySecret;
        accessCode = data.accessCode;
        writeConfig({ relayServerUrl, gatewayId, relaySecret, displayName });
        console.log(t("pair.registered", gatewayId));
    }
    const httpBase = toRelayHttpBase(relayServerUrl);
    const qrPayload = JSON.stringify({
        version: 1,
        server: httpBase,
        gatewayId,
        accessCode,
        displayName,
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