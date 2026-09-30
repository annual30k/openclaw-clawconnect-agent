import assert from "node:assert/strict";
import test from "node:test";
import { createSourceCommit } from "./source-commit.js";
import {
  createSourceCommitCheckpointClient,
  RELAY_SOURCE_COMMIT_RESUME_CAPABILITY,
  type SourceCommitCheckpointQuery,
} from "./source-commit-checkpoint-client.js";

const cursor = createSourceCommit({
  gatewayType: "openclaw",
  gatewayId: "gw-1",
  producerId: "main",
  sourceSessionId: "session-1",
  sourceOrderScope: "openclaw:main:session-1",
  sourceGeneration: "session-1",
  committedThroughSeq: 90,
  sourceRevision: "seq:90",
});

function harness(options: { sendResult?: boolean; timeoutMs?: number } = {}) {
  const sent: SourceCommitCheckpointQuery[] = [];
  let nextId = 0;
  const client = createSourceCommitCheckpointClient({
    send: (query) => {
      sent.push(query);
      return options.sendResult ?? true;
    },
    timeoutMs: options.timeoutMs,
    createRequestId: () => `req-${++nextId}`,
  });
  return { client, sent };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("checkpoint query waits for hello negotiation before sending", async () => {
  const { client, sent } = harness();
  const resolved = client.resolveWatermark(cursor);
  await flush();
  assert.equal(sent.length, 0);

  client.markRelayHello([RELAY_SOURCE_COMMIT_RESUME_CAPABILITY]);
  await flush();
  assert.deepEqual(sent, [{
    type: "source_commit_checkpoint_query",
    requestId: "req-1",
    scope: {
      gatewayType: "openclaw",
      producerId: "main",
      sourceSessionId: "session-1",
      sourceOrderScope: "openclaw:main:session-1",
      sourceGeneration: "session-1",
    },
  }]);
  assert.equal(client.handleResponse({
    type: "source_commit_checkpoint",
    requestId: "req-1",
    status: "found",
    committedThroughSeq: 72,
  }), true);
  assert.equal(await resolved, 72);
});

test("a relay without the resume capability keeps the legacy from-zero projection", async () => {
  const { client, sent } = harness();
  client.markRelayHello(["reliable_delivery_ack_v1"]);
  assert.equal(await client.resolveWatermark(cursor), undefined);
  assert.equal(sent.length, 0);
});

test("a missing relay checkpoint resolves to a from-zero projection", async () => {
  const { client } = harness();
  client.markRelayHello([RELAY_SOURCE_COMMIT_RESUME_CAPABILITY]);
  const resolved = client.resolveWatermark(cursor);
  await flush();
  client.handleResponse({ type: "source_commit_checkpoint", requestId: "req-1", status: "missing" });
  assert.equal(await resolved, undefined);
});

test("owner mismatch, invalid watermark and unsent queries fail instead of guessing a resume point", async () => {
  const mismatch = harness();
  mismatch.client.markRelayHello([RELAY_SOURCE_COMMIT_RESUME_CAPABILITY]);
  const mismatchResult = mismatch.client.resolveWatermark(cursor);
  await flush();
  mismatch.client.handleResponse({ type: "source_commit_checkpoint", requestId: "req-1", status: "owner_mismatch" });
  await assert.rejects(mismatchResult, /status=owner_mismatch/);

  const invalid = harness();
  invalid.client.markRelayHello([RELAY_SOURCE_COMMIT_RESUME_CAPABILITY]);
  const invalidResult = invalid.client.resolveWatermark(cursor);
  await flush();
  invalid.client.handleResponse({
    type: "source_commit_checkpoint",
    requestId: "req-1",
    status: "found",
    committedThroughSeq: -3,
  });
  await assert.rejects(invalidResult, /status=found/);

  const unsent = harness({ sendResult: false });
  unsent.client.markRelayHello([RELAY_SOURCE_COMMIT_RESUME_CAPABILITY]);
  await assert.rejects(unsent.client.resolveWatermark(cursor), /was not sent/);
});

test("closing the connection rejects pending and future queries", async () => {
  const { client } = harness();
  const beforeHello = client.resolveWatermark(cursor);
  client.close("relay closed 1006");
  await assert.rejects(beforeHello, /relay closed 1006/);
  await assert.rejects(client.resolveWatermark(cursor), /relay closed 1006/);

  const second = harness();
  second.client.markRelayHello([RELAY_SOURCE_COMMIT_RESUME_CAPABILITY]);
  const pending = second.client.resolveWatermark(cursor);
  await flush();
  second.client.close("relay closed 1001");
  await assert.rejects(pending, /relay closed 1001/);
});

test("a query that never gets a response times out for liveness only", async () => {
  const { client } = harness({ timeoutMs: 5 });
  client.markRelayHello([RELAY_SOURCE_COMMIT_RESUME_CAPABILITY]);
  await assert.rejects(client.resolveWatermark(cursor), /timed out/);
});

test("unrelated frames are not consumed and stale responses are ignored", () => {
  const { client } = harness();
  assert.equal(client.handleResponse({ type: "event_ack", id: "x" }), false);
  assert.equal(client.handleResponse({
    type: "source_commit_checkpoint",
    requestId: "unknown",
    status: "found",
    committedThroughSeq: 1,
  }), true);
});
