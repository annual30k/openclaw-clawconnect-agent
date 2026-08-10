import { WebSocket, type RawData } from "ws";

export const RELAY_WS_BACKPRESSURE_HIGH_WATER_MARK_BYTES = 4 * 1024 * 1024;
export const RELAY_WS_COMPRESSION_THRESHOLD_BYTES = 1024;
export const RELAY_WS_WRITE_CONFIRMATION_TIMEOUT_MS = 10_000;
export const RELAY_WS_CLIENT_OPTIONS = Object.freeze({
  perMessageDeflate: true as const,
});

export type RelaySendResult = {
  status: "sent" | "socket_not_open" | "backpressure_skipped" | "backpressure_disconnected" | "send_failed";
  byteLength: number;
  bufferedAmount: number;
  projectedBufferedAmount: number;
  aboveHighWaterMark: boolean;
  error?: unknown;
};

export function buildRelayUrl(serverUrl: string, gatewayId: string, relaySecret: string): string {
  const base = serverUrl.replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}/relay/${gatewayId}?secret=${encodeURIComponent(relaySecret)}`;
}

export function createRelayWebSocket(url: string): WebSocket {
  return new WebSocket(url, RELAY_WS_CLIENT_OPTIONS);
}

export function sendRelayJson(
  ws: WebSocket,
  message: unknown,
  highWaterMarkBytes = RELAY_WS_BACKPRESSURE_HIGH_WATER_MARK_BYTES,
  onComplete?: (error?: Error) => void,
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

  let serialized: string;
  try {
    const encoded = JSON.stringify(compactRelayMessageForTransport(message));
    if (encoded === undefined) {
      throw new TypeError("relay_message_not_json_serializable");
    }
    serialized = encoded;
  } catch (error) {
    onComplete?.(asError(error));
    return {
      status: "send_failed",
      byteLength: 0,
      bufferedAmount,
      projectedBufferedAmount: bufferedAmount,
      aboveHighWaterMark: bufferedAmount >= highWaterMarkBytes,
      error,
    };
  }
  const byteLength = Buffer.byteLength(serialized, "utf8");
  const projectedBufferedAmount = bufferedAmount + byteLength;
  // An empty queue may carry one large history/control frame. Under sustained
  // pressure replaceable snapshots are skipped; every other frame closes the
  // socket instead of growing ws.bufferedAmount without bound. Reliable terminal
  // events and responses remain owned by the ACK outbox for reconnect replay.
  if (bufferedAmount > 0 && projectedBufferedAmount > highWaterMarkBytes) {
    if (isRecoverableStreamingSnapshot(message)) {
      return {
        status: "backpressure_skipped",
        byteLength,
        bufferedAmount,
        projectedBufferedAmount,
        aboveHighWaterMark: true,
      };
    }
    closeBackpressuredSocket(ws);
    return {
      status: "backpressure_disconnected",
      byteLength,
      bufferedAmount,
      projectedBufferedAmount,
      aboveHighWaterMark: true,
    };
  }
  try {
    ws.send(
      serialized,
      { compress: byteLength >= RELAY_WS_COMPRESSION_THRESHOLD_BYTES },
      (error) => {
        if (onComplete) {
          onComplete(error);
        } else if (error) {
          console.warn(`[relay] asynchronous WebSocket send failed: ${error.message}`);
        }
      },
    );
  } catch (error) {
    onComplete?.(asError(error));
    return {
      status: "send_failed",
      byteLength,
      bufferedAmount,
      projectedBufferedAmount,
      aboveHighWaterMark: projectedBufferedAmount >= highWaterMarkBytes,
      error,
    };
  }
  return {
    status: "sent",
    byteLength,
    bufferedAmount: finiteNonNegative(ws.bufferedAmount),
    projectedBufferedAmount,
    aboveHighWaterMark: projectedBufferedAmount >= highWaterMarkBytes,
  };
}

/** Waits for the ws.send callback so a stream coalescer can compensate for async write failures. */
export function sendRelayJsonWithWriteConfirmation(
  ws: WebSocket,
  message: unknown,
  highWaterMarkBytes = RELAY_WS_BACKPRESSURE_HIGH_WATER_MARK_BYTES,
  timeoutMs = RELAY_WS_WRITE_CONFIRMATION_TIMEOUT_MS,
): Promise<RelaySendResult> {
  return new Promise<RelaySendResult>((resolve) => {
    let immediate: RelaySendResult | undefined;
    let callbackCompleted = false;
    let callbackError: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const finish = (result: RelaySendResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const finishCallback = (): void => {
      if (!immediate || immediate.status !== "sent") return;
      finish(callbackError
        ? { ...immediate, status: "send_failed", error: callbackError }
        : immediate);
    };

    immediate = sendRelayJson(ws, message, highWaterMarkBytes, (error) => {
      callbackCompleted = true;
      callbackError = error;
      finishCallback();
    });
    if (immediate.status !== "sent") {
      finish(immediate);
      return;
    }
    if (callbackCompleted) {
      finishCallback();
      return;
    }
    timer = setTimeout(() => {
      finish({
        ...immediate!,
        status: "send_failed",
        error: new Error("relay_write_confirmation_timeout"),
      });
    }, positiveInteger(timeoutMs, RELAY_WS_WRITE_CONFIRMATION_TIMEOUT_MS));
  });
}

function isRecoverableStreamingSnapshot(message: unknown): boolean {
  const envelope = asRecord(message);
  if (envelope?.type !== "event") return false;
  const payload = asRecord(envelope.payload);
  const office = asRecord(payload?.office);
  const state = normalizedState(payload?.state) || normalizedState(office?.phase);
  if (envelope.event === "office") {
    const kind = normalizedState(office?.kind);
    return STREAMING_STATES.has(state)
      || (STREAMING_OFFICE_KINDS.has(kind) && state !== "final" && state !== "completed");
  }
  if (envelope.event !== "chat" && envelope.event !== "agent") return false;
  return STREAMING_STATES.has(state)
    && Array.isArray(payload?.timelineEvents)
    && payload.timelineEvents.some((candidate) => asRecord(candidate)?.eventType === "message.part.delta");
}

/**
 * Streaming snapshots carry the complete assistant text in timelineEvents.
 * Remove legacy mirrors only on that canonical path; terminal and non-chat
 * envelopes retain their existing wire shape for mixed-version clients.
 */
export function compactRelayMessageForTransport(message: unknown): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message)) return message;
  const envelope = message as Record<string, unknown>;
  if (envelope.type !== "event" || (envelope.event !== "chat" && envelope.event !== "agent")) return message;
  const payload = asRecord(envelope.payload);
  const state = normalizedState(payload?.state);
  if (!payload || !STREAMING_STATES.has(state)) return message;
  const timelineEvents = Array.isArray(payload.timelineEvents) ? payload.timelineEvents : [];
  if (!timelineEvents.some((candidate) => asRecord(candidate)?.eventType === "message.part.delta")) return message;

  const compactPayload = { ...payload };
  delete compactPayload.delta;
  delete compactPayload.text;
  compactPayload.content = nonTextContent(compactPayload.content);
  if (compactPayload.content === undefined) delete compactPayload.content;
  const messagePayload = compactTextContainer(compactPayload.message);
  if (messagePayload) compactPayload.message = messagePayload;
  else delete compactPayload.message;
  const data = asRecord(compactPayload.data);
  if (data) {
    compactPayload.data = compactTextContainer(data) ?? {};
  }
  return { ...envelope, payload: compactPayload };
}

function compactTextContainer(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const compact = { ...record };
  delete compact.delta;
  delete compact.text;
  const content = nonTextContent(compact.content);
  if (content === undefined) delete compact.content;
  else compact.content = content;
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function nonTextContent(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const retained = value.filter((block) => asRecord(block)?.type !== "text");
  return retained.length > 0 ? retained : undefined;
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

function positiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const STREAMING_STATES = new Set(["delta", "streaming", "in_progress"]);
const STREAMING_OFFICE_KINDS = new Set(["writing", "researching", "executing"]);

function normalizedState(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function disconnectRelaySocketForRecovery(ws: WebSocket, reason: string): void {
  try {
    ws.close(1013, reason);
    return;
  } catch {
    try {
      ws.terminate();
    } catch {
      // The caller still receives backpressure_disconnected and will stop
      // appending to this socket even if a test double cannot close itself.
    }
  }
}

function closeBackpressuredSocket(ws: WebSocket): void {
  disconnectRelaySocketForRecovery(ws, "relay_backpressure");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
