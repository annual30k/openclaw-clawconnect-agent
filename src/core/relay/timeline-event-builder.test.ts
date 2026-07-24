import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAttachmentStateChangedEvent,
  buildHistorySnapshotPage,
  buildMessageCompletedEvent,
  buildMessagePartDeltaEvent,
  buildRunCompletedEvent,
  buildRunErrorEvent,
  buildToolInvocationUpdatedEvent,
  buildTurnUserCreatedEvent,
  createTimelineSequenceSource,
  deriveAttachmentId,
  derivePartId,
} from "./timeline-event-builder.js";

const base = {
  gatewayId: "gw_123",
  sessionKey: "main",
  now: () => new Date("2026-05-29T03:00:00.000Z"),
  idFactory: (prefix: string) => `${prefix}_fixed`,
};

test("builds user turn events using the mobile idempotency key as turnId and runId", () => {
  const event = buildTurnUserCreatedEvent({
    ...base,
    idempotencyKey: "client-run-123",
    text: "hello",
  });

  assert.equal(event.eventType, "turn.user.created");
  assert.equal(event.turnId, "client-run-123");
  assert.equal(event.runId, "client-run-123");
  assert.equal(event.messageId, "user-client-run-123");
  assert.equal(event.partId, "part-text-1");
  assert.deepEqual(event.content, [{ type: "text", text: "hello" }]);
});

test("builds assistant absolute delta events with stable ids and sanitized content", () => {
  const event = buildMessagePartDeltaEvent({
    ...base,
    turnId: "client-run-123",
    runId: "client-run-123",
    role: "assistant",
    partKind: "text",
    seq: 42,
    turnSeq: 2,
    content: [{ type: "text", text: "↻ Resumed session 20260525_114940_1cccb9\nhello " }],
  });

  assert.equal(event.eventType, "message.part.delta");
  assert.equal(event.messageId, "assistant-client-run-123");
  assert.equal(event.partId, "part-text-1");
  assert.equal(event.seq, 42);
  assert.deepEqual(event.content, [{ type: "text", text: "hello " }]);
});

test("drops protocol-only typing marker content before event construction", () => {
  const event = buildMessagePartDeltaEvent({
    ...base,
    turnId: "client-run-123",
    runId: "client-run-123",
    role: "assistant",
    seq: 43,
    turnSeq: 3,
    content: [{ type: "text", text: "[[clawlink:typing]]" }],
  });

  assert.deepEqual(event.content, [{ type: "text", text: "" }]);
});

test("preserves non-text blocks and derives stable part and attachment ids", () => {
  assert.equal(derivePartId({ type: "image", index: 0 }), "part-image-1");
  const attachmentId = deriveAttachmentId({
    sessionKey: "main",
    name: "photo.png",
    mimeType: "image/png",
    size: 123,
  });
  assert.equal(
    attachmentId,
    deriveAttachmentId({
      sessionKey: "main",
      name: "photo.png",
      mimeType: "image/png",
      size: 123,
    }),
  );
  assert.notEqual(
    attachmentId,
    deriveAttachmentId({
      sessionKey: "main",
      name: "photo.png",
      mimeType: "image/png",
      size: 124,
    }),
  );

  const event = buildAttachmentStateChangedEvent({
    ...base,
    turnId: "client-run-123",
    runId: "client-run-123",
    messageId: "user-client-run-123",
    partId: "part-image-1",
    attachment: {
      attachmentId: "att_1",
      state: "available",
      name: "photo.png",
      mimeType: "image/png",
      url: "https://example.invalid/photo.png",
    },
  });

  assert.equal(event.eventType, "attachment.state.changed");
  assert.equal(event.attachmentId, "att_1");
  assert.deepEqual(event.content, []);
  assert.deepEqual(event.attachment, {
    attachmentId: "att_1",
    state: "available",
    name: "photo.png",
    mimeType: "image/png",
    url: "https://example.invalid/photo.png",
  });
});

