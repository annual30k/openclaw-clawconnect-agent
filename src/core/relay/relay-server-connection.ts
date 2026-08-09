import { WebSocket, type RawData } from "ws";

export const RELAY_WS_BACKPRESSURE_HIGH_WATER_MARK_BYTES = 4 * 1024 * 1024;

export type RelaySendResult = {
  status: "sent" | "socket_not_open";
  byteLength: number;
  bufferedAmount: number;
  projectedBufferedAmount: number;
  aboveHighWaterMark: boolean;
};

export function buildRelayUrl(serverUrl: string, gatewayId: string, relaySecret: string): string {
  const base = serverUrl.replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}/relay/${gatewayId}?secret=${encodeURIComponent(relaySecret)}`;
}

export function sendRelayJson(
  ws: WebSocket,
  message: unknown,
  highWaterMarkBytes = RELAY_WS_BACKPRESSURE_HIGH_WATER_MARK_BYTES,
): RelaySendResult {
  const bufferedAmount = finiteNonNegative(ws.bufferedAmount);
  if (ws.readyState !== WebSocket.OPEN) {
    return {
      status: "socket_not_open",
      byteLength: 0,
      bufferedAmount,
      projectedBufferedAmount: bufferedAmount,
      aboveHighWaterMark: bufferedAmount >= highWaterMarkBytes,
    };
  }

  const serialized = JSON.stringify(message);
  const byteLength = Buffer.byteLength(serialized, "utf8");
  const projectedBufferedAmount = bufferedAmount + byteLength;
  // 这里只暴露背压边界，不按消息内容猜测优先级，也不静默丢弃控制或终态帧。
  ws.send(serialized);
  return {
    status: "sent",
    byteLength,
    bufferedAmount: finiteNonNegative(ws.bufferedAmount),
    projectedBufferedAmount,
    aboveHighWaterMark: projectedBufferedAmount >= highWaterMarkBytes,
  };
}

export function parseRelayFrame<T>(raw: RawData): T | undefined {
  try {
    return JSON.parse(raw.toString()) as T;
  } catch {
    return undefined;
  }
}

export function bindRelayAbortSignal(ws: WebSocket, signal?: AbortSignal): void {
  if (!signal) {
    return;
  }
  if (signal.aborted) {
    ws.close(1001, "shutdown");
    return;
  }
  signal.addEventListener("abort", () => ws.close(1001, "shutdown"), { once: true });
}

export function shouldRetryRelayClose(code: number, signal?: AbortSignal): boolean {
  return !(signal?.aborted || code === 4000);
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
