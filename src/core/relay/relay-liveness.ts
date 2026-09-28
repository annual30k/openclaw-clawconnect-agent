import { WebSocket } from "ws";

export const RELAY_LIVENESS_PING_INTERVAL_MS = 20_000;
export const RELAY_LIVENESS_TIMEOUT_MS = 45_000;

export interface RelayLivenessOptions {
  pingIntervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  /** 超时时先于 terminate 调用，便于记录日志或指标。 */
  onTimeout?: (idleMs: number) => void;
}

export interface RelayLivenessMonitor {
  stop(): void;
}

/**
 * Agent 侧的 Relay 连接存活检测。
 *
 * Relay 的心跳只是它向 Agent 发的探测；如果 TCP 半开（网络切换、NAT 超时、Relay 进程被
 * 强杀），Agent 收不到任何帧也不会收到 close，只要 outbox 里没有待 ACK 的项就会一直
 * 显示“已连接”。这里由 Agent 主动按固定周期发 WebSocket ping：任何入站帧（message /
 * pong）都算活动；连续 `timeoutMs` 没有活动就强制 terminate，触发 close → 重连。
 * 判定只依赖本地单调时钟与固定阈值，不依赖 Relay 的配置。
 */
export function startRelayLivenessMonitor(ws: WebSocket, options: RelayLivenessOptions = {}): RelayLivenessMonitor {
  const pingIntervalMs = positiveOr(options.pingIntervalMs, RELAY_LIVENESS_PING_INTERVAL_MS);
  const timeoutMs = positiveOr(options.timeoutMs, RELAY_LIVENESS_TIMEOUT_MS);
  const now = options.now ?? Date.now;
  let lastActivityAt = now();
  let stopped = false;

  const markActivity = (): void => {
    lastActivityAt = now();
  };
  ws.on("message", markActivity);
  ws.on("pong", markActivity);

  const timer = setInterval(() => {
    if (stopped) return;
    const idleMs = now() - lastActivityAt;
    if (idleMs > timeoutMs) {
      stop();
      options.onTimeout?.(idleMs);
      try {
        ws.terminate();
      } catch {
        // close 事件仍会由底层 socket 触发；这里没有别的恢复手段。
      }
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.ping();
    } catch {
      // 发送失败会以 error/close 事件表现出来，交给现有的重连路径处理。
    }
  }, pingIntervalMs);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    ws.off("message", markActivity);
    ws.off("pong", markActivity);
  }

  return { stop };
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
