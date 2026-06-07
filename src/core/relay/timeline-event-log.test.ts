import assert from "node:assert/strict";
import test from "node:test";
import {
  createTimelineIdempotencyTracker,
  isCanonicalTimelineEvent,
  parseCanonicalTimelineEvent,
  parseCanonicalTimelineHistorySnapshotPage,
} from "./timeline-event-log.js";

const validEvent = {
  protocolVersion: 2,
  eventId: "evt_01J00000000000000000000000",
  eventType: "message.part.delta",
  gatewayId: "gw_123",
  sessionKey: "main",
  turnId: "turn_123",
  runId: "run_123",
  messageId: "assistant-turn_123",
  partId: "part-text-1",
  attachmentId: null,
  seq: 12,
  turnSeq: 2,
  role: "assistant",
  messageState: "streaming",
  runState: "active",
  createdAt: "2026-05-29T03:00:00.000Z",
  source: "live",
  content: [{ type: "text", text: "hello", futureBlockField: { nested: true } }],
  attachment: null,
  error: null,
  v3Extension: { extra: true },
};

test("parses canonical timeline events with forward-compatible fields and null optionals", () => {
  const parsed = parseCanonicalTimelineEvent(validEvent);

  assert.equal(parsed.eventId, "evt_01J00000000000000000000000");
  assert.equal(parsed.attachmentId, null);
  assert.equal(parsed.attachment, null);
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.content, [
    { type: "text", text: "hello", futureBlockField: { nested: true } },
  ]);
  assert.deepEqual(parsed.extensions, { v3Extension: { extra: true } });
});

test("accepts absent nullable optional fields", () => {
  const { attachmentId: _attachmentId, attachment: _attachment, error: _error, ...event } = validEvent;
  const parsed = parseCanonicalTimelineEvent(event);

  assert.equal(parsed.attachmentId, null);
  assert.equal(parsed.attachment, null);
  assert.equal(parsed.error, null);
});

test("rejects payloads missing canonical required fields", () => {
  for (const field of [
    "eventId",
    "eventType",
    "turnId",
    "messageId",
    "partId",
    "messageState",
    "runState",
  ]) {
    const invalid = { ...validEvent };
    delete (invalid as Record<string, unknown>)[field];

    assert.equal(isCanonicalTimelineEvent(invalid), false, `expected ${field} to be required`);
    assert.throws(() => parseCanonicalTimelineEvent(invalid), /canonical timeline event/i);
  }
});

test("rejects invalid protocol and state values", () => {
  assert.throws(
    () => parseCanonicalTimelineEvent({ ...validEvent, protocolVersion: 1 }),
    /protocolVersion/i,
  );
  assert.throws(
    () => parseCanonicalTimelineEvent({ ...validEvent, messageState: "typing" }),
    /messageState/i,
  );
  assert.throws(
    () => parseCanonicalTimelineEvent({ ...validEvent, runState: "paused" }),
    /runState/i,
  );
});

test("detects duplicate event ids and duplicate part sequence applications", () => {
  const tracker = createTimelineIdempotencyTracker();

  assert.equal(tracker.acceptEvent(validEvent).accepted, true);
  assert.equal(tracker.acceptEvent({ ...validEvent, seq: 13 }).accepted, false);
  assert.equal(tracker.acceptPartSeq(validEvent).accepted, true);
  assert.equal(tracker.acceptPartSeq({ ...validEvent, eventId: "evt_other" }).accepted, false);
  assert.equal(
    tracker.acceptPartSeq({ ...validEvent, eventId: "evt_new", seq: 13 }).accepted,
    true,
  );
});

test("parses canonical history snapshot pages", () => {
  const page = parseCanonicalTimelineHistorySnapshotPage({
    protocolVersion: 2,
    eventType: "history.snapshot.page",
    gatewayId: "gw_123",
    sessionKey: "main",
    source: "history",
    cursor: "cur_1",
    hasMore: true,
    nextCursor: "cur_0",
    messages: [
      {
        turnId: "turn_123",
        messageId: "assistant-turn_123",
        role: "assistant",
        messageState: "completed",
        createdAt: "2026-05-29T03:00:00.000Z",
        content: [{ type: "text", text: "done" }],
        seq: 12,
        turnSeq: 2,
      },
    ],
    attachments: [],
    unknownSnapshotField: "preserved",
  });

  assert.equal(page.eventType, "history.snapshot.page");
  assert.equal(page.messages[0]?.messageId, "assistant-turn_123");
  assert.equal(page.messages[0]?.seq, 12);
  assert.equal(page.messages[0]?.turnSeq, 2);
  assert.deepEqual(page.extensions, { unknownSnapshotField: "preserved" });
});
