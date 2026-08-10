import { createHash } from "node:crypto";
import { WebSocket } from "ws";

import {
  compactRelayMessageForTransport,
  disconnectRelaySocketForRecovery,
  sendRelayJson,
} from "./relay-server-connection.js";
import type { RelayReliableDeliveryMode } from "./reliable-delivery-protocol.js";
import {
  FileReliableRelayOutboxStore,
  type ReliableRelayOutboxStore,
  type StoredReliableRelayOutboxEntry,
} from "./reliable-relay-outbox-store.js";

export const RELIABLE_RELAY_OUTBOX_MAX_ENTRIES = 1_024;
export const RELIABLE_RELAY_OUTBOX_MAX_BYTES = 64 * 1024 * 1024;
export const RELIABLE_RELAY_ACK_TIMEOUT_MS = 30_000;
export const RELIABLE_RELAY_OUTBOX_STORAGE_SCOPE = "profile_relay_gateway_disk" as const;
// Keep these in sync with Relay host-server validation. Rejecting locally avoids
// retaining a frame forever when Relay can never produce an ACK for it.
export const RELIABLE_RELAY_EVENT_DELIVERY_ID_MAX_LENGTH = 128;
export const RELIABLE_RELAY_RESPONSE_ID_MAX_LENGTH = 191;

type TimerHandle = ReturnType<typeof setTimeout>;
type DeliveryMode = "event_ack" | "response_ack";

type OutboxEntry = {
  key: string;
  message: unknown;
  byteLength: number;
  contentHash: string;
  mode: DeliveryMode;
  deliveryId?: string;
  sentSocket?: WebSocket;
  sentAt?: number;
  attempt: number;
};

type OutboxConnection = {
  socket: WebSocket;
  deliveryMode: RelayReliableDeliveryMode;
};

export type ReliableRelayOutboxEnqueueResult =
  | { status: "not_reliable" }
  | { status: "accepted"; key: string; duplicate: boolean }
  | {
    status: "rejected";
    reason: "outbox_full" | "invalid_message" | "storage_unavailable";
    error: Error;
  };

export type ReliableRelayOutboxOptions = {
  maxEntries?: number;
  maxBytes?: number;
  ackTimeoutMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  onError?: (error: Error) => void;
  storage?: ReliableRelayOutboxStore;
  storageDirectory?: string;
  relayIdentity?: string;
};

/**
 * 按 profile/gateway 隔离的可靠投递队列；生产工厂先同步落盘，Agent 重启后恢复。
 * ACK 模式保留原始 envelope 直到 Relay 回执，legacy 模式只保留到 ws.send callback 成功。
 */
export class ReliableRelayOutbox {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ackTimeoutMs: number;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<ReliableRelayOutboxOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<ReliableRelayOutboxOptions["clearTimer"]>;
  private readonly onError?: (error: Error) => void;
  private readonly storage?: ReliableRelayOutboxStore;
  private readonly entries = new Map<string, OutboxEntry>();
  private connection?: OutboxConnection;
  private sending?: { key: string; socket: WebSocket; attempt: number };
  private ackTimer?: TimerHandle;
  private totalBytes = 0;

