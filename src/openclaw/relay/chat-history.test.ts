import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalizeOpenClawGatewayHistoryResponse,
  clearTranscriptHistoryCache,
  filterOpenClawHeartbeatArtifacts,
  readOpenClawTranscriptChatHistory,
  readChatHistoryFromTranscriptFile,
  type HistoryResponse,
} from "./chat-history.js";
import { DEFAULT_GATEWAY_SESSION_DEFAULTS } from "./session-context.js";

test("OpenClaw projection v3 scopes multi-agent rows and never merges source ids in one run", () => {
  const result = canonicalizeOpenClawGatewayHistoryResponse({
    sessionKey: "agent:writer:mobile",
    sessionId: "session-v3",
    messages: [
      { role: "assistant", runId: "run-one", id: "source-155", seq: 155, content: [{ type: "image", attachmentId: "image-1" }] },
      { role: "assistant", runId: "run-one", id: "source-156", seq: 156, content: [{ type: "image", attachmentId: "image-2" }] },
    ],
  }, {
    sessionKey: "agent:writer:mobile",
    projectionVersion: 3,
    projectionGatewayId: "gw-writer",
  });
  const messages = result.timelineSnapshot?.messages ?? [];
  assert.equal(result.projectionVersion, 3);
  assert.equal(result.timelineSnapshot?.extensions?.sourceOrderScope, "openclaw:writer:session-v3");
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((message) => message.sourceMessageId), ["source-155", "source-156"]);
  assert.notEqual(messages[0]?.canonicalMessageId, messages[1]?.canonicalMessageId);
  assert.match(messages[0]?.canonicalMessageId ?? "", /^timeline:v3:openclaw:[0-9a-f]{64}$/);
  assert.ok((messages[0]?.canonicalMessageId?.length ?? 0) <= 191);
  assert.equal(messages[0]?.gatewayType, "openclaw");
  assert.equal(messages[0]?.producerId, "writer");
  assert.equal(messages[0]?.sourceSessionId, "session-v3");
  assert.equal(messages[0]?.sourceMessageId, "source-155");
  assert.deepEqual(messages.map((message) => message.sourceOrderSeq), [155, 156]);
});

test("OpenClaw projection v3 rejects missing gateway, session, source id, or source seq", () => {
  const base = {
    sessionKey: "agent:writer:mobile",
    sessionId: "session-v3",
    messages: [{ role: "user", id: "source-user", seq: 155, content: "hello" }],
  } satisfies HistoryResponse;

  assert.throws(() => canonicalizeOpenClawGatewayHistoryResponse(base, {
    sessionKey: base.sessionKey!,
    projectionVersion: 3,
  }), /gatewayId/);
  assert.throws(() => canonicalizeOpenClawGatewayHistoryResponse({ ...base, sessionId: undefined }, {
    sessionKey: base.sessionKey!,
    projectionVersion: 3,
    projectionGatewayId: "gw-writer",
  }), /sourceSessionId/);
  assert.throws(() => canonicalizeOpenClawGatewayHistoryResponse({
    ...base,
    messages: [{ role: "user", seq: 155, content: "hello" }],
  }, {
    sessionKey: base.sessionKey!,
    projectionVersion: 3,
    projectionGatewayId: "gw-writer",
  }), /sourceMessageId/);
  assert.throws(() => canonicalizeOpenClawGatewayHistoryResponse({
    ...base,
    messages: [{ role: "user", id: "source-user", content: "hello" }],
  }, {
    sessionKey: base.sessionKey!,
    projectionVersion: 3,
    projectionGatewayId: "gw-writer",
  }), /sourceOrderSeq/);
});

