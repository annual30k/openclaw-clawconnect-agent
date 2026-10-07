import assert from "node:assert/strict";
import test from "node:test";
import {
  createSourceCommitPublishFlow,
  sourceCommitDeliveryId,
} from "./source-commit-publish-flow.js";

const commit = {
  gatewayId: "gw",
  sourceOrderScope: "openclaw:main:s1",
  sourceGeneration: "s1",
  committedThroughSeq: 50,
  sourceRevision: "seq:50",
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("delivery ids are stable for the same page and distinct across pages", () => {
  const first = sourceCommitDeliveryId(commit, ["e1", "e2"]);
  assert.equal(first, sourceCommitDeliveryId(commit, ["e1", "e2"]));
  assert.notEqual(first, sourceCommitDeliveryId({ ...commit, committedThroughSeq: 100 }, ["e1", "e2"]));
  assert.notEqual(first, sourceCommitDeliveryId(commit, ["e1", "e3"]));
  assert.ok(first.startsWith("source-commit-"));
  assert.ok(first.length <= 128);
});

test("only one projection frame is in flight and the next waits for the relay ack", async () => {
  const flow = createSourceCommitPublishFlow({ isAcknowledged: () => true });
  const sent: Array<string | undefined> = [];
  const first = flow.publish("d1", async (deliveryId) => { sent.push(deliveryId); });
  const second = flow.publish("d2", async (deliveryId) => { sent.push(deliveryId); });
  await flush();
  assert.deepEqual(sent, ["d1"]);

  assert.equal(flow.acknowledge("d1"), true);
  await first;
  await flush();
  assert.deepEqual(sent, ["d1", "d2"]);
  assert.equal(flow.acknowledge("d2"), true);
  await second;
  assert.equal(flow.pendingAckCount(), 0);
});

test("frames from different sessions are sent strictly in call order", async () => {
  const flow = createSourceCommitPublishFlow({ isAcknowledged: () => true });
  const order: string[] = [];
  const pending = ["a", "b", "c"].map((id) => flow.publish(id, async () => { order.push(id); }));
  for (const id of ["a", "b", "c"]) {
    await flush();
    flow.acknowledge(id);
  }
  await Promise.all(pending);
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("a relay without event acknowledgements keeps the legacy fire-and-continue behavior", async () => {
  const flow = createSourceCommitPublishFlow({ isAcknowledged: () => false });
  const sent: Array<string | undefined> = [];
  await flow.publish("d1", async (deliveryId) => { sent.push(deliveryId); });
  await flow.publish("d2", async (deliveryId) => { sent.push(deliveryId); });
  assert.deepEqual(sent, [undefined, undefined]);
  assert.equal(flow.pendingAckCount(), 0);
});

test("a failed send releases the gate for the next frame without waiting for an ack", async () => {
  const flow = createSourceCommitPublishFlow({ isAcknowledged: () => true });
  const failed = flow.publish("d1", async () => { throw new Error("socket closed"); });
  await assert.rejects(failed, /socket closed/);
  const sent: string[] = [];
  const next = flow.publish("d2", async (deliveryId) => { sent.push(String(deliveryId)); });
  await flush();
  assert.deepEqual(sent, ["d2"]);
  flow.acknowledge("d2");
  await next;
});

test("an ack that never arrives times out for liveness and the gate moves on", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flow = createSourceCommitPublishFlow({ isAcknowledged: () => true, ackTimeoutMs: 5 });
  const timedOut = assert.rejects(flow.publish("d1", async () => undefined), /ack timed out/);
  await flush();
  t.mock.timers.tick(5);
  await timedOut;
  const sent: string[] = [];
  const next = flow.publish("d2", async (deliveryId) => { sent.push(String(deliveryId)); });
  await flush();
  assert.deepEqual(sent, ["d2"]);
  flow.acknowledge("d2");
  await next;
});

test("closing the connection rejects waiting frames and refuses new ones", async () => {
  const flow = createSourceCommitPublishFlow({ isAcknowledged: () => true });
  const waiting = flow.publish("d1", async () => undefined);
  await flush();
  flow.close("relay closed 1006");
  await assert.rejects(waiting, /relay closed 1006/);
  await assert.rejects(flow.publish("d2", async () => undefined), /relay closed 1006/);
  assert.equal(flow.acknowledge("d1"), false);
});
