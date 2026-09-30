/**
 * A source commit is a durable-source watermark, not a message identity.
 *
 * The producer owns the order scope and cursor.  Relay may use this value to
 * request/reconcile a source snapshot, but it must never use it as a message
 * id, dedupe key, or UI sort key.
 */
export type SourceCommitGateway = "openclaw" | "hermes";

export type SourceCommit = {
  projectionVersion: 3;
  gatewayType: SourceCommitGateway;
  gatewayId: string;
  producerId: string;
  sourceSessionId: string;
  sourceOrderScope: string;
  sourceGeneration: string;
  committedThroughSeq: number;
  sourceRevision: string;
};

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Source commit is missing ${field}`);
  }
  return value.trim();
}

export function createSourceCommit(input: Omit<SourceCommit, "projectionVersion">): SourceCommit {
  if (!Number.isSafeInteger(input.committedThroughSeq) || input.committedThroughSeq < 0) {
    throw new Error("Source commit committedThroughSeq must be a non-negative integer");
  }
  return {
    projectionVersion: 3,
    gatewayType: input.gatewayType,
    gatewayId: required(input.gatewayId, "gatewayId"),
    producerId: required(input.producerId, "producerId"),
    sourceSessionId: required(input.sourceSessionId, "sourceSessionId"),
    sourceOrderScope: required(input.sourceOrderScope, "sourceOrderScope"),
    sourceGeneration: required(input.sourceGeneration, "sourceGeneration"),
    committedThroughSeq: input.committedThroughSeq,
    sourceRevision: required(input.sourceRevision, "sourceRevision"),
  };
}

export function sourceCommitScope(commit: Pick<SourceCommit, "gatewayId" | "gatewayType" | "producerId" | "sourceSessionId" | "sourceOrderScope" | "sourceGeneration">): string {
  return [
    commit.gatewayType,
    commit.gatewayId,
    commit.producerId,
    commit.sourceSessionId,
    commit.sourceOrderScope,
    commit.sourceGeneration,
  ].join("\u0000");
}

export function isSourceCommit(value: unknown): value is SourceCommit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.projectionVersion === 3
    && (record.gatewayType === "openclaw" || record.gatewayType === "hermes")
    && typeof record.gatewayId === "string"
    && typeof record.producerId === "string"
    && typeof record.sourceSessionId === "string"
    && typeof record.sourceOrderScope === "string"
    && typeof record.sourceGeneration === "string"
    && Number.isSafeInteger(record.committedThroughSeq)
    && (record.committedThroughSeq as number) >= 0
    && typeof record.sourceRevision === "string";
}

export type SourceCommitCursorReader<TCursor extends SourceCommit = SourceCommit> = () => TCursor | null | Promise<TCursor | null>;

/**
 * 解析某个源作用域的续传起点：返回下游（Relay）已持久化的水位；`undefined`
 * 表示下游没有该作用域的任何投影，需要从序号 0 开始补齐。解析失败必须抛错，
 * 观察者不会在起点未知时猜测或发布任何投影。
 */
export type SourceCommitWatermarkResolver<TCursor extends SourceCommit = SourceCommit> = (
  cursor: TCursor,
) => Promise<number | undefined>;

export type SourceCommitObserverOptions<TCursor extends SourceCommit = SourceCommit> = {
  readCursor: SourceCommitCursorReader<TCursor> | (() => Promise<TCursor | null>);
  onCommit: (commit: TCursor, previousCommittedThroughSeq: number | undefined) => void | Promise<void>;
  onError?: (error: unknown) => void;
  /** 缺省时每个作用域都从序号 0 开始投影。 */
  resolveInitialWatermark?: SourceCommitWatermarkResolver<TCursor>;
};

/**
 * Serializes notifications and only emits a strictly advancing cursor for a
 * source scope.  Notifications are hints; the reader is authoritative.  A
 * generation change creates a new scope, so a restarted transcript can start
 * at sequence zero without being mistaken for an old cursor.
 *
 * 每个作用域第一次出现时先解析续传起点（通常是 Relay 已落库的水位），之后只投影
 * 起点之后的增量。这样重连不会把整段历史重新推给 Relay，也不会漏掉断线期间写入
 * 的源行：起点来自下游的持久化事实，而不是本地“当前最新”这种时间点快照。
 */
export function createSourceCommitObserver<TCursor extends SourceCommit = SourceCommit>(
  options: SourceCommitObserverOptions<TCursor>,
) {
  let closed = false;
  let running = false;
  let pending = false;
  const resolveInitialWatermark: SourceCommitWatermarkResolver<TCursor> = options.resolveInitialWatermark
    ?? (async () => undefined);
  const latestByScope = new Map<string, number>();
  // 已确定续传起点的作用域；起点为“从零开始”时不会出现在 latestByScope 中。
  const resolvedScopes = new Set<string>();

  const drain = async (): Promise<void> => {
    if (closed || running) return;
    running = true;
    try {
      do {
        pending = false;
        let cursor: TCursor | null;
        try {
          cursor = await options.readCursor();
        } catch (error) {
          options.onError?.(error);
          continue;
        }
        if (!cursor) continue;
        const scope = sourceCommitScope(cursor);
        if (!resolvedScopes.has(scope)) {
          let resolvedWatermark: number | undefined;
          try {
            resolvedWatermark = await resolveInitialWatermark(cursor);
          } catch (error) {
            // 起点未知时不投影任何行；下一次源通知或周期重扫会再次解析同一作用域。
            options.onError?.(error);
            continue;
          }
          if (closed) return;
          if (
            resolvedWatermark !== undefined
            && (!Number.isSafeInteger(resolvedWatermark) || resolvedWatermark < 0)
          ) {
            options.onError?.(new Error(`Source commit watermark is invalid: ${String(resolvedWatermark)}`));
            continue;
          }
          if (resolvedWatermark !== undefined) latestByScope.set(scope, resolvedWatermark);
          resolvedScopes.add(scope);
        }
        const previous = latestByScope.get(scope);
        if (previous !== undefined && cursor.committedThroughSeq <= previous) continue;
        try {
          await options.onCommit(cursor, previous);
          // Advance only after the downstream durable append/broadcast path
          // succeeds. A failed send must be retried by the next notification
          // or startup rescan, rather than being silently acknowledged.
          latestByScope.set(scope, cursor.committedThroughSeq);
        } catch (error) {
          // Do not spin or introduce a timer as a retry mechanism. The next
          // source notification/reconnect rescan will retry the same cursor.
          options.onError?.(error);
        }
      } while (pending && !closed);
    } finally {
      running = false;
    }
  };

  return {
    notify(): void {
      if (closed) return;
      pending = true;
      void drain();
    },
    /** Read immediately during startup/reconnect; no timer is used. */
    rescan(): void {
      this.notify();
    },
    close(): void {
      closed = true;
      pending = false;
    },
    lastCommittedThroughSeq(cursor: Pick<SourceCommit, "gatewayId" | "gatewayType" | "producerId" | "sourceSessionId" | "sourceOrderScope" | "sourceGeneration">): number | undefined {
      return latestByScope.get(sourceCommitScope(cursor));
    },
  };
}
