export const ASSISTANT_STREAM_COALESCE_INTERVAL_MS = 100;
export const ASSISTANT_STREAM_CLOSED_KEY_MAX_ENTRIES = 4_096;
export const ASSISTANT_STREAM_COMPENSATION_RETRY_INTERVAL_MS = 500;
export const ASSISTANT_STREAM_COMPENSATION_MAX_RETRIES = 3;

type TimerHandle = ReturnType<typeof setTimeout>;

export type AssistantStreamEmitResult =
  | { status: "delivered" }
  | { status: "retryable"; error?: unknown };

type PendingSnapshot<T> = {
  value: T;
  failedAttempts: number;
};

type SnapshotState<T> = {
  pending?: PendingSnapshot<T>;
  hasPending: boolean;
  timer?: TimerHandle;
  timerKind?: "coalesce" | "compensation";
  tail: Promise<void>;
  drainingSnapshots: boolean;
  flushRequested: boolean;
};

export type AssistantStreamIdentity = {
  sessionKey: string;
  runId: string;
  messageId?: string;
};

export type LatestSnapshotCoalescerOptions<TKey, TSnapshot> = {
  emit: (
    key: TKey,
    snapshot: TSnapshot,
  ) => void | AssistantStreamEmitResult | Promise<void | AssistantStreamEmitResult>;
  intervalMs?: number;
  compensationRetryIntervalMs?: number;
  maxCompensationRetries?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  onError?: (error: unknown, key: TKey) => void;
  maxClosedKeys?: number;
};

export function buildAssistantStreamSnapshotKey(identity: AssistantStreamIdentity): string {
  const sessionKey = identity.sessionKey.trim();
  const runId = identity.runId.trim();
  if (!sessionKey || !runId) throw new Error("assistant_stream_identity_required");
  const messageId = identity.messageId?.trim() || `assistant-${runId}`;
  return JSON.stringify([sessionKey, runId, messageId]);
}

/**
 * 每个稳定 identity 最多保留一个发送中快照和一个最新待发快照。
 * 可恢复写失败只补偿最新累计快照，次数固定有界；终态屏障会先耗尽该快照的补偿尝试。
 */
export class LatestSnapshotCoalescer<TKey, TSnapshot> {
  private readonly emit: LatestSnapshotCoalescerOptions<TKey, TSnapshot>["emit"];
  private readonly intervalMs: number;
  private readonly compensationRetryIntervalMs: number;
  private readonly maxCompensationRetries: number;
  private readonly setTimer: NonNullable<LatestSnapshotCoalescerOptions<TKey, TSnapshot>["setTimer"]>;
  private readonly clearTimer: NonNullable<LatestSnapshotCoalescerOptions<TKey, TSnapshot>["clearTimer"]>;
  private readonly onError?: LatestSnapshotCoalescerOptions<TKey, TSnapshot>["onError"];
  private readonly maxClosedKeys: number;
  private readonly states = new Map<TKey, SnapshotState<TSnapshot>>();
  private readonly closedKeys = new Map<TKey, true>();
  private disposed = false;

