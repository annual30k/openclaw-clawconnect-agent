import { hostname } from "os";
import { execSync } from "child_process";
import { getServicePlatform } from "../platform/service-manager.js";
function sanitizeDisplayName(name) {
    // Replace smart quotes and other problematic characters with regular ones
    return name
        .replace(/[\u2018\u2019\u201C\u201D]/g, "'") // Smart quotes → regular quotes
        .replace(/[\u2013\u2014]/g, "-") // En/em dashes → regular dash
        .replace(/[\u00A0]/g, " ") // Non-breaking space → regular space
        .replace(/[^\x20-\x7E]/g, ""); // Remove any other non-ASCII characters
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
import { configExists, readConfig, writeConfig } from "../config/config.js";
import { installCommand } from "./install.js";
import qrcodeTerminal from "qrcode-terminal";
import { t } from "../i18n/index.js";
const DEFAULT_RELAY_SERVER = "http://223.109.141.71";
export async function pairCommand(opts) {
    const relayServerUrl = opts.server ?? DEFAULT_RELAY_SERVER;
    const httpBase = relayServerUrl.replace(/^wss?/, "http");
    let gatewayId;
    let relaySecret;
    let accessCode;
    let displayName;
    if (configExists()) {
        const config = readConfig();
        gatewayId = config.gatewayId;
        relaySecret = config.relaySecret;
        displayName = opts.name ? sanitizeDisplayName(opts.name) : config.displayName;
        console.log(t("pair.alreadyRegistered", gatewayId));
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
        displayName = opts.name ? sanitizeDisplayName(opts.name) : getDisplayName();
        console.log(t("pair.registering"));
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
//# sourceMappingURL=pair.js.map