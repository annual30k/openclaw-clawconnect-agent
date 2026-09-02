import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";
import { gatewayWebSocketOrigin, OpenClawGatewayClient } from "./gateway-client.js";

test("gatewayWebSocketOrigin maps secure and insecure Gateway URLs", () => {
  assert.equal(gatewayWebSocketOrigin("ws://localhost:18789/path?token=hidden"), "http://localhost:18789");
  assert.equal(gatewayWebSocketOrigin("wss://gateway.example.test/socket"), "https://gateway.example.test");
});

test("gateway client rejects pending requests when the gateway socket closes", async () => {
  const server = new WebSocketServer({ port: 0 });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  let activeSocket: import("ws").WebSocket | undefined;
  let connected = false;
  server.on("connection", (socket) => {
    activeSocket = socket;
    sendConnectChallenge(socket);
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { type?: string; id?: string; method?: string };
      if (msg.type === "req" && msg.method === "connect" && msg.id) {
        sendHelloOk(socket, msg.id);
      }
    });
  });

  const client = new OpenClawGatewayClient({
    url: `ws://127.0.0.1:${address.port}`,
    token: "test-token",
    onConnected: () => { connected = true; },
    onEvent: () => undefined,
    onDisconnected: () => undefined,
  });

  try {
    client.start();
    await waitFor(() => connected && activeSocket !== undefined);

    const pending = client.request("slow.command", {});
    activeSocket?.close(1011, "test close");

    await assert.rejects(pending, /gateway closed \(1011\): test close|gateway client stopped/);
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

test("gateway client advertises the supported WebChat identity and exact protocol", async () => {
  const server = new WebSocketServer({ port: 0 });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  let connectParams: {
    minProtocol?: number;
    maxProtocol?: number;
    client?: { id?: string; mode?: string; displayName?: string; version?: string; buildId?: string };
  } | undefined;
  let requestOrigin: string | undefined;
  let connected = false;
  server.on("connection", (socket, request) => {
    requestOrigin = request.headers.origin;
    sendConnectChallenge(socket);
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as {
        type?: string;
        id?: string;
        method?: string;
        params?: {
          minProtocol?: number;
          maxProtocol?: number;
          client?: { id?: string; mode?: string; displayName?: string; version?: string; buildId?: string };
        };
      };
      if (msg.type === "req" && msg.method === "connect" && msg.id) {
        connectParams = msg.params;
        sendHelloOk(socket, msg.id);
      }
    });
  });

  const client = new OpenClawGatewayClient({
    url: `ws://127.0.0.1:${address.port}`,
    token: "test-token",
    onConnected: () => { connected = true; },
    onEvent: () => undefined,
    onDisconnected: () => undefined,
  });

  try {
    client.start();
    await waitFor(() => connected && connectParams !== undefined);

    assert.equal(connectParams?.minProtocol, 4);
    assert.equal(connectParams?.maxProtocol, 4);
    assert.equal(connectParams?.client?.id, "webchat-ui");
    assert.equal(connectParams?.client?.mode, "webchat");
    assert.equal(connectParams?.client?.displayName, "ClawConnect Agent");
    assert.equal(connectParams?.client?.version, "0.2.4");
    assert.equal(connectParams?.client?.buildId, undefined);
    assert.equal(requestOrigin, `http://127.0.0.1:${address.port}`);
  } finally {
    client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
    sendConnectChallenge(socket);
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { type?: string; id?: string; method?: string };
      if (msg.type === "req" && msg.method === "connect" && msg.id) {
        sendHelloOk(socket, msg.id);
      }
    });
  });

  return state;
}

function sendConnectChallenge(socket: import("ws").WebSocket): void {
  socket.send(JSON.stringify({
    type: "event",
    event: "connect.challenge",
    payload: { nonce: "test-nonce", ts: Date.now() },
  }));
}

function sendHelloOk(socket: import("ws").WebSocket, id: string): void {
  socket.send(JSON.stringify({
    type: "res",
    id,
    ok: true,
    payload: {
      type: "hello-ok",
      protocol: 4,
      server: { version: "2026.8.2", connId: "test-connection" },
      features: { methods: [], events: [] },
      snapshot: {
        presence: [],
        health: { ok: true, ts: Date.now() },
        stateVersion: { presence: 1, health: 1 },
        uptimeMs: 1,
      },
    },
  }));
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
