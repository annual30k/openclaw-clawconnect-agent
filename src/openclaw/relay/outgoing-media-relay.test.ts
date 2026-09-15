import assert from "assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { DatabaseSync } from "node:sqlite";
import {
  adaptOpenClawMessageToolDelivery,
  relayOutgoingMediaInHistoryResponse,
  relayOutgoingMediaInPayload,
} from "./outgoing-media-relay.js";
import { readOpenClawTranscriptChatHistory } from "./chat-history.js";
import { DEFAULT_GATEWAY_SESSION_DEFAULTS } from "./session-context.js";
import {
  isOpenClawAssistantMediaSidecarPayload,
  materializeOpenClawDisplayContentPayload,
  normalizeOpenClawAutomaticMediaReplies,
  normalizeOpenClawAssistantMediaSidecars,
} from "./assistant-media-sidecar.js";
import { realOpenClawMessageToolResultFixture } from "./openclaw-message-tool-real-shape.fixture.js";

test("live OpenClaw payload promotes display-only media into message content", () => {
  const payload = materializeOpenClawDisplayContentPayload({
    state: "final",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "图片已发出" }],
      openclawDisplayContent: [{ type: "image", url: "/api/chat/media/outgoing/main/photo/full" }],
    },
  }) as Record<string, unknown>;

  assert.deepEqual((payload.message as Record<string, unknown>).content, [
    { type: "text", text: "图片已发出" },
    { type: "image", url: "/api/chat/media/outgoing/main/photo/full" },
  ]);
});

test("projection v3 keeps sidecars independent without an explicit parent id", () => {
  const normalized = normalizeOpenClawAssistantMediaSidecars([
    { id: "assistant-1", role: "assistant", runId: "run-v3", content: [{ type: "text", text: "answer" }] },
    {
      id: "sidecar-1",
      role: "assistant",
      idempotencyKey: "run-v3:assistant-media",
      runId: "run-v3",
      content: [{ type: "image", attachmentId: "image-independent" }],
    },
  ], "agent:main:session-v3", { projectionVersion: 3 });
  assert.equal(normalized.messages.length, 2);
  assert.equal(normalized.messages[1]?.id, "sidecar-1");
});

test("projection v3 keeps each message-tool reply as an independent source row", () => {
  const normalized = normalizeOpenClawAutomaticMediaReplies([
    { id: "assistant-1", role: "assistant", runId: "run-v3", content: [{ type: "text", text: "sent" }] },
    {
      id: "message-tool-1",
      role: "assistant",
      idempotencyKey: "run-v3:message-tool:call-1",
      runId: "run-v3",
      content: [{ type: "image", attachmentId: "image-1" }],
    },
    {
      id: "message-tool-2",
      role: "assistant",
      idempotencyKey: "run-v3:message-tool:call-2",
      runId: "run-v3",
      content: [{ type: "image", attachmentId: "image-2" }],
    },
  ], "agent:main:session-v3", { projectionVersion: 3 });
  assert.equal(normalized.messages.length, 3);
  assert.deepEqual(normalized.messages.slice(1).map((message) => (message as Record<string, unknown>).id), [
    "message-tool-1",
    "message-tool-2",
  ]);
});

