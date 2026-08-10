import type { ChatRunContext } from "./chat-history.js";

export type OpenClawChatRunIdentity = ChatRunContext & {
  gatewayId: string;
  providerRunId: string;
  canonicalRunId: string;
};

type StoredOpenClawChatRunIdentity = OpenClawChatRunIdentity & {
  terminal?: boolean;
  accumulatedText: string;
};

export const OPENCLAW_CHAT_RUN_IDENTITY_MAX_ENTRIES = 2_048;

/**
 * OpenClaw 的 provider runId 只负责关联 Gateway 事件；移动端幂等键才是跨 Relay
 * 重连仍然有效的对外身份。累计正文与身份共用同一进程级、LRU 有界生命周期；新的
 * provider command response 是运行代际边界，即使 provider 重用了 runId，也不会继承
 * 上一轮 terminal 状态。
 */
export class OpenClawChatRunIdentityRegistry {
  private readonly identitiesByProvider = new Map<string, StoredOpenClawChatRunIdentity>();
  private readonly providerRunsByCanonical = new Map<string, string>();

  constructor(private readonly maxEntries = OPENCLAW_CHAT_RUN_IDENTITY_MAX_ENTRIES) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("openclaw_chat_run_identity_limit_invalid");
    }
  }

  /** Starts a new authoritative provider run generation. */
  register(identity: OpenClawChatRunIdentity): void {
    const gatewayId = identity.gatewayId.trim();
    const providerRunId = identity.providerRunId.trim();
    const canonicalRunId = identity.canonicalRunId.trim();
    if (!gatewayId || !providerRunId || !canonicalRunId) {
      return;
    }
    const identityKey = this.key(gatewayId, providerRunId);
    this.removeCanonicalMapping(this.identitiesByProvider.get(identityKey));
    this.identitiesByProvider.delete(identityKey);
    this.identitiesByProvider.set(identityKey, {
      ...identity,
      gatewayId,
      providerRunId,
      canonicalRunId,
      accumulatedText: "",
    });
    this.providerRunsByCanonical.set(this.key(gatewayId, canonicalRunId), providerRunId);
    this.prune();
  }

  /** Registers event-only runs without resetting a generation already in flight. */
  ensure(identity: OpenClawChatRunIdentity): OpenClawChatRunIdentity | undefined {
    const existing = this.resolve(identity.gatewayId, identity.providerRunId);
    if (existing) return existing;
    this.register(identity);
    return this.resolve(identity.gatewayId, identity.providerRunId);
  }

  resolve(gatewayId: string, providerRunId: string): OpenClawChatRunIdentity | undefined {
    const key = this.key(gatewayId.trim(), providerRunId.trim());
    const stored = this.touch(key);
    return stored ? this.publicIdentity(stored) : undefined;
  }

  resolveProviderRunId(gatewayId: string, canonicalRunId: string): string | undefined {
    return this.providerRunsByCanonical.get(this.key(gatewayId.trim(), canonicalRunId.trim()));
  }

  markTerminal(gatewayId: string, providerRunId: string): void {
    const key = this.key(gatewayId.trim(), providerRunId.trim());
    const identity = this.touch(key);
    if (identity) identity.terminal = true;
  }

  isTerminal(gatewayId: string, providerRunId: string): boolean {
    return this.touch(this.key(gatewayId.trim(), providerRunId.trim()))?.terminal === true;
  }

  accumulatedText(gatewayId: string, providerRunId: string): string {
    return this.touch(this.key(gatewayId.trim(), providerRunId.trim()))?.accumulatedText ?? "";
  }

  setAccumulatedText(gatewayId: string, providerRunId: string, text: string): void {
    const identity = this.touch(this.key(gatewayId.trim(), providerRunId.trim()));
    if (identity) identity.accumulatedText = text;
  }

  clearTransient(gatewayId: string, providerRunId: string): void {
    const identity = this.touch(this.key(gatewayId.trim(), providerRunId.trim()));
    if (!identity) return;
    identity.accumulatedText = "";
    identity.promptText = undefined;
  }

  remove(gatewayId: string, providerRunId: string): void {
    const key = this.key(gatewayId.trim(), providerRunId.trim());
    const identity = this.identitiesByProvider.get(key);
    this.removeCanonicalMapping(identity);
    this.identitiesByProvider.delete(key);
  }

  clear(): void {
    this.identitiesByProvider.clear();
    this.providerRunsByCanonical.clear();
  }

  private key(gatewayId: string, providerRunId: string): string {
    return `${gatewayId}\u0000${providerRunId}`;
  }

  private touch(key: string): StoredOpenClawChatRunIdentity | undefined {
    const identity = this.identitiesByProvider.get(key);
    if (!identity) return undefined;
    this.identitiesByProvider.delete(key);
    this.identitiesByProvider.set(key, identity);
    return identity;
  }

  private prune(): void {
    while (this.identitiesByProvider.size > this.maxEntries) {
      const oldestKey = this.identitiesByProvider.keys().next().value as string | undefined;
      if (!oldestKey) return;
      const identity = this.identitiesByProvider.get(oldestKey);
      this.removeCanonicalMapping(identity);
      this.identitiesByProvider.delete(oldestKey);
    }
  }

  private removeCanonicalMapping(identity: StoredOpenClawChatRunIdentity | undefined): void {
    if (!identity) return;
    const canonicalKey = this.key(identity.gatewayId, identity.canonicalRunId);
    if (this.providerRunsByCanonical.get(canonicalKey) === identity.providerRunId) {
      this.providerRunsByCanonical.delete(canonicalKey);
    }
  }

  private publicIdentity(identity: StoredOpenClawChatRunIdentity): OpenClawChatRunIdentity {
    const {
      terminal: _terminal,
      accumulatedText: _accumulatedText,
      ...publicIdentity
    } = identity;
    return publicIdentity;
  }
}

export function normalizeOpenClawMobileRunId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return value.trim().replace(/:(?:user|assistant|tool|system)$/i, "") || undefined;
}

export function resolveExplicitMobileRunIdFromChatPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const message = record.message && typeof record.message === "object" && !Array.isArray(record.message)
    ? record.message as Record<string, unknown>
    : undefined;
  return normalizeOpenClawMobileRunId(record.idempotencyKey)
    ?? normalizeOpenClawMobileRunId(record.clientRunId)
    ?? normalizeOpenClawMobileRunId(message?.idempotencyKey)
    ?? normalizeOpenClawMobileRunId(message?.clientRunId);
}

export function canonicalizeOpenClawChatSendResult(result: unknown, canonicalRunId: string): Record<string, unknown> {
  const record = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  return {
    ...record,
    runId: canonicalRunId,
  };
}

export function restoreOpenClawProviderRunIdForCommand(
  method: string,
  params: unknown,
  gatewayId: string,
  registry: OpenClawChatRunIdentityRegistry,
): unknown {
  if (method !== "chat.abort" || !params || typeof params !== "object" || Array.isArray(params)) {
    return params;
  }
  const record = params as Record<string, unknown>;
  const canonicalRunId = normalizeOpenClawMobileRunId(record.runId);
  if (!canonicalRunId) {
    return params;
  }
  const providerRunId = registry.resolveProviderRunId(gatewayId, canonicalRunId);
  return providerRunId
    ? { ...record, runId: providerRunId }
    : params;
}

export const openClawChatRunIdentities = new OpenClawChatRunIdentityRegistry();
