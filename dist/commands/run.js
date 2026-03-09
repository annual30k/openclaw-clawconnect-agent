import { readConfig, readGatewayUrl, readGatewayAuth } from "../config/config.js";
import { runRelayManager } from "../relay/relay-manager.js";
import { withReconnect } from "../relay/reconnect.js";
import { t } from "../i18n/index.js";
export async function runCommand() {
    const config = readConfig();
    const gatewayUrl = readGatewayUrl();
    const gatewayAuth = readGatewayAuth(config);
    console.log(t("run.starting"));
    console.log(t("run.gatewayId", config.gatewayId));
    console.log(t("run.relayServer", config.relayServerUrl));
    console.log(t("run.gatewayUrl", gatewayUrl));
    await withReconnect(() => runRelayManager({
        relayServerUrl: config.relayServerUrl,
        gatewayId: config.gatewayId,
        relaySecret: config.relaySecret,
        gatewayUrl,
        gatewayToken: gatewayAuth.token,
        gatewayPassword: gatewayAuth.password,
        onConnected: () => console.log(t("run.connected")),
        onDisconnected: () => console.log(t("run.disconnected")),
    }), {
        onRetry: (attempt, delayMs) => {
            console.log(t("run.retry", String(attempt), String(delayMs)));
        },
    });
}
//# sourceMappingURL=run.js.map