test("dashboard live-first/history-first relation keeps tool order and reuses one upload across aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-openclaw-dashboard-relation-"));
  const imagePath = join(root, "same-image.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
  const server = await createFileUploadRelayServer("file_dashboard_relation");
  const runId = "wx_dashboard_relation_run";
  const defaults = {
    mainSessionKey: "agent:main:main",
    mainKey: "main",
    defaultAgentId: "main",
  };
  const receipt = (toolCallId: string) => ({
    contract: "openclaw.message-tool-delivery.v1",
    toolName: "message",
    toolCallId,
    idempotencyKey: `${runId}:message-tool:delivery:${toolCallId}`,
    sourceRunId: runId,
    mediaUrls: [imagePath],
  });
  const row = (id: string, sessionKey: string, toolCallId: string) => ({
    id,
    role: "assistant",
    sessionKey,
    runId,
    idempotencyKey: `${runId}:message-tool:delivery:${toolCallId}`,
    openclawDelivery: receipt(toolCallId),
    content: [],
  });
  const options = {
    relayServerUrl: server.baseUrl,
    relaySecret: "secret",
    gatewayId: "gw_test",
    cache: new Map(),
    sessionDefaults: defaults,
  };

  try {
    const live = await relayOutgoingMediaInPayload({
      sessionKey: "agent:main:dashboard:38ff",
      runId,
      message: row("live-first", "agent:main:dashboard:38ff", "call_first"),
      timelineEvents: [{
        eventType: "message.completed",
        role: "assistant",
        sessionKey: "agent:main:dashboard:38ff",
        runId,
        turnId: runId,
        idempotencyKey: `${runId}:message-tool:delivery:call_first`,
        content: [],
      }],
    }, options) as any;
    const liveImage = live.message.content[0];
    assert.equal(liveImage.toolCallId, "call_first");
    assert.equal(liveImage.sessionKey, "agent:main:dashboard:38ff");
    assert.equal(live.timelineEvents[0].content[0].toolCallId, "call_first");

    const history = await relayOutgoingMediaInHistoryResponse({
      sessionKey: "dashboard:38ff",
      messages: [
        row("history-first", "dashboard:38ff", "call_first"),
        row("history-first-replay", "dashboard:38ff", "call_first"),
        row("history-second", "agent:main:dashboard:38ff", "call_second"),
      ],
      timelineSnapshot: {
        messages: [
          { id: "history-first", sourceMessageId: "history-first", projectionVersion: 3 },
          { id: "history-second", sourceMessageId: "history-second", projectionVersion: 3 },
        ],
      },
    }, options) as any;
    const historyImages = history.messages
      .map((message: any) => message.content?.[0])
      .filter(Boolean);
    assert.deepEqual(historyImages.map((image: any) => image.toolCallId), ["call_first", "call_second"]);
    assert.deepEqual(historyImages.map((image: any) => image.sourceRunId), [runId, runId]);
    assert.equal(history.timelineSnapshot.messages.length, 2);
    assert.deepEqual(history.timelineSnapshot.messages.map((message: any) => message.content[0].toolCallId), [
      "call_first",
      "call_second",
    ]);
    assert.equal(server.initRequestCount(), 1);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("managed inbound images are uploaded once across history projections and reject traversal", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "inbound-media-test-"));
  const server = await createFileUploadRelayServer("file_inbound");
  try {
    await mkdir(join(stateDir, "media", "inbound"), { recursive: true });
    await writeFile(join(stateDir, "media", "inbound", "photo.png"), "image bytes");
    await writeFile(join(stateDir, "outside.png"), "private");
    const options = { stateDir, relayServerUrl: server.baseUrl, relaySecret: "secret", gatewayId: "gw_test", cache: new Map() };
    const message = { role: "user", runId: "user-run", content: [{ type: "image", url: "media://inbound/photo.png" }] };
    const result = await relayOutgoingMediaInHistoryResponse({ sessionKey: "agent:health:chat", messages: [message], timelineSnapshot: { messages: [message] } }, options) as any;
    assert.equal(result.messages[0].content[0].fileId, "file_inbound");
    assert.equal(result.timelineSnapshot.messages[0].content[0].fileId, "file_inbound");
    assert.equal(server.initBody()?.sourceRole, "user");
    const escaped = await relayOutgoingMediaInPayload({ sessionKey: "agent:health:chat", message: { ...message, content: [{ type: "image", url: "media://inbound/../../outside.png" }] } }, options) as any;
    assert.equal(escaped.message.content[0].isRemoteExpired, true);
    assert.equal(escaped.message.content[0].url, undefined);
  } finally {
    await server.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("relayOutgoingMediaInPayload uploads OpenClaw outgoing media and rewrites the image block", async () => {
  const fixture = await createOutgoingMediaFixture();
  const server = await createFileUploadRelayServer("file_outgoing_payload");
  try {
    const payload = {
      runId: "assistant-run-outgoing",
      message: {
        runId: "assistant-run-outgoing",
        role: "assistant",
        content: [
          { type: "text", text: "sent image" },
          {
            type: "image",
            url: `/api/chat/media/outgoing/agent%3Amain%3Asession_1/${fixture.attachmentId}/full`,
            alt: "photo.jpg",
            mimeType: "image/jpeg",
          },
        ],
      },
      timelineEvents: [{
        eventType: "message.completed",
        runId: "assistant-run-outgoing",
        content: [
          { type: "text", text: "sent image" },
          {
            type: "image",
            url: `/api/chat/media/outgoing/agent%3Amain%3Asession_1/${fixture.attachmentId}/full`,
            alt: "photo.jpg",
            mimeType: "image/jpeg",
          },
        ],
      }],
    };

    const result = await relayOutgoingMediaInPayload(payload, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      recordsDir: fixture.recordsDir,
      cache: new Map(),
    }) as typeof payload;

    const image = result.message.content[1] as Record<string, unknown>;
    assert.equal(image.fileId, "file_outgoing_payload");
    assert.equal(image.downloadUrl, "/api/mobile/files/file_outgoing_payload");
    assert.equal(image.fileName, "photo.jpg");
    assert.equal(image.sourceRunId, "assistant-run-outgoing");
    assert.equal(image.sourceRole, "assistant");
    assert.equal(image.gatewayId, "gw_test");
    assert.equal(image.sessionKey, "agent:main:session_1");
    assert.equal(server.initBody()?.timelineDelivery, "embedded");
    const eventImage = result.timelineEvents[0]?.content[1] as Record<string, unknown>;
    assert.equal(eventImage.fileId, "file_outgoing_payload");
    assert.deepEqual(result.timelineEvents[0]?.attachmentIds, [fixture.attachmentId, "file_outgoing_payload"]);
  } finally {
    await server.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("relayOutgoingMediaInPayload materializes source-commit timeline events without a message wrapper", async () => {
  const fixture = await createOutgoingMediaFixture();
  const server = await createFileUploadRelayServer("file_source_commit_projection");
  try {
    const payload = {
      state: "source_commit",
      sessionKey: "agent:main:session_1",
      sourceCommit: { projectionVersion: 3 },
      timelineEvents: [{
        eventType: "message.completed",
        runId: "source-run-1",
        content: [{
          type: "image",
          url: `/api/chat/media/outgoing/agent%3Amain%3Asession_1/${fixture.attachmentId}/full`,
          mimeType: "image/jpeg",
        }],
      }],
    };

    const result = await relayOutgoingMediaInPayload(payload, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      recordsDir: fixture.recordsDir,
      cache: new Map(),
    }) as typeof payload;

    const event = result.timelineEvents[0];
    const image = event?.content?.[0] as Record<string, unknown>;
    assert.equal("message" in result, false);
    assert.equal(image.fileId, "file_source_commit_projection");
    assert.equal(image.downloadPath, "/api/mobile/files/file_source_commit_projection");
    assert.equal(image.transferState, "available");
    assert.deepEqual(event?.attachmentIds, [fixture.attachmentId, "file_source_commit_projection"]);
  } finally {
    await server.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("relayOutgoingMediaInPayload uploads an OpenClaw SQLite managed outgoing image", async () => {
  const fixture = await createSqliteOutgoingMediaFixture();
  const server = await createFileUploadRelayServer("file_outgoing_sqlite");
  try {
    const payload = {
      runId: "assistant-run-sqlite",
      message: {
        role: "assistant",
        content: [{
          type: "image",
          url: `/api/chat/media/outgoing/agent%3Amain%3Asession_1/${fixture.attachmentId}/full`,
        }],
      },
    };

    const result = await relayOutgoingMediaInPayload(payload, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      stateDir: fixture.stateDir,
      cache: new Map(),
    }) as typeof payload;

    const image = result.message.content[0] as Record<string, unknown>;
    assert.equal(image.fileId, "file_outgoing_sqlite");
    assert.equal(image.fileName, "photo.png");
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.width, 20);
    assert.equal(image.height, 10);
    assert.equal(server.initRequestCount(), 1);
  } finally {
    await server.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("relayOutgoingMediaInPayload uploads trusted OpenClaw delivery media into the message and matching completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-openclaw-delivery-media-"));
  const firstPath = join(root, "first.png");
  const secondPath = join(root, "second.png");
  await writeFile(firstPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
  await writeFile(secondPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]));
  const server = await createFileUploadRelayServer("file_delivery_media");
  const runId = "wx_1788998820912_1jbs06xy";
  const sessionKey = "agent:main:session_delivery";
  const payload = {
    runId,
    sessionKey,
    state: "final",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "I should send the images." }],
      openclawDelivery: {
        contract: "openclaw.message-tool-delivery.v1",
        toolName: "message",
        toolCallId: "call-delivery-media",
        idempotencyKey: `${runId}:message-tool:delivery:call-delivery-media`,
        sourceRunId: runId,
        textPhaseRequiresTerminal: true,
        mediaUrls: [firstPath, secondPath, firstPath],
      },
    },
    timelineEvents: [
      {
        protocolVersion: 2,
        eventId: "evt-delivery-message",
        eventType: "message.completed",
        gatewayId: "gw_test",
        sessionKey,
        turnId: runId,
        runId,
        messageId: `assistant-${runId}`,
        partId: "part-text-1",
        attachmentId: null,
        seq: 100,
        turnSeq: 1,
        role: "assistant",
        messageState: "completed",
        runState: "active",
        createdAt: "2026-09-10T00:07:00.000Z",
        source: "live",
        content: [],
        attachment: null,
        error: null,
        attachmentIds: [],
      },
      {
        protocolVersion: 2,
        eventId: "evt-delivery-run",
        eventType: "run.completed",
        gatewayId: "gw_test",
        sessionKey,
        turnId: runId,
        runId,
        messageId: `assistant-${runId}`,
        partId: "run-state",
        attachmentId: null,
        seq: 101,
        turnSeq: 2,
        role: "assistant",
        messageState: "completed",
        runState: "completed",
        createdAt: "2026-09-10T00:07:00.000Z",
        source: "live",
        content: [],
        attachment: null,
        error: null,
      },
      {
        protocolVersion: 2,
        eventId: "evt-other-run-message",
        eventType: "message.completed",
        gatewayId: "gw_test",
        sessionKey,
        turnId: "other-run",
        runId: "other-run",
        messageId: "assistant-other-run",
        partId: "part-text-1",
        attachmentId: null,
        seq: 102,
        turnSeq: 1,
        role: "assistant",
        messageState: "completed",
        runState: "active",
        createdAt: "2026-09-10T00:07:00.000Z",
        source: "live",
        content: [],
        attachment: null,
        error: null,
      },
    ],
  };
  const options = {
    relayServerUrl: server.baseUrl,
    relaySecret: "secret",
    gatewayId: "gw_test",
    cache: new Map(),
    userMessage: "把这两张图片发给我",
  };

  try {
    const result = await relayOutgoingMediaInPayload(payload, options) as any;
    const messageContent = result.message.content as Array<Record<string, unknown>>;
    const messageImages = messageContent.filter((block) => block.type === "image");
    const completed = result.timelineEvents.find((event: Record<string, unknown>) => event.eventType === "message.completed" && event.runId === runId);
    const runCompleted = result.timelineEvents.find((event: Record<string, unknown>) => event.eventType === "run.completed");
    const otherCompleted = result.timelineEvents.find((event: Record<string, unknown>) => event.runId === "other-run");

    assert.deepEqual(messageImages.map((block) => block.fileId), ["file_delivery_media", "file_delivery_media_2"]);
    assert.deepEqual(messageImages.map((block) => block.sourceRunId), [runId, runId]);
    assert.deepEqual(messageImages.map((block) => [block.gatewayId, block.sessionKey, block.sourceRole]), [
      ["gw_test", sessionKey, "assistant"],
      ["gw_test", sessionKey, "assistant"],
    ]);
    assert.deepEqual(server.initBodies().map((body) => body.fileName), ["first.png", "second.png"]);
    assert.deepEqual(server.initBodies().map((body) => [
      body.sessionKey,
      body.sourceRunId,
      body.sourceRole,
      body.timelineDelivery,
    ]), [
      [sessionKey, runId, "assistant", "embedded"],
      [sessionKey, runId, "assistant", "embedded"],
    ]);
    assert.equal(server.initRequestCount(), 2);
    assert.deepEqual(completed?.content?.map((block: Record<string, unknown>) => block.type), ["image", "image"]);
    assert.deepEqual(completed?.content?.map((block: Record<string, unknown>) => block.fileId), ["file_delivery_media", "file_delivery_media_2"]);
    assert.deepEqual(completed?.content?.map((block: Record<string, unknown>) => block.sourceRunId), [runId, runId]);
    assert.deepEqual(completed?.attachmentIds, completed?.content.flatMap((block: Record<string, unknown>) => [block.attachmentId, block.fileId]));
    assert.deepEqual(runCompleted?.content, []);
    assert.deepEqual(otherCompleted?.content, []);

    const replay = await relayOutgoingMediaInPayload(result, options) as any;
    assert.equal(server.initRequestCount(), 2);
    assert.deepEqual(replay.message.content, result.message.content);
    assert.deepEqual(replay.timelineEvents, result.timelineEvents);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("adapts the deployed untyped OpenClaw message-tool shape into a typed two-image receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-openclaw-message-tool-adapter-"));
  const firstPath = join(root, "adapter-first.png");
  const secondPath = join(root, "adapter-second.png");
  await writeFile(firstPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x11]));
  await writeFile(secondPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x12]));
  const server = await createFileUploadRelayServer("file_message_tool_adapter");
  const runId = "run-message-tool-adapter";
  const payload = {
    runId,
    sessionKey: "agent:main:adapter-session",
    state: "final",
    message: realOpenClawMessageToolResultFixture({
      runId,
      toolCallId: "call-adapter-images",
      idempotencyKey: `${runId}:message-tool:delivery:call-adapter-images`,
      mediaUrls: [firstPath, secondPath],
    }),
  };

  try {
    const adapted = adaptOpenClawMessageToolDelivery(payload, runId);
    assert.deepEqual(adapted, {
      contract: "openclaw.message-tool-delivery.v1",
      toolName: "message",
      toolCallId: "call-adapter-images",
      idempotencyKey: `${runId}:message-tool:delivery:call-adapter-images`,
      sourceRunId: runId,
      mediaUrls: [firstPath, secondPath],
    });
    const result = await relayOutgoingMediaInPayload(payload, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      cache: new Map(),
    }) as any;
    assert.deepEqual(
      result.message.content.filter((block: Record<string, unknown>) => block.type === "image").map((block: Record<string, unknown>) => block.fileId),
      ["file_message_tool_adapter", "file_message_tool_adapter_2"],
    );
    assert.deepEqual(server.initBodies().map((body) => [body.sourceRunId, body.fileName]), [
      [runId, "adapter-first.png"],
      [runId, "adapter-second.png"],
    ]);
    assert.equal(server.initRequestCount(), 2);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("real OpenClaw transcript message-tool rows become ordered canonical assistant attachments", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-openclaw-history-message-tool-"));
  const firstPath = join(root, "history-first.png");
  const secondPath = join(root, "history-second.png");
  const thirdPath = join(root, "history-third.png");
  await writeFile(firstPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x21]));
  await writeFile(secondPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x22]));
  await writeFile(thirdPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x23]));
  const transcriptPath = join(root, "session.jsonl");
  const runId = "history-message-tool-run";
  const firstToolResult = realOpenClawMessageToolResultFixture({
    runId,
    toolCallId: "call-history-first",
    idempotencyKey: `${runId}:message-tool:delivery:call-history-first`,
    mediaUrls: [firstPath, secondPath],
  });
  const secondToolResult = realOpenClawMessageToolResultFixture({
    runId,
    toolCallId: "call-history-second",
    idempotencyKey: `${runId}:message-tool:delivery:call-history-second`,
    mediaUrls: [thirdPath],
  });
  const partialToolResult = realOpenClawMessageToolResultFixture({
    runId,
    toolCallId: "call-history-partial",
    idempotencyKey: `${runId}:message-tool:delivery:call-history-partial`,
    mediaUrls: [firstPath],
  });
  ((partialToolResult.details as Record<string, unknown>).messageDelivery as Record<string, unknown>).partialDelivery = true;
  const dryRunToolResult = realOpenClawMessageToolResultFixture({
    runId,
    toolCallId: "call-history-dry-run",
    idempotencyKey: `${runId}:message-tool:delivery:call-history-dry-run`,
    mediaUrls: [firstPath],
  });
  (dryRunToolResult.details as Record<string, unknown>).dryRun = true;
  const untrustedToolResult = realOpenClawMessageToolResultFixture({
    runId,
    toolCallId: "call-history-untrusted",
    idempotencyKey: `${runId}:message-tool:delivery:call-history-untrusted`,
    mediaUrls: [firstPath],
  });
  const untrustedDetails = untrustedToolResult.details as Record<string, unknown>;
  const untrustedSourceReply = untrustedDetails.sourceReply as Record<string, unknown>;
  untrustedSourceReply.trustedLocalMedia = false;
  const genericMediaProjection = {
    role: "assistant",
    id: "generic-media-projection",
    runId,
    content: [],
    openclawDelivery: { mediaUrls: [firstPath] },
  };
  await writeFile(transcriptPath, `${[
    { type: "message", id: "history-user", timestamp: "2026-09-11T00:00:00.000Z", message: { role: "user", content: "show the files" } },
    { type: "message", id: "history-first-row", timestamp: "2026-09-11T00:00:01.000Z", message: firstToolResult },
    { type: "message", id: "history-second-row", timestamp: "2026-09-11T00:00:02.000Z", message: secondToolResult },
    { type: "message", id: "history-partial-row", timestamp: "2026-09-11T00:00:03.000Z", message: partialToolResult },
    { type: "message", id: "history-dry-run-row", timestamp: "2026-09-11T00:00:04.000Z", message: dryRunToolResult },
    { type: "message", id: "history-untrusted-row", timestamp: "2026-09-11T00:00:05.000Z", message: untrustedToolResult },
    { type: "message", id: "generic-media-projection", timestamp: "2026-09-11T00:00:06.000Z", message: genericMediaProjection },
  ].map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  const stateDir = join(root, "state");
  const databasePath = join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  await mkdir(join(stateDir, "agents", "main", "agent"), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT NOT NULL);
      CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL);
    `);
    database.prepare("INSERT INTO session_nodes (session_key, current_session_id) VALUES (?, ?)")
      .run("agent:main:history-message-tool", "history-source-session");
    const insertEvent = database.prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json) VALUES (?, ?, ?)",
    );
    const rawLines = (await readFile(transcriptPath, "utf8")).trim().split("\n");
    rawLines.forEach((line, index) => insertEvent.run("history-source-session", index + 1, line));
  } finally {
    database.close();
  }
  const server = await createFileUploadRelayServer("file_history_message_tool", { echoFileName: true });
  const options = {
    relayServerUrl: server.baseUrl,
    relaySecret: "secret",
    gatewayId: "gw_test",
    cache: new Map(),
  };
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;

  try {
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const history = await readOpenClawTranscriptChatHistory({
      sessionKey: "agent:main:history-message-tool",
      projectionGatewayId: "gw_test",
      limit: 20,
      projectionVersion: 3,
    }, DEFAULT_GATEWAY_SESSION_DEFAULTS);
    assert.deepEqual(history.messages?.map((message) => message.role), [
      "user",
      "assistant",
      "assistant",
      "toolResult",
      "toolResult",
      "toolResult",
      "assistant",
    ]);
    assert.deepEqual(history.timelineSnapshot?.messages.map((message) => [message.role, message.sourceOrderSeq]), [
      ["user", 1],
      ["assistant", 2],
      ["assistant", 3],
      ["tool", 4],
      ["tool", 5],
      ["tool", 6],
      ["assistant", 7],
    ]);

    const relayed = await relayOutgoingMediaInHistoryResponse(history, options) as typeof history;
    const assistantRows = (relayed.messages ?? []).filter((message) => message.role === "assistant");
    assert.equal(assistantRows.length, 3);
    assert.deepEqual((assistantRows[0]?.content as Array<Record<string, unknown>>).map((block) => block.fileName), [
      "history-first.png",
      "history-second.png",
    ]);
    assert.deepEqual((assistantRows[1]?.content as Array<Record<string, unknown>>).map((block) => block.fileName), [
      "history-third.png",
    ]);
    assert.deepEqual(assistantRows.slice(0, 2).map((message) => message.runId), [runId, runId]);
    assert.equal((relayed.messages ?? []).find((message) => message.id === "history-partial-row")?.role, "toolResult");
    assert.deepEqual((relayed.messages ?? []).find((message) => message.id === "generic-media-projection")?.content, []);
    assert.deepEqual(
      ["history-partial-row", "history-dry-run-row", "history-untrusted-row"].map((id) => (
        (relayed.messages ?? []).find((message) => message.id === id)?.role
      )),
      ["toolResult", "toolResult", "toolResult"],
    );

    const canonical = relayed.timelineSnapshot?.messages ?? [];
    assert.deepEqual(canonical.slice(1, 3).map((message) => ({
      role: message.role,
      sourceMessageId: message.sourceMessageId,
      sourceOrderSeq: message.sourceOrderSeq,
      attachmentCount: message.attachmentIds?.length,
      attachmentIdsIncludeContent: message.content.every((block) => (
        message.attachmentIds?.includes(String(block.attachmentId))
        && message.attachmentIds?.includes(String(block.fileId))
      )),
      fileNames: message.content.map((block) => block.fileName),
    })), [
      {
        role: "assistant",
        sourceMessageId: "history-first-row",
        sourceOrderSeq: 2,
        attachmentCount: 4,
        attachmentIdsIncludeContent: true,
        fileNames: ["history-first.png", "history-second.png"],
      },
      {
        role: "assistant",
        sourceMessageId: "history-second-row",
        sourceOrderSeq: 3,
        attachmentCount: 2,
        attachmentIdsIncludeContent: true,
        fileNames: ["history-third.png"],
      },
    ]);
    assert.equal(canonical.some((message) => message.role === "tool" && message.content.some((block) => block.fileId)), false);
    assert.equal(server.initRequestCount(), 3);

    const replay = await relayOutgoingMediaInHistoryResponse(relayed, options) as typeof relayed;
    assert.deepEqual(replay.timelineSnapshot?.messages, relayed.timelineSnapshot?.messages);
    assert.equal(server.initRequestCount(), 3);
  } finally {
    await server.close();
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenClaw delivery media upload failure preserves the terminal payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-openclaw-delivery-media-failure-"));
  const imagePath = join(root, "terminal.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const server = await createFileUploadRelayServer("file_should_not_complete", { initStatus: 400 });
  const payload = {
    runId: "delivery-failure-run",
    sessionKey: "agent:main:session_delivery_failure",
    state: "final",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "terminal" }],
      openclawDelivery: {
        contract: "openclaw.message-tool-delivery.v1",
        toolName: "message",
        toolCallId: "call-delivery-failure",
        idempotencyKey: "delivery-failure-run:message-tool:delivery:call-delivery-failure",
        sourceRunId: "delivery-failure-run",
        textPhaseRequiresTerminal: true,
        mediaUrls: [imagePath],
      },
    },
    timelineEvents: [
      {
        eventType: "message.completed",
        role: "assistant",
        runId: "delivery-failure-run",
        turnId: "delivery-failure-run",
        content: [],
        attachmentIds: [],
      },
      {
        eventType: "run.completed",
        role: "assistant",
        runId: "delivery-failure-run",
        turnId: "delivery-failure-run",
        content: [],
      },
    ],
  };

  try {
    const result = await relayOutgoingMediaInPayload(payload, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      cache: new Map(),
      userMessage: "把这张图片发给我",
    });
    assert.deepEqual(result, payload);
    assert.equal(server.initRequestCount(), 1);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenClaw delivery media uses structured metadata and rejects invalid paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-openclaw-delivery-media-gate-"));
  const imagePath = join(root, "valid.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const server = await createFileUploadRelayServer("file_structured_delivery");
  const makePayload = (mediaUrls: unknown[]) => ({
    runId: "delivery-gate-run",
    sessionKey: "agent:main:session_delivery_gate",
    state: "final",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "delivery" }],
      openclawDelivery: {
        contract: "openclaw.message-tool-delivery.v1",
        toolName: "message",
        toolCallId: "call-delivery-gate",
        idempotencyKey: "delivery-gate-run:message-tool:delivery:call-delivery-gate",
        sourceRunId: "delivery-gate-run",
        textPhaseRequiresTerminal: true,
        mediaUrls,
      },
    },
    timelineEvents: [],
  });
  const options = {
    relayServerUrl: server.baseUrl,
    relaySecret: "secret",
    gatewayId: "gw_test",
    cache: new Map(),
  };

  try {
    const structuredDelivery = await relayOutgoingMediaInPayload(makePayload([imagePath]), {
      ...options,
      userMessage: "图片的路径是什么",
    }) as any;
    assert.equal(structuredDelivery.message.content[1].fileId, "file_structured_delivery");
    assert.equal(server.initRequestCount(), 1);

    const invalidPaths = await relayOutgoingMediaInPayload(makePayload([
      join(root, "missing.png"),
      join(root, "not-supported.exe"),
      "relative.png",
      `file://${imagePath}`,
      "C:\\Users\\someone\\Desktop\\remote.png",
      "\\\\server\\share\\remote.png",
    ]), {
      ...options,
      userMessage: "把这些图片发给我",
    });
    assert.deepEqual(invalidPaths, makePayload([
      join(root, "missing.png"),
      join(root, "not-supported.exe"),
      "relative.png",
      `file://${imagePath}`,
      "C:\\Users\\someone\\Desktop\\remote.png",
      "\\\\server\\share\\remote.png",
    ]));
    assert.equal(server.initRequestCount(), 1);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("arbitrary OpenClaw mediaUrls without a typed delivery receipt are inert", async () => {
  const fixture = await createOutgoingMediaFixture();
  const server = await createFileUploadRelayServer("file_untyped_delivery");
  const imagePath = join(fixture.root, "originals", "photo.jpg");
  try {
    const result = await relayOutgoingMediaInPayload({
      runId: "untyped-delivery-run",
      sessionKey: "agent:main:session_1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "图片路径是 /tmp/user-question.png" }],
        openclawDelivery: { mediaUrls: [imagePath] },
      },
    }, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      cache: new Map(),
      userMessage: "图片的路径是什么",
    });
    assert.deepEqual(result, {
      runId: "untyped-delivery-run",
      sessionKey: "agent:main:session_1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "图片路径是 /tmp/user-question.png" }],
        openclawDelivery: { mediaUrls: [imagePath] },
      },
    });
    assert.equal(server.initRequestCount(), 0);
  } finally {
    await server.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("relayOutgoingMediaInPayload shares one upload while identical blocks resolve concurrently", async () => {
  const fixture = await createOutgoingMediaFixture();
  const server = await createFileUploadRelayServer("file_outgoing_shared");
  try {
    const outgoingUrl = `/api/chat/media/outgoing/agent%3Amain%3Asession_1/${fixture.attachmentId}/full`;
    const payload = {
      message: {
        runId: "assistant-run-shared",
        role: "assistant",
        content: [
          { type: "image", url: outgoingUrl, mimeType: "image/jpeg" },
          { type: "image", url: outgoingUrl, mimeType: "image/jpeg" },
        ],
      },
    };

    const result = await relayOutgoingMediaInPayload(payload, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      recordsDir: fixture.recordsDir,
      cache: new Map(),
    }) as typeof payload;

    assert.equal(server.initRequestCount(), 1);
    assert.deepEqual(
      result.message.content.map((block) => (block as Record<string, unknown>).fileId),
      ["file_outgoing_shared", "file_outgoing_shared"],
    );
    assert.equal(typeof server.initBody()?.idempotencyKey, "string");
    assert.notEqual(server.initBody()?.idempotencyKey, "");
  } finally {
    await server.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("relayOutgoingMediaInHistoryResponse rewrites outgoing media inside chat history", async () => {
  const fixture = await createOutgoingMediaFixture();
  const server = await createFileUploadRelayServer("file_outgoing_history");
  try {
    const history = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "image",
              url: `/api/chat/media/outgoing/agent%3Amain%3Asession_1/${fixture.attachmentId}/full`,
              mimeType: "image/jpeg",
            },
          ],
        },
      ],
    };

    const result = await relayOutgoingMediaInHistoryResponse(history, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      recordsDir: fixture.recordsDir,
      cache: new Map(),
    }) as typeof history;

    const image = result.messages[0].content[0] as Record<string, unknown>;
    assert.equal(image.fileId, "file_outgoing_history");
    assert.equal(image.downloadPath, "/api/mobile/files/file_outgoing_history");
  } finally {
    await server.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("relay history uploads images that only exist in an OpenClaw delivery-mirror projection", async () => {
  const fixture = await createOutgoingMediaFixture();
  const server = await createFileUploadRelayServer("file_delivery_mirror_history");
  const runId = "assistant-delivery-mirror";
  const outgoingUrl = `/api/chat/media/outgoing/agent%3Amain%3Asession_1/${fixture.attachmentId}/full`;
  try {
    const result = await relayOutgoingMediaInHistoryResponse({
      sessionKey: "agent:main:session_1",
      messages: [
        {
          role: "assistant",
          __openclaw: { runId },
          content: [{ type: "toolCall", id: "call_send", name: "message" }],
        },
        {
          role: "assistant",
          idempotencyKey: `${runId}:message-tool:delivery:call_send`,
          __openclaw: { runId },
          content: [],
          openclawDisplayContent: [{ type: "image", url: outgoingUrl, alt: "photo.jpg" }],
        },
      ],
    }, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      recordsDir: fixture.recordsDir,
      cache: new Map(),
    }) as { messages: Array<{ content: Array<Record<string, unknown>> }> };

    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]?.content[1]?.type, "image");
    assert.equal(result.messages[0]?.content[1]?.fileId, "file_delivery_mirror_history");
    assert.equal(result.messages[0]?.content[1]?.downloadPath, "/api/mobile/files/file_delivery_mirror_history");
    assert.equal(server.initRequestCount(), 1);
  } finally {
    await server.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("history merges an OpenClaw assistant-media sidecar only through its explicit run identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-openclaw-sidecar-history-"));
  const recordsDir = join(root, "missing-records");
  const attachmentId = "att_missing_sidecar";
  const outgoingUrl = `/api/chat/media/outgoing/agent%3Amain%3Asession_1/${attachmentId}/full`;
  const runId = "wx_1787558915948_espv455s";
  try {
    const history = {
      sessionKey: "agent:main:session_1",
      messages: [
        {
          id: "assistant-text",
          role: "assistant",
          runId,
          content: [{ type: "text", text: "桌面只找到一张图片\nMEDIA:/Users/example/Desktop/photo.png" }],
        },
        {
          id: "assistant-media",
          role: "assistant",
          idempotencyKey: `${runId}:assistant-media`,
          content: [
            { type: "text", text: "桌面只找到一张图片" },
            { type: "image", url: outgoingUrl },
          ],
        },
      ],
      timelineSnapshot: {
        messages: [
          {
            messageId: "assistant-text",
            role: "assistant",
            runId,
            content: [{ type: "text", text: "桌面只找到一张图片\nMEDIA:/Users/example/Desktop/photo.png" }],
          },
          {
            messageId: "assistant-media",
            role: "assistant",
            idempotencyKey: `${runId}:assistant-media`,
            content: [
              { type: "text", text: "桌面只找到一张图片" },
              { type: "image", url: outgoingUrl, attachmentId },
            ],
            attachmentIds: [attachmentId],
          },
        ],
      },
    };

    const result = await relayOutgoingMediaInHistoryResponse(history, {
      relayServerUrl: "http://127.0.0.1:1",
      relaySecret: "secret",
      gatewayId: "gw_test",
      recordsDir,
      cache: new Map(),
    }) as typeof history;

    assert.equal(result.messages.length, 1);
    const expectedContent = [
      { type: "text", text: "桌面只找到一张图片" },
      {
        type: "image",
        attachmentId,
        fileName: "图片",
        transferState: "expired",
        isRemoteExpired: true,
        attachmentStatusText: "图片文件在桌面端已不可用",
        uploadStatusText: "图片文件在桌面端已不可用",
      },
    ];
    assert.deepEqual(result.messages[0]?.content, expectedContent);
    assert.equal(result.timelineSnapshot.messages.length, 1);
    assert.deepEqual(result.timelineSnapshot.messages[0]?.content, expectedContent);
    assert.deepEqual(result.timelineSnapshot.messages[0]?.attachmentIds, [attachmentId]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assistant-media sidecars are never matched by text or a non-identical run", () => {
  const runId = "run-parent";
  const sameTextDifferentRun = normalizeOpenClawAssistantMediaSidecars([
    { role: "assistant", runId: "run-other", content: [{ type: "text", text: "same text" }] },
    { role: "assistant", idempotencyKey: `${runId}:assistant-media`, content: [{ type: "image", url: "x" }] },
  ], "agent:main:session_1");

  assert.equal(sameTextDifferentRun.changed, false);
  assert.equal(sameTextDifferentRun.messages.length, 2);
  assert.equal(isOpenClawAssistantMediaSidecarPayload({
    state: "final",
    message: { role: "assistant", idempotencyKey: `${runId}:assistant-media`, content: [] },
  }), true);
  assert.equal(isOpenClawAssistantMediaSidecarPayload({
    state: "final",
    message: { role: "assistant", idempotencyKey: runId, content: [] },
  }), false);
});

