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
