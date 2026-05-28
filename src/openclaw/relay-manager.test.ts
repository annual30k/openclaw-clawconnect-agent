import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

import { runRelayManager } from "./relay-manager.js";

test("relay manager forwards OpenClaw agent tool events to relay", async () => {
  const relayServer = new WebSocketServer({ port: 0 });
  const gatewayServer = new WebSocketServer({ port: 0 });
  const abort = new AbortController();
  const relayMessages: Array<Record<string, unknown>> = [];
  let gatewaySocket: WebSocket | undefined;

  relayServer.on("connection", (socket) => {
    socket.on("message", (raw) => {
      relayMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });

  gatewayServer.on("connection", (socket) => {
    gatewaySocket = socket;
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-1" },
    }));
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as {
        type?: string;
        id?: string;
        method?: string;
      };
      if (msg.type !== "req" || !msg.id) {
        return;
      }
      socket.send(JSON.stringify({ type: "res", id: msg.id, ok: true, payload: {} }));
      if (msg.method === "connect") {
        socket.send(JSON.stringify({
          type: "event",
          event: "agent",
          payload: {
            runId: "run-1",
            sessionKey: "main",
            stream: "tool",
            data: {
              phase: "start",
              toolCallId: "tool-1",
              name: "bash",
            },
          },
        }));
      }
    });
  });

  const relayAddress = relayServer.address();
  const gatewayAddress = gatewayServer.address();
  assert.ok(relayAddress && typeof relayAddress === "object");
  assert.ok(gatewayAddress && typeof gatewayAddress === "object");

  const manager = runRelayManager({
    relayServerUrl: `http://127.0.0.1:${relayAddress.port}`,
    gatewayId: "gw-test",
    relaySecret: "secret",
    gatewayUrl: `ws://127.0.0.1:${gatewayAddress.port}`,
    signal: abort.signal,
  });

  try {
    await waitFor(() => relayMessages.some((message) => {
      return message.type === "event" &&
        message.event === "agent" &&
        isRecord(message.payload) &&
        message.payload.runId === "run-1" &&
        isRecord(message.payload.data) &&
        message.payload.data.toolCallId === "tool-1";
    }), 4_000);
  } finally {
    abort.abort();
    gatewaySocket?.close(1000, "test done");
    await manager.catch(() => false);
    await closeServer(relayServer);
    await closeServer(gatewayServer);
  }
});

test("relay manager answers chat.history cursor pages from OpenClaw transcripts without forwarding to gateway", async () => {
  const openclawHome = await createOpenClawHomeFixture(12);
  const previousOpenClawHome = process.env.CLAWCONNECT_OPENCLAW_HOME;
  process.env.CLAWCONNECT_OPENCLAW_HOME = openclawHome.home;

  const relayServer = new WebSocketServer({ port: 0 });
  const gatewayServer = new WebSocketServer({ port: 0 });
  const abort = new AbortController();
  const relayMessages: Array<Record<string, unknown>> = [];
  const gatewayHistoryRequests: unknown[] = [];
  let relaySocket: WebSocket | undefined;
  let gatewaySocket: WebSocket | undefined;

  relayServer.on("connection", (socket) => {
    relaySocket = socket;
    socket.on("message", (raw) => {
      relayMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });

  gatewayServer.on("connection", (socket) => {
    gatewaySocket = socket;
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-1" },
    }));
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as {
        type?: string;
        id?: string;
        method?: string;
        params?: unknown;
      };
      if (msg.type !== "req" || !msg.id) {
        return;
      }
      if (msg.method === "chat.history") {
        gatewayHistoryRequests.push(msg.params);
      }
      socket.send(JSON.stringify({
        type: "res",
        id: msg.id,
        ok: true,
        payload: msg.method === "config.get" ? sessionDefaultsPayload() : {},
      }));
    });
  });

  const relayAddress = relayServer.address();
  const gatewayAddress = gatewayServer.address();
  assert.ok(relayAddress && typeof relayAddress === "object");
  assert.ok(gatewayAddress && typeof gatewayAddress === "object");

  const manager = runRelayManager({
    relayServerUrl: `http://127.0.0.1:${relayAddress.port}`,
    gatewayId: "gw-test",
    relaySecret: "secret",
    gatewayUrl: `ws://127.0.0.1:${gatewayAddress.port}`,
    signal: abort.signal,
  });

  try {
    await waitFor(() => Boolean(relaySocket) && relayMessages.some((message) => message.type === "gateway_connected"), 4_000);
    relaySocket?.send(JSON.stringify({
      type: "cmd",
      id: "history-1",
      method: "chat.history",
      params: {
        sessionKey: "agent:main:main",
        limit: 5,
        cursor: "seq:8",
        direction: "older",
      },
    }));

    await waitFor(() => relayMessages.some((message) => message.type === "res" && message.id === "history-1"), 4_000);
    const response = relayMessages.find((message) => message.type === "res" && message.id === "history-1");
    assert.equal(response?.ok, true);
    const payload = response?.payload as { messages?: Array<Record<string, unknown>>; hasMore?: boolean; nextCursor?: string; newestCursor?: string };
    assert.deepEqual(payload.messages?.map((message) => message.seq), [3, 4, 5, 6, 7]);
    assert.equal(payload.hasMore, true);
    assert.equal(payload.nextCursor, "seq:3");
    assert.equal(payload.newestCursor, "seq:7");
    assert.deepEqual(gatewayHistoryRequests, []);
  } finally {
    abort.abort();
    gatewaySocket?.close(1000, "test done");
    await manager.catch(() => false);
    await closeServer(relayServer);
    await closeServer(gatewayServer);
    if (previousOpenClawHome === undefined) {
      delete process.env.CLAWCONNECT_OPENCLAW_HOME;
    } else {
      process.env.CLAWCONNECT_OPENCLAW_HOME = previousOpenClawHome;
    }
    await openclawHome.cleanup();
  }
});

