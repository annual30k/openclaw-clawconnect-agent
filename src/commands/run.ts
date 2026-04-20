import { readConfig, readGatewayUrl, readGatewayAuth } from "../config/config.js";
import { runRelayManager } from "../relay/relay-manager.js";
import { withReconnect } from "../relay/reconnect.js";
import { t } from "../i18n/index.js";

function parseBooleanEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

export async function runCommand(): Promise<void> {
  const config = readConfig();
  const gatewayUrl = readGatewayUrl();
  const gatewayAuth = readGatewayAuth(config);
  const defaultVoiceReplyEnabled = parseBooleanEnv(process.env.OPENCLAW_TTS_ENABLED);

  console.log(t("run.starting"));
  console.log(t("run.gatewayId", config.gatewayId));
  console.log(t("run.relayServer", config.relayServerUrl));
  console.log(t("run.gatewayUrl", gatewayUrl));

  await withReconnect(
    () =>
      runRelayManager({
        relayServerUrl: config.relayServerUrl,
        gatewayId: config.gatewayId,
        relaySecret: config.relaySecret,
        gatewayUrl,
        gatewayToken: gatewayAuth.token,
        gatewayPassword: gatewayAuth.password,
        defaultVoiceReplyEnabled,
        onConnected: () => console.log(t("run.connected")),
        onDisconnected: () => console.log(t("run.disconnected")),
      }),
    {
      onRetry: (attempt, delayMs) => {
        console.log(t("run.retry", String(attempt), String(delayMs)));
      },
    }
  );
}
