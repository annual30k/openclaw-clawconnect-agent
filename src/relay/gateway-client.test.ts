import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";
import { OpenClawGatewayClient } from "./gateway-client.js";

test("gateway client rejects pending requests when the gateway socket closes", async () => {
  const server = new WebSocketServer({ port: 0 });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  let activeSocket: import("ws").WebSocket | undefined;
  server.on("connection", (socket) => {
    activeSocket = socket;
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { type?: string; id?: string; method?: string };
      if (msg.type === "req" && msg.method === "connect" && msg.id) {
        socket.send(JSON.stringify({ type: "res", id: msg.id, ok: true, payload: {} }));
      }
    });
  });

  const client = new OpenClawGatewayClient({
    url: `ws://127.0.0.1:${address.port}`,
    token: "test-token",
    onConnected: () => undefined,
    onEvent: () => undefined,
    onDisconnected: () => undefined,
  });

  try {
    client.start();
    await waitFor(() => activeSocket !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const pending = client.request("slow.command", {});
    activeSocket?.close(1011, "test close");

    await assert.rejects(pending, /gateway disconnected: test close|gateway client stopped/);
  } finally {
    client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("gateway client resolves the websocket URL before each reconnect", async () => {
  const firstServer = createConnectAckServer();
  const secondServer = createConnectAckServer();
  let currentUrl = firstServer.url;
  let connectedCount = 0;

  const client = new OpenClawGatewayClient({
    url: () => currentUrl,
    token: "test-token",
    onConnected: () => { connectedCount += 1; },
    onEvent: () => undefined,
    onDisconnected: () => undefined,
  });

  try {
    client.start();
    await waitFor(() => connectedCount === 1 && firstServer.activeSocket !== undefined, 4_000);

    currentUrl = secondServer.url;
    firstServer.activeSocket?.close(1012, "port changed");

    await waitFor(() => connectedCount === 2 && secondServer.activeSocket !== undefined, 5_000);
  } finally {
    client.stop();
    await firstServer.close();
    await secondServer.close();
  }
});

function createConnectAckServer(): {
  url: string;
  activeSocket?: import("ws").WebSocket;
  close: () => Promise<void>;
} {
  const server = new WebSocketServer({ port: 0 });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const state: {
    url: string;
    activeSocket?: import("ws").WebSocket;
    close: () => Promise<void>;
  } = {
    url: `ws://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };

  server.on("connection", (socket) => {
    state.activeSocket = socket;
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { type?: string; id?: string; method?: string };
      if (msg.type === "req" && msg.method === "connect" && msg.id) {
        socket.send(JSON.stringify({ type: "res", id: msg.id, ok: true, payload: {} }));
      }
    });
  });

  return state;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}