  constructor(
    private readonly gatewayId: string,
    options: ReliableRelayOutboxOptions = {},
  ) {
    this.maxEntries = positiveInteger(options.maxEntries, RELIABLE_RELAY_OUTBOX_MAX_ENTRIES);
    this.maxBytes = positiveInteger(options.maxBytes, RELIABLE_RELAY_OUTBOX_MAX_BYTES);
    this.ackTimeoutMs = positiveInteger(options.ackTimeoutMs, RELIABLE_RELAY_ACK_TIMEOUT_MS);
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    });
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onError = options.onError;
    if (options.storageDirectory && !options.relayIdentity?.trim()) {
      throw new Error("reliable_relay_outbox_relay_identity_required");
    }
    this.storage = options.storage ?? (options.storageDirectory
      ? new FileReliableRelayOutboxStore({
        directory: options.storageDirectory,
        gatewayId,
        relayIdentity: options.relayIdentity!,
        onMaintenanceError: (error) => this.report(error),
      })
      : undefined);
    try {
      for (const stored of this.storage?.load() ?? []) this.restore(stored);
    } catch (error) {
      this.storage?.close();
      throw error;
    }
  }

  attach(socket: WebSocket, deliveryMode: RelayReliableDeliveryMode): void {
    if (this.sending && this.sending.socket !== socket) {
      const entry = this.entries.get(this.sending.key);
      if (entry) entry.sentSocket = undefined;
      this.sending = undefined;
    }
    this.cancelAckTimer();
    this.connection = { socket, deliveryMode };
    this.flush();
  }

  detach(socket: WebSocket): void {
    if (this.connection?.socket === socket) {
      this.connection = undefined;
      this.cancelAckTimer();
    }
    if (this.sending?.socket === socket) {
      const entry = this.entries.get(this.sending.key);
      if (entry) entry.sentSocket = undefined;
      this.sending = undefined;
    }
  }

  enqueueIfReliable(message: unknown): ReliableRelayOutboxEnqueueResult {
    try {
      const terminal = buildAcknowledgedTerminalEnvelope(this.gatewayId, message);
      if (terminal) {
        return this.enqueue({
          key: `event_ack:${terminal.deliveryId}`,
          message: terminal.message,
          mode: "event_ack",
          deliveryId: terminal.deliveryId,
        });
      }

      const controlKey = reliableControlKey(message);
      if (controlKey) {
        return this.enqueue({ key: controlKey, message, mode: "response_ack" });
      }
      return { status: "not_reliable" };
    } catch (value) {
      const error = asError(value);
      this.report(error);
      return { status: "rejected", reason: "invalid_message", error };
    }
  }

  acknowledge(deliveryId: string): boolean {
    if (this.connection?.deliveryMode !== "acknowledged") return false;
    const normalized = deliveryId.trim();
    if (!normalized) return false;
    const key = `event_ack:${normalized}`;
    const entry = this.entries.get(key);
    if (!entry || entry.mode !== "event_ack") return false;
    return this.remove(key, entry);
  }

  acknowledgeResponse(requestId: string, responsePhase?: string): boolean {
    if (this.connection?.deliveryMode !== "acknowledged") return false;
    const id = requestId;
    if (!id.trim()) return false;
    const phase = responsePhase?.trim() || "response";
    const key = `response_ack:${id}:${phase}`;
    const entry = this.entries.get(key);
    if (!entry || entry.mode !== "response_ack") return false;
    return this.remove(key, entry);
  }

  clear(): void {
    this.cancelAckTimer();
    this.sending = undefined;
    this.connection = undefined;
    for (const [key, entry] of [...this.entries]) this.remove(key, entry, false);
  }

  /** Releases file handles/ownership without deleting unacknowledged entries. */
  dispose(): void {
    this.cancelAckTimer();
    this.sending = undefined;
    this.connection = undefined;
    this.storage?.close();
  }

  get pendingCount(): number {
    return this.entries.size;
  }

  get pendingAckCount(): number {
    return Array.from(this.entries.values()).filter((entry) => entry.sentSocket !== undefined).length;
  }

  get pendingBytes(): number {
    return this.totalBytes;
  }

  get isIdleForRegistryEviction(): boolean {
    return this.entries.size === 0
      && this.connection === undefined
      && this.sending === undefined
      && this.ackTimer === undefined;
  }

  private enqueue(
    input: Omit<OutboxEntry, "byteLength" | "contentHash" | "attempt">,
  ): ReliableRelayOutboxEnqueueResult {
    const snapshot = snapshotRelayMessage(input.message);
    const existing = this.entries.get(input.key);
    if (existing) {
      if (existing.contentHash !== snapshot.contentHash) {
        const error = new Error(`reliable_relay_duplicate_content_mismatch key=${input.key}`);
        this.report(error);
        return { status: "rejected", reason: "invalid_message", error };
      }
      return { status: "accepted", key: input.key, duplicate: true };
    }
    const { byteLength } = snapshot;
    if (this.entries.size >= this.maxEntries || this.totalBytes + byteLength > this.maxBytes) {
      const error = new Error(`reliable_relay_outbox_full gatewayId=${this.gatewayId}`);
      this.report(error);
      return { status: "rejected", reason: "outbox_full", error };
    }
    const entry: OutboxEntry = {
      ...input,
      message: snapshot.message,
      byteLength,
      contentHash: snapshot.contentHash,
      attempt: 0,
    };
    try {
      this.storage?.put(storedEntry(entry));
    } catch (value) {
      const error = asError(value);
      this.report(error);
      return { status: "rejected", reason: "storage_unavailable", error };
    }
    this.entries.set(entry.key, entry);
    this.totalBytes += byteLength;
    this.flush();
    return { status: "accepted", key: entry.key, duplicate: false };
  }

  private flush(): void {
    const connection = this.connection;
    if (this.sending || !connection || connection.socket.readyState !== WebSocket.OPEN) return;
    const { socket } = connection;
    const entry = Array.from(this.entries.values()).find((candidate) => candidate.sentSocket !== socket);
    if (!entry) {
      this.scheduleAckHealthCheck();
      return;
    }

    entry.attempt += 1;
    const attempt = entry.attempt;
    this.sending = { key: entry.key, socket, attempt };
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      const current = this.entries.get(entry.key);
      const isCurrentAttempt = current?.attempt === attempt;
      if (error && isCurrentAttempt) {
        if (current) {
          current.sentSocket = undefined;
          current.sentAt = undefined;
        }
        if (this.connection?.socket === socket) {
          this.connection = undefined;
          this.cancelAckTimer();
        }
        this.report(error);
        disconnectRelaySocketForRecovery(socket, "reliable_write_failed");
      } else if (!error && current && isCurrentAttempt) {
        if (connection.deliveryMode === "legacy_write_confirmed") {
          if (!this.remove(entry.key, current, false)) {
            disconnectRelaySocketForRecovery(socket, "reliable_storage_failed");
          }
        } else {
          current.sentSocket = socket;
          current.sentAt = this.now();
        }
      }
      if (
        this.sending?.key === entry.key
        && this.sending.socket === socket
        && this.sending.attempt === attempt
      ) {
        this.sending = undefined;
      }
      this.scheduleAckHealthCheck();
      this.flush();
    };

    const result = sendRelayJson(socket, entry.message, undefined, settle);
    if (result.status !== "sent") {
      settle(result.error instanceof Error
        ? result.error
        : new Error(`reliable_relay_send_${result.status}`));
    }
  }

  private remove(key: string, entry: OutboxEntry, flush = true): boolean {
    if (this.entries.get(key) !== entry) return false;
    try {
      this.storage?.remove(key);
    } catch (value) {
      const error = asError(value);
      this.report(error);
      const socket = this.connection?.socket;
      this.connection = undefined;
      this.cancelAckTimer();
      if (socket) disconnectRelaySocketForRecovery(socket, "reliable_storage_failed");
      return false;
    }
    this.entries.delete(key);
    this.totalBytes = Math.max(0, this.totalBytes - entry.byteLength);
    this.scheduleAckHealthCheck();
    if (flush) this.flush();
    return true;
  }

  private restore(stored: StoredReliableRelayOutboxEntry): void {
    const snapshot = snapshotRelayMessage(stored.message);
    if (snapshot.byteLength !== stored.byteLength || snapshot.contentHash !== stored.contentHash) {
      throw new Error(`reliable_outbox_store_content_mismatch key=${stored.key}`);
    }
    if (stored.mode === "event_ack") {
      const terminal = buildAcknowledgedTerminalEnvelope(this.gatewayId, snapshot.message);
      if (!terminal || stored.deliveryId !== terminal.deliveryId || stored.key !== `event_ack:${terminal.deliveryId}`) {
        throw new Error(`reliable_outbox_store_invalid_event key=${stored.key}`);
      }
    } else if (reliableControlKey(snapshot.message) !== stored.key || stored.deliveryId !== undefined) {
      throw new Error(`reliable_outbox_store_invalid_response key=${stored.key}`);
    }
    if (this.entries.has(stored.key)) {
      throw new Error(`reliable_outbox_store_duplicate_key key=${stored.key}`);
    }
    if (this.entries.size >= this.maxEntries || this.totalBytes + stored.byteLength > this.maxBytes) {
      throw new Error(`reliable_outbox_store_limit_exceeded gatewayId=${this.gatewayId}`);
    }
    this.entries.set(stored.key, {
      ...stored,
      message: snapshot.message,
      attempt: 0,
    });
    this.totalBytes += stored.byteLength;
  }

  private scheduleAckHealthCheck(): void {
    this.cancelAckTimer();
    const connection = this.connection;
    if (!connection || connection.deliveryMode !== "acknowledged") return;
    const sentEntries = Array.from(this.entries.values()).filter((entry) => (
      entry.sentSocket === connection.socket && entry.sentAt !== undefined
    ));
    if (sentEntries.length === 0) return;
    const oldestSentAt = Math.min(...sentEntries.map((entry) => entry.sentAt!));
    const delayMs = Math.max(0, oldestSentAt + this.ackTimeoutMs - this.now());
    const socket = connection.socket;
    this.ackTimer = this.setTimer(() => {
      this.ackTimer = undefined;
      if (this.connection?.socket !== socket || this.connection.deliveryMode !== "acknowledged") return;
      const timedOut = Array.from(this.entries.values()).some((entry) => (
        entry.sentSocket === socket
        && entry.sentAt !== undefined
        && entry.sentAt + this.ackTimeoutMs <= this.now()
      ));
      if (!timedOut) {
        this.scheduleAckHealthCheck();
        return;
      }
      const error = new Error(`reliable_relay_ack_timeout gatewayId=${this.gatewayId}`);
      this.report(error);
      this.connection = undefined;
      disconnectRelaySocketForRecovery(socket, "reliable_ack_timeout");
      // ACK 超时只判定连接不健康；所有未确认 entry 继续留在进程内，供下一连接原样重放。
    }, delayMs);
  }

  private cancelAckTimer(): void {
    if (!this.ackTimer) return;
    this.clearTimer(this.ackTimer);
    this.ackTimer = undefined;
  }

  private report(error: Error): void {
    if (this.onError) {
      try {
        this.onError(error);
        return;
      } catch {
        // Observability callbacks cannot affect delivery ownership.
      }
    }
    console.warn(`[relay] reliable delivery deferred gatewayId=${this.gatewayId}: ${error.message}`);
  }
}

