import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";

import { startRelayLivenessMonitor } from "./relay-liveness.js";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  pings = 0;
  terminated = 0;
  ping(): void { this.pings += 1; }
  terminate(): void { this.terminated += 1; this.readyState = WebSocket.CLOSED; }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("liveness monitor pings periodically and stays quiet while pongs keep arriving", async () => {
  const socket = new FakeSocket();
  const monitor = startRelayLivenessMonitor(socket as unknown as WebSocket, { pingIntervalMs: 10, timeoutMs: 40 });
  const feeder = setInterval(() => socket.emit("pong"), 5);
  try {
    await wait(120);
    assert.ok(socket.pings >= 5, `expected periodic pings, got ${socket.pings}`);
    assert.equal(socket.terminated, 0);
  } finally {
    clearInterval(feeder);
    monitor.stop();
  }
});

test("liveness monitor terminates a half-open socket once no frame arrives within the timeout", async () => {
  const socket = new FakeSocket();
  let reportedIdleMs = 0;
  const monitor = startRelayLivenessMonitor(socket as unknown as WebSocket, {
    pingIntervalMs: 10,
    timeoutMs: 40,
    onTimeout: (idleMs) => { reportedIdleMs = idleMs; },
  });
  try {
    await wait(120);
    assert.equal(socket.terminated, 1);
    assert.ok(reportedIdleMs > 40);
    const pingsAtTermination = socket.pings;
    await wait(40);
    // 超时后监视器自行停止，不再继续 ping。
    assert.equal(socket.pings, pingsAtTermination);
  } finally {
    monitor.stop();
  }
});

test("liveness monitor counts inbound messages as activity and stops cleanly", async () => {
  const socket = new FakeSocket();
  const monitor = startRelayLivenessMonitor(socket as unknown as WebSocket, { pingIntervalMs: 10, timeoutMs: 40 });
  const feeder = setInterval(() => socket.emit("message", Buffer.from("{}")), 5);
  await wait(90);
  clearInterval(feeder);
  monitor.stop();
  const pingsAfterStop = socket.pings;
  await wait(60);
  assert.equal(socket.terminated, 0);
  assert.equal(socket.pings, pingsAfterStop);
  assert.equal(socket.listenerCount("message"), 0);
  assert.equal(socket.listenerCount("pong"), 0);
});
