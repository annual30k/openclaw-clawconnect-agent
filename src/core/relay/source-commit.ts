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

export type SourceCommitObserverOptions<TCursor extends SourceCommit = SourceCommit> = {
  readCursor: SourceCommitCursorReader<TCursor> | (() => Promise<TCursor | null>);
  onCommit: (commit: TCursor, previousCommittedThroughSeq: number | undefined) => void | Promise<void>;
  onError?: (error: unknown) => void;
  initialWatermarkMode?: "latest" | "from_zero";
};

/**
 * Serializes notifications and only emits a strictly advancing cursor for a
 * source scope.  Notifications are hints; the reader is authoritative.  A
 * generation change creates a new scope, so a restarted transcript can start
 * at sequence zero without being mistaken for an old cursor.
 */
export function createSourceCommitObserver<TCursor extends SourceCommit = SourceCommit>(
  options: SourceCommitObserverOptions<TCursor>,
) {
  let closed = false;
  let running = false;
  let pending = false;
  let initialWatermarkPending = options.initialWatermarkMode === "latest";
  const latestByScope = new Map<string, number>();

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
        if (initialWatermarkPending) {
          initialWatermarkPending = false;
          if (cursor) {
            const scope = sourceCommitScope(cursor);
            latestByScope.set(scope, cursor.committedThroughSeq);
            continue;
          }
        }
        if (!cursor) continue;
        const scope = sourceCommitScope(cursor);
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
