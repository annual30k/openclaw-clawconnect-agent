import { WebSocket, type RawData } from "ws";

export function buildRelayUrl(serverUrl: string, gatewayId: string, relaySecret: string): string {
  const base = serverUrl.replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}/relay/${gatewayId}?secret=${encodeURIComponent(relaySecret)}`;
}

export function sendRelayJson(ws: WebSocket, message: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
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
