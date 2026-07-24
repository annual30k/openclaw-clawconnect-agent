import { createHash, randomUUID } from "node:crypto";
import { canonicalizeMobileAssistantText } from "./mobile-chat-run-bridge.js";
import {
  type AttachmentState,
  type CanonicalTimelineEvent,
  type CanonicalTimelineHistorySnapshotPage,
  type TimelineContentBlock,
  type TimelineItemKind,
  type TimelineHistoryMessage,
  type TimelineMessageState,
  type TimelineRole,
  type TimelineRunState,
  type TimelineSource,
  type ToolState,
  parseCanonicalTimelineEvent,
  parseCanonicalTimelineHistorySnapshotPage,
} from "./timeline-event-log.js";

type TimelineBuilderBase = {
  gatewayId: string;
  sessionKey: string;
  now?: () => Date;
  idFactory?: (prefix: string) => string;
};

type TimelineTurnBase = TimelineBuilderBase & {
  turnId: string;
  runId: string;
  seq?: number;
  turnSeq?: number;
  role?: TimelineRole;
  source?: TimelineSource;
};

type TimelineAttachmentInput = Record<string, unknown> & {
  attachmentId: string;
  state: AttachmentState;
};

const DEFAULT_TEXT_PART_ID = "part-text-1";

function nowDate(params: TimelineBuilderBase): Date {
  return params.now?.() ?? new Date();
}

function eventId(params: TimelineBuilderBase, prefix = "evt"): string {
  return params.idFactory?.(prefix) ?? `${prefix}_${Date.now().toString(36)}_${randomUUID()}`;
}

function createdAt(params: TimelineBuilderBase): string {
  return nowDate(params).toISOString();
}

function defaultSeq(params: TimelineBuilderBase): number {
  return nowDate(params).getTime() * 1_000;
}

function messageId(role: TimelineRole, turnId: string, provided?: string): string {
  return provided && provided.trim().length > 0 ? provided.trim() : `${role}-${turnId}`;
}

function sanitizeContent(content: TimelineContentBlock[]): TimelineContentBlock[] {
  return content.map((block) => {
    if (block.type !== "text" || typeof block.text !== "string") {
      return { ...block };
    }
    const canonical = canonicalizeMobileAssistantText(block.text, { preserveWhitespace: true });
    return { ...block, text: canonical.text };
  });
}

function buildEvent(
  params: TimelineTurnBase & {
    eventType: CanonicalTimelineEvent["eventType"];
    messageId?: string;
    partId?: string;
    attachmentId?: string | null;
    messageState: TimelineMessageState;
    runState: TimelineRunState;
    content?: TimelineContentBlock[];
    attachment?: TimelineAttachmentInput | null;
    error?: Record<string, unknown> | null;
    toolInvocationId?: string;
    toolState?: ToolState;
    timelineItemKind?: TimelineItemKind;
    timelineResolvesWaiting?: boolean;
  },
): CanonicalTimelineEvent {
  const role = params.role ?? "assistant";
  return parseCanonicalTimelineEvent({
    protocolVersion: 2,
    eventId: eventId(params),
    eventType: params.eventType,
    gatewayId: params.gatewayId,
    sessionKey: params.sessionKey,
    turnId: params.turnId,
    runId: params.runId,
    messageId: messageId(role, params.turnId, params.messageId),
    partId: params.partId ?? DEFAULT_TEXT_PART_ID,
    attachmentId: params.attachmentId ?? null,
    seq: params.seq ?? defaultSeq(params),
    turnSeq: params.turnSeq ?? 1,
    role,
    messageState: params.messageState,
    runState: params.runState,
    createdAt: createdAt(params),
    source: params.source ?? "live",
    content: sanitizeContent(params.content ?? []),
    attachment: params.attachment ?? null,
    error: params.error ?? null,
    ...(params.toolInvocationId ? { toolInvocationId: params.toolInvocationId } : {}),
    ...(params.toolState ? { toolState: params.toolState } : {}),
    ...(params.timelineItemKind ? { timelineItemKind: params.timelineItemKind } : {}),
    ...(typeof params.timelineResolvesWaiting === "boolean"
      ? { timelineResolvesWaiting: params.timelineResolvesWaiting }
      : {}),
  });
}

export function createTimelineSequenceSource(params: {
  nowMs?: () => number;
} = {}) {
  const lastByScope = new Map<string, number>();
  const nowMs = params.nowMs ?? (() => Date.now());
  return {
    next(gatewayId: string, sessionKey: string): number {
      const scope = `${gatewayId}\u0000${sessionKey}`;
      const base = nowMs() * 1_000;
      const previous = lastByScope.get(scope);
      const next = previous === undefined ? base : Math.max(base, previous + 1);
      lastByScope.set(scope, next);
      return next;
    },
  };
}

export function derivePartId(params: { type?: string; index?: number }): string {
  const type = params.type && params.type.trim().length > 0 ? params.type.trim() : "text";
  const index = params.index ?? 0;
  return `part-${type}-${index + 1}`;
}

export function deriveAttachmentId(params: {
  sessionKey: string;
  name?: string;
  mimeType?: string;
  size?: number;
  url?: string;
  contentHash?: string;
}): string {
  const stable = [
    params.sessionKey,
    params.contentHash ?? "",
    params.name ?? "",
    params.mimeType ?? "",
    params.size ?? "",
    params.url ?? "",
  ].join("\u0000");
  const digest = createHash("sha256").update(stable).digest("hex").slice(0, 16);
  return `att_${digest}`;
}

