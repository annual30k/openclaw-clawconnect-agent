import assert from "node:assert/strict";
import test from "node:test";
import { createSourceCommit, createSourceCommitObserver } from "./source-commit.js";

function commit(seq: number, generation = "session-a") {
  return createSourceCommit({
    gatewayType: "openclaw",
    gatewayId: "gw-1",
    producerId: "agent:main",
    sourceSessionId: "session-1",
    sourceOrderScope: "openclaw:main:session-1",
    sourceGeneration: generation,
    committedThroughSeq: seq,
    sourceRevision: `seq:${seq}`,
  });
}

test("source commit emits only advancing cursors and keeps commit out of identity", async () => {
  let current = commit(155);
  const emitted: number[] = [];
  const observer = createSourceCommitObserver({
    readCursor: () => current,
    onCommit: async (value) => { emitted.push(value.committedThroughSeq); },
  });
  observer.rescan();
  await new Promise((resolve) => setImmediate(resolve));
  current = commit(155);
  observer.notify();
  current = commit(163);
  observer.notify();
  observer.notify();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(emitted, [155, 163]);
  assert.equal(observer.lastCommittedThroughSeq(current), 163);
  observer.close();
});

test("source generation isolates a restarted source cursor", async () => {
  let current = commit(163, "generation-a");
  const emitted: string[] = [];
  const observer = createSourceCommitObserver({
    readCursor: () => current,
    onCommit: (value) => { emitted.push(`${value.sourceGeneration}:${value.committedThroughSeq}`); },
  });
  observer.notify();
  await new Promise((resolve) => setImmediate(resolve));
  current = commit(1, "generation-b");
  observer.notify();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(emitted, ["generation-a:163", "generation-b:1"]);
  observer.close();
});

test("source commit does not acknowledge a failed downstream append", async () => {
  const current = commit(9);
  let attempts = 0;
  const observer = createSourceCommitObserver({
    readCursor: async () => current,
    onCommit: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("relay unavailable");
    },
  });
  observer.notify();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observer.lastCommittedThroughSeq(current), undefined);
  observer.notify();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(observer.lastCommittedThroughSeq(current), 9);
  observer.close();
});

test("source commit acknowledges hidden-only commits without throwing and preserves the next visible cursor", async () => {
  let current = commit(10);
  const callbacks: Array<{ seq: number; previous: number | undefined }> = [];
  const observer = createSourceCommitObserver({
    readCursor: () => current,
    onCommit: async (value, previous) => {
      // A commit can contain only filtered heartbeat rows. The reconciliation
      // callback treats that as a successful observation with no Relay event.
      callbacks.push({ seq: value.committedThroughSeq, previous });
    },
  });

  observer.notify();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(observer.lastCommittedThroughSeq(current), 10);

  current = commit(12);
  observer.notify();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(callbacks, [
    { seq: 10, previous: undefined },
    { seq: 12, previous: 10 },
  ]);
  assert.equal(observer.lastCommittedThroughSeq(current), 12);
  observer.close();
});

test("resolved downstream watermark resumes projection after the durable seq instead of replaying history", async () => {
  let current = commit(120);
  const callbacks: Array<{ seq: number; previous: number | undefined }> = [];
  const resolvedScopes: string[] = [];
  const observer = createSourceCommitObserver({
    readCursor: () => current,
    resolveInitialWatermark: async (cursor) => {
      resolvedScopes.push(cursor.sourceGeneration);
      return 100;
    },
    onCommit: async (value, previous) => {
      callbacks.push({ seq: value.committedThroughSeq, previous });
    },
  });
  observer.rescan();
  await new Promise((resolve) => setImmediate(resolve));
  current = commit(125);
  observer.notify();
  await new Promise((resolve) => setImmediate(resolve));

  // 断线期间写入的 101..120 通过一次增量补上；同一作用域的起点只解析一次。
  assert.deepEqual(callbacks, [
    { seq: 120, previous: 100 },
    { seq: 125, previous: 120 },
  ]);
  assert.deepEqual(resolvedScopes, ["session-a"]);
  observer.close();
});

test("downstream watermark at the local cursor publishes nothing until the source advances", async () => {
  let current = commit(80);
  const emitted: number[] = [];
  const observer = createSourceCommitObserver({
    readCursor: () => current,
    resolveInitialWatermark: async () => 80,
    onCommit: async (value) => { emitted.push(value.committedThroughSeq); },
  });
  observer.rescan();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(emitted, []);
  assert.equal(observer.lastCommittedThroughSeq(current), 80);

  current = commit(81);
  observer.notify();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(emitted, [81]);
  observer.close();
});

test("missing downstream watermark projects the scope from sequence zero exactly once", async () => {
  const current = commit(30);
  const callbacks: Array<{ seq: number; previous: number | undefined }> = [];
  let resolutions = 0;
  const observer = createSourceCommitObserver({
    readCursor: () => current,
    resolveInitialWatermark: async () => {
      resolutions += 1;
      return undefined;
    },
    onCommit: async (value, previous) => {
      callbacks.push({ seq: value.committedThroughSeq, previous });
    },
  });
  observer.rescan();
  await new Promise((resolve) => setImmediate(resolve));
  observer.notify();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(callbacks, [{ seq: 30, previous: undefined }]);
  assert.equal(resolutions, 1);
  observer.close();
});

test("a failed watermark resolution publishes nothing and retries on the next notification", async () => {
  const current = commit(40);
  const emitted: Array<number | undefined> = [];
  const errors: string[] = [];
  let attempts = 0;
  const observer = createSourceCommitObserver({
    readCursor: () => current,
    resolveInitialWatermark: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("relay checkpoint unavailable");
      return 35;
    },
    onCommit: async (_value, previous) => { emitted.push(previous); },
    onError: (error) => { errors.push(String(error)); },
  });
  observer.notify();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(emitted, []);
  assert.equal(errors.length, 1);

  observer.notify();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(emitted, [35]);
  observer.close();
});

test("an invalid downstream watermark is rejected instead of being used as a resume point", async () => {
  const current = commit(10);
  const emitted: number[] = [];
  const errors: string[] = [];
  const observer = createSourceCommitObserver({
    readCursor: () => current,
    resolveInitialWatermark: async () => -1,
    onCommit: async (value) => { emitted.push(value.committedThroughSeq); },
    onError: (error) => { errors.push(String(error)); },
  });
  observer.notify();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(emitted, []);
  assert.match(errors[0] ?? "", /watermark is invalid/);
  observer.close();
});

test("each source generation resolves its own downstream watermark", async () => {
  let current = commit(12, "generation-a");
  const resolved: string[] = [];
  const callbacks: Array<{ generation: string; previous: number | undefined }> = [];
  const observer = createSourceCommitObserver({
    readCursor: () => current,
    resolveInitialWatermark: async (cursor) => {
      resolved.push(cursor.sourceGeneration);
      return cursor.sourceGeneration === "generation-a" ? 10 : undefined;
    },
    onCommit: async (value, previous) => {
      callbacks.push({ generation: value.sourceGeneration, previous });
    },
  });
  observer.notify();
  await new Promise((resolve) => setImmediate(resolve));
  current = commit(3, "generation-b");
  observer.notify();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(resolved, ["generation-a", "generation-b"]);
  assert.deepEqual(callbacks, [
    { generation: "generation-a", previous: 10 },
    { generation: "generation-b", previous: undefined },
  ]);
  observer.close();
});
