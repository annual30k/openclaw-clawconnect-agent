import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import test, { after, afterEach } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

import { runRelayManager as runRelayManagerImplementation } from "./relay-manager.js";
import type { RelayManagerOptions } from "./relay/relay-manager-protocol.js";
import { openClawChatRunIdentities } from "./relay/chat-run-identity.js";
import { clearReliableRelayOutboxesForTests } from "../core/relay/reliable-relay-outbox-registry.js";

const reliableOutboxStorageDirectory = mkdtempSync(join(tmpdir(), "clawconnect-openclaw-manager-test-"));

afterEach(() => {
  clearReliableRelayOutboxesForTests();
  rmSync(reliableOutboxStorageDirectory, { recursive: true, force: true });
  mkdirSync(reliableOutboxStorageDirectory, { recursive: true });
});

after(() => rmSync(reliableOutboxStorageDirectory, { recursive: true, force: true }));

function runRelayManager(opts: RelayManagerOptions): Promise<boolean> {
  return runRelayManagerImplementation({ ...opts, reliableOutboxStorageDirectory });
}

test("relay manager reconnects on missing Relay hello instead of silently selecting legacy mode", async () => {
  const relayServer = new WebSocketServer({ port: 0 });
  const gatewayServer = new WebSocketServer({ port: 0 });
  let relayClose: { code: number; reason: string } | undefined;

  relayServer.on("connection", (socket) => {
    socket.on("close", (code, reason) => {
      relayClose = { code, reason: reason.toString() };
    });
  });

  const relayAddress = relayServer.address();
  const gatewayAddress = gatewayServer.address();
  assert.ok(relayAddress && typeof relayAddress === "object");
  assert.ok(gatewayAddress && typeof gatewayAddress === "object");

  const retry = await runRelayManager({
    relayServerUrl: `http://127.0.0.1:${relayAddress.port}`,
    gatewayId: "gw-hello-timeout",
    relaySecret: "secret",
    gatewayUrl: `ws://127.0.0.1:${gatewayAddress.port}`,
    relayHelloTimeoutMs: 25,
  });

  await waitFor(() => relayClose !== undefined);
  assert.equal(retry, true);
  assert.deepEqual(relayClose, { code: 1013, reason: "relay_hello_timeout" });
  await closeServer(relayServer);
  await closeServer(gatewayServer);
});

