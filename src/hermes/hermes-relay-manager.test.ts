import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";

import {
  buildHermesArtifactCompletedEvent,
  buildHermesArtifactContentBlock,
  buildHermesArtifactTimelineEvents,
  buildHermesArtifactUploadRequest,
  buildHermesRelayHelloMessage,
  collectHermesSlashCommandCatalog,
  rememberActiveHermesChatRun,
  resolveHermesChatPreferredRunId,
  resolveHermesAbortRun,
  runHermesRelayManagerWithDependencies,
  searchHermesSlashCommandCatalog,
  shouldPublishHermesOfficeSnapshot,
  type HermesRelayManagerDependencies,
} from "./hermes-relay-manager.js";

const imageUpload = {
  filePath: "/tmp/reply.png",
  absolutePath: "/tmp/reply.png",
  gatewayId: "gw-1",
  sessionKey: "main",
  fileId: "file-image-1",
  uploadId: "upload-1",
  fileName: "reply.png",
  mimeType: "image/png",
  sizeBytes: 1234,
  imageWidth: 640,
  imageHeight: 360,
  sha256: "sha",
  chunkSize: 1024,
  totalChunks: 2,
  sourceRunId: "run-1",
  expiresAt: "2026-06-06T00:00:00.000Z",
  downloadPath: "/api/mobile/files/file-image-1",
  downloadUrl: "http://127.0.0.1:8080/api/mobile/files/file-image-1",
  status: "available",
  createdAt: "2026-06-06T00:00:00.000Z",
  updatedAt: "2026-06-06T00:00:00.000Z",
};

test("Hermes image artifact upload is represented as a mobile content block", () => {
  const block = buildHermesArtifactContentBlock(imageUpload, "att-1");

  assert.deepEqual(block, {
    type: "image",
    attachmentId: "att-1",
    fileId: "file-image-1",
    fileName: "reply.png",
    mimeType: "image/png",
    sizeBytes: 1234,
    imageWidth: 640,
    imageHeight: 360,
    downloadUrl: "/api/mobile/files/file-image-1",
    downloadPath: "/api/mobile/files/file-image-1",
    expiresAt: "2026-06-06T00:00:00.000Z",
    sourceRunId: "run-1",
    gatewayId: "gw-1",
    sessionKey: "main",
    status: "available",
  });
});

