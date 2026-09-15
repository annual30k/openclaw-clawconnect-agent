import assert from "node:assert/strict";
import test from "node:test";
import { createSourceCommit } from "../../core/relay/source-commit.js";
import {
  buildSourceCommitTimelineEvents,
  projectSourceCommitHistoryPages,
} from "./source-commit-projection.js";
import type { HistoryResponse } from "./chat-history.js";

test("source commit projects every text, tool, and image row in source order", () => {
  const sourceCommit = createSourceCommit({
    gatewayType: "openclaw",
    gatewayId: "gw-1",
    producerId: "main",
    sourceSessionId: "session-1",
    sourceOrderScope: "openclaw:main:session-1",
    sourceGeneration: "session-1",
    committedThroughSeq: 163,
    sourceRevision: "seq:163",
  });
  const history = {
    sessionKey: "main",
    timelineSnapshot: {
      protocolVersion: 2 as const,
      eventType: "history.snapshot.page" as const,
      gatewayId: "gw-1",
      sessionKey: "main",
      source: "history" as const,
      cursor: null,
      hasMore: false,
      nextCursor: null,
      newestCursor: "seq:163",
      messages: [155, 156, 157, 158, 159, 160, 161, 162, 163].map((seq, index) => ({
        turnId: "turn-1",
        messageId: `m-${seq}`,
        role: index === 0 ? "user" as const : index === 4 ? "tool" as const : "assistant" as const,
        messageState: "completed" as const,
        createdAt: new Date(1_700_000_000_000 + index).toISOString(),
        content: [{ type: index >= 1 && index <= 4 ? "image" : "text", ...(index >= 1 && index <= 4 ? { attachmentId: `a-${seq}` } : { text: `row ${seq}` }) }],
        seq,
        sourceOrderSeq: seq,
        projectionVersion: 3 as const,
        canonicalMessageId: `canonical-${seq}`,
        gatewayType: "openclaw" as const,
        producerId: "main",
        sourceSessionId: "session-1",
        sourceMessageId: `m-${seq}`,
        sourceOrderScope: "openclaw:main:session-1",
        sourceRole: index === 0 ? "user" as const : index === 4 ? "tool" as const : "assistant" as const,
        timelineDelivery: "independent" as const,
      })),
      attachments: [],
    },
  };
  const events = buildSourceCommitTimelineEvents(history, sourceCommit);
  assert.deepEqual(events.map((event) => event.sourceOrderSeq), [155, 156, 157, 158, 159, 160, 161, 162, 163]);
  assert.equal(events.filter((event) => event.sourceCommit?.sourceRevision === "seq:163").length, 9);
  assert.equal(events[0]?.role, "user");
  assert.equal(events[4]?.role, "tool");
  assert.equal(events[1]?.content[0]?.type, "image");

  const incremental = buildSourceCommitTimelineEvents(history, sourceCommit, 160);
  assert.deepEqual(incremental.map((event) => event.sourceOrderSeq), [161, 162, 163]);
  const replayWithNewerRevision = buildSourceCommitTimelineEvents(history, {
    ...sourceCommit,
    committedThroughSeq: 164,
    sourceRevision: "seq:164",
  });
  assert.equal(replayWithNewerRevision[0]?.eventId, events[0]?.eventId);
});

function projectionHistory(message: Record<string, unknown>): HistoryResponse {
  return {
    sessionKey: "main",
    projectionVersion: 3,
    timelineSnapshot: {
      protocolVersion: 2,
      eventType: "history.snapshot.page",
      gatewayId: "gw-1",
      sessionKey: "main",
      source: "history",
      cursor: null,
      hasMore: false,
      nextCursor: null,
      newestCursor: "seq:1",
      messages: [message as never],
      attachments: [],
    },
  };
}

const strictSourceCommit = createSourceCommit({
  gatewayType: "openclaw",
  gatewayId: "gw-1",
  producerId: "main",
  sourceSessionId: "session-1",
  sourceOrderScope: "openclaw:main:session-1",
  sourceGeneration: "session-1",
  committedThroughSeq: 1,
  sourceRevision: "seq:1",
});

const strictProjectionMessage = {
  turnId: "turn-1",
  messageId: "provider-row-1",
  role: "assistant" as const,
  messageState: "completed" as const,
  createdAt: "2026-09-10T00:00:00.000Z",
  content: [{ type: "text", text: "reply" }],
  projectionVersion: 3 as const,
  canonicalMessageId: "timeline:v3:row-1",
  gatewayType: "openclaw" as const,
  producerId: "main",
  sourceSessionId: "session-1",
  sourceMessageId: "provider-row-1",
  sourceOrderScope: "openclaw:main:session-1",
  sourceOrderSeq: 1,
  sourceRole: "assistant" as const,
};