test("relay manager forwards OpenClaw agent tool events to relay", async () => {
  const relayServer = new WebSocketServer({ port: 0 });
  const gatewayServer = new WebSocketServer({ port: 0 });
  const abort = new AbortController();
  const relayMessages: Array<Record<string, unknown>> = [];
  let gatewaySocket: WebSocket | undefined;

  relayServer.on("connection", (socket) => {
    sendRelayHello(socket, "gw-test");
    socket.on("message", (raw) => {
      relayMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });

  gatewayServer.on("connection", (socket) => {
    gatewaySocket = socket;
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-1", ts: Date.now() },
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

test("relay manager subscribes before chat.send and streams canonical OpenClaw tool and text events", async () => {
  const relayServer = new WebSocketServer({ port: 0 });
  const gatewayServer = new WebSocketServer({ port: 0 });
  const abort = new AbortController();
  const relayMessages: Array<Record<string, unknown>> = [];
  const gatewayMethods: string[] = [];
  let gatewaySocket: WebSocket | undefined;
  let relaySocket: WebSocket | undefined;
  let sessionMessagesSubscribed = false;

  relayServer.on("connection", (socket) => {
    relaySocket = socket;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      relayMessages.push(message);
    });
  });

  gatewayServer.on("connection", (socket) => {
    gatewaySocket = socket;
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-agent-tool", ts: Date.now() },
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
      if (msg.method) {
        gatewayMethods.push(msg.method);
      }
      if (msg.method === "connect") {
        socket.send(JSON.stringify({ type: "res", id: msg.id, ok: true, payload: {} }));
        return;
      }
      if (msg.method === "sessions.messages.subscribe") {
        sessionMessagesSubscribed = true;
        socket.send(JSON.stringify({
          type: "res",
          id: msg.id,
          ok: true,
          payload: { subscribed: true, key: "agent:main:main" },
        }));
        return;
      }
      if (msg.method === "chat.send") {
        socket.send(JSON.stringify({
          type: "res",
          id: msg.id,
          ok: true,
          payload: { runId: "openclaw-run-456" },
        }));
        if (!sessionMessagesSubscribed) {
          return;
        }
        socket.send(JSON.stringify({
          type: "event",
          event: "agent",
          payload: {
            runId: "openclaw-run-456",
            sessionKey: "main",
            stream: "tool",
            data: {
              phase: "start",
              toolCallId: "tool-weather-1",
              name: "weather",
            },
          },
        }));
        socket.send(JSON.stringify({
          type: "event",
          event: "chat",
          payload: {
            runId: "openclaw-run-456",
            sessionKey: "main",
            state: "delta",
            role: "assistant",
            seq: 1,
            delta: "天气查询中",
          },
        }));
        return;
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
    await waitFor(() => Boolean(relaySocket) && relayMessages.some((m) => m.type === "gateway_connected"), 4_000);
    relaySocket?.send(JSON.stringify({
      type: "cmd",
      id: "send-tool-1",
      method: "chat.send",
      params: {
        sessionKey: "main",
        message: "查天气",
        idempotencyKey: "wx-run-weather-canonical",
      },
    }));

    await waitFor(() => relayMessages.some((message) => {
      return message.type === "event" &&
        message.event === "agent" &&
        isRecord(message.payload) &&
        message.payload.runId === "wx-run-weather-canonical" &&
        isRecord(message.payload.data) &&
        message.payload.data.toolCallId === "tool-weather-1" &&
        message.payload.data.name === "weather";
    }), 4_000);
    await waitFor(() => relayMessages.some((message) => (
      message.type === "event" &&
      message.event === "chat" &&
      isRecord(message.payload) &&
      message.payload.runId === "wx-run-weather-canonical" &&
      message.payload.state === "delta" &&
      extractPayloadText(message.payload) === "天气查询中"
    )), 4_000);
    assert.ok(
      gatewayMethods.indexOf("sessions.messages.subscribe") < gatewayMethods.indexOf("chat.send"),
      "the session must be subscribed before chat.send starts the run",
    );
  } finally {
    abort.abort();
    gatewaySocket?.close(1000, "test done");
    await manager.catch(() => false);
    await closeServer(relayServer);
    await closeServer(gatewayServer);
  }
});

test("relay manager publishes OpenClaw chat deltas as accumulated assistant text", async () => {
  const relayServer = new WebSocketServer({ port: 0 });
  const gatewayServer = new WebSocketServer({ port: 0 });
  const abort = new AbortController();
  const relayMessages: Array<Record<string, unknown>> = [];
  let gatewaySocket: WebSocket | undefined;

  relayServer.on("connection", (socket) => {
    sendRelayHello(socket, "gw-test");
    socket.on("message", (raw) => {
      relayMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });

  gatewayServer.on("connection", (socket) => {
    gatewaySocket = socket;
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-1", ts: Date.now() },
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
          event: "chat",
          payload: {
            runId: "run-1",
            sessionKey: "main",
            state: "delta",
            role: "assistant",
            seq: 1,
            delta: "hello ",
          },
        }));
        socket.send(JSON.stringify({
          type: "event",
          event: "chat",
          payload: {
            runId: "run-1",
            sessionKey: "main",
            state: "delta",
            role: "assistant",
            seq: 2,
            delta: "world",
          },
        }));
        socket.send(JSON.stringify({
          type: "event",
          event: "chat",
          payload: {
            runId: "run-1",
            sessionKey: "main",
            state: "final",
            role: "assistant",
            seq: 3,
            text: "hello world",
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
      if (message.type !== "event" || message.event !== "chat" || !isRecord(message.payload)) {
        return false;
      }
      return extractPayloadText(message.payload) === "hello world";
    }), 4_000);
    const accumulatedPayload = relayMessages
      .filter((message) => message.type === "event" && message.event === "chat" && isRecord(message.payload))
      .map((message) => message.payload as Record<string, unknown>)
      .find((payload) => payload.state === "delta" && extractPayloadText(payload) === "hello world");
    assert.ok(accumulatedPayload);
    const deltaEvents = timelineEvents(accumulatedPayload);
    assert.equal(deltaEvents[0]?.eventType, "message.part.delta");
    assert.equal(deltaEvents[0]?.runId, "run-1");
    assert.equal(deltaEvents[0]?.turnId, "run-1");
    assert.equal(deltaEvents[0]?.messageId, "assistant-run-1");
    assert.equal(deltaEvents[0]?.seq, 2);
    assert.deepEqual(deltaEvents[0]?.content, [{ type: "text", text: "hello world" }]);
    const runChatFrames = relayMessages
      .filter((message) => message.type === "event" && message.event === "chat" && isRecord(message.payload))
      .map((message) => message.payload as Record<string, unknown>)
      .filter((payload) => payload.runId === "run-1");
    assert.equal(runChatFrames.filter((payload) => payload.state === "delta").length, 1);

    await waitFor(() => relayMessages.some((message) => {
      if (message.type !== "event" || message.event !== "chat" || !isRecord(message.payload)) {
        return false;
      }
      const events = timelineEvents(message.payload);
      return message.payload.state === "final" &&
        events.some((event) => event.eventType === "message.completed") &&
        events.some((event) => event.eventType === "run.completed");
    }), 4_000);
    const orderedRunStates = relayMessages
      .filter((message) => message.type === "event" && message.event === "chat" && isRecord(message.payload))
      .map((message) => message.payload as Record<string, unknown>)
      .filter((payload) => payload.runId === "run-1")
      .map((payload) => payload.state);
    assert.deepEqual(orderedRunStates, ["delta", "final"]);
    const writingOfficeFrames = relayMessages.filter((message) => (
      message.type === "event" &&
      message.event === "office" &&
      isRecord(message.payload) &&
      isRecord(message.payload.office) &&
      message.payload.office.kind === "writing" &&
      message.payload.office.detail === "hello world"
    ));
    assert.equal(writingOfficeFrames.length, 1);
  } finally {
    abort.abort();
    gatewaySocket?.close(1000, "test done");
    await manager.catch(() => false);
    await closeServer(relayServer);
    await closeServer(gatewayServer);
  }
});

test("relay manager projects an OpenClaw assistant-media sidecar onto the parent canonical message identity", async () => {
  const relayServer = new WebSocketServer({ port: 0 });
  const gatewayServer = new WebSocketServer({ port: 0 });
  const abort = new AbortController();
  const relayMessages: Array<Record<string, unknown>> = [];
  let gatewaySocket: WebSocket | undefined;
  const runId = "wx_1787558915948_espv455s";

  relayServer.on("connection", (socket) => {
    sendRelayHello(socket, "gw-sidecar");
    socket.on("message", (raw) => relayMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
  });
  gatewayServer.on("connection", (socket) => {
    gatewaySocket = socket;
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-sidecar", ts: Date.now() } }));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { type?: string; id?: string; method?: string };
      if (message.type !== "req" || !message.id) return;
      socket.send(JSON.stringify({ type: "res", id: message.id, ok: true, payload: {} }));
      if (message.method !== "connect") return;
      socket.send(JSON.stringify({
        type: "event",
        event: "chat",
        payload: {
          runId,
          sessionKey: "main",
          state: "final",
          role: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "桌面只找到一张图片\nMEDIA:/Users/example/Desktop/photo.png" }] },
        },
      }));
      socket.send(JSON.stringify({
        type: "event",
        event: "chat",
        payload: {
          runId,
          sessionKey: "main",
          state: "final",
          role: "assistant",
          message: {
            role: "assistant",
            idempotencyKey: `${runId}:assistant-media`,
            content: [
              { type: "text", text: "桌面只找到一张图片" },
              { type: "image", url: "/api/chat/media/outgoing/agent%3Amain%3Asession_1/att_missing/full" },
            ],
          },
        },
      }));
    });
  });
  const relayAddress = relayServer.address();
  const gatewayAddress = gatewayServer.address();
  assert.ok(relayAddress && typeof relayAddress === "object");
  assert.ok(gatewayAddress && typeof gatewayAddress === "object");
  const manager = runRelayManager({
    relayServerUrl: `http://127.0.0.1:${relayAddress.port}`,
    gatewayId: "gw-sidecar",
    relaySecret: "secret",
    gatewayUrl: `ws://127.0.0.1:${gatewayAddress.port}`,
    signal: abort.signal,
  });
  try {
    await waitFor(() => relayMessages.filter((message) => (
      message.type === "event" && message.event === "chat" && isRecord(message.payload) && message.payload.state === "final"
    )).length === 2, 4_000);
    const terminals = relayMessages.filter((message) => (
      message.type === "event" && message.event === "chat" && isRecord(message.payload) && message.payload.state === "final"
    ));
    assert.equal(terminals.length, 2);
    assert.equal(extractPayloadText(terminals[0]!.payload as Record<string, unknown>), "桌面只找到一张图片");
    assert.equal(extractPayloadText(terminals[1]!.payload as Record<string, unknown>), "桌面只找到一张图片");
    const completed = terminals.map((terminal) => timelineEvents(terminal.payload as Record<string, unknown>)
      .find((event) => event.eventType === "message.completed"));
    assert.deepEqual(completed.map((event) => event?.messageId), [`assistant-${runId}`, `assistant-${runId}`]);
    assert.deepEqual(completed[1]?.content?.[0], { type: "text", text: "桌面只找到一张图片" });
    const attachment = completed[1]?.content?.[1] as Record<string, unknown> | undefined;
    assert.equal(attachment?.type, "image");
    assert.equal(attachment?.transferState, "expired");
    assert.equal(attachment?.isRemoteExpired, true);
  } finally {
    abort.abort();
    gatewaySocket?.close(1000, "test done");
    await manager.catch(() => false);
    await closeServer(relayServer);
    await closeServer(gatewayServer);
  }
});

test("relay manager replaces the OpenClaw media display placeholder with source-run media history", async () => {
  const relayServer = new WebSocketServer({ port: 0 });
  const gatewayServer = new WebSocketServer({ port: 0 });
  const abort = new AbortController();
  const relayMessages: Array<Record<string, unknown>> = [];
  let gatewaySocket: WebSocket | undefined;
  const runId = "wx_media_history_parent";

  relayServer.on("connection", (socket) => {
    sendRelayHello(socket, "gw-media-history");
    socket.on("message", (raw) => relayMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
  });
  gatewayServer.on("connection", (socket) => {
    gatewaySocket = socket;
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-media-history", ts: Date.now() } }));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { type?: string; id?: string; method?: string };
      if (message.type !== "req" || !message.id) return;
      const history = message.method === "chat.history"
        ? {
            sessionKey: "main",
            messages: [
              {
                id: "user-media-history",
                role: "user",
                idempotencyKey: `${runId}:user`,
                content: [{ type: "text", text: "把图片发过来" }],
              },
              {
                id: "assistant-media-history",
                role: "assistant",
                runId,
                content: [{ type: "text", text: "图片已经发过来" }],
              },
              {
                id: "message-tool-media-history",
                role: "assistant",
                sourceRunId: runId,
                content: [{ type: "image", url: "/api/chat/media/outgoing/agent%3Amain%3Amain/att_history/full" }],
              },
            ],
          }
        : {};
      socket.send(JSON.stringify({ type: "res", id: message.id, ok: true, payload: history }));
      if (message.method !== "connect") return;
      socket.send(JSON.stringify({
        type: "event",
        event: "chat",
        payload: {
          runId,
          sessionKey: "main",
          state: "final",
          role: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Media reply could not be displayed." }] },
        },
      }));
    });
  });
  const relayAddress = relayServer.address();
  const gatewayAddress = gatewayServer.address();
  assert.ok(relayAddress && typeof relayAddress === "object");
  assert.ok(gatewayAddress && typeof gatewayAddress === "object");
  const manager = runRelayManager({
    relayServerUrl: `http://127.0.0.1:${relayAddress.port}`,
    gatewayId: "gw-media-history",
    relaySecret: "secret",
    gatewayUrl: `ws://127.0.0.1:${gatewayAddress.port}`,
    signal: abort.signal,
  });
  try {
    await waitFor(() => relayMessages.some((message) => (
      message.type === "event"
      && message.event === "chat"
      && extractPayloadText(message.payload as Record<string, unknown>) === "图片已经发过来"
    )), 4_000);
    const final = relayMessages.find((message) => (
      message.type === "event"
      && message.event === "chat"
      && extractPayloadText(message.payload as Record<string, unknown>) === "图片已经发过来"
    ));
    assert.ok(final);
    const completed = timelineEvents(final.payload as Record<string, unknown>)
      .find((event) => event.eventType === "message.completed");
    assert.deepEqual(completed?.content?.[0], { type: "text", text: "图片已经发过来" });
    const attachment = completed?.content?.[1] as Record<string, unknown> | undefined;
    assert.equal(attachment?.type, "image");
    assert.equal(attachment?.transferState, "expired");
    assert.equal(relayMessages.some((message) => (
      message.type === "event"
      && message.event === "chat"
      && extractPayloadText(message.payload as Record<string, unknown>) === "Media reply could not be displayed."
    )), false);
  } finally {
    abort.abort();
    gatewaySocket?.close(1000, "test done");
    await manager.catch(() => false);
    await closeServer(relayServer);
    await closeServer(gatewayServer);
  }
});

test("relay manager keeps mobile chat identity across provider events and transcript history", async () => {
  openClawChatRunIdentities.clear();
  const openclawHome = await createEmptyOpenClawHomeFixture();
  const previousOpenClawHome = process.env.CLAWCONNECT_OPENCLAW_HOME;
  process.env.CLAWCONNECT_OPENCLAW_HOME = openclawHome.home;
  const sessionsDir = join(openclawHome.home, "agents", "main", "sessions");
  const transcriptPath = join(sessionsDir, "session-identity.jsonl");
  await writeFile(
    join(sessionsDir, "sessions.json"),
    `${JSON.stringify({
      "agent:main:main": {
        sessionId: "session-identity",
        sessionFile: "session-identity.jsonl",
      },
    })}\n`,
    "utf8",
  );
  await writeFile(transcriptPath, "", "utf8");

  const relayServer = new WebSocketServer({ port: 0 });
  const gatewayServer = new WebSocketServer({ port: 0 });
  const abort = new AbortController();
  const relayMessages: Array<Record<string, unknown>> = [];
  const gatewayAbortParams: Array<Record<string, unknown>> = [];
  let relaySocket: WebSocket | undefined;
  let gatewaySocket: WebSocket | undefined;

  relayServer.on("connection", (socket) => {
    relaySocket = socket;
    sendRelayHello(socket, "gw-stable-identity");
    socket.on("message", (raw) => {
      relayMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });
  gatewayServer.on("connection", (socket) => {
    gatewaySocket = socket;
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-stable-identity", ts: Date.now() },
    }));
    socket.on("message", (raw) => {
      void (async () => {
        const message = JSON.parse(raw.toString()) as {
          type?: string;
          id?: string;
          method?: string;
          params?: Record<string, unknown>;
        };
        if (message.type !== "req" || !message.id) {
          return;
        }
        if (message.method === "chat.abort") {
          gatewayAbortParams.push(message.params ?? {});
          socket.send(JSON.stringify({ type: "res", id: message.id, ok: true, payload: { aborted: true } }));
          return;
        }
        if (message.method !== "chat.send") {
          socket.send(JSON.stringify({
            type: "res",
            id: message.id,
            ok: true,
            payload: sessionDefaultsPayload(),
          }));
          return;
        }

        const mobileRunId = String(message.params?.idempotencyKey);
        await writeFile(transcriptPath, [
          JSON.stringify({
            type: "message",
            id: "transcript-user-stable",
            parentId: "previous-assistant",
            message: {
              role: "user",
              content: message.params?.message,
              idempotencyKey: `${mobileRunId}:user`,
            },
          }),
          JSON.stringify({
            type: "message",
            id: "transcript-assistant-stable",
            parentId: "transcript-user-stable",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "canonical answer" }],
              stopReason: "stop",
            },
          }),
        ].join("\n") + "\n", "utf8");
        socket.send(JSON.stringify({
          type: "res",
          id: message.id,
          ok: true,
          payload: { runId: "provider-run-stable", status: "started" },
        }));
        setImmediate(() => {
          socket.send(JSON.stringify({
            type: "event",
            event: "chat",
            payload: {
              runId: "provider-run-stable",
              sessionKey: "agent:main:main",
              state: "delta",
              role: "assistant",
              seq: 1,
              delta: "canonical ",
            },
          }));
          socket.send(JSON.stringify({
            type: "event",
            event: "chat",
            payload: {
              runId: "provider-run-stable",
              sessionKey: "agent:main:main",
              state: "final",
              role: "assistant",
              seq: 2,
              text: "canonical answer",
            },
          }));
        });
      })();
    });
  });

  const relayAddress = relayServer.address();
  const gatewayAddress = gatewayServer.address();
  assert.ok(relayAddress && typeof relayAddress === "object");
  assert.ok(gatewayAddress && typeof gatewayAddress === "object");
  const manager = runRelayManager({
    relayServerUrl: `http://127.0.0.1:${relayAddress.port}`,
    gatewayId: "gw-stable-identity",
    relaySecret: "secret",
    gatewayUrl: `ws://127.0.0.1:${gatewayAddress.port}`,
    signal: abort.signal,
  });

  try {
    await waitFor(() => Boolean(relaySocket) && relayMessages.some((message) => message.type === "gateway_connected"), 4_000);
    relaySocket?.send(JSON.stringify({
      type: "cmd",
      id: "send-stable-identity",
      method: "chat.send",
      params: {
        sessionKey: "agent:main:main",
        message: "stable prompt",
        idempotencyKey: "mobile-run-stable",
      },
    }));

    await waitFor(() => relayMessages.some((message) => message.type === "res" && message.id === "send-stable-identity"), 4_000);
    const sendResponse = relayMessages.find((message) => message.type === "res" && message.id === "send-stable-identity");
    assert.equal((sendResponse?.payload as Record<string, unknown> | undefined)?.runId, "mobile-run-stable");
    assert.equal(JSON.stringify(sendResponse?.payload).includes("provider-run-stable"), false);

    await waitFor(() => relayMessages.some((message) => {
      if (message.type !== "event" || message.event !== "chat" || !isRecord(message.payload)) {
        return false;
      }
      return message.payload.state === "final" && extractPayloadText(message.payload) === "canonical answer";
    }), 4_000);
    const livePayloads = relayMessages
      .filter((message) => message.type === "event" && message.event === "chat" && isRecord(message.payload))
      .map((message) => message.payload as Record<string, unknown>)
      .filter((payload) => payload.state === "delta" || payload.state === "final");
    assert.ok(livePayloads.length >= 2);
    for (const payload of livePayloads) {
      assert.equal(payload.runId, "mobile-run-stable");
      for (const event of timelineEvents(payload)) {
        assert.equal(event.runId, "mobile-run-stable");
        assert.equal(event.turnId, "mobile-run-stable");
        if (event.eventType === "message.part.delta" || event.eventType === "message.completed") {
          assert.equal(event.messageId, "assistant-mobile-run-stable");
        }
      }
    }

    relaySocket?.send(JSON.stringify({
      type: "cmd",
      id: "abort-stable-identity",
      method: "chat.abort",
      params: {
        sessionKey: "agent:main:main",
        runId: "mobile-run-stable",
      },
    }));
    await waitFor(() => relayMessages.some((message) => message.type === "res" && message.id === "abort-stable-identity"), 4_000);
    assert.deepEqual(gatewayAbortParams, [{
      sessionKey: "agent:main:main",
      runId: "provider-run-stable",
    }]);

    relaySocket?.send(JSON.stringify({
      type: "cmd",
      id: "history-stable-identity",
      method: "chat.history",
      params: { sessionKey: "agent:main:main", limit: 10 },
    }));
    await waitFor(() => relayMessages.some((message) => message.type === "res" && message.id === "history-stable-identity"), 4_000);
    const historyResponse = relayMessages.find((message) => message.type === "res" && message.id === "history-stable-identity");
    const historyPayload = historyResponse?.payload as {
      timelineSnapshot?: { messages?: Array<Record<string, unknown>> };
    } | undefined;
    const historyAssistant = historyPayload?.timelineSnapshot?.messages?.find((message) => message.role === "assistant");
    assert.deepEqual({
      runId: historyAssistant?.runId,
      turnId: historyAssistant?.turnId,
      messageId: historyAssistant?.messageId,
    }, {
      runId: "mobile-run-stable",
      turnId: "mobile-run-stable",
      messageId: "assistant-mobile-run-stable",
    });
  } finally {
    abort.abort();
    gatewaySocket?.close(1000, "test done");
    await manager.catch(() => false);
    await closeServer(relayServer);
    await closeServer(gatewayServer);
    openClawChatRunIdentities.clear();
    if (previousOpenClawHome === undefined) {
      delete process.env.CLAWCONNECT_OPENCLAW_HOME;
    } else {
      process.env.CLAWCONNECT_OPENCLAW_HOME = previousOpenClawHome;
    }
    await openclawHome.cleanup();
  }
});

