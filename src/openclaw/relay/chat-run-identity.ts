import type { ChatRunContext } from "./chat-history.js";

export type OpenClawChatRunIdentity = ChatRunContext & {
  gatewayId: string;
  providerRunId: string;
  canonicalRunId: string;
};

/**
 * OpenClaw 的 provider runId 只负责关联 Gateway 事件；移动端幂等键才是跨 Relay
 * 重连仍然有效的对外身份。该注册表位于连接实例之外，并按显式运行身份保留到进程结束，
 * 避免长运行或迟到事件因时间窗口、容量淘汰而退化为 provider 身份。
 */
export class OpenClawChatRunIdentityRegistry {
  private readonly identitiesByProvider = new Map<string, OpenClawChatRunIdentity>();
  private readonly providerRunsByCanonical = new Map<string, string>();

  register(identity: OpenClawChatRunIdentity): void {
    const gatewayId = identity.gatewayId.trim();
    const providerRunId = identity.providerRunId.trim();
    const canonicalRunId = identity.canonicalRunId.trim();
    if (!gatewayId || !providerRunId || !canonicalRunId) {
      return;
    }
    this.identitiesByProvider.set(this.key(gatewayId, providerRunId), {
      ...identity,
      gatewayId,
      providerRunId,
      canonicalRunId,
    });
    this.providerRunsByCanonical.set(this.key(gatewayId, canonicalRunId), providerRunId);
  }

  resolve(gatewayId: string, providerRunId: string): OpenClawChatRunIdentity | undefined {
    return this.identitiesByProvider.get(this.key(gatewayId.trim(), providerRunId.trim()));
  }

  resolveProviderRunId(gatewayId: string, canonicalRunId: string): string | undefined {
    return this.providerRunsByCanonical.get(this.key(gatewayId.trim(), canonicalRunId.trim()));
  }

  clear(): void {
    this.identitiesByProvider.clear();
    this.providerRunsByCanonical.clear();
  }

  private key(gatewayId: string, providerRunId: string): string {
    return `${gatewayId}\u0000${providerRunId}`;
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