test("source commit projection rejects missing v3 source identity and order instead of falling back", () => {
  assert.throws(
    () => buildSourceCommitTimelineEvents(
      projectionHistory({ ...strictProjectionMessage, sourceMessageId: undefined }),
      strictSourceCommit,
    ),
    /sourceMessageId is missing/,
  );
  assert.throws(
    () => buildSourceCommitTimelineEvents(
      projectionHistory({ ...strictProjectionMessage, sourceOrderSeq: undefined, seq: 1 }),
      strictSourceCommit,
    ),
    /sourceOrderSeq is missing or invalid/,
  );
  assert.throws(
    () => buildSourceCommitTimelineEvents(
      projectionHistory({ ...strictProjectionMessage, projectionVersion: undefined, sourceOrderSeq: undefined, seq: 1 }),
      strictSourceCommit,
    ),
    /requires v3/,
  );
  assert.throws(
    () => buildSourceCommitTimelineEvents(
      projectionHistory({ ...strictProjectionMessage, sourceOrderSeq: 0 }),
      strictSourceCommit,
    ),
    /sourceOrderSeq is missing or invalid/,
  );
});

function pagedProjectionMessage(seq: number): Record<string, unknown> {
  return {
    ...strictProjectionMessage,
    turnId: `turn-${seq}`,
    messageId: `provider-row-${seq}`,
    canonicalMessageId: `timeline:v3:row-${seq}`,
    sourceMessageId: `provider-row-${seq}`,
    sourceOrderSeq: seq,
    content: [{ type: "text", text: `row ${seq}` }],
  };
}

function projectionPage(
  messages: Array<Record<string, unknown>>,
  sourceReadThroughSeq: number,
  sourceHasMore: boolean,
): HistoryResponse {
  return {
    ...projectionHistory(messages[0] ?? pagedProjectionMessage(sourceReadThroughSeq)),
    sourceReadThroughSeq,
    sourceRangeStartSeq: sourceReadThroughSeq - messages.length + 1,
    sourceRangeHasGap: false,
    sourceHasMore,
    timelineSnapshot: {
      protocolVersion: 2,
      eventType: "history.snapshot.page",
      gatewayId: "gw-1",
      sessionKey: "main",
      source: "history",
      cursor: `seq:${Math.max(0, sourceReadThroughSeq - messages.length)}`,
      hasMore: sourceHasMore,
      nextCursor: sourceHasMore ? `seq:${sourceReadThroughSeq}` : null,
      newestCursor: `seq:${sourceReadThroughSeq}`,
      messages: messages as never,
      attachments: [],
    },
  };
}

test("source commit paging projects a 450-row range in ordered watermarks", async () => {
  const sourceCommit = createSourceCommit({ ...strictSourceCommit, committedThroughSeq: 450, sourceRevision: "seq:450" });
  const published: Array<{ seq: number; eventSeqs: number[] }> = [];
  const finalSeq = await projectSourceCommitHistoryPages({
    sourceCommit,
    readPage: async (cursorSeq) => {
      const start = cursorSeq + 1;
      const end = Math.min(start + 199, 450);
      return projectionPage(
        Array.from({ length: end - start + 1 }, (_, index) => pagedProjectionMessage(start + index)),
        end,
        end < 450,
      );
    },
    publish: ({ sourceCommit: pageCommit, events }) => {
      published.push({
        seq: pageCommit.committedThroughSeq,
        eventSeqs: events.map((event) => event.sourceOrderSeq ?? -1),
      });
    },
  });

  assert.equal(finalSeq, 450);
  assert.deepEqual(published.map((batch) => batch.seq), [200, 400, 450]);
  assert.equal(published.flatMap((batch) => batch.eventSeqs).length, 450);
  assert.deepEqual(published.flatMap((batch) => batch.eventSeqs), Array.from({ length: 450 }, (_, index) => index + 1));
});

test("source commit paging does not advance through an unreported source gap", async () => {
  const sourceCommit = createSourceCommit({ ...strictSourceCommit, committedThroughSeq: 450, sourceRevision: "seq:450" });
  const published: number[] = [];

  await assert.rejects(
    projectSourceCommitHistoryPages({
      sourceCommit,
      readPage: async () => projectionPage(
        Array.from({ length: 200 }, (_, index) => pagedProjectionMessage(index + 1)),
        200,
        false,
      ),
      publish: ({ sourceCommit: pageCommit }) => {
        published.push(pageCommit.committedThroughSeq);
      },
    }),
    /ended before source watermark/,
  );
  assert.deepEqual(published, [200]);
});

test("source commit paging rejects a page with an internal source sequence gap", async () => {
  const sourceCommit = createSourceCommit({ ...strictSourceCommit, committedThroughSeq: 3, sourceRevision: "seq:3" });
  await assert.rejects(
    projectSourceCommitHistoryPages({
      sourceCommit,
      readPage: async () => ({
        ...projectionPage([pagedProjectionMessage(1), pagedProjectionMessage(3)], 3, false),
        sourceRangeHasGap: true,
      }),
      publish: () => {
        throw new Error("must not publish a gapped source page");
      },
    }),
    /source gap/,
  );
});