test("relay manager does not complete an OpenClaw run for a thinking plus toolCall preamble", async () => {
  openClawChatRunIdentities.clear();
  const openclawHome = await createEmptyOpenClawHomeFixture();
  const previousOpenClawHome = process.env.CLAWCONNECT_OPENCLAW_HOME;
  process.env.CLAWCONNECT_OPENCLAW_HOME = openclawHome.home;
  const sessionsDir = join(openclawHome.home, "agents", "main", "sessions");
  const transcriptPath = join(sessionsDir, "session-tool-preamble.jsonl");
  await writeFile(
    join(sessionsDir, "sessions.json"),
    `${JSON.stringify({
      "agent:main:main": {
        sessionId: "session-tool-preamble",
        sessionFile: "session-tool-preamble.jsonl",
      },
    })}\n`,
    "utf8",
  );

  const mobileRunId = "mobile-run-tool-preamble";
  const providerRunId = "provider-run-tool-preamble";
  const writeTranscript = async (includeFinalAnswer: boolean): Promise<void> => {
    const rows = [
      {
        type: "message",
        id: "tool-preamble-user",
        parentId: "previous-assistant",
        message: {
          role: "user",
          content: "wait for the tool",
          idempotencyKey: `${mobileRunId}:user`,
        },
      },
      {
        type: "message",
        id: "tool-preamble-assistant",
        parentId: "tool-preamble-user",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should run the tool before replying." },
            {
              type: "toolCall",
              id: "tool-wait",
              name: "exec",
              arguments: { command: "wait" },
            },
          ],
        },
      },
    ];
    if (includeFinalAnswer) {
      rows.push({
        type: "message",
        id: "tool-preamble-final",
        parentId: "tool-preamble-assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "tool finished" }],
        },
      });
    }
    await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  };
  await writeTranscript(false);

  const relayServer = new WebSocketServer({ port: 0 });
  const gatewayServer = new WebSocketServer({ port: 0 });
  const abort = new AbortController();
  const relayMessages: Array<Record<string, unknown>> = [];
  let relaySocket: WebSocket | undefined;
  let gatewaySocket: WebSocket | undefined;

  relayServer.on("connection", (socket) => {
    relaySocket = socket;
    sendRelayHello(socket, "gw-tool-preamble");
    socket.on("message", (raw) => {
      relayMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });
  gatewayServer.on("connection", (socket) => {
    gatewaySocket = socket;
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-tool-preamble", ts: Date.now() },
    }));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as {
        type?: string;
        id?: string;
        method?: string;
      };
      if (message.type !== "req" || !message.id) {
        return;
      }
      if (message.method === "chat.send") {
        socket.send(JSON.stringify({
          type: "res",
          id: message.id,
          ok: true,
          payload: { runId: providerRunId, status: "started" },
        }));
        setImmediate(() => {
          socket.send(JSON.stringify({
            type: "event",
            event: "chat",
            payload: {
              runId: providerRunId,
              sessionKey: "agent:main:main",
              state: "final",
              role: "assistant",
              text: "",
            },
          }));
        });
        return;
      }
      socket.send(JSON.stringify({
        type: "res",
        id: message.id,
        ok: true,
        payload: sessionDefaultsPayload(),
      }));
    });
  });

  const relayAddress = relayServer.address();
  const gatewayAddress = gatewayServer.address();
  assert.ok(relayAddress && typeof relayAddress === "object");
  assert.ok(gatewayAddress && typeof gatewayAddress === "object");
  const manager = runRelayManager({
    relayServerUrl: `http://127.0.0.1:${relayAddress.port}`,
    gatewayId: "gw-tool-preamble",
    relaySecret: "secret",
    gatewayUrl: `ws://127.0.0.1:${gatewayAddress.port}`,
    signal: abort.signal,
  });

  const terminalEvents = (): Array<Record<string, unknown>> => relayMessages.flatMap((message) => {
    if (message.type !== "event" || message.event !== "chat" || !isRecord(message.payload)) {
      return [];
    }
    return timelineEvents(message.payload).filter((event) => (
      event.runId === mobileRunId && event.eventType === "run.completed"
    ));
  });

  try {
    await waitFor(() => Boolean(relaySocket) && relayMessages.some((message) => message.type === "gateway_connected"), 4_000);
    relaySocket?.send(JSON.stringify({
      type: "cmd",
      id: "send-tool-preamble",
      method: "chat.send",
      params: {
        sessionKey: "agent:main:main",
        message: "wait for the tool",
        idempotencyKey: mobileRunId,
      },
    }));
    await waitFor(() => relayMessages.some((message) => message.type === "res" && message.id === "send-tool-preamble"), 4_000);

    // Wait beyond the immediate history read and its retry. The tool preamble must not
    // be projected as a terminal assistant reply while the actual tool is still running.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.deepEqual(terminalEvents(), []);

    await writeTranscript(true);
    gatewaySocket?.send(JSON.stringify({
      type: "event",
      event: "chat",
      payload: {
        runId: providerRunId,
        sessionKey: "agent:main:main",
        state: "final",
        role: "assistant",
        text: "tool finished",
      },
    }));
    await waitFor(() => terminalEvents().length === 1, 4_000);
    await new Promise((resolve) => setTimeout(resolve, 1_350));
    assert.equal(terminalEvents().length, 1);
  } finally {
    abort.abort();
    gatewaySocket?.close(1000, "test done");
    await manager.catch(() => false);
    await closeServer(relayServer);
    await closeServer(gatewayServer);
    openClawChatRunIdentities.clear();
    if (previousOpenClawHome === undefined) {
      delete process.env.CLAWCONNECT_OPENCLAW_HOME;
    } else {
      process.env.CLAWCONNECT_OPENCLAW_HOME = previousOpenClawHome;
    }
    await openclawHome.cleanup();
  }
});

