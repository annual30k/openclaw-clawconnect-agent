import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import {
  bindRelayAbortSignal,
  buildRelayUrl,
  createRelayWebSocket,
  parseRelayFrame,
  RELAY_WS_CLIENT_OPTIONS,
  RELAY_WS_COMPRESSION_THRESHOLD_BYTES,
  sendRelayJson,
  sendRelayJsonWithWriteConfirmation,
  shouldRetryRelayClose,
} from "./relay-server-connection.js";

test("Relay client explicitly enables and negotiates permessage-deflate", async () => {
  const server = new WebSocketServer({ port: 0, perMessageDeflate: true });
  let client: WebSocket | undefined;
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    assert.equal(RELAY_WS_CLIENT_OPTIONS.perMessageDeflate, true);

    client = createRelayWebSocket(`ws://127.0.0.1:${address.port}`);
    await once(client, "open");
    assert.match(client.extensions, /(?:^|,\s*)permessage-deflate(?:,|$)/);
    client.close();
    await once(client, "close");
  } finally {
    client?.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("buildRelayUrl converts HTTP relay URLs to websocket relay URLs", () => {
  assert.equal(
    buildRelayUrl("https://relay.example/base/", "gw 1", "secret&1"),
    "wss://relay.example/base/relay/gw 1?secret=secret%261",
  );
});

test("parseRelayFrame returns undefined for invalid JSON", () => {
  assert.deepEqual(parseRelayFrame(Buffer.from("{\"type\":\"heartbeat\"}")), { type: "heartbeat" });
  assert.equal(parseRelayFrame(Buffer.from("{")), undefined);
});

test("sendRelayJson only sends when socket is open", () => {
  const sent: string[] = [];
  const compression: boolean[] = [];
  let completed = false;
  const ws = {
    readyState: WebSocket.OPEN,
    send: (value: string, options: { compress: boolean }, callback: (error?: Error) => void) => {
      sent.push(value);
      compression.push(options.compress);
      callback();
    },
  } as unknown as WebSocket;

  const result = sendRelayJson(ws, { type: "heartbeat" }, undefined, (error) => {
    assert.equal(error, undefined);
    completed = true;
  });
  assert.deepEqual(sent, ['{"type":"heartbeat"}']);
  assert.deepEqual(compression, [false]);
  assert.equal(completed, true);
  assert.equal(result.status, "sent");
  assert.equal(result.aboveHighWaterMark, false);
  assert.equal(result.byteLength, Buffer.byteLength('{"type":"heartbeat"}'));
});

test("sendRelayJson explicitly compresses payloads at or above 1 KiB", () => {
  const compression: boolean[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (_value: string, options: { compress: boolean }, callback: (error?: Error) => void) => {
      compression.push(options.compress);
      callback();
    },
  } as unknown as WebSocket;

  sendRelayJson(ws, { payload: "x".repeat(RELAY_WS_COMPRESSION_THRESHOLD_BYTES) });

  assert.deepEqual(compression, [true]);
});

test("sendRelayJson reports asynchronous and synchronous send failures", () => {
  const asyncError = new Error("async write failed");
  let observedAsyncError: Error | undefined;
  const asyncWs = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (_value: string, _options: { compress: boolean }, callback: (error?: Error) => void) => {
      callback(asyncError);
    },
  } as unknown as WebSocket;

  const accepted = sendRelayJson(asyncWs, { type: "res", id: "1" }, undefined, (error) => {
    observedAsyncError = error;
  });
  assert.equal(accepted.status, "sent");
  assert.equal(observedAsyncError, asyncError);

  const syncError = new Error("sync write failed");
  const syncWs = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: () => { throw syncError; },
  } as unknown as WebSocket;
  const failed = sendRelayJson(syncWs, { type: "res", id: "2" });
  assert.equal(failed.status, "send_failed");
  assert.equal(failed.error, syncError);
});

test("write-confirmed send converts asynchronous callback failure into explicit result", async () => {
  const writeError = new Error("async confirmation failed");
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (_value: string, _options: { compress: boolean }, callback: (error?: Error) => void) => {
      queueMicrotask(() => callback(writeError));
    },
  } as unknown as WebSocket;

  const result = await sendRelayJsonWithWriteConfirmation(ws, { type: "event" }, undefined, 100);
  assert.equal(result.status, "send_failed");
  assert.equal(result.error, writeError);
});

test("write-confirmed send reports bounded callback timeout", async () => {
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: () => undefined,
  } as unknown as WebSocket;

  const result = await sendRelayJsonWithWriteConfirmation(ws, { type: "event" }, undefined, 5);
  assert.equal(result.status, "send_failed");
  assert.match(String((result.error as Error | undefined)?.message), /relay_write_confirmation_timeout/);
});

test("sendRelayJson skips a recoverable stream snapshot before crossing the backpressure limit", () => {
  const sent: string[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 99,
    send: (value: string) => sent.push(value),
  } as unknown as WebSocket;

  const result = sendRelayJson(ws, {
    type: "event",
    event: "chat",
    payload: {
      state: "delta",
      timelineEvents: [{ eventType: "message.part.delta", content: [{ type: "text", text: "partial" }] }],
    },
  }, 100);

  assert.equal(result.status, "backpressure_skipped");
  assert.equal(result.aboveHighWaterMark, true);
  assert.ok(result.projectedBufferedAmount > 100);
  assert.deepEqual(sent, []);
});

