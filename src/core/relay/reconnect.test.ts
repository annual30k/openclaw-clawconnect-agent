import assert from "node:assert/strict";
import test from "node:test";

import { withReconnect } from "./reconnect.js";

test("reconnect backoff stops immediately when shutdown is requested", async () => {
  const shutdown = new AbortController();
  let attempts = 0;
  const startedAt = Date.now();

  await withReconnect(async () => {
    attempts += 1;
    return true;
  }, {
    initialDelayMs: 30_000,
    signal: shutdown.signal,
    onRetry: () => shutdown.abort(),
  });

  assert.equal(attempts, 1);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("an already-aborted reconnect loop never starts a connection", async () => {
  const shutdown = new AbortController();
  shutdown.abort();
  let attempts = 0;

  await withReconnect(async () => {
    attempts += 1;
    return false;
  }, { signal: shutdown.signal });

  assert.equal(attempts, 0);
});
