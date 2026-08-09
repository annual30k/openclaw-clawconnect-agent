import assert from "node:assert/strict";
import test from "node:test";

import {
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
    emit: (_key, snapshot) => emitted.push(snapshot),
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
  await coalescer.closeAfterFlush(key, () => emitted.push("final:complete answer"));

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
    onError: (error) => errors.push(error),
  });

  coalescer.schedule("run-terminal", "partial");
  await coalescer.closeAfterFlush("run-terminal", () => emitted.push("final"));

  assert.deepEqual(emitted, ["final"]);
  assert.equal(errors.length, 1);
});

test("different stable run identities never share snapshots", async () => {
  const timers = createManualTimers();
  const emitted: Array<[string, string]> = [];
  const firstKey = buildAssistantStreamSnapshotKey({ sessionKey: "main", runId: "run-a" });
  const secondKey = buildAssistantStreamSnapshotKey({ sessionKey: "main", runId: "run-b" });
  const coalescer = new LatestSnapshotCoalescer<string, string>({
    emit: (key, snapshot) => emitted.push([key, snapshot]),
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
    emit: (_key, snapshot) => emitted.push(snapshot),
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