test("builds message completion and terminal run events separately", () => {
  const completed = buildMessageCompletedEvent({
    ...base,
    turnId: "client-run-123",
    runId: "client-run-123",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
  });
  const runCompleted = buildRunCompletedEvent({
    ...base,
    turnId: "client-run-123",
    runId: "client-run-123",
    role: "assistant",
  });
  const runFailed = buildRunErrorEvent({
    ...base,
    turnId: "client-run-123",
    runId: "client-run-123",
    role: "assistant",
    userMessage: "Request failed",
  });

  assert.equal(completed.eventType, "message.completed");
  assert.equal(completed.runState, "active");
  assert.equal(runCompleted.eventType, "run.completed");
  assert.equal(runCompleted.runState, "completed");
  assert.equal(runFailed.eventType, "run.failed");
  assert.deepEqual(runFailed.error, { userMessage: "Request failed" });
});

test("builds explicit tool invocation lifecycle events", () => {
  const event = buildToolInvocationUpdatedEvent({
    ...base,
    turnId: "client-run-123",
    runId: "client-run-123",
    toolInvocationId: "tool_123",
    toolState: "pending_approval",
    content: [{ type: "tool_call", toolName: "shell", input: "pwd" }],
  });

  assert.equal(event.eventType, "tool.invocation.updated");
  assert.equal(event.role, "tool");
  assert.equal(event.messageId, "tool-tool_123");
  assert.equal(event.toolInvocationId, "tool_123");
  assert.equal(event.toolState, "pending_approval");
  assert.equal(event.partId, "part-tool-1");
  assert.deepEqual(event.content, [{ type: "tool_call", toolName: "shell", input: "pwd" }]);
});

test("uses the invocation id as the tool message identity within a multi-tool turn", () => {
  const firstStarted = buildToolInvocationUpdatedEvent({
    ...base,
    turnId: "shared-turn",
    runId: "shared-run",
    toolInvocationId: "call-1",
    toolState: "running",
    content: [{ type: "tool_call", toolName: "shell", text: "first" }],
  });
  const firstCompleted = buildToolInvocationUpdatedEvent({
    ...base,
    turnId: "shared-turn",
    runId: "shared-run",
    toolInvocationId: "call-1",
    toolState: "success",
    content: [{ type: "tool_result", toolName: "shell", text: "done" }],
  });
  const secondStarted = buildToolInvocationUpdatedEvent({
    ...base,
    turnId: "shared-turn",
    runId: "shared-run",
    toolInvocationId: "call-2",
    toolState: "running",
    content: [{ type: "tool_call", toolName: "shell", text: "second" }],
  });

  assert.equal(firstStarted.messageId, "tool-call-1");
  assert.equal(firstCompleted.messageId, firstStarted.messageId);
  assert.equal(secondStarted.messageId, "tool-call-2");
  assert.notEqual(secondStarted.messageId, firstStarted.messageId);
});

test("builds canonical history snapshot pages", () => {
  const page = buildHistorySnapshotPage({
    gatewayId: "gw_123",
    sessionKey: "main",
    cursor: "cur_1",
    hasMore: true,
    nextCursor: "cur_0",
    messages: [
      {
        turnId: "turn_1",
        messageId: "assistant-turn_1",
        role: "assistant",
        messageState: "completed",
        createdAt: "2026-05-29T03:00:00.000Z",
        content: [{ type: "text", text: "done" }],
      },
    ],
  });

  assert.equal(page.protocolVersion, 2);
  assert.equal(page.eventType, "history.snapshot.page");
  assert.equal(page.messages.length, 1);
});

test("sequence source is scoped and monotonic without requiring caller counters", () => {
  const source = createTimelineSequenceSource({
    nowMs: () => 1_700_000_000_000,
  });

  assert.deepEqual(source.next("gw_1", "main"), 1_700_000_000_000_000);
  assert.deepEqual(source.next("gw_1", "main"), 1_700_000_000_000_001);
  assert.deepEqual(source.next("gw_1", "other"), 1_700_000_000_000_000);
});