  constructor(options: LatestSnapshotCoalescerOptions<TKey, TSnapshot>) {
    this.emit = options.emit;
    this.intervalMs = positiveFinite(options.intervalMs, ASSISTANT_STREAM_COALESCE_INTERVAL_MS);
    this.compensationRetryIntervalMs = positiveFinite(
      options.compensationRetryIntervalMs,
      ASSISTANT_STREAM_COMPENSATION_RETRY_INTERVAL_MS,
    );
    this.maxCompensationRetries = nonNegativeInteger(
      options.maxCompensationRetries,
      ASSISTANT_STREAM_COMPENSATION_MAX_RETRIES,
    );
    this.setTimer = options.setTimer ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    });
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onError = options.onError;
    this.maxClosedKeys = options.maxClosedKeys ?? ASSISTANT_STREAM_CLOSED_KEY_MAX_ENTRIES;
    if (!Number.isInteger(this.maxClosedKeys) || this.maxClosedKeys <= 0) {
      throw new Error("snapshot_closed_key_limit_invalid");
    }
  }

  schedule(key: TKey, snapshot: TSnapshot): boolean {
    if (this.disposed || this.isClosed(key)) return false;
    const state = this.stateFor(key);
    state.pending = { value: snapshot, failedAttempts: 0 };
    state.hasPending = true;
    if (state.timerKind === "compensation") {
      this.cancelTimer(state);
    }
    if (state.timer || state.drainingSnapshots) return true;
    this.scheduleDrain(key, state, this.intervalMs, "coalesce");
    return true;
  }

  flush(key: TKey): Promise<void> {
    const state = this.states.get(key);
    if (!state) return Promise.resolve();
    this.cancelTimer(state);
    return this.flushState(key, state);
  }

  flushThen(key: TKey, operation: () => void | Promise<void>): Promise<void> {
    return this.flushThenInternal(key, operation, false);
  }

  closeAfterFlush(key: TKey, operation: () => void | Promise<void>): Promise<void> {
    return this.flushThenInternal(key, operation, true);
  }

  clear(key: TKey): void {
    const state = this.states.get(key);
    if (!state) return;
    this.cancelTimer(state);
    state.pending = undefined;
    state.hasPending = false;
    this.cleanupWhenIdle(key, state);
  }

  releaseClosed(key: TKey): void {
    this.closedKeys.delete(key);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const state of this.states.values()) {
      this.cancelTimer(state);
      state.pending = undefined;
      state.hasPending = false;
    }
    this.states.clear();
    this.closedKeys.clear();
  }

  get pendingCount(): number {
    let count = 0;
    for (const state of this.states.values()) {
      if (state.hasPending) count += 1;
    }
    return count;
  }

  private flushThenInternal(
    key: TKey,
    operation: () => void | Promise<void>,
    close: boolean,
  ): Promise<void> {
    if (close) this.rememberClosed(key);
    const state = this.stateFor(key);
    this.cancelTimer(state);
    const result = this.flushState(key, state).then(operation);
    const guarded = result.catch((error) => {
      this.reportError(error, key);
    });
    state.tail = guarded;
    void guarded.then(() => this.cleanupWhenIdle(key, state, guarded));
    return result;
  }

  private flushState(key: TKey, state: SnapshotState<TSnapshot>): Promise<void> {
    state.flushRequested = true;
    if (state.drainingSnapshots) {
      return state.tail;
    }
    if (!state.hasPending) {
      state.flushRequested = false;
      return state.tail;
    }
    return this.enqueueSnapshotDrain(key, state, true);
  }

  private stateFor(key: TKey): SnapshotState<TSnapshot> {
    const existing = this.states.get(key);
    if (existing) return existing;
    const created: SnapshotState<TSnapshot> = {
      hasPending: false,
      tail: Promise.resolve(),
      drainingSnapshots: false,
      flushRequested: false,
    };
    this.states.set(key, created);
    return created;
  }

  private takePending(state: SnapshotState<TSnapshot>): PendingSnapshot<TSnapshot> | undefined {
    if (!state.hasPending) return undefined;
    const pending = state.pending;
    state.pending = undefined;
    state.hasPending = false;
    return pending;
  }

  private scheduleDrain(
    key: TKey,
    state: SnapshotState<TSnapshot>,
    delayMs: number,
    timerKind: NonNullable<SnapshotState<TSnapshot>["timerKind"]>,
  ): void {
    if (state.timer || state.drainingSnapshots || !state.hasPending || this.disposed) return;
    state.timerKind = timerKind;
    state.timer = this.setTimer(() => {
      state.timer = undefined;
      state.timerKind = undefined;
      void this.enqueueSnapshotDrain(key, state, false).catch(() => undefined);
    }, delayMs);
  }

  private cancelTimer(state: SnapshotState<TSnapshot>): void {
    if (!state.timer) return;
    this.clearTimer(state.timer);
    state.timer = undefined;
    state.timerKind = undefined;
  }

  private enqueue(
    key: TKey,
    state: SnapshotState<TSnapshot>,
    operation: () => void | Promise<void>,
  ): Promise<void> {
    const result = state.tail.then(operation);
    const guarded = result.catch((error) => {
      this.reportError(error, key);
    });
    state.tail = guarded;
    void guarded.then(() => this.cleanupWhenIdle(key, state, guarded));
    return result;
  }

  private enqueueSnapshotDrain(
    key: TKey,
    state: SnapshotState<TSnapshot>,
    immediateCompensation: boolean,
  ): Promise<void> {
    if (state.drainingSnapshots) return state.tail;
    state.drainingSnapshots = true;
    return this.enqueue(key, state, async () => {
      try {
        while (state.hasPending) {
          const pending = this.takePending(state);
          if (!pending) continue;
          const outcome = await this.emitSnapshot(key, pending.value);
          if (outcome.status === "delivered") continue;
          if (state.hasPending) continue;

          const failedAttempts = pending.failedAttempts + 1;
          if (failedAttempts > this.maxCompensationRetries) {
            this.reportError(
              outcome.error ?? new Error("assistant_stream_snapshot_retry_exhausted"),
              key,
            );
            continue;
          }
          state.pending = { value: pending.value, failedAttempts };
          state.hasPending = true;
          if (immediateCompensation || state.flushRequested) continue;
          this.scheduleDrain(
            key,
            state,
            this.compensationRetryIntervalMs,
            "compensation",
          );
          return;
        }
      } finally {
        state.drainingSnapshots = false;
        state.flushRequested = false;
        if (state.hasPending && !state.timer && !immediateCompensation) {
          this.scheduleDrain(
            key,
            state,
            this.compensationRetryIntervalMs,
            "compensation",
          );
        }
      }
    });
  }

  private async emitSnapshot(key: TKey, snapshot: TSnapshot): Promise<AssistantStreamEmitResult> {
    try {
      const result = await this.emit(key, snapshot);
      return result?.status === "retryable" ? result : { status: "delivered" };
    } catch (error) {
      return { status: "retryable", error };
    }
  }

  private reportError(error: unknown, key: TKey): void {
    try {
      this.onError?.(error, key);
    } catch {
      // Observability hooks must never break per-key ordering.
    }
  }

  private isClosed(key: TKey): boolean {
    if (!this.closedKeys.has(key)) return false;
    this.closedKeys.delete(key);
    this.closedKeys.set(key, true);
    return true;
  }

  private rememberClosed(key: TKey): void {
    this.closedKeys.delete(key);
    this.closedKeys.set(key, true);
    while (this.closedKeys.size > this.maxClosedKeys) {
      const oldest = this.closedKeys.keys().next();
      if (oldest.done) return;
      this.closedKeys.delete(oldest.value);
    }
  }

  private cleanupWhenIdle(
    key: TKey,
    state: SnapshotState<TSnapshot>,
    expectedTail: Promise<void> = state.tail,
  ): void {
    if (
      this.states.get(key) === state
      && state.tail === expectedTail
      && !state.hasPending
      && !state.timer
      && !state.drainingSnapshots
    ) {
      this.states.delete(key);
    }
  }
}

function positiveFinite(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new Error("snapshot_interval_invalid");
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) throw new Error("snapshot_retry_limit_invalid");
  return resolved;
}