test("OpenClaw v4 gateway history becomes a canonical snapshot with native user turns", () => {
  const firstRunId = "f7ef5c1e-c3e9-48fd-a2a5-84d4f029bc07";
  const secondRunId = "b3eae41d-40ee-4a59-b65e-9182a26adf12";
  const page = canonicalizeOpenClawGatewayHistoryResponse({
    sessionKey: "main",
    sessionId: "session-v4",
    messages: [
      {
        role: "user",
        content: "你好",
        idempotencyKey: `${firstRunId}:user`,
        timestamp: 1_788_355_499_910,
        __openclaw: { id: "provider-user-1", seq: 212 },
      },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "greet" }, { type: "text", text: "你好 Alex" }],
        timestamp: 1_788_355_500_183,
        __openclaw: { id: "provider-assistant-1", seq: 213, runId: firstRunId },
      },
      {
        role: "user",
        content: "你可以做什么",
        idempotencyKey: `${secondRunId}:user`,
        timestamp: 1_788_355_511_481,
        __openclaw: { id: "provider-user-2", seq: 214 },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "我可以帮你完成任务" }],
        timestamp: 1_788_355_511_699,
        __openclaw: { id: "provider-assistant-2", seq: 215, runId: secondRunId },
      },
    ],
    hasMore: true,
  }, { sessionKey: "main" });

  assert.deepEqual(page.timelineSnapshot?.messages.map((message) => ({
    role: message.role,
    turnId: message.turnId,
    runId: message.runId,
    messageId: message.messageId,
    idempotencyKey: message.idempotencyKey,
    seq: message.seq,
  })), [
    {
      role: "user",
      turnId: firstRunId,
      runId: firstRunId,
      messageId: `user-${firstRunId}`,
      idempotencyKey: firstRunId,
      seq: 212,
    },
    {
      role: "assistant",
      turnId: firstRunId,
      runId: firstRunId,
      messageId: `assistant-${firstRunId}`,
      idempotencyKey: undefined,
      seq: 213,
    },
    {
      role: "user",
      turnId: secondRunId,
      runId: secondRunId,
      messageId: `user-${secondRunId}`,
      idempotencyKey: secondRunId,
      seq: 214,
    },
    {
      role: "assistant",
      turnId: secondRunId,
      runId: secondRunId,
      messageId: `assistant-${secondRunId}`,
      idempotencyKey: undefined,
      seq: 215,
    },
  ]);
  assert.equal(page.timelineSnapshot?.hasMore, true);
  assert.deepEqual(page.timelineSnapshot?.extensions, {
    orderPolicy: "transcript",
    sourceOrderScope: "session-v4",
  });
});

test("OpenClaw v4 gateway history keeps tool interims distinct from the final assistant", () => {
  const runId = "run-tool-1";
  const page = canonicalizeOpenClawGatewayHistoryResponse({
    sessionKey: "main",
    messages: [
      {
        role: "user",
        content: "查天气",
        idempotencyKey: `${runId}:user`,
        __openclaw: { id: "provider-user", seq: 10 },
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-weather", name: "weather" }],
        __openclaw: { id: "provider-assistant-tool", seq: 11, runId },
      },
      {
        role: "toolResult",
        toolCallId: "call-weather",
        content: [{ type: "text", text: "晴" }],
        __openclaw: { id: "provider-tool-result", seq: 12, runId },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "今天晴天" }],
        __openclaw: { id: "provider-assistant-final", seq: 13, runId },
      },
    ],
  }, { sessionKey: "main" });

  assert.deepEqual(page.timelineSnapshot?.messages.map((message) => message.messageId), [
    `user-${runId}`,
    "provider-assistant-tool",
    "tool-call-weather",
    `assistant-${runId}`,
  ]);
  assert.equal(new Set(page.timelineSnapshot?.messages.map((message) => message.messageId)).size, 4);
  assert.equal(page.timelineSnapshot?.messages[2]?.turnId, runId);
});

test("OpenClaw v4 gateway history folds concurrent media replies in tool-call order", () => {
  const runId = "wx_media_order";
  const page = canonicalizeOpenClawGatewayHistoryResponse({
    sessionKey: "main",
    messages: [
      {
        role: "user",
        content: "再发一遍图片",
        idempotencyKey: `${runId}:user`,
        __openclaw: { id: "provider-user", seq: 20 },
      },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_first", name: "message" },
          { type: "toolCall", id: "call_second", name: "message" },
          { type: "toolCall", id: "call_third", name: "message" },
        ],
        __openclaw: { id: "provider-tool-calls", seq: 21, runId },
      },
      {
        role: "assistant",
        idempotencyKey: `${runId}:message-tool:delivery-third:call_third`,
        content: [{ type: "image", attachmentId: "att-third" }],
        __openclaw: { id: "provider-third", seq: 22, runId },
      },
      {
        role: "assistant",
        idempotencyKey: `${runId}:message-tool:delivery-first:call_first`,
        content: [{ type: "image", attachmentId: "att-first" }],
        __openclaw: { id: "provider-first", seq: 23, runId },
      },
      {
        role: "assistant",
        idempotencyKey: `${runId}:message-tool:delivery-second:call_second`,
        content: [{ type: "image", attachmentId: "att-second" }],
        __openclaw: { id: "provider-second", seq: 24, runId },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "三张图片再发一遍" }],
        __openclaw: { id: "provider-final", seq: 25, runId },
      },
    ],
  }, { sessionKey: "main" });

  assert.deepEqual(page.timelineSnapshot?.messages.map((message) => message.messageId), [
    `user-${runId}`,
    "provider-tool-calls",
    `assistant-${runId}`,
  ]);
  assert.deepEqual(page.timelineSnapshot?.messages[2]?.content, [
    { type: "text", text: "三张图片再发一遍" },
    { type: "image", attachmentId: "att-first", transferState: "available" },
    { type: "image", attachmentId: "att-second", transferState: "available" },
    { type: "image", attachmentId: "att-third", transferState: "available" },
  ]);
});

