import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withReconnect } from "./reconnect.js";

const reconnectModulePath = fileURLToPath(new URL("./reconnect.ts", import.meta.url));
const repositoryRoot = resolve(dirname(reconnectModulePath), "..", "..", "..");

test("reconnect backoff keeps the process alive while waiting for the next attempt", () => {
  // 在独立进程里跑：等待期间若没有句柄保活，进程会在第一次重试前静默退出。
  const script = `
    import { withReconnect } from ${JSON.stringify(reconnectModulePath)};
    let connections = 0;
    await withReconnect(async () => {
      connections += 1;
      return connections < 3;
    }, {
      initialDelayMs: 20,
      onRetry: (attempt) => console.log("retry " + attempt),
    });
    console.log("finished");
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(child.stdout.trim().split("\n"), ["retry 1", "retry 2", "finished"]);
});

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

test("reconnect backoff restarts from the initial delay after an established connection drops", async () => {
  const retries: Array<{ attempt: number; delayMs: number }> = [];
  let connections = 0;

  await withReconnect(async (session) => {
    connections += 1;
    // 第 1、2 次连接从未完成握手；第 3 次握手成功后掉线；第 4 次再次失败；第 5 次结束循环。
    if (connections === 3) {
      session.markEstablished();
    }
    return connections < 5;
  }, {
    initialDelayMs: 10,
    maxDelayMs: 40,
    onRetry: (attempt, delayMs) => retries.push({ attempt, delayMs }),
  });

  assert.equal(connections, 5);
  assert.deepEqual(retries, [
    { attempt: 1, delayMs: 10 },
    { attempt: 2, delayMs: 20 },
    { attempt: 1, delayMs: 10 },
    { attempt: 2, delayMs: 20 },
  ]);
});

test("reconnect backoff keeps growing to the cap while the handshake never succeeds", async () => {
  const delays: number[] = [];
  let connections = 0;

  await withReconnect(async () => {
    connections += 1;
    return connections < 5;
  }, {
    initialDelayMs: 10,
    maxDelayMs: 40,
    onRetry: (_attempt, delayMs) => delays.push(delayMs),
  });

  assert.deepEqual(delays, [10, 20, 40, 40]);
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
