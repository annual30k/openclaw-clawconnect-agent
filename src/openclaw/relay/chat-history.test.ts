import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  clearTranscriptHistoryCache,
  readChatHistoryFromTranscriptFile,
  type HistoryResponse,
} from "./chat-history.js";

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