function storedEntry(entry: OutboxEntry): StoredReliableRelayOutboxEntry {
  return {
    key: entry.key,
    message: entry.message,
    byteLength: entry.byteLength,
    contentHash: entry.contentHash,
    mode: entry.mode,
    ...(entry.deliveryId ? { deliveryId: entry.deliveryId } : {}),
  };
}

function buildAcknowledgedTerminalEnvelope(
  gatewayId: string,
  message: unknown,
): { deliveryId: string; message: Record<string, unknown> } | undefined {
  const envelope = asRecord(message);
  if (envelope?.type !== "event" || (envelope.event !== "chat" && envelope.event !== "agent")) {
    return undefined;
  }
  const payload = asRecord(envelope.payload);
  const state = normalizedString(payload?.state);
  if (!TERMINAL_STATES.has(state)) return undefined;
  const timelineEvents = Array.isArray(payload?.timelineEvents) ? payload.timelineEvents : [];
  const eventIds = timelineEvents
    .map((candidate) => normalizedString(asRecord(candidate)?.eventId))
    .filter(Boolean);
  const hasCanonicalTerminal = timelineEvents.some((candidate) => (
    TERMINAL_EVENT_TYPES.has(normalizedString(asRecord(candidate)?.eventType))
  ));
  if (!hasCanonicalTerminal) return undefined;
  if (eventIds.length !== timelineEvents.length || eventIds.length === 0) {
    throw new Error("canonical_terminal_event_id_required");
  }
  const existingDeliveryId = normalizedString(envelope.deliveryId);
  if (existingDeliveryId.length > RELIABLE_RELAY_EVENT_DELIVERY_ID_MAX_LENGTH) {
    throw new Error("reliable_relay_delivery_id_too_long");
  }
  const deliveryId = existingDeliveryId || `delivery_${createHash("sha256")
    .update([gatewayId, String(envelope.event), ...eventIds].join("\u0000"))
    .digest("hex")
    .slice(0, 32)}`;
  return { deliveryId, message: { ...envelope, deliveryId } };
}