test("automatic message-tool media is folded through its explicit sourceRunId", () => {
  const sourceRunId = "wx_media_parent";
  const normalized = normalizeOpenClawAutomaticMediaReplies([
    {
      id: "assistant-parent",
      role: "assistant",
      sessionKey: "agent:main:session_1",
      runId: sourceRunId,
      content: [{ type: "text", text: "三张图片都发过来了" }],
    },
    {
      id: "message-tool-media-1",
      role: "assistant",
      sessionKey: "agent:main:session_1",
      sourceRunId,
      content: [{ type: "image", url: "/api/chat/media/outgoing/session/att_one/full" }],
    },
    {
      id: "message-tool-media-2",
      role: "assistant",
      sessionKey: "agent:main:session_1",
      sourceRunId,
      content: [{ type: "image", url: "/api/chat/media/outgoing/session/att_two/full" }],
    },
  ], "agent:main:session_1");

  assert.equal(normalized.changed, true);
  assert.equal(normalized.messages.length, 1);
  assert.deepEqual((normalized.messages[0] as Record<string, unknown>).content, [
    { type: "text", text: "三张图片都发过来了" },
    { type: "image", url: "/api/chat/media/outgoing/session/att_one/full" },
    { type: "image", url: "/api/chat/media/outgoing/session/att_two/full" },
  ]);
});

