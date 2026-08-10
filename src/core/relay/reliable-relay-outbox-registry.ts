import { resolve } from "node:path";

import { normalizeRelayServerIdentity } from "./file-upload-utils.js";
import { ReliableRelayOutbox } from "./reliable-relay-outbox.js";
import { reliableRelayOutboxStorageDirectory } from "./reliable-relay-outbox-store.js";

export const RELIABLE_RELAY_OUTBOX_MAX_GATEWAYS = 64;

export type ReliableRelayOutboxLookupResult =
  | { status: "ready"; outbox: ReliableRelayOutbox }
  | {
    status: "rejected";
    reason: "gateway_id_required" | "relay_identity_required" | "gateway_limit_reached" | "storage_unavailable";
    error: Error;
  };

const outboxesByNamespace = new Map<string, ReliableRelayOutbox>();

/**
 * Relay、profile 存储目录和 gateway 共同定义唯一队列，禁止跨 Relay 误重放。
 */
export function reliableRelayOutboxForGateway(
  gatewayId: string,
  options: { storageDirectory?: string; relayIdentity?: string } = {},
): ReliableRelayOutboxLookupResult {
  const normalized = typeof gatewayId === "string" ? gatewayId.trim() : "";
  if (!normalized) {
    return rejectedLookup("gateway_id_required", "reliable_relay_gateway_id_required");
  }
  const relayIdentity = options.relayIdentity?.trim();
  if (!relayIdentity) {
    return rejectedLookup("relay_identity_required", "reliable_relay_relay_identity_required");
  }
  let canonicalRelayIdentity: string;
  try {
    canonicalRelayIdentity = normalizeRelayServerIdentity(relayIdentity);
  } catch (value) {
    return rejectedLookup("relay_identity_required", `reliable_relay_relay_identity_invalid: ${asError(value).message}`);
  }
  const storageDirectory = options.storageDirectory ?? reliableRelayOutboxStorageDirectory();
  const registryKey = `${resolve(storageDirectory)}\u0000${canonicalRelayIdentity}\u0000${normalized}`;
  const existing = outboxesByNamespace.get(registryKey);
  if (existing) {
    outboxesByNamespace.delete(registryKey);
    outboxesByNamespace.set(registryKey, existing);
    return { status: "ready", outbox: existing };
  }
  pruneIdleOutboxes();
  if (outboxesByNamespace.size >= RELIABLE_RELAY_OUTBOX_MAX_GATEWAYS) {
    return rejectedLookup("gateway_limit_reached", "reliable_relay_gateway_outbox_limit_reached");
  }
  let created: ReliableRelayOutbox;
  try {
    created = new ReliableRelayOutbox(normalized, {
      storageDirectory,
      relayIdentity: canonicalRelayIdentity,
    });
  } catch (value) {
    const error = asError(value);
    return rejectedLookup("storage_unavailable", `reliable_relay_outbox_storage_unavailable: ${error.message}`);
  }
  outboxesByNamespace.set(registryKey, created);
  return { status: "ready", outbox: created };
}

export function clearReliableRelayOutboxesForTests(): void {
  disposeReliableRelayOutboxes();
}

export function disposeReliableRelayOutboxes(): void {
  for (const outbox of outboxesByNamespace.values()) outbox.dispose();
  outboxesByNamespace.clear();
}

function rejectedLookup(
  reason: Extract<ReliableRelayOutboxLookupResult, { status: "rejected" }>["reason"],
  message: string,
): ReliableRelayOutboxLookupResult {
  const error = new Error(message);
  console.warn(`[relay] reliable outbox unavailable: ${message}`);
  return { status: "rejected", reason, error };
}

function pruneIdleOutboxes(): void {
  if (outboxesByNamespace.size < RELIABLE_RELAY_OUTBOX_MAX_GATEWAYS) return;
  for (const [namespace, outbox] of outboxesByNamespace) {
    // 在线连接即使暂时为空也仍拥有该队列，不能为了容量回收关闭其持久化存储。
    if (outbox.isIdleForRegistryEviction) {
      outbox.dispose();
      outboxesByNamespace.delete(namespace);
      if (outboxesByNamespace.size < RELIABLE_RELAY_OUTBOX_MAX_GATEWAYS) return;
    }
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
