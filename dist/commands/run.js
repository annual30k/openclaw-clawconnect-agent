import { readConfig, readGatewayUrl, readGatewayAuth } from "../config/config.js";
import { getGatewayRuntimeAdapter } from "../runtime-adapters.js";
import { withReconnect } from "../core/relay/reconnect.js";
import { t } from "../i18n/index.js";
import { createInterface } from "readline";
import { disposeReliableRelayOutboxes } from "../core/relay/reliable-relay-outbox-registry.js";
export async function runCommand() {
    const config = readConfig();
    const gatewayType = config.gatewayType ?? "openclaw";
    const runtimeAdapter = getGatewayRuntimeAdapter(gatewayType);
    const gatewayUrl = readGatewayUrl();
    const gatewayAuth = readGatewayAuth(config);
    // ── Shutdown signal ──────────────────────────────────────────────────
    // SIGTERM / SIGINT → gracefully close the relay WebSocket so the server
    // knows we disconnected intentionally, and the retry loop stops.
    const shutdown = new AbortController();
    const onSignal = () => { shutdown.abort(); };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    // On Windows, taskkill without /F sends WM_CLOSE.  A readline interface
    // installs a console control handler that translates this into SIGTERM.
    let rl;
    if (process.platform === "win32") {
        rl = createInterface({ input: process.stdin, output: process.stdout });
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
    try {
        await withReconnect(() => runtimeAdapter.start({
            config,
            gatewayUrl: () => readGatewayUrl(),
            gatewayAuth,
            signal: shutdown.signal,
            onConnected: () => console.log(t("run.connected")),
            onDisconnected: () => console.log(t("run.disconnected")),
        }), {
            signal: shutdown.signal,
            onRetry: (attempt, delayMs) => {
                console.log(t("run.retry", String(attempt), String(delayMs)));
            },
        });
    }
    finally {
        process.removeListener("SIGTERM", onSignal);
        process.removeListener("SIGINT", onSignal);
        rl?.removeListener("SIGTERM", onSignal);
        rl?.removeListener("close", onSignal);
        rl?.close();
        disposeReliableRelayOutboxes();
    }
}
//# sourceMappingURL=run.js.map