test("concurrent message-tool media is restored to authoritative tool-call order", () => {
  const sourceRunId = "wx_media_parent";
  const normalized = normalizeOpenClawAutomaticMediaReplies([
    {
      id: "assistant-tool-calls",
      role: "assistant",
      __openclaw: { runId: sourceRunId },
      content: [
        { type: "thinking", thinking: "send three files" },
        { type: "toolCall", id: "call_first", name: "message" },
        { type: "toolCall", id: "call_second", name: "message" },
        { type: "toolCall", id: "call_third", name: "message" },
      ],
    },
    {
      id: "reply-third",
      role: "assistant",
      idempotencyKey: `${sourceRunId}:message-tool:delivery-third:call_third`,
      __openclaw: { runId: sourceRunId },
      content: [{ type: "image", url: "/api/chat/media/outgoing/session/att_third/full" }],
    },
    {
      id: "reply-first",
      role: "assistant",
      idempotencyKey: `${sourceRunId}:message-tool:delivery-first:call_first`,
      __openclaw: { runId: sourceRunId },
      content: [{ type: "image", url: "/api/chat/media/outgoing/session/att_first/full" }],
    },
    {
      id: "reply-second",
      role: "assistant",
      idempotencyKey: `${sourceRunId}:message-tool:delivery-second:call_second`,
      __openclaw: { runId: sourceRunId },
      content: [{ type: "image", url: "/api/chat/media/outgoing/session/att_second/full" }],
    },
    {
      id: "assistant-visible-final",
      role: "assistant",
      __openclaw: { runId: sourceRunId },
      content: [{ type: "text", text: "三张图片再发一遍" }],
    },
  ], "agent:main:session_1");

  assert.equal(normalized.changed, true);
  assert.equal(normalized.messages.length, 2);
  assert.deepEqual((normalized.messages[1] as Record<string, unknown>).content, [
    { type: "text", text: "三张图片再发一遍" },
    { type: "image", url: "/api/chat/media/outgoing/session/att_first/full" },
    { type: "image", url: "/api/chat/media/outgoing/session/att_second/full" },
    { type: "image", url: "/api/chat/media/outgoing/session/att_third/full" },
  ]);
});

