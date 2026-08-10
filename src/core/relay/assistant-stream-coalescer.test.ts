import assert from "node:assert/strict";
import test from "node:test";

import {
  ASSISTANT_STREAM_COMPENSATION_MAX_RETRIES,
  ASSISTANT_STREAM_COMPENSATION_RETRY_INTERVAL_MS,
  ASSISTANT_STREAM_COALESCE_INTERVAL_MS,
  LatestSnapshotCoalescer,
  buildAssistantStreamSnapshotKey,
} from "./assistant-stream-coalescer.js";

type ManualTimer = ReturnType<typeof setTimeout>;

function createManualTimers() {
  let nextId = 0;
  const callbacks = new Map<number, { callback: () => void; delayMs: number }>();
  return {
    setTimer: (callback: () => void, delayMs: number): ManualTimer => {
      nextId += 1;
      callbacks.set(nextId, { callback, delayMs });
      return nextId as unknown as ManualTimer;
    },
    clearTimer: (timer: ManualTimer): void => {
      callbacks.delete(timer as unknown as number);
    },
    fireAll: (): void => {
      const pending = [...callbacks.entries()];
      callbacks.clear();
      for (const [, entry] of pending) {
        entry.callback();
      }
    },
    callbacks,
  };
}

test("latest snapshot coalescer merges a burst and keeps the latest absolute payload", async () => {
  const timers = createManualTimers();
  const emitted: string[] = [];
  const key = buildAssistantStreamSnapshotKey({ sessionKey: "main", runId: "run-1" });
  const coalescer = new LatestSnapshotCoalescer<string, string>({
    emit: (_key, snapshot) => { emitted.push(snapshot); },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coalescer.schedule(key, "h");
  coalescer.schedule(key, "he");
  coalescer.schedule(key, "hello");

  assert.equal(timers.callbacks.size, 1);
  assert.equal([...timers.callbacks.values()][0]?.delayMs, ASSISTANT_STREAM_COALESCE_INTERVAL_MS);
  assert.equal(coalescer.pendingCount, 1);
  timers.fireAll();
  await coalescer.flush(key);

  assert.deepEqual(emitted, ["hello"]);
  assert.equal(coalescer.pendingCount, 0);
});

test("terminal operation flushes the latest snapshot first and closes its stable identity", async () => {
  const timers = createManualTimers();
  const emitted: string[] = [];
  const key = buildAssistantStreamSnapshotKey({
    sessionKey: "main",
    runId: "run-final",
    messageId: "assistant-run-final",
  });
  const coalescer = new LatestSnapshotCoalescer<string, string>({
    emit: async (_key, snapshot) => {
      await Promise.resolve();
      emitted.push(`delta:${snapshot}`);
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coalescer.schedule(key, "complete answer");
  await coalescer.closeAfterFlush(key, () => { emitted.push("final:complete answer"); });

  assert.deepEqual(emitted, ["delta:complete answer", "final:complete answer"]);
  assert.equal(timers.callbacks.size, 0);
  assert.equal(coalescer.schedule(key, "late delta"), false);
});

test("terminal operation still runs when its pending intermediate snapshot fails", async () => {
  const timers = createManualTimers();
  const emitted: string[] = [];
  const errors: unknown[] = [];
  const coalescer = new LatestSnapshotCoalescer<string, string>({
    emit: () => {
      throw new Error("intermediate upload failed");
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onError: (error) => { errors.push(error); },
  });

  coalescer.schedule("run-terminal", "partial");
  await coalescer.closeAfterFlush("run-terminal", () => { emitted.push("final"); });

  assert.deepEqual(emitted, ["final"]);
  assert.equal(errors.length, 1);
});

test("slow emit keeps only one in-flight snapshot and the newest pending snapshot", async () => {
  const timers = createManualTimers();
  const emitted: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const coalescer = new LatestSnapshotCoalescer<string, string>({
    emit: async (_key, snapshot) => {
      emitted.push(snapshot);
      if (snapshot === "s1") {
        await firstBlocked;
      }
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coalescer.schedule("run-slow", "s1");
  timers.fireAll();
  await Promise.resolve();
  coalescer.schedule("run-slow", "s2");
  coalescer.schedule("run-slow", "s3");
  coalescer.schedule("run-slow", "s4");
  coalescer.schedule("run-slow", "s5");

  assert.deepEqual(emitted, ["s1"]);
  assert.equal(coalescer.pendingCount, 1);
  assert.equal(timers.callbacks.size, 0);

  const terminal = coalescer.closeAfterFlush("run-slow", () => {
    emitted.push("terminal");
  });
  releaseFirst();
  await terminal;

  assert.deepEqual(emitted, ["s1", "s5", "terminal"]);
  assert.equal(coalescer.pendingCount, 0);
});

test("retryable write outcome schedules one bounded compensation for the latest snapshot", async () => {
  const timers = createManualTimers();
  const emitted: string[] = [];
  let attempt = 0;
  const coalescer = new LatestSnapshotCoalescer<string, string>({
    emit: (_key, snapshot) => {
      emitted.push(snapshot);
      attempt += 1;
      return attempt === 1 ? { status: "retryable" } : { status: "delivered" };
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coalescer.schedule("run-retry", "latest text");
  timers.fireAll();
  await settleMicrotasks();

  assert.equal(timers.callbacks.size, 1);
  assert.equal(
    [...timers.callbacks.values()][0]?.delayMs,
    ASSISTANT_STREAM_COMPENSATION_RETRY_INTERVAL_MS,
  );
  timers.fireAll();
  await coalescer.flush("run-retry");

  assert.deepEqual(emitted, ["latest text", "latest text"]);
  assert.equal(timers.callbacks.size, 0);
});

test("a newer snapshot replaces failed compensation and returns to coalesce interval", async () => {
  const timers = createManualTimers();
  const emitted: string[] = [];
  const coalescer = new LatestSnapshotCoalescer<string, string>({
    emit: (_key, snapshot) => {
      emitted.push(snapshot);
      return snapshot === "old" ? { status: "retryable" } : { status: "delivered" };
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coalescer.schedule("run-latest", "old");
  timers.fireAll();
  await settleMicrotasks();
  assert.equal([...timers.callbacks.values()][0]?.delayMs, ASSISTANT_STREAM_COMPENSATION_RETRY_INTERVAL_MS);

  coalescer.schedule("run-latest", "new");
  assert.equal(timers.callbacks.size, 1);
  assert.equal([...timers.callbacks.values()][0]?.delayMs, ASSISTANT_STREAM_COALESCE_INTERVAL_MS);
  timers.fireAll();
  await coalescer.flush("run-latest");

  assert.deepEqual(emitted, ["old", "new"]);
});

test("terminal barrier exhausts bounded latest-snapshot compensation before final", async () => {
  const timers = createManualTimers();
  const order: string[] = [];
  const errors: unknown[] = [];
  const coalescer = new LatestSnapshotCoalescer<string, string>({
    emit: (_key, snapshot) => {
      order.push(`snapshot:${snapshot}`);
      return { status: "retryable", error: new Error("still backpressured") };
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onError: (error) => { errors.push(error); },
  });

  coalescer.schedule("run-terminal-retry", "complete text");
  await coalescer.closeAfterFlush("run-terminal-retry", () => {
    order.push("final");
  });

  assert.equal(
    order.filter((entry) => entry.startsWith("snapshot:")).length,
    ASSISTANT_STREAM_COMPENSATION_MAX_RETRIES + 1,
  );
  assert.equal(order.at(-1), "final");
  assert.equal(errors.length, 1);
  assert.equal(timers.callbacks.size, 0);
});

test("different stable run identities never share snapshots", async () => {
  const timers = createManualTimers();
  const emitted: Array<[string, string]> = [];
  const firstKey = buildAssistantStreamSnapshotKey({ sessionKey: "main", runId: "run-a" });
  const secondKey = buildAssistantStreamSnapshotKey({ sessionKey: "main", runId: "run-b" });
  const coalescer = new LatestSnapshotCoalescer<string, string>({
    emit: (key, snapshot) => { emitted.push([key, snapshot]); },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coalescer.schedule(firstKey, "answer-a");
  coalescer.schedule(secondKey, "answer-b");
  await Promise.all([coalescer.flush(firstKey), coalescer.flush(secondKey)]);

  assert.deepEqual(new Map(emitted), new Map([
    [firstKey, "answer-a"],
    [secondKey, "answer-b"],
  ]));
});

test("dispose cancels timers and discards unsent snapshots", async () => {
  const timers = createManualTimers();
  const emitted: string[] = [];
  const coalescer = new LatestSnapshotCoalescer<string, string>({
    emit: (_key, snapshot) => { emitted.push(snapshot); },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  coalescer.schedule("run-a", "a");
  coalescer.schedule("run-b", "b");
  coalescer.dispose();
  timers.fireAll();
  await Promise.resolve();

  assert.equal(timers.callbacks.size, 0);
  assert.equal(coalescer.pendingCount, 0);
  assert.deepEqual(emitted, []);
  assert.equal(coalescer.schedule("run-c", "c"), false);
});

test("a terminal identity can be released after its owner records completion", async () => {
  const coalescer = new LatestSnapshotCoalescer<string, string>({ emit: () => undefined });
  await coalescer.closeAfterFlush("run-terminal", () => undefined);

  assert.equal(coalescer.schedule("run-terminal", "late"), false);
  coalescer.releaseClosed("run-terminal");
  assert.equal(coalescer.schedule("run-terminal", "owned elsewhere"), true);
  coalescer.dispose();
});

test("closed-key tombstones use a bounded LRU while rejecting recent late snapshots", async () => {
  const coalescer = new LatestSnapshotCoalescer<string, string>({
    emit: () => undefined,
    maxClosedKeys: 2,
  });
  await coalescer.closeAfterFlush("run-a", () => undefined);
  await coalescer.closeAfterFlush("run-b", () => undefined);

  assert.equal(coalescer.schedule("run-a", "late-a"), false);
  await coalescer.closeAfterFlush("run-c", () => undefined);

  // The rejected run-a delta refreshed its tombstone, so run-b is the LRU.
  assert.equal(coalescer.schedule("run-a", "still-late-a"), false);
  assert.equal(coalescer.schedule("run-c", "late-c"), false);
  assert.equal(coalescer.schedule("run-b", "new-generation-b"), true);
  coalescer.dispose();
});

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
