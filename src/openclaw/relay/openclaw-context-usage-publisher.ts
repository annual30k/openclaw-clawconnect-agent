import type { OpenClawGatewayClient } from "../gateway-client.js";
import {
  buildContextUsageFingerprint,
  canonicalizeSessionKey,
  contextUsageSnapshotFromSessionsList,
  readContextUsageSnapshot,
  type ContextUsageSnapshot,
  type GatewaySessionDefaults,
} from "./session-context.js";

export type ContextUsageEventPayload = {
  sessionKey: string;
  currentModel?: string;
  contextUsage?: number;
  contextLimit?: number;
  promptTokens?: number;
  maxInputTokens?: number;
};

export type OpenClawContextUsagePublisherOptions = {
  getGatewayClient: () => OpenClawGatewayClient | null;
  getSessionDefaults: () => GatewaySessionDefaults;
  /** 把 `context_usage` 事件送往 Relay。 */
  sendContextUsage: (payload: ContextUsageEventPayload) => void;
  warn?: (message: string) => void;
};

export type OpenClawContextUsagePublisher = {
  /** 按指纹去重后发布一条快照；`force` 时即使指纹未变也发布。 */
  emit(snapshot: ContextUsageSnapshot, force?: boolean): void;
  /** 读取并发布某会话的上下文用量；优先走网关 `sessions.list`，失败时退回本地会话文件。 */
  publish(sessionKey: string, force?: boolean): Promise<void>;
  /** 延迟合并刷新：同一会话在延迟窗口内的多次请求只触发最后一次。 */
  scheduleRefresh(sessionKey: string | undefined, delayMs?: number, force?: boolean): void;
  /** 取消所有待执行的刷新；Relay 连接关闭时调用。 */
  dispose(): void;
};

/**
 * 从 relay-manager 闭包中拆出的上下文用量发布器：
 * 指纹去重、延迟合并与数据源回退都封装在这里，依赖通过显式 getter 注入，
 * 以便在 Relay 重连（gatewayClient/sessionDefaults 变化）后继续使用同一实例。
 */
export function createOpenClawContextUsagePublisher(
  options: OpenClawContextUsagePublisherOptions,
): OpenClawContextUsagePublisher {
  const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const fingerprints = new Map<string, string>();
  const warn = options.warn ?? ((message: string) => console.warn(message));

  const normalizedSessionKey = (sessionKey: string | undefined): string | undefined => {
    if (!sessionKey) return undefined;
    const canonical = canonicalizeSessionKey(sessionKey, options.getSessionDefaults());
    const normalized = typeof canonical === "string" ? canonical.trim() : "";
    return normalized.length > 0 ? normalized : undefined;
  };

  const emit = (snapshot: ContextUsageSnapshot, force = false): void => {
    const fingerprint = buildContextUsageFingerprint(snapshot);
    if (!force && fingerprints.get(snapshot.sessionKey) === fingerprint) {
      return;
    }
    fingerprints.set(snapshot.sessionKey, fingerprint);
    options.sendContextUsage({
      sessionKey: snapshot.sessionKey,
      currentModel: snapshot.currentModel,
      contextUsage: snapshot.promptTokens ?? snapshot.contextUsage,
      contextLimit: snapshot.contextLimit,
      promptTokens: snapshot.promptTokens,
      maxInputTokens: snapshot.contextLimit,
    });
  };

  const publish = async (sessionKey: string, force = false): Promise<void> => {
    const requestedSessionKey = normalizedSessionKey(sessionKey);
    if (!requestedSessionKey) return;
    const sessionDefaults = options.getSessionDefaults();
    const gatewayClient = options.getGatewayClient();
    let snapshot: ContextUsageSnapshot | null = null;
    if (gatewayClient) {
      try {
        const sessions = await gatewayClient.request("sessions.list", {
          limit: 100,
          includeGlobal: true,
          includeUnknown: true,
        });
        snapshot = contextUsageSnapshotFromSessionsList(sessions, requestedSessionKey, sessionDefaults);
      } catch (error) {
        warn(`[relay] failed to read context usage from sessions.list: ${String(error)}`);
      }
    }
    snapshot ??= await readContextUsageSnapshot(requestedSessionKey, sessionDefaults);
    if (!snapshot) return;
    emit(snapshot, force);
  };

  const scheduleRefresh = (sessionKey: string | undefined, delayMs = 250, force = false): void => {
    const key = normalizedSessionKey(sessionKey);
    if (!key) return;
    const existing = refreshTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      refreshTimers.delete(key);
      void publish(key, force).catch((error) => {
        warn(`[relay] failed to publish context usage for session ${key}: ${String(error)}`);
      });
    }, delayMs);
    timer.unref?.();
    refreshTimers.set(key, timer);
  };

  const dispose = (): void => {
    for (const timer of refreshTimers.values()) clearTimeout(timer);
    refreshTimers.clear();
  };

  return { emit, publish, scheduleRefresh, dispose };
}
