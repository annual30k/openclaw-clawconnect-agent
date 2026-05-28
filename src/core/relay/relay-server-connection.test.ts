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

  sendRelayJson(ws, { type: "heartbeat" });
  assert.deepEqual(sent, ['{"type":"heartbeat"}']);
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
