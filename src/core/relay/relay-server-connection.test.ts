import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import {
  bindRelayAbortSignal,
  buildRelayUrl,
  parseRelayFrame,
  sendRelayJson,
  shouldRetryRelayClose,
} from "./relay-server-connection.js";

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
  const ws = {
    readyState: WebSocket.OPEN,
    send: (value: string) => sent.push(value),
  } as unknown as WebSocket;

  const result = sendRelayJson(ws, { type: "heartbeat" });
  assert.deepEqual(sent, ['{"type":"heartbeat"}']);
  assert.equal(result.status, "sent");
  assert.equal(result.aboveHighWaterMark, false);
  assert.equal(result.byteLength, Buffer.byteLength('{"type":"heartbeat"}'));
});

test("sendRelayJson reports backpressure but still sends the frame", () => {
  const sent: string[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 99,
    send: (value: string) => sent.push(value),
  } as unknown as WebSocket;

  const result = sendRelayJson(ws, { type: "res", ok: true }, 100);

  assert.equal(result.status, "sent");
  assert.equal(result.aboveHighWaterMark, true);
  assert.ok(result.projectedBufferedAmount > 100);
  assert.deepEqual(sent, ['{"type":"res","ok":true}']);
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