test("relay manager restores identity and cumulative assistant text after Relay WebSocket reconnect", async () => {
  openClawChatRunIdentities.clear();
  const relayServer = new WebSocketServer({ port: 0 });
  const gatewayServer = new WebSocketServer({ port: 0 });
  const relayMessages: Array<Record<string, unknown>> = [];
  const relaySockets: WebSocket[] = [];
  const gatewaySockets: WebSocket[] = [];
  let gatewayConnectionCount = 0;

  relayServer.on("connection", (socket) => {
    relaySockets.push(socket);
    sendRelayHello(socket, "gw-identity-reconnect", true);
    socket.on("message", (raw) => {
      relayMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });
  gatewayServer.on("connection", (socket) => {
    gatewaySockets.push(socket);
    gatewayConnectionCount += 1;
    const connectionNumber = gatewayConnectionCount;
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: `nonce-reconnect-${connectionNumber}`, ts: Date.now() },
    }));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as {
        type?: string;
        id?: string;
        method?: string;
      };
      if (message.type !== "req" || !message.id) {
        return;
      }
      if (message.method === "chat.send") {
        socket.send(JSON.stringify({
          type: "res",
          id: message.id,
          ok: true,
          payload: { runId: "provider-run-reconnect" },
        }));
        if (connectionNumber === 1) {
          setImmediate(() => {
            socket.send(JSON.stringify({
              type: "event",
              event: "chat",
              payload: {
                runId: "provider-run-reconnect",
                sessionKey: "agent:main:main",
                state: "delta",
                role: "assistant",
                text: "hello ",
                seq: 1,
              },
            }));
          });
        }
        return;
      }
      socket.send(JSON.stringify({
        type: "res",
        id: message.id,
        ok: true,
        payload: sessionDefaultsPayload(),
      }));
      if (message.method === "connect" && connectionNumber === 2) {
        setImmediate(() => {
          socket.send(JSON.stringify({
            type: "event",
            event: "chat",
            payload: {
              runId: "provider-run-reconnect",
              sessionKey: "agent:main:main",
              state: "final",
              role: "assistant",
              text: "world",
            },
          }));
        });
      }
    });
  });

  const relayAddress = relayServer.address();
  const gatewayAddress = gatewayServer.address();
  assert.ok(relayAddress && typeof relayAddress === "object");
  assert.ok(gatewayAddress && typeof gatewayAddress === "object");
  const managerOptions = {
    relayServerUrl: `http://127.0.0.1:${relayAddress.port}`,
    gatewayId: "gw-identity-reconnect",
    relaySecret: "secret",
    gatewayUrl: `ws://127.0.0.1:${gatewayAddress.port}`,
  };
  const firstAbort = new AbortController();
  const firstManager = runRelayManager({ ...managerOptions, signal: firstAbort.signal });
  let secondManager: Promise<boolean> | undefined;
  let secondAbort: AbortController | undefined;

  try {
    await waitFor(() => relaySockets.length === 1 && relayMessages.some((message) => message.type === "gateway_connected"), 4_000);
    relaySockets[0]?.send(JSON.stringify({
      type: "cmd",
      id: "send-before-reconnect",
      method: "chat.send",
      params: {
        sessionKey: "agent:main:main",
        message: "keep identity",
        idempotencyKey: "mobile-run-reconnect",
      },
    }));
    await waitFor(() => relayMessages.some((message) => (
      message.type === "event" && message.event === "chat" && isRecord(message.payload)
      && message.payload.state === "delta" && extractPayloadText(message.payload) === "hello "
    )), 4_000);
    relaySockets[0]?.close(1012, "test reconnect");
    await firstManager;

    secondAbort = new AbortController();
    secondManager = runRelayManager({ ...managerOptions, signal: secondAbort.signal });
    await waitFor(() => relayMessages.some((message) => {
      if (message.type !== "event" || message.event !== "chat" || !isRecord(message.payload)) {
        return false;
      }
      return message.payload.state === "final" && extractPayloadText(message.payload) === "hello world";
    }), 4_000);
    const reconnectedMessage = relayMessages.find((message) => (
      message.type === "event" && message.event === "chat" && isRecord(message.payload)
      && extractPayloadText(message.payload) === "hello world"
    ));
    assert.match(String(reconnectedMessage?.deliveryId), /^delivery_[a-f0-9]{32}$/);
    relaySockets.at(-1)?.send(JSON.stringify({ type: "event_ack", id: reconnectedMessage?.deliveryId }));
    const reconnectedPayload = reconnectedMessage?.payload as Record<string, unknown> | undefined;
    assert.equal(reconnectedPayload?.runId, "mobile-run-reconnect");
    const completed = timelineEvents(reconnectedPayload ?? {}).find((event) => event.eventType === "message.completed");
    assert.deepEqual({
      runId: completed?.runId,
      turnId: completed?.turnId,
      messageId: completed?.messageId,
    }, {
      runId: "mobile-run-reconnect",
      turnId: "mobile-run-reconnect",
      messageId: "assistant-mobile-run-reconnect",
    });
  } finally {
    firstAbort.abort();
    secondAbort?.abort();
    for (const socket of gatewaySockets) {
      socket.close(1000, "test done");
    }
    await firstManager.catch(() => false);
    await secondManager?.catch(() => false);
    await closeServer(relayServer);
    await closeServer(gatewayServer);
    openClawChatRunIdentities.clear();
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
    sendRelayHello(socket, "gw-test");
    socket.on("message", (raw) => {
      relayMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });

  gatewayServer.on("connection", (socket) => {
    gatewaySocket = socket;
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-1", ts: Date.now() },
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

test("relay manager queries and canonicalizes non-main OpenClaw v4 history", async () => {
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
    sendRelayHello(socket, "gw-test");
    socket.on("message", (raw) => {
      relayMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });

  gatewayServer.on("connection", (socket) => {
    gatewaySocket = socket;
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-1", ts: Date.now() },
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
          ? {
              sessionKey: "mobile-session-c6ae",
              sessionId: "provider-session-c6ae",
              messages: [
                {
                  role: "user",
                  content: "non-main prompt",
                  idempotencyKey: "non-main-run:user",
                  __openclaw: { id: "provider-user", runId: "non-main-run", seq: 41 },
                },
                {
                  role: "assistant",
                  content: [{ type: "text", text: "non-main reply" }],
                  __openclaw: { id: "provider-assistant", runId: "non-main-run", seq: 42 },
                },
                { id: "heartbeat-user", role: "user", content: [{ type: "text", text: "[OpenClaw heartbeat poll]" }] },
                { id: "heartbeat-assistant", role: "assistant", content: [{ type: "text", text: "HEARTBEAT_OK" }] },
              ],
            }
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
      id: "history-non-main",
      method: "chat.history",
      params: {
        sessionKey: "mobile-session-c6ae",
        limit: 7,
        cursor: "",
        direction: "older",
      },
    }));

    await waitFor(() => relayMessages.some((message) => message.type === "res" && message.id === "history-non-main"), 4_000);
    assert.deepEqual(gatewayHistoryRequests, [{ sessionKey: "mobile-session-c6ae", limit: 7 }]);
    const response = relayMessages.find((message) => message.type === "res" && message.id === "history-non-main");
    assert.equal(response?.ok, true);
    const payload = response?.payload as {
      messages?: Array<Record<string, unknown>>;
      timelineSnapshot?: { messages?: Array<Record<string, unknown>> };
    };
    assert.deepEqual(payload.messages?.map((message) => message.role), ["user", "assistant"]);
    assert.deepEqual(payload.timelineSnapshot?.messages?.map((message) => message.messageId), [
      "user-non-main-run",
      "assistant-non-main-run",
    ]);
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

test("relay manager removes duplicate OpenClaw prompt mirrors before serving transcript history", async () => {
  const openclawHome = await createEmptyOpenClawHomeFixture();
  const previousOpenClawHome = process.env.CLAWCONNECT_OPENCLAW_HOME;
  process.env.CLAWCONNECT_OPENCLAW_HOME = openclawHome.home;

  const sessionsDir = join(openclawHome.home, "agents", "main", "sessions");
  const transcriptPath = join(sessionsDir, "session-1.jsonl");
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
  await writeFile(transcriptPath, "", "utf8");

  const relayServer = new WebSocketServer({ port: 0 });
  const gatewayServer = new WebSocketServer({ port: 0 });
  const abort = new AbortController();
  const relayMessages: Array<Record<string, unknown>> = [];
  let relaySocket: WebSocket | undefined;
  let gatewaySocket: WebSocket | undefined;

  relayServer.on("connection", (socket) => {
    relaySocket = socket;
    sendRelayHello(socket, "gw-test");
    socket.on("message", (raw) => {
      relayMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });

  gatewayServer.on("connection", (socket) => {
    gatewaySocket = socket;
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-1", ts: Date.now() },
    }));
    socket.on("message", (raw) => {
      void (async () => {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          id?: string;
          method?: string;
          params?: Record<string, unknown>;
        };
        if (msg.type !== "req" || !msg.id) {
          return;
        }
        if (msg.method === "chat.send") {
          await writeFile(
            transcriptPath,
            [
              JSON.stringify({
                type: "message",
                id: "original-user",
                parentId: "previous-assistant",
                message: {
                  role: "user",
                  content: msg.params?.message,
                  idempotencyKey: `${String(msg.params?.idempotencyKey)}:user`,
                },
              }),
              JSON.stringify({
                type: "message",
                id: "prompt-mirror",
                parentId: "original-user",
                message: {
                  role: "user",
                  content: `[Mon 2026-06-01 09:43 GMT+8] ${String(msg.params?.message)}`,
                  senderId: "openclaw-macos",
                  senderName: "ClawConnect Agent",
                  __openclaw: { mirrorIdentity: "thread-1:prompt" },
                  idempotencyKey: "codex-app-server:thread-1:prompt",
                },
              }),
              JSON.stringify({
                type: "message",
                id: "assistant-1",
                parentId: "prompt-mirror",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "天气表格" }],
                },
              }),
            ].join("\n") + "\n",
            "utf8",
          );
        }
        socket.send(JSON.stringify({
          type: "res",
          id: msg.id,
          ok: true,
          payload: msg.method === "chat.send"
            ? { runId: "gateway-run-1" }
            : msg.method === "config.get"
              ? sessionDefaultsPayload()
              : {},
        }));
      })().catch((error) => {
        socket.send(JSON.stringify({
          type: "res",
          id: "unknown",
          ok: false,
          error: { code: "TEST_ERROR", message: String(error) },
        }));
      });
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
      id: "send-1",
      method: "chat.send",
      params: {
        sessionKey: "agent:main:main",
        message: "后天福州的天气怎么样返回表格",
        idempotencyKey: "mobile-run-1",
      },
    }));

    await waitFor(() => relayMessages.some((message) => message.type === "res" && message.id === "send-1"), 4_000);
    relaySocket?.send(JSON.stringify({
      type: "cmd",
      id: "history-1",
      method: "chat.history",
      params: {
        sessionKey: "agent:main:main",
        limit: 10,
      },
    }));

    await waitFor(() => relayMessages.some((message) => message.type === "res" && message.id === "history-1"), 4_000);
    const response = relayMessages.find((message) => message.type === "res" && message.id === "history-1");
    assert.equal(response?.ok, true);
    const payload = response?.payload as { messages?: Array<Record<string, unknown>> };
    assert.deepEqual(payload.messages?.map((message) => message.id), ["original-user", "assistant-1"]);

    const rewrittenTranscript = await readFile(transcriptPath, "utf8");
    assert.equal(rewrittenTranscript.includes("prompt-mirror"), false);
    assert.match(rewrittenTranscript, /"id":"assistant-1","parentId":"original-user"/);
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

test("relay manager reuses one OpenClaw model request for concurrent and terminal chat.send retries", async () => {
  const relayServer = new WebSocketServer({ port: 0 });
  const gatewayServer = new WebSocketServer({ port: 0 });
  const abort = new AbortController();
  const relayMessages: Array<Record<string, unknown>> = [];
  let relaySocket: WebSocket | undefined;
  let gatewaySocket: WebSocket | undefined;
  let modelRequests = 0;

  relayServer.on("connection", (socket) => {
    relaySocket = socket;
    sendRelayHello(socket, "gw-openclaw-idempotency-test");
    socket.on("message", (raw) => {
      relayMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });
  gatewayServer.on("connection", (socket) => {
    gatewaySocket = socket;
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-idempotency", ts: Date.now() },
    }));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as {
        type?: string;
        id?: string;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (message.type !== "req" || !message.id) {
        return;
      }
      if (message.method === "chat.send") {
        modelRequests += 1;
        setTimeout(() => {
          if (message.params?.idempotencyKey === "openclaw-client-run-idempotency-error") {
            socket.send(JSON.stringify({
              type: "res",
              id: message.id,
              ok: false,
              error: { code: "PROVIDER_UNAVAILABLE", message: "provider_unavailable" },
            }));
            return;
          }
          socket.send(JSON.stringify({
            type: "res",
            id: message.id,
            ok: true,
            payload: { runId: "openclaw-idempotent-run" },
          }));
        }, 40);
        return;
      }
      socket.send(JSON.stringify({ type: "res", id: message.id, ok: true, payload: sessionDefaultsPayload() }));
    });
  });

  const relayAddress = relayServer.address();
  const gatewayAddress = gatewayServer.address();
  assert.ok(relayAddress && typeof relayAddress === "object");
  assert.ok(gatewayAddress && typeof gatewayAddress === "object");
  const manager = runRelayManager({
    relayServerUrl: `http://127.0.0.1:${relayAddress.port}`,
    gatewayId: "gw-openclaw-idempotency-test",
    relaySecret: "secret",
    gatewayUrl: `ws://127.0.0.1:${gatewayAddress.port}`,
    signal: abort.signal,
  });

  const sendChat = (
    id: string,
    message = "只执行一次",
    idempotencyKey = "openclaw-client-run-idempotency-1",
  ) => {
    relaySocket?.send(JSON.stringify({
      type: "cmd",
      id,
      method: "chat.send",
      params: {
        sessionKey: "main",
        message,
        idempotencyKey,
      },
    }));
  };

  try {
    await waitFor(() => Boolean(relaySocket) && relayMessages.some((message) => message.type === "gateway_connected"), 4_000);
    sendChat("retry-concurrent-1");
    sendChat("retry-concurrent-2");
    await waitFor(() => ["retry-concurrent-1", "retry-concurrent-2"].every((id) => (
      relayMessages.some((message) => message.type === "res" && message.id === id && message.ok === true)
    )), 4_000);
    assert.equal(modelRequests, 1);

    sendChat("retry-terminal");
    await waitFor(() => relayMessages.some((message) => message.type === "res" && message.id === "retry-terminal"), 4_000);
    assert.equal(modelRequests, 1);

    sendChat("retry-conflict", "同一个键但内容变了");
    await waitFor(() => relayMessages.some((message) => message.type === "res" && message.id === "retry-conflict"), 4_000);
    const conflict = relayMessages.find((message) => message.type === "res" && message.id === "retry-conflict");
    assert.equal(conflict?.ok, false);
    assert.match(String((conflict?.error as { message?: string } | undefined)?.message), /chat_send_idempotency_conflict/);
    assert.equal(modelRequests, 1);

    sendChat("retry-error-1", "失败也只执行一次", "openclaw-client-run-idempotency-error");
    sendChat("retry-error-2", "失败也只执行一次", "openclaw-client-run-idempotency-error");
    await waitFor(() => ["retry-error-1", "retry-error-2"].every((id) => (
      relayMessages.some((message) => message.type === "res" && message.id === id && message.ok === false)
    )), 4_000);
    assert.equal(modelRequests, 2);
    sendChat("retry-error-terminal", "失败也只执行一次", "openclaw-client-run-idempotency-error");
    await waitFor(() => relayMessages.some((message) => message.type === "res" && message.id === "retry-error-terminal"), 4_000);
    const terminalError = relayMessages.find((message) => message.type === "res" && message.id === "retry-error-terminal");
    assert.equal(terminalError?.ok, false);
    assert.match(String((terminalError?.error as { message?: string } | undefined)?.message), /provider_unavailable/);
    assert.equal(modelRequests, 2);
  } finally {
    abort.abort();
    gatewaySocket?.close(1000, "test done");
    await manager.catch(() => false);
    await closeServer(relayServer);
    await closeServer(gatewayServer);
  }
});

function extractPayloadText(payload: Record<string, unknown>): string {
  const message = isRecord(payload.message) ? payload.message : undefined;
  const content = Array.isArray(message?.content) ? message.content : [];
  const textBlock = content.find((block): block is Record<string, unknown> => isRecord(block) && block.type === "text");
  if (typeof textBlock?.text === "string") return textBlock.text;
  for (const event of timelineEvents(payload)) {
    const eventContent = Array.isArray(event.content) ? event.content : [];
    const eventText = eventContent.find((block): block is Record<string, unknown> => (
      isRecord(block) && block.type === "text" && typeof block.text === "string"
    ));
    if (typeof eventText?.text === "string") return eventText.text;
  }
  return "";
}

function timelineEvents(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(payload.timelineEvents)
    ? payload.timelineEvents.filter((event): event is Record<string, unknown> => isRecord(event))
    : [];
}

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

function sendRelayHello(socket: WebSocket, gatewayId: string, acknowledged = false): void {
  socket.send(JSON.stringify({
    type: "hello",
    role: "relay",
    gatewayId,
    ok: true,
    ...(acknowledged ? { protocolCapabilities: ["reliable_delivery_ack_v1"] } : {}),
  }));
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