test("automatic message-tool media stays independent without one exact parent run", () => {
  const normalized = normalizeOpenClawAutomaticMediaReplies([
    {
      id: "parent-one",
      role: "assistant",
      sessionKey: "agent:main:session_1",
      runId: "wx_shared_run",
      content: [{ type: "text", text: "first" }],
    },
    {
      id: "parent-two",
      role: "assistant",
      sessionKey: "agent:main:session_1",
      runId: "wx_shared_run",
      content: [{ type: "text", text: "second" }],
    },
    {
      id: "message-tool-media",
      role: "assistant",
      sessionKey: "agent:main:session_1",
      sourceRunId: "wx_shared_run",
      content: [{ type: "image", url: "/api/chat/media/outgoing/session/att/full" }],
    },
  ], "agent:main:session_1");

  assert.equal(normalized.changed, false);
  assert.equal(normalized.messages.length, 3);
});

test("automatic media relation registry keeps explicit agent dashboard scopes distinct", () => {
  const sourceRunId = "same-run-id-in-fixture";
  const defaults = {
    mainSessionKey: "agent:main:main",
    mainKey: "main",
    defaultAgentId: "main",
  };
  const normalized = normalizeOpenClawAutomaticMediaReplies([
    {
      id: "main-parent",
      role: "assistant",
      sessionKey: "dashboard:38ff",
      runId: sourceRunId,
      content: [{ type: "toolCall", id: "call-main", name: "message" }],
    },
    {
      id: "writer-parent",
      role: "assistant",
      sessionKey: "agent:writer:dashboard:38ff",
      runId: sourceRunId,
      content: [{ type: "toolCall", id: "call-writer", name: "message" }],
    },
    {
      id: "main-reply",
      role: "assistant",
      sessionKey: "agent:main:dashboard:38ff",
      idempotencyKey: `${sourceRunId}:message-tool:delivery:call-main`,
      content: [{ type: "image", url: "main-image" }],
    },
    {
      id: "writer-reply",
      role: "assistant",
      sessionKey: "agent:writer:dashboard:38ff",
      idempotencyKey: `${sourceRunId}:message-tool:delivery:call-writer`,
      content: [{ type: "image", url: "writer-image" }],
    },
  ], undefined, { sessionDefaults: defaults });

  assert.equal(normalized.messages.length, 2);
  assert.deepEqual(normalized.messages.map((message: any) => [
    message.id,
    message.content.map((block: any) => block.url).filter(Boolean),
  ]), [
    ["main-parent", ["main-image"]],
    ["writer-parent", ["writer-image"]],
  ]);
});

