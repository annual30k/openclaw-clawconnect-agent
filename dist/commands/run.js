import { readConfig, readGatewayUrl, readGatewayAuth, readVoiceReplyConfig } from "../config/config.js";
import { getGatewayRuntimeAdapter } from "../runtime-adapters.js";
import { withReconnect } from "../relay/reconnect.js";
import { t } from "../i18n/index.js";
import { createInterface } from "readline";
function parseBooleanEnv(value) {
    return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}
export async function runCommand() {
    const config = readConfig();
    const gatewayType = config.gatewayType ?? "openclaw";
    const runtimeAdapter = getGatewayRuntimeAdapter(gatewayType);
    const gatewayUrl = readGatewayUrl();
    const gatewayAuth = readGatewayAuth(config);
    const defaultVoiceReplyEnabled = parseBooleanEnv(process.env.OPENCLAW_TTS_ENABLED);
    const defaultVoiceReplyConfig = readVoiceReplyConfig(config);
    // ── Shutdown signal ──────────────────────────────────────────────────
    // SIGTERM / SIGINT → gracefully close the relay WebSocket so the server
    // knows we disconnected intentionally, and the retry loop stops.
    const shutdown = new AbortController();
    const onSignal = () => { shutdown.abort(); };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    // On Windows, taskkill without /F sends WM_CLOSE.  A readline interface
    // installs a console control handler that translates this into SIGTERM.
    if (process.platform === "win32") {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.on("SIGTERM", onSignal);
        rl.on("close", onSignal);
    }
    console.log(t("run.starting"));
    console.log(t("run.gatewayId", config.gatewayId));
    console.log(t("run.relayServer", config.relayServerUrl));
    if (runtimeAdapter.type !== "openclaw") {
        console.log(`  Gateway type: ${runtimeAdapter.type}`);
    }
    if (runtimeAdapter.logsGatewayUrl) {
        console.log(t("run.gatewayUrl", gatewayUrl));
    }
    await withReconnect(() => runtimeAdapter.start({
        config,
        gatewayUrl: () => readGatewayUrl(),
        gatewayAuth,
        defaultVoiceReplyEnabled,
        defaultVoiceReplyConfig,
        signal: shutdown.signal,
        onConnected: () => console.log(t("run.connected")),
        onDisconnected: () => console.log(t("run.disconnected")),
    }), {
        onRetry: (attempt, delayMs) => {
            console.log(t("run.retry", String(attempt), String(delayMs)));
        },
    });
}
//# sourceMappingURL=run.js.map