test("SQLite transcript history preserves the Control UI sequence for asynchronously appended messages", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "clawconnect-chat-history-sqlite-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const sessionKey = "agent:health-manager:scheduled-review";
  const sessionId = "sqlite-history-session";
  const databasePath = join(stateDir, "agents", "health-manager", "agent", "openclaw-agent.sqlite");
  await mkdir(join(stateDir, "agents", "health-manager", "agent"), { recursive: true });

  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT NOT NULL);
      CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL);
    `);
    database.prepare("INSERT INTO session_nodes (session_key, current_session_id) VALUES (?, ?)")
      .run(sessionKey, sessionId);
    const insertEvent = database.prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json) VALUES (?, ?, ?)",
    );
    for (const [seq, id, role, text] of [
      [14, "lunch-photo", "user", "午餐图片"],
      [19, "lunch-reply", "assistant", "午餐已记录"],
      [26, "noon-workout", "user", "中午运动图片"],
      [31, "workout-reply", "assistant", "中午运动已记录"],
      [35, "dinner-missing", "assistant", "晚餐还没核实"],
      [36, "dinner-photo", "user", "晚餐图片"],
    ] as const) {
      insertEvent.run(sessionId, seq, JSON.stringify({
        type: "message",
        id,
        timestamp: new Date(Date.UTC(2026, 8, 7, 12, 0, seq)).toISOString(),
        message: { id, role, content: text },
      }));
    }
  } finally {
    database.close();
  }

  try {
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const page = await readOpenClawTranscriptChatHistory(
      { sessionKey, limit: 20 },
      DEFAULT_GATEWAY_SESSION_DEFAULTS,
    );

    assert.deepEqual(page?.messages?.map((message) => message.id), [
      "lunch-photo",
      "lunch-reply",
      "noon-workout",
      "workout-reply",
      "dinner-missing",
      "dinner-photo",
    ]);
    assert.deepEqual(page?.timelineSnapshot?.messages.map((message) => message.seq), [14, 19, 26, 31, 35, 36]);
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("SQLite projection v3 carries a mobile run id across hidden first-turn events", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "clawconnect-chat-history-sqlite-lineage-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const sessionKey = "agent:main:mobile-first-turn";
  const sessionId = "sqlite-first-turn-session";
  const runId = "wx_1789454924396_90d3l1a9";
  const databasePath = join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  await mkdir(join(stateDir, "agents", "main", "agent"), { recursive: true });

  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT NOT NULL);
      CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL);
    `);
    database.prepare("INSERT INTO session_nodes (session_key, current_session_id) VALUES (?, ?)")
      .run(sessionKey, sessionId);
    const insertEvent = database.prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json) VALUES (?, ?, ?)",
    );
    insertEvent.run(sessionId, 1, JSON.stringify({
      type: "message",
      id: "source-user",
      message: { role: "user", content: "你好", idempotencyKey: `${runId}:user` },
    }));
    insertEvent.run(sessionId, 2, JSON.stringify({
      type: "thinking_level_change",
      id: "source-thinking",
      parentId: "source-user",
    }));
    insertEvent.run(sessionId, 3, JSON.stringify({
      type: "custom",
      id: "source-custom",
      parentId: "source-thinking",
    }));
    insertEvent.run(sessionId, 4, JSON.stringify({
      type: "message",
      id: "source-assistant",
      parentId: "source-custom",
      message: { role: "assistant", content: "你好，有什么可以帮忙的？" },
    }));
  } finally {
    database.close();
  }

  try {
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const page = await readOpenClawTranscriptChatHistory({
      sessionKey,
      projectionGatewayId: "gw-openclaw",
      projectionVersion: 3,
      limit: 20,
    }, DEFAULT_GATEWAY_SESSION_DEFAULTS);
    const messages = page?.timelineSnapshot?.messages ?? [];

    assert.equal(messages.length, 2);
    assert.deepEqual(messages.map((message) => ({
      sourceMessageId: message.sourceMessageId,
      parentSourceMessageId: message.parentSourceMessageId,
      runId: message.runId,
      turnId: message.turnId,
      idempotencyKey: message.idempotencyKey,
    })), [
      {
        sourceMessageId: "source-user",
        parentSourceMessageId: undefined,
        runId: `${runId}:user`,
        turnId: `${runId}:user`,
        idempotencyKey: `${runId}:user`,
      },
      {
        sourceMessageId: "source-assistant",
        parentSourceMessageId: "source-user",
        runId,
        turnId: runId,
        idempotencyKey: runId,
      },
    ]);
    assert.notEqual(messages[0]?.canonicalMessageId, messages[1]?.canonicalMessageId);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("SQLite transcript history resolves the qualified main session through its main alias", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "clawconnect-chat-history-sqlite-alias-"));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const sessionId = "sqlite-main-alias-session";
  const databasePath = join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  await mkdir(join(stateDir, "agents", "main", "agent"), { recursive: true });

  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT NOT NULL);
      CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL);
    `);
    database.prepare("INSERT INTO session_nodes (session_key, current_session_id) VALUES (?, ?)")
      .run("agent:main:main", sessionId);
    database.prepare("INSERT INTO transcript_events (session_id, seq, event_json) VALUES (?, ?, ?)")
      .run(sessionId, 1, JSON.stringify({
        type: "message",
        id: "main-alias-reply",
        message: { role: "assistant", content: "主会话别名可读" },
      }));
  } finally {
    database.close();
  }

  try {
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const page = await readOpenClawTranscriptChatHistory(
      { sessionKey: "main", limit: 20 },
      { mainSessionKey: "agent:main:main", mainKey: "main", defaultAgentId: "main" },
    );
    assert.equal(page?.sessionId, sessionId);
    assert.equal(page?.messages?.[0]?.id, "main-alias-reply");
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("transcript history hides completed OpenClaw heartbeat-only turns", async () => {
  const fixture = await createTranscriptFixture(4, [
    transcriptMessage("user-1", "user", "hello", "2026-05-28T01:00:00.000Z"),
    transcriptMessage("assistant-1", "assistant", "hi", "2026-05-28T01:00:01.000Z"),
    transcriptMessage("heartbeat-user", "user", "[OpenClaw heartbeat poll]", "2026-05-28T01:01:00.000Z"),
    transcriptMessage("heartbeat-assistant", "assistant", "HEARTBEAT_OK", "2026-05-28T01:01:01.000Z"),
  ]);
  try {
    const page = await readChatHistoryFromTranscriptFile({
      sessionKey: "agent:main:main",
      transcriptPath: fixture.path,
      limit: 20,
    });

    assert.deepEqual(page.messages?.map((message) => message.id), ["user-1", "assistant-1"]);
    assert.deepEqual(page.timelineSnapshot?.messages.map((message) => message.messageId), ["user-1", "assistant-1"]);
  } finally {
    await fixture.cleanup();
  }
});

test("heartbeat filtering keeps real alerts and similar user text", () => {
  const messages = [
    { id: "heartbeat-alert-user", role: "user", content: "[OpenClaw heartbeat poll]" },
    { id: "heartbeat-alert-assistant", role: "assistant", content: "Disk space is low" },
    { id: "similar-user", role: "user", content: "[OpenClaw heartbeat poll] please explain" },
    { id: "similar-assistant", role: "assistant", content: "HEARTBEAT_OK" },
  ];

  assert.deepEqual(filterOpenClawHeartbeatArtifacts(messages), messages);
});

test("heartbeat filtering removes multi-step heartbeats with intermediate assistant thoughts and tool calls", () => {
  const messages = [
    { id: "heartbeat-user", role: "user", content: "[OpenClaw heartbeat poll]" },
    { id: "heartbeat-assistant-thinking", role: "assistant", content: "" },
    { id: "heartbeat-tool-call", role: "assistant", content: [{ type: "toolCall", name: "read" }] },
    { id: "heartbeat-tool-result", role: "toolResult", content: [{ type: "toolResult", text: "ok" }] },
    { id: "heartbeat-assistant-ack", role: "assistant", content: "HEARTBEAT_OK" },
    { id: "real-user", role: "user", content: "Hello OpenClaw" },
  ];

  assert.deepEqual(filterOpenClawHeartbeatArtifacts(messages), [messages[5]]);
});

test("heartbeat filtering removes standalone heartbeat prompts and ACKs", () => {
  const messages = [
    { id: "standalone-prompt", role: "user", content: "[OpenClaw heartbeat poll]" },
    { id: "standalone-ack", role: "assistant", content: "HEARTBEAT_OK" },
    { id: "real-user", role: "user", content: "How are you?" },
  ];

  assert.deepEqual(filterOpenClawHeartbeatArtifacts(messages), [messages[2]]);
});

test("heartbeat filtering removes silent tool artifacts only after a terminal acknowledgement", () => {
  const messages = [
    { id: "heartbeat-user", role: "user", content: "[OpenClaw heartbeat poll]" },
    { id: "heartbeat-tool-call", role: "assistant", content: [{ type: "toolCall", name: "read" }] },
    { id: "heartbeat-tool-result", role: "toolResult", content: [{ type: "toolResult", text: "ok" }] },
    { id: "heartbeat-assistant", role: "assistant", content: [{ type: "text", text: "HEARTBEAT_OK" }] },
    { id: "next-user", role: "user", content: "hello" },
  ];

  assert.deepEqual(filterOpenClawHeartbeatArtifacts(messages), [messages[4]]);
});

test("transcript history provider pages newest and older windows with seq cursors", async () => {
  const fixture = await createTranscriptFixture(260);
  try {
    const firstPage = await readChatHistoryFromTranscriptFile({
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      transcriptPath: fixture.path,
      limit: 100,
    });

    assert.equal(firstPage.messages?.length, 100);
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.nextCursor, "seq:161");
    assert.equal(firstPage.newestCursor, "seq:260");
    assert.deepEqual(firstPage.messages?.map((message) => message.seq).slice(0, 3), [161, 162, 163]);
    assert.deepEqual(firstPage.messages?.map((message) => message.seq).slice(-3), [258, 259, 260]);

    const secondPage = await readChatHistoryFromTranscriptFile({
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      transcriptPath: fixture.path,
      limit: 100,
      cursor: firstPage.nextCursor,
      direction: "older",
    });

    assert.equal(secondPage.messages?.length, 100);
    assert.equal(secondPage.hasMore, true);
    assert.equal(secondPage.nextCursor, "seq:61");
    assert.equal(secondPage.newestCursor, "seq:160");
    assert.deepEqual(secondPage.messages?.map((message) => message.seq).slice(0, 3), [61, 62, 63]);
    assert.deepEqual(secondPage.messages?.map((message) => message.seq).slice(-3), [158, 159, 160]);

    const finalPage = await readChatHistoryFromTranscriptFile({
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      transcriptPath: fixture.path,
      limit: 100,
      cursor: secondPage.nextCursor,
      direction: "older",
    });

    assert.equal(finalPage.messages?.length, 60);
    assert.equal(finalPage.hasMore, false);
    assert.equal(finalPage.nextCursor, undefined);
    assert.equal(finalPage.newestCursor, "seq:60");
    assert.deepEqual(finalPage.messages?.map((message) => message.seq).slice(0, 3), [1, 2, 3]);
    assert.deepEqual(finalPage.messages?.map((message) => message.seq).slice(-3), [58, 59, 60]);
  } finally {
    await fixture.cleanup();
  }
});

test("transcript history provider preserves OpenClaw tool content blocks", async () => {
  const fixture = await createTranscriptFixture(2, [
    {
      type: "message",
      id: "assistant-tool-call",
      timestamp: "2026-05-28T01:00:00.000Z",
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: "pwd" },
        }],
      },
    },
    {
      type: "message",
      id: "tool-result",
      timestamp: "2026-05-28T01:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{
          type: "toolResult",
          id: "call-1",
          name: "bash",
          content: "/Users/qiuqiquan/Desktop/openClaw",
          text: "/Users/qiuqiquan/Desktop/openClaw",
        }],
      },
    },
  ]);
  try {
    const page = await readChatHistoryFromTranscriptFile({
      sessionKey: "agent:main:main",
      transcriptPath: fixture.path,
      limit: 20,
    });

    assert.equal(page.messages?.length, 2);
    assert.deepEqual(page.messages?.[0]?.content, [{
      type: "toolCall",
      id: "call-1",
      name: "bash",
      arguments: { command: "pwd" },
    }]);
    assert.deepEqual(page.messages?.[1]?.content, [{
      type: "toolResult",
      id: "call-1",
      name: "bash",
      content: "/Users/qiuqiquan/Desktop/openClaw",
      text: "/Users/qiuqiquan/Desktop/openClaw",
    }]);
    assert.deepEqual(page.timelineSnapshot?.messages[1]?.content, [{
      type: "toolresult",
      id: "call-1",
      name: "bash",
      content: "/Users/qiuqiquan/Desktop/openClaw",
      text: "/Users/qiuqiquan/Desktop/openClaw",
      toolCallId: "call-1",
    }]);
    assert.match(page.timelineSnapshot?.messages[1]?.content[0]?.toolCallId as string, /^call-1$/);
  } finally {
    await fixture.cleanup();
  }
});

test("transcript history provider returns a canonical timeline snapshot page", async () => {
  const fixture = await createTranscriptFixture(2, [
    {
      type: "message",
      id: "prompt-1",
      timestamp: "2026-05-28T01:00:00.000Z",
      message: {
        role: "user",
        content: "send the desktop image",
      },
    },
    {
      type: "message",
      id: "file-1",
      timestamp: "2026-05-28T01:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "sent:" },
          {
            type: "file",
            attachmentId: "file-history-1",
            fileId: "file-history-1",
            fileName: "desktop.png",
            mimeType: "image/png",
            transferState: "available",
          },
        ],
      },
    },
  ]);
  try {
    const page = await readChatHistoryFromTranscriptFile({
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      transcriptPath: fixture.path,
      limit: 20,
    });
    const snapshot = (page as HistoryResponse & {
      timelineSnapshot?: {
        protocolVersion: number;
        eventType: string;
        sessionKey: string;
        cursor: string | null;
        hasMore: boolean;
        newestCursor: string | null;
        messages: Array<Record<string, unknown>>;
        attachments: unknown[];
      };
    }).timelineSnapshot;

    assert.equal(snapshot?.protocolVersion, 2);
    assert.equal(snapshot?.eventType, "history.snapshot.page");
    assert.equal(snapshot?.sessionKey, "agent:main:main");
    assert.equal(snapshot?.cursor, null);
    assert.equal(snapshot?.hasMore, false);
    assert.equal(snapshot?.newestCursor, "seq:2");
    assert.deepEqual(page.timelineSnapshot?.extensions, {
      orderPolicy: "transcript",
      sourceOrderScope: "session-1",
    });
    assert.deepEqual(snapshot?.messages.map((message) => ({
      messageId: message.messageId,
      role: message.role,
      content: message.content,
      seq: message.seq,
      turnSeq: message.turnSeq,
    })), [
      {
        messageId: "prompt-1",
        role: "user",
        content: [{ type: "text", text: "send the desktop image" }],
        seq: 1,
        turnSeq: 1,
      },
      {
        messageId: "file-1",
        role: "assistant",
        content: [
          { type: "text", text: "sent:" },
          {
            type: "file",
            attachmentId: "file-history-1",
            fileId: "file-history-1",
            fileName: "desktop.png",
            mimeType: "image/png",
            transferState: "available",
          },
        ],
        seq: 2,
        turnSeq: 2,
      },
    ]);
    assert.deepEqual(snapshot?.attachments, []);
  } finally {
    await fixture.cleanup();
  }
});

test("transcript history provider uses transcript message id as timeline identity fallback", async () => {
  const fixture = await createTranscriptFixture(2, [
    {
      type: "message",
      id: "transcript-user-1",
      timestamp: "2026-05-28T01:00:00.000Z",
      message: {
        role: "user",
        content: "hello from transcript id",
      },
    },
    {
      type: "message",
      id: "transcript-assistant-1",
      timestamp: "2026-05-28T01:00:01.000Z",
      message: {
        role: "assistant",
        content: "answer from transcript id",
      },
    },
  ]);
  try {
    const page = await readChatHistoryFromTranscriptFile({
      sessionKey: "agent:main:main",
      transcriptPath: fixture.path,
      limit: 20,
    });
    const snapshot = (page as HistoryResponse & {
      timelineSnapshot?: { messages: Array<Record<string, unknown>> };
    }).timelineSnapshot;

    assert.deepEqual(snapshot?.messages.map((message) => ({
      turnId: message.turnId,
      runId: message.runId,
      messageId: message.messageId,
    })), [
      {
        turnId: "transcript-user-1",
        runId: "transcript-user-1",
        messageId: "transcript-user-1",
      },
      {
        turnId: "transcript-assistant-1",
        runId: "transcript-assistant-1",
        messageId: "transcript-assistant-1",
      },
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("transcript history provider carries the mobile run id through the parent chain", async () => {
  const fixture = await createTranscriptFixture(3, [
    {
      type: "message",
      id: "transcript-user-mobile",
      timestamp: "2026-05-28T01:00:00.000Z",
      message: {
        role: "user",
        content: "mobile prompt",
        idempotencyKey: "mobile-run-42:user",
      },
    },
    {
      type: "message",
      id: "transcript-assistant-tool",
      parentId: "transcript-user-mobile",
      timestamp: "2026-05-28T01:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool-1", name: "image" }],
      },
    },
    {
      type: "message",
      id: "transcript-assistant-final",
      parentId: "transcript-assistant-tool",
      timestamp: "2026-05-28T01:00:02.000Z",
      message: {
        role: "assistant",
        content: "final answer",
      },
    },
  ]);
  try {
    const page = await readChatHistoryFromTranscriptFile({
      sessionKey: "agent:main:main",
      transcriptPath: fixture.path,
      limit: 20,
    });
    const snapshot = page.timelineSnapshot;

    assert.deepEqual(snapshot?.messages.map((message) => ({
      messageId: message.messageId,
      turnId: message.turnId,
      runId: message.runId,
    })), [
      { messageId: "transcript-user-mobile", turnId: "mobile-run-42:user", runId: "mobile-run-42:user" },
      { messageId: "transcript-assistant-tool", turnId: "mobile-run-42", runId: "mobile-run-42" },
      { messageId: "assistant-mobile-run-42", turnId: "mobile-run-42", runId: "mobile-run-42" },
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("transcript history folds assistant-media into its explicit assistant parent before lineage rewrites keys", async () => {
  const runId = "wx_1787558915948_espv455s";
  const fixture = await createTranscriptFixture(3, [
    {
      type: "message",
      id: "user-source",
      timestamp: "2026-08-24T08:09:20.000Z",
      message: { role: "user", content: "把桌面图片发来", idempotencyKey: `${runId}:user` },
    },
    {
      type: "message",
      id: "assistant-parent",
      parentId: "user-source",
      timestamp: "2026-08-24T08:09:22.125Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "桌面只找到一张图片\nMEDIA:/Users/example/Desktop/photo.png" }],
      },
    },
    {
      type: "message",
      id: "assistant-media-sidecar",
      parentId: "assistant-parent",
      timestamp: "2026-08-24T08:09:22.339Z",
      message: {
        role: "assistant",
        idempotencyKey: `${runId}:assistant-media`,
        content: [
          { type: "text", text: "桌面只找到一张图片" },
          { type: "image", url: "/api/chat/media/outgoing/agent%3Amain%3Asession/att_fixture/full" },
        ],
      },
    },
  ]);
  try {
    const page = await readChatHistoryFromTranscriptFile({
      sessionKey: "agent:main:main",
      transcriptPath: fixture.path,
      limit: 20,
    });

    assert.deepEqual(page.messages?.map((message) => message.id), ["user-source", "assistant-parent"]);
    assert.equal(page.messages?.[1]?.idempotencyKey, runId);
    assert.equal(page.messages?.[1]?.messageId, `assistant-${runId}`);
    assert.deepEqual(page.messages?.[1]?.content, [
      { type: "text", text: "桌面只找到一张图片\nMEDIA:/Users/example/Desktop/photo.png" },
      { type: "image", url: "/api/chat/media/outgoing/agent%3Amain%3Asession/att_fixture/full" },
    ]);
    assert.equal(page.timelineSnapshot?.messages.length, 2);
    assert.equal(page.timelineSnapshot?.messages[1]?.messageId, `assistant-${runId}`);
  } finally {
    await fixture.cleanup();
  }
});

test("transcript history provider preserves every visible and tool row in a folded mobile run", async () => {
  const runId = "mobile-folded-run";
  const lines: Array<Record<string, unknown>> = [
    {
      type: "message",
      id: "folded-user",
      timestamp: "2026-07-27T02:22:00.000Z",
      message: { role: "user", content: "把桌面的蜘蛛侠图片发过来", idempotencyKey: `${runId}:user` },
    },
    {
      type: "message",
      id: "folded-assistant-image-call",
      parentId: "folded-user",
      timestamp: "2026-07-27T02:22:01.000Z",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call-image", name: "image" }] },
    },
    {
      type: "message",
      id: "folded-tool-image-result",
      parentId: "folded-assistant-image-call",
      timestamp: "2026-07-27T02:22:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-image",
        toolName: "image",
        content: [{ type: "toolResult", id: "call-image", name: "image", text: "标准证件照分析" }],
      },
    },
    {
      type: "message",
      id: "folded-assistant-analysis",
      parentId: "folded-tool-image-result",
      timestamp: "2026-07-27T02:22:03.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "这是一张标准证件照。关于蜘蛛侠图片，我来找找：" },
          { type: "toolCall", id: "call-find-1", name: "exec" },
        ],
      },
    },
    {
      type: "message",
      id: "folded-tool-find-failed",
      parentId: "folded-assistant-analysis",
      timestamp: "2026-07-27T02:22:04.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-find-1",
        toolName: "exec",
        content: [{ type: "toolResult", id: "call-find-1", name: "exec", text: "not found" }],
      },
    },
    {
      type: "message",
      id: "folded-assistant-find-call",
      parentId: "folded-tool-find-failed",
      timestamp: "2026-07-27T02:22:05.000Z",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call-find-2", name: "exec" }] },
    },
    {
      type: "message",
      id: "folded-tool-find-result",
      parentId: "folded-assistant-find-call",
      timestamp: "2026-07-27T02:22:06.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-find-2",
        toolName: "exec",
        content: [{ type: "toolResult", id: "call-find-2", name: "exec", text: "spiderman.jpg" }],
      },
    },
    {
      type: "message",
      id: "folded-assistant-found",
      parentId: "folded-tool-find-result",
      timestamp: "2026-07-27T02:22:07.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "找到了！现在发到 iPhone：" },
          { type: "toolCall", id: "call-send", name: "send_file" },
        ],
      },
    },
    {
      type: "message",
      id: "folded-tool-send-result",
      parentId: "folded-assistant-found",
      timestamp: "2026-07-27T02:22:08.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-send",
        toolName: "send_file",
        content: [{ type: "toolResult", id: "call-send", name: "send_file", text: "sent" }],
      },
    },
    {
      type: "message",
      id: "folded-assistant-final",
      parentId: "folded-tool-send-result",
      timestamp: "2026-07-27T02:22:09.000Z",
      message: { role: "assistant", content: "搞定！spiderman.jpg 已经发到你 iPhone 上了" },
    },
  ];
  const fixture = await createTranscriptFixture(lines.length, lines);
  try {
    const page = await readChatHistoryFromTranscriptFile({
      sessionKey: "agent:main:main",
      transcriptPath: fixture.path,
      limit: 20,
    });
    const messages = page.timelineSnapshot?.messages ?? [];

    assert.deepEqual(messages.map((message) => message.messageId), [
      "folded-user",
      "folded-assistant-image-call",
      "folded-tool-image-result",
      "folded-assistant-analysis",
      "folded-tool-find-failed",
      "folded-assistant-find-call",
      "folded-tool-find-result",
      "folded-assistant-found",
      "folded-tool-send-result",
      `assistant-${runId}`,
    ]);
    assert.deepEqual(
      messages.slice(1).map((message) => [message.turnId, message.runId]),
      Array.from({ length: 9 }, () => [runId, runId]),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("transcript history provider does not emit epoch timestamps when message time is missing", async () => {
  const fixture = await createTranscriptFixture(2, [
    {
      type: "message",
      id: "prompt-untimed",
      message: {
        role: "user",
        content: "untimed prompt",
      },
    },
    {
      type: "message",
      id: "assistant-timed",
      timestamp: "2026-05-28T01:00:01.000Z",
      message: {
        role: "assistant",
        content: "timed answer",
      },
    },
  ]);
  try {
    const page = await readChatHistoryFromTranscriptFile({
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      transcriptPath: fixture.path,
      limit: 20,
    });
    const snapshot = (page as HistoryResponse & {
      timelineSnapshot?: { messages: Array<Record<string, unknown>> };
    }).timelineSnapshot;

    assert.deepEqual(snapshot?.messages.map((message) => message.createdAt), [
      "2026-05-28T01:00:00.999Z",
      "2026-05-28T01:00:01.000Z",
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("transcript history provider recovers invalid and future cursors to newest older page", async () => {
  const fixture = await createTranscriptFixture(12);
  try {
    const invalidCursorPage = await readChatHistoryFromTranscriptFile({
      sessionKey: "agent:main:main",
      transcriptPath: fixture.path,
      limit: 5,
      cursor: "not-a-cursor",
      direction: "older",
    });
    const futureCursorPage = await readChatHistoryFromTranscriptFile({
      sessionKey: "agent:main:main",
      transcriptPath: fixture.path,
      limit: 5,
      cursor: "seq:999",
      direction: "older",
    });

    assert.deepEqual(messageSeqs(invalidCursorPage), [8, 9, 10, 11, 12]);
    assert.deepEqual(messageSeqs(futureCursorPage), [8, 9, 10, 11, 12]);
    assert.equal(invalidCursorPage.nextCursor, "seq:8");
    assert.equal(futureCursorPage.nextCursor, "seq:8");
  } finally {
    await fixture.cleanup();
  }
});

function messageSeqs(response: HistoryResponse): unknown[] {
  return response.messages?.map((message) => message.seq) ?? [];
}

function transcriptMessage(
  id: string,
  role: string,
  text: string,
  timestamp: string,
): Record<string, unknown> {
  return {
    type: "message",
    id,
    timestamp,
    message: {
      role,
      content: [{ type: "text", text }],
    },
  };
}

async function createTranscriptFixture(
  count: number,
  explicitLines?: Array<Record<string, unknown>>,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  clearTranscriptHistoryCache();
  const dir = await mkdtemp(join(tmpdir(), "clawconnect-chat-history-"));
  const path = join(dir, "session.jsonl");
  const lines = explicitLines ?? Array.from({ length: count }, (_, index) => {
    const seq = index + 1;
    return {
      type: "message",
      id: `message-${seq}`,
      timestamp: new Date(Date.UTC(2026, 4, 28, 1, 0, seq)).toISOString(),
      message: {
        role: seq % 2 === 0 ? "assistant" : "user",
        content: [{ type: "text", text: `message ${seq}` }],
        seq,
      },
    };
  });
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return {
    path,
    cleanup: async () => {
      clearTranscriptHistoryCache();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
