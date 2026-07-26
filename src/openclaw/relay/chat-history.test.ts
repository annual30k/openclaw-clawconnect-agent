import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  clearTranscriptHistoryCache,
  filterOpenClawHeartbeatArtifacts,
  readChatHistoryFromTranscriptFile,
  type HistoryResponse,
} from "./chat-history.js";

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