test("sendRelayJson applies recoverable backpressure to streaming Office snapshots", () => {
  const sent: string[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 99,
    send: (value: string) => sent.push(value),
  } as unknown as WebSocket;

  const result = sendRelayJson(ws, {
    type: "event",
    event: "office",
    payload: {
      office: { kind: "writing", phase: "in_progress", detail: "partial" },
    },
  }, 100);

  assert.equal(result.status, "backpressure_skipped");
  assert.deepEqual(sent, []);
});

test("sendRelayJson disconnects instead of queueing non-recoverable frames above the limit", () => {
  const sent: string[] = [];
  const closes: Array<[number, string]> = [];
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 99,
    send: (value: string) => sent.push(value),
    close: (code: number, reason: string) => closes.push([code, reason]),
  } as unknown as WebSocket;

  const result = sendRelayJson(ws, { type: "res", ok: true }, 100);

  assert.equal(result.status, "backpressure_disconnected");
  assert.equal(result.aboveHighWaterMark, true);
  assert.deepEqual(sent, []);
  assert.deepEqual(closes, [[1013, "relay_backpressure"]]);
});

test("sustained non-stream events cannot keep growing a saturated socket queue", () => {
  const sent: string[] = [];
  let readyState: number = WebSocket.OPEN;
  let closeCount = 0;
  const ws = {
    get readyState() { return readyState; },
    bufferedAmount: 99,
    send: (value: string) => sent.push(value),
    close: () => {
      closeCount += 1;
      readyState = WebSocket.CLOSING;
    },
  } as unknown as WebSocket;

  const first = sendRelayJson(ws, {
    type: "event",
    event: "maintenance_log",
    payload: {
      line: "x".repeat(100),
    },
  }, 100);
  const second = sendRelayJson(ws, {
    type: "event",
    event: "maintenance_log",
    payload: { line: "another line" },
  }, 100);

  assert.equal(first.status, "backpressure_disconnected");
  assert.equal(second.status, "socket_not_open");
  assert.equal(closeCount, 1);
  assert.deepEqual(sent, []);
});

test("sendRelayJson allows one large frame when the socket queue is empty", () => {
  const sent: string[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (value: string) => sent.push(value),
    close: () => assert.fail("an empty queue must allow one complete frame"),
  } as unknown as WebSocket;

  const result = sendRelayJson(ws, { payload: "x".repeat(200) }, 100);

  assert.equal(result.status, "sent");
  assert.equal(result.aboveHighWaterMark, true);
  assert.equal(sent.length, 1);
});

test("sendRelayJson removes duplicate text mirrors from canonical streaming events", () => {
  const sent: string[] = [];
  const text = "x".repeat(50_000);
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (value: string) => sent.push(value),
  } as unknown as WebSocket;

  sendRelayJson(ws, {
    type: "event",
    event: "chat",
    payload: {
      state: "delta",
      role: "assistant",
      delta: text,
      text,
      data: { delta: text },
      message: { content: [{ type: "text", text }] },
      timelineEvents: [{ eventType: "message.part.delta", content: [{ type: "text", text }] }],
    },
  });

  const wire = JSON.parse(sent[0]!) as { payload: Record<string, unknown> };
  assert.equal(sent[0]!.match(/x{100}/g)?.length, 500);
  assert.equal(wire.payload.delta, undefined);
  assert.equal(wire.payload.message, undefined);
  assert.equal((wire.payload.timelineEvents as Array<{ content: Array<{ text: string }> }>)[0]?.content[0]?.text, text);
  assert.ok(Buffer.byteLength(sent[0]!) < 51_000);
});

test("stream compaction preserves non-text content blocks", () => {
  const sent: string[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (value: string) => sent.push(value),
  } as unknown as WebSocket;

  sendRelayJson(ws, {
    type: "event",
    event: "chat",
    payload: {
      state: "streaming",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "partial" },
          { type: "image", fileId: "file-1" },
        ],
      },
      timelineEvents: [{ eventType: "message.part.delta", content: [{ type: "text", text: "partial" }] }],
    },
  });

  const wire = JSON.parse(sent[0]!) as {
    payload: { message?: { role?: string; content?: unknown[] } };
  };
  assert.equal(wire.payload.message?.role, "assistant");
  assert.deepEqual(wire.payload.message?.content, [{ type: "image", fileId: "file-1" }]);
});

test("sendRelayJson reports a closed socket instead of pretending to send", () => {
  const ws = {
    readyState: WebSocket.CLOSED,
    bufferedAmount: 0,
    send: () => assert.fail("closed socket must not call send"),
  } as unknown as WebSocket;

  const result = sendRelayJson(ws, { type: "heartbeat" });

  assert.equal(result.status, "socket_not_open");
  assert.equal(result.byteLength, 0);
});

test("bindRelayAbortSignal closes with shutdown code on abort", () => {
  const controller = new AbortController();
  let closeCode = 0;
  let closeReason = "";
  const ws = {
    close: (code: number, reason: string) => {
      closeCode = code;
      closeReason = reason;
    },
  } as unknown as WebSocket;

  bindRelayAbortSignal(ws, controller.signal);
  controller.abort();
  assert.equal(closeCode, 1001);
  assert.equal(closeReason, "shutdown");
});

test("shouldRetryRelayClose stops retrying for replacement and shutdown closes", () => {
  const controller = new AbortController();
  assert.equal(shouldRetryRelayClose(1006, controller.signal), true);
  assert.equal(shouldRetryRelayClose(4000, controller.signal), false);
  controller.abort();
  assert.equal(shouldRetryRelayClose(1001, controller.signal), false);
});