test("delivery-mirror display media is promoted when protocol content is empty", () => {
  const sourceRunId = "wx_display_mirror_run";
  const displayUrl = "/api/chat/media/outgoing/agent%3Amain%3Asession_1/att_display/full";
  const normalized = normalizeOpenClawAutomaticMediaReplies([
    {
      id: "assistant-tool-call",
      role: "assistant",
      __openclaw: { runId: sourceRunId },
      content: [{ type: "toolCall", id: "call_display", name: "message" }],
    },
    {
      id: "delivery-mirror-display",
      role: "assistant",
      idempotencyKey: `${sourceRunId}:message-tool:delivery-display:call_display`,
      __openclaw: { runId: sourceRunId },
      content: [],
      openclawDisplayContent: [{
        type: "image",
        artifactId: "artifact_managed_image_display",
        url: displayUrl,
        alt: "photo.png",
        mimeType: "image/png",
      }],
    },
  ], "agent:main:session_1");

  assert.equal(normalized.changed, true);
  assert.equal(normalized.messages.length, 1);
  assert.deepEqual((normalized.messages[0] as Record<string, unknown>).content, [{
    type: "toolCall",
    id: "call_display",
    name: "message",
  }, {
    type: "image",
    artifactId: "artifact_managed_image_display",
    url: displayUrl,
    alt: "photo.png",
    mimeType: "image/png",
  }]);
});

test("multiple delivery-mirror display rows remain visible when their run has several tool calls", () => {
  const sourceRunId = "wx_display_mirror_concurrent";
  const normalized = normalizeOpenClawAutomaticMediaReplies([
    {
      id: "assistant-tool-call-one",
      role: "assistant",
      __openclaw: { runId: sourceRunId },
      content: [{ type: "toolCall", id: "call_one", name: "message" }],
    },
    {
      id: "assistant-tool-call-two",
      role: "assistant",
      __openclaw: { runId: sourceRunId },
      content: [{ type: "toolCall", id: "call_two", name: "message" }],
    },
    {
      id: "delivery-mirror-one",
      role: "assistant",
      idempotencyKey: `${sourceRunId}:message-tool:delivery-one:call_one`,
      __openclaw: { runId: sourceRunId },
      content: [],
      openclawDisplayContent: [{ type: "image", url: "/api/chat/media/outgoing/session/att_one/full" }],
    },
    {
      id: "delivery-mirror-two",
      role: "assistant",
      idempotencyKey: `${sourceRunId}:message-tool:delivery-two:call_two`,
      __openclaw: { runId: sourceRunId },
      content: [],
      openclawDisplayContent: [{ type: "image", url: "/api/chat/media/outgoing/session/att_two/full" }],
    },
  ], "agent:main:session_1");

  assert.equal(normalized.changed, true);
  assert.equal(normalized.messages.length, 4);
  assert.deepEqual(
    normalized.messages.slice(2).map((message) => (message as Record<string, unknown>).content),
    [
      [{ type: "image", url: "/api/chat/media/outgoing/session/att_one/full" }],
      [{ type: "image", url: "/api/chat/media/outgoing/session/att_two/full" }],
    ],
  );
});

