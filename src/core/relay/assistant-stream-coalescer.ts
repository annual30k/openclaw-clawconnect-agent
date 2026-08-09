export const ASSISTANT_STREAM_COALESCE_INTERVAL_MS = 100;

type TimerHandle = ReturnType<typeof setTimeout>;

type SnapshotState<T> = {
  pending?: T;
  hasPending: boolean;
  timer?: TimerHandle;
  tail: Promise<void>;
};

export type AssistantStreamIdentity = {
  sessionKey: string;
  runId: string;
  messageId?: string;
};

export type LatestSnapshotCoalescerOptions<TKey, TSnapshot> = {
  emit: (key: TKey, snapshot: TSnapshot) => void | Promise<void>;
  intervalMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  onError?: (error: unknown, key: TKey) => void;
};

export function buildAssistantStreamSnapshotKey(identity: AssistantStreamIdentity): string {
  const sessionKey = identity.sessionKey.trim();
  const runId = identity.runId.trim();
  if (!sessionKey || !runId) {
    throw new Error("assistant_stream_identity_required");
  }
  const messageId = identity.messageId?.trim() || `assistant-${runId}`;
  return JSON.stringify([sessionKey, runId, messageId]);
}

/**
 * Keeps only the newest absolute snapshot inside one short interval while
 * preserving a strict per-identity async send order.
 */
export class LatestSnapshotCoalescer<TKey, TSnapshot> {
  private readonly emit: LatestSnapshotCoalescerOptions<TKey, TSnapshot>["emit"];
  private readonly intervalMs: number;
  private readonly setTimer: NonNullable<LatestSnapshotCoalescerOptions<TKey, TSnapshot>["setTimer"]>;
  private readonly clearTimer: NonNullable<LatestSnapshotCoalescerOptions<TKey, TSnapshot>["clearTimer"]>;
  private readonly onError?: LatestSnapshotCoalescerOptions<TKey, TSnapshot>["onError"];
  private readonly states = new Map<TKey, SnapshotState<TSnapshot>>();
  private readonly closedKeys = new Set<TKey>();
  private disposed = false;

  constructor(options: LatestSnapshotCoalescerOptions<TKey, TSnapshot>) {
    this.emit = options.emit;
    this.intervalMs = options.intervalMs ?? ASSISTANT_STREAM_COALESCE_INTERVAL_MS;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error("snapshot_coalesce_interval_invalid");
    }
    this.setTimer = options.setTimer ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    });
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onError = options.onError;
  }

  schedule(key: TKey, snapshot: TSnapshot): boolean {
    if (this.disposed || this.closedKeys.has(key)) {
      return false;
    }
    const state = this.stateFor(key);
    state.pending = snapshot;
    state.hasPending = true;
    if (state.timer) {
      return true;
    }
    state.timer = this.setTimer(() => {
      state.timer = undefined;
      const pending = this.takePending(state);
      if (pending === undefined) {
        this.cleanupWhenIdle(key, state);
        return;
      }
      void this.enqueue(key, state, () => this.emit(key, pending)).catch(() => undefined);
    }, this.intervalMs);
    return true;
  }

  flush(key: TKey): Promise<void> {
    const state = this.states.get(key);
    if (!state) {
      return Promise.resolve();
    }
    this.cancelTimer(state);
    const pending = this.takePending(state);
    return pending === undefined
      ? state.tail
      : this.enqueue(key, state, () => this.emit(key, pending));
  }

  flushThen(key: TKey, operation: () => void | Promise<void>): Promise<void> {
    return this.flushThenInternal(key, operation, false);
  }

  closeAfterFlush(key: TKey, operation: () => void | Promise<void>): Promise<void> {
    return this.flushThenInternal(key, operation, true);
  }

  clear(key: TKey): void {
    const state = this.states.get(key);
    if (!state) {
      return;
    }
    this.cancelTimer(state);
    state.pending = undefined;
    state.hasPending = false;
    this.cleanupWhenIdle(key, state);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
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
      if (state.hasPending) {
        count += 1;
      }
    }
    return count;
  }

  private flushThenInternal(
    key: TKey,
    operation: () => void | Promise<void>,
    close: boolean,
  ): Promise<void> {
    if (close) {
      this.closedKeys.add(key);
    }
    const state = this.stateFor(key);
    this.cancelTimer(state);
    const pending = this.takePending(state);
    return this.enqueue(key, state, async () => {
      if (pending !== undefined) {
        try {
          await this.emit(key, pending);
        } catch (error) {
          // 中间快照失败不能阻断 final、error 或工具状态。终态仍按同一稳定
          // identity 顺序执行，中间帧错误单独上报供诊断。
          this.reportError(error, key);
        }
      }
      await operation();
    });
  }

  private stateFor(key: TKey): SnapshotState<TSnapshot> {
    const existing = this.states.get(key);
    if (existing) {
      return existing;
    }
    const created: SnapshotState<TSnapshot> = {
      hasPending: false,
      tail: Promise.resolve(),
    };
    this.states.set(key, created);
    return created;
  }

  private takePending(state: SnapshotState<TSnapshot>): TSnapshot | undefined {
    if (!state.hasPending) {
      return undefined;
    }
    const pending = state.pending;
    state.pending = undefined;
    state.hasPending = false;
    return pending;
  }

  private cancelTimer(state: SnapshotState<TSnapshot>): void {
    if (!state.timer) {
      return;
    }
    this.clearTimer(state.timer);
    state.timer = undefined;
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

  private reportError(error: unknown, key: TKey): void {
    try {
      this.onError?.(error, key);
    } catch {
      // Observability hooks must never break the per-key ordering queue.
    }
  }

  private cleanupWhenIdle(
    key: TKey,
    state: SnapshotState<TSnapshot>,
    expectedTail: Promise<void> = state.tail,
  ): void {
    if (
      this.states.get(key) === state &&
      state.tail === expectedTail &&
      !state.hasPending &&
      !state.timer
    ) {
      this.states.delete(key);
    }
  }
}