test("Hermes artifact uploads use independent non-resolving attachment timeline messages", () => {
  const block = buildHermesArtifactContentBlock(imageUpload, "att-1");
  const event = buildHermesArtifactCompletedEvent({
    gatewayId: "gw-1",
    sessionKey: "main",
    runId: "run-1",
    upload: imageUpload,
    attachmentId: "att-1",
    contentBlock: block,
    artifactIndex: 0,
    now: () => new Date("2026-06-06T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_fixed`,
  });

  assert.equal(event.eventType, "message.completed");
  assert.equal(event.messageId, "file-file-image-1");
  assert.equal(event.partId, "part-image-1");
  assert.equal(event.timelineItemKind, "attachment");
  assert.equal(event.timelineResolvesWaiting, false);
  assert.deepEqual(event.content, [block]);
});

test("Hermes artifact completed and state events use distinct sequence keys", () => {
  const events = buildHermesArtifactTimelineEvents({
    gatewayId: "gw-1",
    sessionKey: "main",
    runId: "run-1",
    upload: imageUpload,
    attachmentId: "att-1",
    artifactIndex: 0,
    now: () => new Date("2026-06-06T00:00:00.000Z"),
    idFactory: (prefix) => `${prefix}_fixed_${prefix === "evt" ? "1" : "0"}`,
  });

  assert.equal(events.completed.messageId, "file-file-image-1");
  assert.equal(events.attachment.messageId, "file-file-image-1");
  assert.equal(events.completed.partId, "part-image-1");
  assert.equal(events.attachment.partId, "part-image-1");
  assert.equal(events.attachment.seq, events.completed.seq + 1);
  assert.equal(events.attachment.timelineItemKind, "attachment");
  assert.equal(events.attachment.timelineResolvesWaiting, false);
});

test("Hermes artifact uploads are linked to the assistant source run", () => {
  const request = buildHermesArtifactUploadRequest({
      artifactPath: "/tmp/reply.jpg",
      relayServerUrl: "https://relay.example",
      relaySecret: "secret-1",
      gatewayId: "gw-1",
      sessionKey: "main",
      runId: "run-voice-1",
    });
  assert.deepEqual(request, {
    relayServerUrl: "https://relay.example",
    relaySecret: "secret-1",
    gatewayId: "gw-1",
    sessionKey: "main",
    filePath: "/tmp/reply.jpg",
    sourceRunId: "run-voice-1",
  });
  assert.equal("json" in request, false);
  assert.equal("gateway" in request, false);
  assert.equal("session" in request, false);
});

test("Hermes office snapshots skip high-frequency assistant deltas", () => {
  assert.equal(
    shouldPublishHermesOfficeSnapshot("chat", {
      state: "delta",
      role: "assistant",
      delta: "hello",
    }),
    false,
  );

  assert.equal(
    shouldPublishHermesOfficeSnapshot("chat", {
      state: "final",
      role: "assistant",
      message: { content: [{ type: "text", text: "done" }] },
    }),
    true,
  );
});

test("Hermes abort lookup accepts the mobile idempotency key", () => {
  const controller = new AbortController();
  const activeRuns = new Map();
  const run = {
    runId: "server-run-1",
    sessionKey: "main",
  };

  rememberActiveHermesChatRun(
    activeRuns,
    run,
    { idempotencyKey: "client-run-1" },
    "relay-request-1",
    controller,
  );

  const resolved = resolveHermesAbortRun({ idempotencyKey: "client-run-1" }, activeRuns);
  assert.equal(resolved?.controller, controller);
  assert.equal(resolved?.run.runId, "server-run-1");
});

test("Hermes chat run prefers the mobile idempotency key over relay request id", () => {
  assert.equal(
    resolveHermesChatPreferredRunId({
      idempotencyKey: "mobile-run-1",
      runId: "",
    }),
    "mobile-run-1",
  );
  assert.equal(
    resolveHermesChatPreferredRunId({ runId: "explicit-run-1", idempotencyKey: "mobile-run-1" }),
    "explicit-run-1",
  );
  assert.equal(
    resolveHermesChatPreferredRunId({ idempotencyKey: "mobile-run-1" }, { runId: "voice-run-1", sessionKey: "main" }),
    "voice-run-1",
  );
});

test("Hermes slash command catalog is loaded from Hermes terminal metadata", () => {
  const catalog = collectHermesSlashCommandCatalog(() => JSON.stringify([
    {
      command: "/new",
      title: "new",
      detail: "Start a new session",
    },
    {
      command: "model",
      title: "model",
      description: "Switch model",
    },
    {
      command: "/new",
      title: "duplicate",
      detail: "Duplicate command",
    },
    {
      command: "",
      title: "ignored",
      detail: "Ignored command",
    },
  ]));

  assert.deepEqual(catalog, [
    {
      source: "Hermes",
      command: "/new",
      title: "new",
      detail: "Start a new session",
    },
    {
      source: "Hermes",
      command: "/model",
      title: "model",
      detail: "Switch model",
    },
  ]);
});

test("Hermes relay hello does not eagerly include Hermes slash commands", () => {
  const hello = buildHermesRelayHelloMessage({
    platform: "darwin (Hermes)",
    agentVersion: "hermes",
    capabilities: ["chat"],
  });

  assert.deepEqual(hello, {
    type: "hello",
    platform: "darwin (Hermes)",
    agentVersion: "hermes",
    capabilities: ["chat"],
  });
});

test("Hermes relay hello can still include explicit slash commands for compatibility", () => {
  const slashCommands = [
    {
      source: "Hermes" as const,
      command: "/retry",
      title: "retry",
      detail: "Retry the last message",
    },
  ];

  assert.deepEqual(
    buildHermesRelayHelloMessage({
      platform: "darwin (Hermes)",
      agentVersion: "hermes",
      capabilities: ["chat"],
      slashCommands,
    }),
    {
      type: "hello",
      platform: "darwin (Hermes)",
      agentVersion: "hermes",
      capabilities: ["chat"],
      slashCommands,
    },
  );
});

test("Hermes slash command search filters, paginates, and fuzzy matches the terminal catalog lazily", () => {
  const result = searchHermesSlashCommandCatalog({
    query: "/mdl",
    limit: 1,
    offset: 1,
    collect: () => [
      {
        source: "Hermes",
        command: "/new",
        title: "new",
        detail: "Start a new session",
      },
      {
        source: "Hermes",
        command: "/model",
        title: "model",
        detail: "Switch model",
      },
      {
        source: "Hermes",
        command: "/model provider",
        title: "model provider",
        detail: "Switch provider",
      },
      {
        source: "Hermes",
        command: "/history",
        title: "history",
        detail: "Show history",
      },
    ],
  });

  assert.deepEqual(result, {
    items: [
      {
        source: "Hermes",
        command: "/model provider",
        title: "model provider",
        detail: "Switch provider",
      },
    ],
    hasMore: false,
    total: 2,
  });
});

test("Hermes relay manager reuses one successful model run for concurrent and terminal retries", async () => {
  const relayServer = new WebSocketServer({ port: 0 });
  const relayMessages: Array<Record<string, unknown>> = [];
  const abort = new AbortController();
  let relaySocket: WebSocket | undefined;
  let modelRuns = 0;
  const modelResult = createHermesTestDeferred<{
    output: string;
    sessionKey: string;
    artifactPaths: string[];
  }>();
  relayServer.on("connection", (socket) => {
    relaySocket = socket;
    socket.on("message", (raw) => {
      relayMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });
  const relayAddress = relayServer.address();
  assert.ok(relayAddress && typeof relayAddress === "object");
  const manager = runHermesRelayManagerWithDependencies({
    relayServerUrl: `http://127.0.0.1:${relayAddress.port}`,
    gatewayId: "gw-hermes-idempotency-success",
    relaySecret: "secret",
    signal: abort.signal,
  }, hermesTestDependencies(async (params) => {
    modelRuns += 1;
    const record = params as Record<string, unknown>;
    const result = await modelResult.promise;
    return { ...result, sessionKey: String(record.sessionKey) };
  }));

  const send = (id: string, message = "hello") => {
    relaySocket?.send(JSON.stringify({
      type: "cmd",
      id,
      method: "chat.send",
      params: {
        sessionKey: "main",
        message,
        idempotencyKey: "hermes-client-run-success-1",
      },
    }));
  };

  try {
    await waitForHermesTest(() => Boolean(relaySocket) && relayMessages.some((message) => message.type === "gateway_connected"));
    send("hermes-success-1");
    send("hermes-success-2");
    await waitForHermesTest(() => ["hermes-success-1", "hermes-success-2"].every((id) => (
      relayMessages.some((message) => message.type === "res" && message.id === id && message.ok === true)
    )));
    assert.equal(modelRuns, 1);
    assert.equal(terminalHermesChatEvents(relayMessages, "final").length, 0);
    const firstAck = relayMessages.find((message) => message.type === "res" && message.id === "hermes-success-1");
    const secondAck = relayMessages.find((message) => message.type === "res" && message.id === "hermes-success-2");
    assert.equal(firstAck?.responsePhase, "accepted");
    assert.equal(secondAck?.responsePhase, "accepted");
    assert.deepEqual(firstAck?.payload, secondAck?.payload);

    modelResult.resolve({ output: "只运行一次", sessionKey: "main", artifactPaths: [] });
    await waitForHermesTest(() => terminalHermesChatEvents(relayMessages, "final").length === 1);
    await waitForHermesTest(() => ["hermes-success-1", "hermes-success-2"].every((id) => (
      relayMessages.some((message) => message.type === "res" && message.id === id && message.responsePhase === "terminal")
    )));

    send("hermes-success-terminal");
    await waitForHermesTest(() => relayMessages.some((message) => message.type === "res" && message.id === "hermes-success-terminal"));
    assert.equal(modelRuns, 1);
    assert.equal(terminalHermesChatEvents(relayMessages, "final").length, 1);

    send("hermes-success-conflict", "changed");
    await waitForHermesTest(() => relayMessages.some((message) => message.type === "res" && message.id === "hermes-success-conflict"));
    const conflict = relayMessages.find((message) => message.type === "res" && message.id === "hermes-success-conflict");
    assert.equal(conflict?.ok, false);
    assert.match(String((conflict?.error as { message?: string } | undefined)?.message), /chat_send_idempotency_conflict/);
    assert.equal(modelRuns, 1);
  } finally {
    abort.abort();
    await manager.catch(() => false);
    await closeHermesTestServer(relayServer);
  }
});

test("Hermes relay manager immediately reuses accepted and publishes one model error event", async () => {
  const relayServer = new WebSocketServer({ port: 0 });
  const relayMessages: Array<Record<string, unknown>> = [];
  const abort = new AbortController();
  let relaySocket: WebSocket | undefined;
  let modelRuns = 0;
  const modelResult = createHermesTestDeferred<never>();
  relayServer.on("connection", (socket) => {
    relaySocket = socket;
    socket.on("message", (raw) => {
      relayMessages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
  });
  const relayAddress = relayServer.address();
  assert.ok(relayAddress && typeof relayAddress === "object");
  const manager = runHermesRelayManagerWithDependencies({
    relayServerUrl: `http://127.0.0.1:${relayAddress.port}`,
    gatewayId: "gw-hermes-idempotency-error",
    relaySecret: "secret",
    signal: abort.signal,
  }, hermesTestDependencies(async () => {
    modelRuns += 1;
    return modelResult.promise;
  }));

  const send = (id: string) => {
    relaySocket?.send(JSON.stringify({
      type: "cmd",
      id,
      method: "chat.send",
      params: {
        sessionKey: "main",
        message: "fail once",
        idempotencyKey: "hermes-client-run-error-1",
      },
    }));
  };

  try {
    await waitForHermesTest(() => Boolean(relaySocket) && relayMessages.some((message) => message.type === "gateway_connected"));
    send("hermes-error-1");
    send("hermes-error-2");
    await waitForHermesTest(() => ["hermes-error-1", "hermes-error-2"].every((id) => (
      relayMessages.some((message) => message.type === "res" && message.id === id && message.ok === true)
    )));
    assert.equal(modelRuns, 1);
    const firstAck = relayMessages.find((message) => message.type === "res" && message.id === "hermes-error-1");
    const secondAck = relayMessages.find((message) => message.type === "res" && message.id === "hermes-error-2");
    assert.equal(firstAck?.responsePhase, "accepted");
    assert.equal(secondAck?.responsePhase, "accepted");
    assert.deepEqual(firstAck?.payload, secondAck?.payload);
    assert.equal(terminalHermesChatEvents(relayMessages, "error").length, 0);

    modelResult.reject(new Error("hermes_provider_unavailable"));
    await waitForHermesTest(() => terminalHermesChatEvents(relayMessages, "error").length === 1);
    await waitForHermesTest(() => ["hermes-error-1", "hermes-error-2"].every((id) => (
      relayMessages.some((message) => message.type === "res" && message.id === id
        && message.responsePhase === "terminal" && message.ok === false)
    )));

    send("hermes-error-terminal");
    await waitForHermesTest(() => relayMessages.some((message) => message.type === "res" && message.id === "hermes-error-terminal"));
    const terminalRetry = relayMessages.find((message) => message.type === "res" && message.id === "hermes-error-terminal");
    assert.equal(terminalRetry?.ok, true);
    assert.deepEqual(terminalRetry?.payload, firstAck?.payload);
    assert.equal(modelRuns, 1);
    assert.equal(terminalHermesChatEvents(relayMessages, "error").length, 1);
  } finally {
    abort.abort();
    await manager.catch(() => false);
    await closeHermesTestServer(relayServer);
  }
});

function hermesTestDependencies(
  runChat: HermesRelayManagerDependencies["runChat"],
): HermesRelayManagerDependencies {
  return {
    runChat,
    readStatusSnapshot: async () => ({}),
    publishUsageSnapshot: async () => undefined,
    resolveStateDbRealtimePath: () => undefined,
    createStateDbRealtimeWatcher: () => {
      throw new Error("state db watcher is disabled in relay manager tests");
    },
  };
}

function createHermesTestDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function terminalHermesChatEvents(
  messages: Array<Record<string, unknown>>,
  state: string,
): Array<Record<string, unknown>> {
  return messages.filter((message) => (
    message.type === "event" &&
    message.event === "chat" &&
    message.payload !== null &&
    typeof message.payload === "object" &&
    !Array.isArray(message.payload) &&
    (message.payload as Record<string, unknown>).state === state
  ));
}

async function waitForHermesTest(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for Hermes relay test condition");
}

async function closeHermesTestServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