export function buildTurnUserCreatedEvent(params: TimelineBuilderBase & {
  idempotencyKey?: string;
  requestId?: string;
  turnId?: string;
  runId?: string;
  text: string;
  seq?: number;
}): CanonicalTimelineEvent {
  const turnId = params.turnId ?? params.idempotencyKey ?? params.requestId ?? `turn-${randomUUID()}`;
  const runId = params.runId ?? turnId;
  return buildEvent({
    ...params,
    turnId,
    runId,
    role: "user",
    eventType: "turn.user.created",
    messageState: "completed",
    runState: "active",
    messageId: messageId("user", turnId),
    content: [{ type: "text", text: params.text }],
    source: "local",
  });
}

export function buildMessagePartDeltaEvent(params: TimelineTurnBase & {
  role: TimelineRole;
  partKind?: string;
  messageId?: string;
  partId?: string;
  content: TimelineContentBlock[];
}): CanonicalTimelineEvent {
  return buildEvent({
    ...params,
    eventType: "message.part.delta",
    messageId: params.messageId,
    partId: params.partId ?? derivePartId({ type: params.partKind ?? "text", index: 0 }),
    messageState: "streaming",
    runState: "active",
    content: params.content,
  });
}

export function buildMessageCompletedEvent(params: TimelineTurnBase & {
  role: TimelineRole;
  messageId?: string;
  partId?: string;
  content: TimelineContentBlock[];
  timelineItemKind?: TimelineItemKind;
  timelineResolvesWaiting?: boolean;
}): CanonicalTimelineEvent {
  return buildEvent({
    ...params,
    eventType: "message.completed",
    messageState: "completed",
    runState: "active",
    content: params.content,
  });
}

export function buildRunCompletedEvent(params: TimelineTurnBase): CanonicalTimelineEvent {
  return buildEvent({
    ...params,
    eventType: "run.completed",
    partId: "run-state",
    messageState: "completed",
    runState: "completed",
  });
}

export function buildRunErrorEvent(params: TimelineTurnBase & {
  userMessage: string;
  code?: string;
}): CanonicalTimelineEvent {
  return buildEvent({
    ...params,
    eventType: "run.failed",
    partId: "run-state",
    messageState: "failed",
    runState: "failed",
    error: {
      userMessage: params.userMessage,
      ...(params.code ? { code: params.code } : {}),
    },
  });
}

export function buildRunAbortedEvent(params: TimelineTurnBase & {
  userMessage?: string;
}): CanonicalTimelineEvent {
  return buildEvent({
    ...params,
    eventType: "run.aborted",
    partId: "run-state",
    messageState: "aborted",
    runState: "aborted",
    error: params.userMessage ? { userMessage: params.userMessage } : null,
  });
}

export function buildAttachmentStateChangedEvent(params: TimelineTurnBase & {
  messageId: string;
  partId: string;
  attachment: TimelineAttachmentInput;
  timelineItemKind?: TimelineItemKind;
  timelineResolvesWaiting?: boolean;
}): CanonicalTimelineEvent {
  return buildEvent({
    ...params,
    eventType: "attachment.state.changed",
    messageState: "pending",
    runState: "active",
    attachmentId: params.attachment.attachmentId,
    attachment: params.attachment,
    content: [],
  });
}

export function buildToolInvocationUpdatedEvent(params: TimelineTurnBase & {
  toolInvocationId: string;
  toolState: ToolState;
  content: TimelineContentBlock[];
}): CanonicalTimelineEvent {
  return buildEvent({
    ...params,
    role: "tool",
    eventType: "tool.invocation.updated",
    // A turn may contain multiple tool calls. The invocation identity, rather than
    // the parent turn, is the stable message identity for one tool lifecycle.
    messageId: messageId("tool", params.toolInvocationId),
    partId: derivePartId({ type: "tool", index: 0 }),
    messageState: ["denied", "success", "failed", "cancelled"].includes(params.toolState)
      ? "completed"
      : "streaming",
    runState: ["denied", "success", "failed", "cancelled"].includes(params.toolState)
      ? "inactive"
      : "active",
    toolInvocationId: params.toolInvocationId,
    toolState: params.toolState,
    content: params.content,
  });
}

export function buildHistorySnapshotPage(params: {
  gatewayId: string;
  sessionKey: string;
  cursor?: string | null;
  hasMore?: boolean;
  nextCursor?: string | null;
  newestCursor?: string | null;
  messages?: TimelineHistoryMessage[];
  attachments?: TimelineAttachmentInput[];
  orderPolicy?: "display" | "transcript";
}): CanonicalTimelineHistorySnapshotPage {
  return parseCanonicalTimelineHistorySnapshotPage({
    protocolVersion: 2,
    eventType: "history.snapshot.page",
    gatewayId: params.gatewayId,
    sessionKey: params.sessionKey,
    source: "history",
    cursor: params.cursor ?? null,
    hasMore: Boolean(params.hasMore),
    nextCursor: params.nextCursor ?? null,
    newestCursor: params.newestCursor ?? null,
    messages: params.messages ?? [],
    attachments: params.attachments ?? [],
    ...(params.orderPolicy ? { orderPolicy: params.orderPolicy } : {}),
  });
}
