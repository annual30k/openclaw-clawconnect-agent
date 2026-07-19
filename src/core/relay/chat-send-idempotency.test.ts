import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatSendIdempotencyRequest,
  ChatSendIdempotencyConflictError,
  ChatSendIdempotencyGuard,
} from "./chat-send-idempotency.js";

test("chat.send idempotency shares one concurrent successful execution and its terminal result", async () => {
  const guard = new ChatSendIdempotencyGuard<{ runId: string }>();
  let executions = 0;
  let finish!: (value: { runId: string }) => void;
  const request = requiredRequest({ message: "hello", attachments: [{ fileId: "file-1" }] });

  const first = guard.execute(request, async () => {
    executions += 1;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const concurrent = guard.execute(requiredRequest({
    attachments: [{ fileId: "file-1" }],
    message: "hello",
  }), async () => {
    executions += 1;
    return { runId: "wrong" };
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(first.status, "started");
  assert.equal(concurrent.status, "reused");
  assert.equal(executions, 1);
  finish({ runId: "run-1" });
  assert.deepEqual(await Promise.all([first.promise, concurrent.promise]), [
    { runId: "run-1" },
    { runId: "run-1" },
  ]);

  const terminalRetry = guard.execute(request, async () => {
    executions += 1;
    return { runId: "wrong" };
  });
  assert.equal(terminalRetry.status, "reused");
  assert.deepEqual(await terminalRetry.promise, { runId: "run-1" });
  assert.equal(executions, 1);
});

test("chat.send idempotency shares concurrent and terminal errors without rerunning", async () => {
  const guard = new ChatSendIdempotencyGuard<never>();
  let executions = 0;
  const request = requiredRequest({ message: "fail" });
  const first = guard.execute(request, async () => {
    executions += 1;
    throw new Error("provider_unavailable");
  });
  const concurrent = guard.execute(request, async () => {
    executions += 1;
    throw new Error("wrong");
  });

  await assert.rejects(first.promise, /provider_unavailable/);
  await assert.rejects(concurrent.promise, /provider_unavailable/);
  const terminalRetry = guard.execute(request, async () => {
    executions += 1;
    throw new Error("wrong");
  });
  await assert.rejects(terminalRetry.promise, /provider_unavailable/);
  assert.equal(executions, 1);
});

test("chat.send idempotency rejects a changed payload for the same scoped key", () => {
  const guard = new ChatSendIdempotencyGuard<void>();
  guard.claim(requiredRequest({ message: "first" }));

  assert.throws(
    () => guard.claim(requiredRequest({ message: "changed" })),
    ChatSendIdempotencyConflictError,
  );
});

test("chat.send idempotency isolates gateway and session scopes", () => {
  const guard = new ChatSendIdempotencyGuard<void>();
  const base = requiredRequest({ message: "same" });

  assert.equal(guard.claim(base).status, "started");
  assert.equal(guard.claim({ ...base, gatewayId: "gateway-2" }).status, "started");
  assert.equal(guard.claim({ ...base, sessionKey: "other-session" }).status, "started");
});

test("chat.send idempotency expires only terminal entries after the short retention", async () => {
  let nowMs = 100;
  const guard = new ChatSendIdempotencyGuard<string>({ terminalTtlMs: 50, now: () => nowMs });
  const request = requiredRequest({ message: "again later" });
  const first = guard.execute(request, async () => "first");
  assert.equal(await first.promise, "first");

  nowMs = 149;
  assert.equal(guard.claim(request).status, "reused");
  nowMs = 150;
  assert.equal(guard.claim(request).status, "started");
});

test("chat.send accepted responses remain in-flight until the owner marks model execution complete", async () => {
  let nowMs = 100;
  const guard = new ChatSendIdempotencyGuard<string>({ terminalTtlMs: 50, now: () => nowMs });
  const request = requiredRequest({ message: "long Hermes run" });
  const owner = guard.claim(request);
  assert.equal(owner.status, "started");
  if (owner.status !== "started") {
    return;
  }
  owner.accept("accepted-run-1");
  assert.equal(await owner.promise, "accepted-run-1");

  nowMs = 10_000;
  const duringLongRun = guard.claim(request);
  assert.equal(duringLongRun.status, "reused");
  assert.equal(await duringLongRun.promise, "accepted-run-1");

  owner.complete();
  assert.deepEqual(await duringLongRun.terminal, { status: "completed" });
  nowMs = 10_049;
  assert.equal(guard.claim(request).status, "reused");
  nowMs = 10_050;
  assert.equal(guard.claim(request).status, "started");
});

test("chat.send releases an accepted owner after transport loss so the stable key can run again", async () => {
  const guard = new ChatSendIdempotencyGuard<string>();
  const request = requiredRequest({ message: "retry after reconnect" });
  const owner = guard.claim(request);
  assert.equal(owner.status, "started");
  if (owner.status !== "started") return;

  owner.accept("accepted-before-disconnect");
  const duplicate = guard.claim(request);
  assert.equal(duplicate.status, "reused");
  owner.release();

  assert.deepEqual(await duplicate.terminal, { status: "released" });
  assert.equal(guard.claim(request).status, "started");
});

test("chat.send exposes a terminal model error to accepted retries", async () => {
  const guard = new ChatSendIdempotencyGuard<string>();
  const request = requiredRequest({ message: "terminal error" });
  const owner = guard.claim(request);
  assert.equal(owner.status, "started");
  if (owner.status !== "started") return;

  owner.accept("accepted-run-error");
  const duplicate = guard.claim(request);
  const error = new Error("provider_unavailable");
  owner.complete(error);

  const terminal = await duplicate.terminal;
  assert.equal(terminal.status, "failed");
  if (terminal.status === "failed") assert.equal(terminal.error, error);
});

function requiredRequest(payload: unknown) {
  const request = buildChatSendIdempotencyRequest({
    gatewayId: "gateway-1",
    sessionKey: "main",
    idempotencyKey: "client-run-1",
    payload,
  });
  assert.ok(request);
  return request;
}