test("relay manager sanitizes legacy OpenClaw chat.history fallback params", async () => {
  const openclawHome = await createEmptyOpenClawHomeFixture();
  const previousOpenClawHome = process.env.CLAWCONNECT_OPENCLAW_HOME;
  process.env.CLAWCONNECT_OPENCLAW_HOME = openclawHome.home;

  const relayServer = new WebSocketServer({ port: 0 });
  const gatewayServer = new WebSocketServer({ port: 0 });
  const abort = new AbortController();
  const relayMessages: Array<Record<string, unknown>> = [];
  const gatewayHistoryRequests: unknown[] = [];
  let relaySocket: WebSocket | undefined;
  let gatewaySocket: WebSocket | undefined;

  relayServer.on("connection", (socket) => {
    relaySocket = socket;
    socket.on("message", (raw) => {
      relayMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });

  gatewayServer.on("connection", (socket) => {
    gatewaySocket = socket;
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-1" },
    }));
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as {
        type?: string;
        id?: string;
        method?: string;
        params?: unknown;
      };
      if (msg.type !== "req" || !msg.id) {
        return;
      }
      if (msg.method === "chat.history") {
        gatewayHistoryRequests.push(msg.params);
      }
      socket.send(JSON.stringify({
        type: "res",
        id: msg.id,
        ok: true,
        payload: msg.method === "chat.history"
          ? { messages: [{ role: "assistant", content: [{ type: "text", text: "legacy" }] }] }
          : msg.method === "config.get"
            ? sessionDefaultsPayload()
            : {},
      }));
    });
  });

  const relayAddress = relayServer.address();
  const gatewayAddress = gatewayServer.address();
  assert.ok(relayAddress && typeof relayAddress === "object");
  assert.ok(gatewayAddress && typeof gatewayAddress === "object");

  const manager = runRelayManager({
    relayServerUrl: `http://127.0.0.1:${relayAddress.port}`,
    gatewayId: "gw-test",
    relaySecret: "secret",
    gatewayUrl: `ws://127.0.0.1:${gatewayAddress.port}`,
    signal: abort.signal,
  });

  try {
    await waitFor(() => Boolean(relaySocket) && relayMessages.some((message) => message.type === "gateway_connected"), 4_000);
    relaySocket?.send(JSON.stringify({
      type: "cmd",
      id: "history-legacy",
      method: "chat.history",
      params: {
        sessionKey: "agent:main:main",
        limit: 7,
        cursor: "",
        direction: "older",
      },
    }));

    await waitFor(() => relayMessages.some((message) => message.type === "res" && message.id === "history-legacy"), 4_000);
    assert.deepEqual(gatewayHistoryRequests, [{ sessionKey: "agent:main:main", limit: 7 }]);
    const response = relayMessages.find((message) => message.type === "res" && message.id === "history-legacy");
    assert.equal(response?.ok, true);
  } finally {
    abort.abort();
    gatewaySocket?.close(1000, "test done");
    await manager.catch(() => false);
    await closeServer(relayServer);
    await closeServer(gatewayServer);
    if (previousOpenClawHome === undefined) {
      delete process.env.CLAWCONNECT_OPENCLAW_HOME;
    } else {
      process.env.CLAWCONNECT_OPENCLAW_HOME = previousOpenClawHome;
    }
    await openclawHome.cleanup();
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

async function closeServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function sessionDefaultsPayload(): Record<string, unknown> {
  return {
    snapshot: {
      sessionDefaults: {
        mainSessionKey: "agent:main:main",
        mainKey: "main",
        defaultAgentId: "main",
      },
    },
  };
}

async function createOpenClawHomeFixture(messageCount: number): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const fixture = await createEmptyOpenClawHomeFixture();
  const sessionsDir = join(fixture.home, "agents", "main", "sessions");
  const transcriptPath = join(sessionsDir, "session-1.jsonl");
  const messages = Array.from({ length: messageCount }, (_, index) => {
    const seq = index + 1;
    return {
      type: "message",
      id: `message-${seq}`,
      timestamp: new Date(Date.UTC(2026, 4, 28, 1, 0, seq)).toISOString(),
      message: {
        role: seq % 2 === 0 ? "assistant" : "user",
        content: [{ type: "text", text: `message ${seq}` }],
      },
    };
  });
  await writeFile(
    join(sessionsDir, "sessions.json"),
    `${JSON.stringify({
      "agent:main:main": {
        sessionId: "session-1",
        sessionFile: "session-1.jsonl",
      },
    })}\n`,
    "utf8",
  );
  await writeFile(transcriptPath, `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`, "utf8");
  return fixture;
}

async function createEmptyOpenClawHomeFixture(): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), "relay-manager-openclaw-home-"));
  await mkdir(join(home, "agents", "main", "sessions"), { recursive: true });
  return {
    home,
    cleanup: async () => {
      await rm(home, { recursive: true, force: true });
    },
  };
}