function reliableControlKey(message: unknown): string | undefined {
  const envelope = asRecord(message);
  if (envelope?.type !== "res") return undefined;
  const id = typeof envelope.id === "string" ? envelope.id : "";
  if (!id.trim()) throw new Error("reliable_relay_response_id_required");
  if (id.length > RELIABLE_RELAY_RESPONSE_ID_MAX_LENGTH) {
    throw new Error("reliable_relay_response_id_too_long");
  }
  const requestedPhase = normalizedString(envelope.responsePhase);
  if (requestedPhase && requestedPhase !== "accepted" && requestedPhase !== "terminal") {
    throw new Error("reliable_relay_response_phase_invalid");
  }
  const phase = requestedPhase || "response";
  return `response_ack:${id}:${phase}`;
}

function snapshotRelayMessage(message: unknown): {
  message: unknown;
  byteLength: number;
  contentHash: string;
} {
  const serialized = JSON.stringify(compactRelayMessageForTransport(message));
  if (serialized === undefined) throw new TypeError("relay_message_not_json_serializable");
  return {
    // Detach the queued envelope from mutable caller-owned objects so every
    // reconnect replays the exact bytes that were originally accepted.
    message: JSON.parse(serialized) as unknown,
    byteLength: Buffer.byteLength(serialized, "utf8"),
    contentHash: createHash("sha256").update(serialized).digest("hex"),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function normalizedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

const TERMINAL_STATES = new Set(["final", "error", "failed", "fail", "aborted"]);
const TERMINAL_EVENT_TYPES = new Set(["message.completed", "run.completed", "run.failed", "run.aborted"]);