test("repeated display entries are preserved when OpenClaw intentionally sends the same media twice", () => {
  const normalized = normalizeOpenClawAutomaticMediaReplies([
    {
      role: "assistant",
      idempotencyKey: "run-repeat:message-tool:delivery:call_repeat",
      __openclaw: { runId: "run-repeat" },
      content: [],
      openclawDisplayContent: [
        { type: "image", url: "/api/chat/media/outgoing/session/att_repeat/full" },
        { type: "image", url: "/api/chat/media/outgoing/session/att_repeat/full" },
      ],
    },
  ], "agent:main:session_1");

  assert.equal(normalized.changed, true);
  assert.equal(normalized.messages.length, 1);
  assert.equal((normalized.messages[0] as Record<string, unknown>).content?.length, 2);
});

test("payload preserves unavailable outgoing media as an explicit placeholder", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-openclaw-sidecar-payload-"));
  const recordsDir = join(root, "missing-records");
  const attachmentId = "att_missing_payload";
  const outgoingUrl = `/api/chat/media/outgoing/agent%3Amain%3Asession_1/${attachmentId}/full`;
  try {
    const payload = {
      runId: "run-1",
      sessionKey: "agent:main:session_1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "图片如下" }, { type: "image", url: outgoingUrl, attachmentId }],
      },
      timelineEvents: [{
        eventType: "message.completed",
        runId: "run-1",
        content: [{ type: "text", text: "图片如下" }, { type: "image", url: outgoingUrl, attachmentId }],
        attachmentIds: [attachmentId],
      }],
    };
    const result = await relayOutgoingMediaInPayload(payload, {
      relayServerUrl: "http://127.0.0.1:1",
      relaySecret: "secret",
      gatewayId: "gw_test",
      recordsDir,
      cache: new Map(),
    }) as typeof payload;

    const messageAttachment = result.message.content[1] as Record<string, unknown>;
    const timelineAttachment = result.timelineEvents[0]?.content[1] as Record<string, unknown>;
    assert.deepEqual(result.message.content[0], { type: "text", text: "图片如下" });
    assert.equal(messageAttachment.attachmentId, attachmentId);
    assert.equal(messageAttachment.transferState, "expired");
    assert.equal(messageAttachment.isRemoteExpired, true);
    assert.equal(messageAttachment.downloadUrl, undefined);
    assert.equal(timelineAttachment.attachmentId, attachmentId);
    assert.equal(timelineAttachment.transferState, "expired");
    assert.deepEqual(result.timelineEvents[0]?.attachmentIds, [attachmentId]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live payload waits for an outgoing-media record that is committed just after its event", async () => {
  const fixture = await createOutgoingMediaFixture();
  const server = await createFileUploadRelayServer("file_outgoing_delayed_record");
  const recordPath = join(fixture.recordsDir, `${fixture.attachmentId}.json`);
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const recordJson = await readFile(recordPath, "utf8");
    await unlink(recordPath);
    const startedAt = Date.now();
    restoreTimer = setTimeout(() => {
      void writeFile(recordPath, recordJson);
    }, 20);

    const result = await relayOutgoingMediaInPayload({
      runId: "run-delayed-outgoing-record",
      sessionKey: "agent:main:session_1",
      message: {
        role: "assistant",
        content: [{
          type: "image",
          url: `/api/chat/media/outgoing/agent%3Amain%3Asession_1/${fixture.attachmentId}/full`,
        }],
      },
    }, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      recordsDir: fixture.recordsDir,
      cache: new Map(),
      waitForOutgoingMediaRecord: true,
    }) as { message: { content: Array<Record<string, unknown>> } };

    assert.equal(result.message.content[0]?.fileId, "file_outgoing_delayed_record");
    assert.equal(result.message.content[0]?.transferState, "available");
    // The bounded wait is only for external file-record visibility; timeline
    // identity/order is already projected before this upload path runs.
    assert.ok(Date.now() - startedAt < 2_000);
  } finally {
    if (restoreTimer) clearTimeout(restoreTimer);
    await server.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("relayOutgoingMediaInHistoryResponse strips staged user media without reuploading host paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-openclaw-input-media-history-"));
  const imagePath = join(root, "22.JPG");
  await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const server = await createFileUploadRelayServer("file_input_history");
  try {
    const history = {
      sessionKey: "agent:main:session_1",
      messages: [{
        id: "user-message-1",
        runId: "client-run-1:user",
        role: "user",
        content: [{ type: "text", text: `分析一下这个图片\n\n[media attached: ${imagePath} (image/jpeg) | ${imagePath}]` }],
      }],
    };

    const result = await relayOutgoingMediaInHistoryResponse(history, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      cache: new Map(),
    }) as typeof history;

    assert.equal(result.messages[0].content[0]?.text, "分析一下这个图片");
    assert.equal(result.messages[0].content.length, 1);
    assert.equal(server.initRequestCount(), 0);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("relayOutgoingMediaInHistoryResponse strips OpenClaw MEDIA control markers without local artifact uploads", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-openclaw-media-marker-history-"));
  const imagePath = join(root, "codex-shot.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const server = await createFileUploadRelayServer("file_should_not_upload");
  try {
    const history = {
      sessionKey: "agent:main:session_1",
      messages: [
        {
          id: "assistant-message-1",
          role: "assistant",
          content: [
            { type: "text", text: `桌面截图已发送到你手机上了\nMEDIA:${imagePath}` },
          ],
        },
      ],
      timelineSnapshot: {
        messages: [
          {
            messageId: "assistant-message-1",
            role: "assistant",
            content: [
              { type: "text", text: `桌面截图已发送到你手机上了\nMEDIA:${imagePath}` },
            ],
          },
        ],
      },
    };

    const result = await relayOutgoingMediaInHistoryResponse(history, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      cache: new Map(),
    }) as typeof history;

    assert.equal((result.messages[0].content[0] as Record<string, unknown>).text, "桌面截图已发送到你手机上了");
    assert.equal(result.messages[0].content.length, 1);
    assert.equal((result.timelineSnapshot.messages[0].content[0] as Record<string, unknown>).text, "桌面截图已发送到你手机上了");
    assert.equal(result.timelineSnapshot.messages[0].content.length, 1);
    assert.equal(server.initRequestCount(), 0);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("relayOutgoingMediaInPayload does not treat OpenClaw MEDIA markers as sendable local paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-openclaw-media-marker-payload-"));
  const imagePath = join(root, "codex-shot.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const server = await createFileUploadRelayServer("file_should_not_upload");
  try {
    const payload = {
      runId: "assistant-run-1",
      sessionKey: "agent:main:session_1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: `截图已经发过去了\nMEDIA:${imagePath}` },
        ],
      },
    };

    const result = await relayOutgoingMediaInPayload(payload, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      cache: new Map(),
      userMessage: "把截图发过来",
    }) as typeof payload;

    assert.deepEqual(result.message.content, [
      { type: "text", text: "截图已经发过去了" },
    ]);
    assert.equal(server.initRequestCount(), 0);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows OpenClaw MEDIA and input attachment markers are removed without host path uploads", async () => {
  const server = await createFileUploadRelayServer("windows_path_should_not_upload");
  try {
    const drivePath = "C:\\Users\\测试 User\\Pictures\\shot.png";
    const uncPath = "\\\\fileserver\\共享\\report.pdf";
    const payload = {
      runId: "windows-user-run:user",
      sessionKey: "agent:main:session_1",
      message: {
        id: "windows-user-message",
        runId: "windows-user-run:user",
        role: "user",
        content: [{
          type: "text",
          text: `检查附件\n[media attached: ${drivePath} (image/png) | ${drivePath}]\nMEDIA:${uncPath}`,
        }],
      },
    };

    const result = await relayOutgoingMediaInHistoryResponse({
      sessionKey: payload.sessionKey,
      messages: [payload.message],
    }, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      cache: new Map(),
    }) as { messages: Array<{ content: Array<{ text?: string }> }> };

    assert.deepEqual(result.messages[0]?.content, [{ type: "text", text: "检查附件" }]);
    assert.equal(server.initRequestCount(), 0);
  } finally {
    await server.close();
  }
});

