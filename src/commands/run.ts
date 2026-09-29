import { readConfig, readGatewayUrl, readGatewayAuth } from "../config/config.js";
import { getGatewayRuntimeAdapter } from "../runtime-adapters.js";
import { withReconnect } from "../core/relay/reconnect.js";
import { t } from "../i18n/index.js";
import { createInterface } from "readline";
import type { Interface } from "readline";
import { disposeReliableRelayOutboxes } from "../core/relay/reliable-relay-outbox-registry.js";
import { rotateProfileLogsIfOversized } from "../config/profile-log-rotation.js";
import { getActiveProfile } from "../config/profile.js";
import { RELAY_CLOSE_CODE_UNAUTHORIZED } from "../core/relay/relay-server-connection.js";
import { relayCredentialsRejectedHint } from "./profile-hints.js";

export async function runCommand(): Promise<void> {
  // 服务管理器只会追加写日志；每次进程启动先做一次有界轮转，避免日志无限增长。
  for (const result of rotateProfileLogsIfOversized(getActiveProfile())) {
    if (result.rotated) console.log(`[clawconnect] rotated ${result.path} (${result.bytesBefore} bytes)`);
  }
  const config = readConfig();
  const gatewayType = config.gatewayType ?? "openclaw";
  const runtimeAdapter = getGatewayRuntimeAdapter(gatewayType);
  const gatewayUrl = readGatewayUrl();
  const gatewayAuth = readGatewayAuth(config);

  // ── Shutdown signal ──────────────────────────────────────────────────
  // SIGTERM / SIGINT → gracefully close the relay WebSocket so the server
  // knows we disconnected intentionally, and the retry loop stops.
  const shutdown = new AbortController();
  const onSignal = (): void => { shutdown.abort(); };

  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  // On Windows, taskkill without /F sends WM_CLOSE.  A readline interface
  // installs a console control handler that translates this into SIGTERM.
  let rl: Interface | undefined;
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

  // 4401 基本是永久性的（网关已解绑或被清理），但 Relay 数据可能被恢复，因此仍按退避重连；
  // 只在每段连续拒绝的第一次打印恢复指引，避免每 30 秒刷一条相同日志。
  let credentialsRejectionReported = false;

  try {
    await withReconnect(
      (session) => runtimeAdapter.start({
        config,
        gatewayUrl: () => readGatewayUrl(),
        gatewayAuth,
        signal: shutdown.signal,
        onConnected: () => console.log(t("run.connected")),
        onRelayReady: () => {
          credentialsRejectionReported = false;
          session.markEstablished();
        },
        onDisconnected: (closeCode) => {
          console.log(t("run.disconnected"));
          if (closeCode === RELAY_CLOSE_CODE_UNAUTHORIZED && !credentialsRejectionReported) {
            credentialsRejectionReported = true;
            console.error(`[relay] ${relayCredentialsRejectedHint(getActiveProfile())}`);
          }
        },
      }),
      {
        signal: shutdown.signal,
        onRetry: (attempt, delayMs) => {
          console.log(t("run.retry", String(attempt), String(delayMs)));
        },
      },
    );
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    rl?.removeListener("SIGTERM", onSignal);
    rl?.removeListener("close", onSignal);
    rl?.close();
    disposeReliableRelayOutboxes();
  }
}