test("assistant text and user intent cannot manufacture an attachment", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-openclaw-artifact-"));
  const imagePath = join(root, "ChatGPT Image 2026 04 24.jpg");
  await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const server = await createFileUploadRelayServer("file_text_must_not_upload");
  try {
    const payload = {
      runId: "run-1",
      sessionKey: "agent:main:session_1",
      state: "final",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: `Here is the image:\n${imagePath}` },
        ],
      },
    };

    const result = await relayOutgoingMediaInPayload(payload, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      cache: new Map(),
      userMessage: `send ${imagePath} to my phone`,
    }) as typeof payload;

    assert.deepEqual(result, payload);
    assert.equal(server.initRequestCount(), 0);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function createOutgoingMediaFixture() {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-outgoing-media-"));
  const recordsDir = join(root, "records");
  const originalsDir = join(root, "originals");
  await mkdir(recordsDir, { recursive: true });
  await mkdir(originalsDir, { recursive: true });
  const attachmentId = "att_test";
  const imagePath = join(originalsDir, "photo.jpg");
  await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await writeFile(join(recordsDir, `${attachmentId}.json`), JSON.stringify({
    attachmentId,
    sessionKey: "agent:main:session_1",
    alt: "photo.jpg",
    original: {
      path: imagePath,
      contentType: "image/jpeg",
      width: 20,
      height: 10,
      sizeBytes: 4,
      filename: "photo.jpg",
    },
  }));
  return { root, recordsDir, attachmentId };
}

async function createSqliteOutgoingMediaFixture() {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-outgoing-media-sqlite-"));
  const stateDir = join(root, "state-dir");
  const stateDatabaseDir = join(stateDir, "state");
  const mediaRoot = join(stateDir, "media");
  const originalsDir = join(mediaRoot, "outgoing", "originals");
  await mkdir(stateDatabaseDir, { recursive: true });
  await mkdir(originalsDir, { recursive: true });
  const attachmentId = "a87e1a99-0fd5-47be-a78d-34c44c2c0964";
  const mediaId = "f8275042-1ae1-4a94-8737-787e8a52dc47.png";
  await writeFile(join(originalsDir, mediaId), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const database = new DatabaseSync(join(stateDatabaseDir, "openclaw.sqlite"));
  try {
    database.exec(`
      CREATE TABLE managed_outgoing_image_records (
        attachment_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        alt TEXT,
        original_media_root TEXT NOT NULL,
        original_media_id TEXT NOT NULL,
        original_media_subdir TEXT NOT NULL,
        original_content_type TEXT,
        original_width INTEGER,
        original_height INTEGER,
        original_size_bytes INTEGER,
        original_filename TEXT,
        cleanup_pending INTEGER NOT NULL DEFAULT 0
      )
    `);
    database.prepare(`
      INSERT INTO managed_outgoing_image_records (
        attachment_id, session_key, alt, original_media_root, original_media_id,
        original_media_subdir, original_content_type, original_width,
        original_height, original_size_bytes, original_filename, cleanup_pending
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      attachmentId,
      "agent:main:session_1",
      "photo.png",
      mediaRoot,
      mediaId,
      "outgoing/originals",
      "image/png",
      20,
      10,
      4,
      "photo.png",
    );
  } finally {
    database.close();
  }
  return { root, stateDir, attachmentId };
}

async function createFileUploadRelayServer(fileId: string, options: { initStatus?: number; echoFileName?: boolean } = {}) {
  const uploads = new Map<string, {
    chunks: Buffer[];
    fileId: string;
    fileName?: string;
    sizeBytes: number;
    sourceRunId?: string;
    sessionKey?: string;
  }>();
  const initBodies: Array<Record<string, unknown>> = [];
  let lastInitBody: Record<string, unknown> | undefined;
  let initRequestCount = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (req.method === "POST" && url === "/api/host/gateways/gw_test/files/init") {
      initRequestCount += 1;
      const initBody = JSON.parse((await readRequestBody(req)).toString("utf8")) as Record<string, unknown>;
      initBodies.push(initBody);
      lastInitBody = initBody;
      if (options.initStatus !== undefined) {
        res.statusCode = options.initStatus;
        res.end("rejected");
        return;
      }
      const uploadId = `upload_test_${initRequestCount}`;
      const resolvedFileId = initRequestCount === 1 ? fileId : `${fileId}_${initRequestCount}`;
      uploads.set(uploadId, {
        chunks: [],
        fileId: resolvedFileId,
        fileName: typeof initBody.fileName === "string" ? initBody.fileName : undefined,
        sizeBytes: Number(initBody.sizeBytes ?? 0),
        sourceRunId: typeof initBody.sourceRunId === "string" ? initBody.sourceRunId : undefined,
        sessionKey: typeof initBody.sessionKey === "string" ? initBody.sessionKey : undefined,
      });
      writeJson(res, {
        fileId: resolvedFileId,
        uploadId,
        chunkSize: 1024,
        expiresAt: "2026-06-02T00:00:00.000Z",
        uploadUrl: `/api/host/files/${uploadId}/chunks`,
      });
      return;
    }
    const chunkMatch = /^\/api\/host\/files\/(upload_test_\d+)\/chunks\/0$/.exec(url);
    if (req.method === "PUT" && chunkMatch) {
      uploads.get(chunkMatch[1]!)?.chunks.push(await readRequestBody(req));
      writeJson(res, { ok: true });
      return;
    }
    const completeMatch = /^\/api\/host\/files\/(upload_test_\d+)\/complete$/.exec(url);
    if (req.method === "POST" && completeMatch) {
      await readRequestBody(req);
      const upload = uploads.get(completeMatch[1]!);
      assert(upload);
      assert.equal(Buffer.concat(upload.chunks).length, upload.sizeBytes);
      writeJson(res, {
        ok: true,
        payload: {
          fileId: upload.fileId,
          gatewayId: "gw_test",
          sessionKey: upload.sessionKey ?? "agent:main:session_1",
          fileName: options.echoFileName ? (upload.fileName ?? "photo.jpg") : "photo.jpg",
          mimeType: "image/jpeg",
          sizeBytes: upload.sizeBytes,
          imageWidth: 20,
          imageHeight: 10,
          sha256: "sha",
          origin: "host",
          createdAt: "2026-05-26T00:00:00.000Z",
          updatedAt: "2026-05-26T00:00:00.000Z",
          expiresAt: "2026-06-02T00:00:00.000Z",
          status: "ready",
          storagePath: "files/test",
          downloadPath: `/api/mobile/files/${upload.fileId}`,
          chunkSize: 1024,
          totalChunks: 1,
          sourceRunId: upload.sourceRunId,
        },
      });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    initRequestCount: () => initRequestCount,
    initBody: () => lastInitBody,
    initBodies: () => initBodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function writeJson(res: ServerResponse, body: unknown): void {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
