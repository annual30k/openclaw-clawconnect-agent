export const CANONICAL_TIMELINE_PROTOCOL_VERSION = 2 as const;

export type TimelineEventType =
  | "turn.user.created"
  | "message.part.delta"
  | "message.completed"
  | "run.completed"
  | "run.failed"
  | "run.aborted"
  | "history.snapshot.page"
  | "attachment.state.changed"
  | "tool.invocation.updated";

export type TimelineRole = "user" | "assistant" | "tool" | "system";
export type TimelineMessageState = "pending" | "streaming" | "completed" | "failed" | "aborted";
export type TimelineRunState = "inactive" | "active" | "completed" | "failed" | "aborted";
export type TimelineSource = "local" | "live" | "history" | "relay-legacy";
export type AttachmentState =
  | "local_pending"
  | "uploading"
  | "uploaded"
  | "linked"
  | "available"
  | "expired"
  | "failed";
export type ToolState =
  | "pending_approval"
  | "approved"
  | "denied"
  | "running"
  | "streaming_output"
  | "success"
  | "failed"
  | "cancelled";

export type TimelineItemKind =
  | "message:user"
  | "message:assistant"
  | "tool"
  | "attachment"
  | "system"
  | "waiting";

export type TimelineContentBlock = Record<string, unknown> & {
  type: string;
};

export type TimelineAttachment = Record<string, unknown> & {
  attachmentId: string;
  state: AttachmentState;
};

export type TimelineError = Record<string, unknown> & {
  userMessage?: string;
  code?: string;
};

export type CanonicalTimelineEvent = {
  protocolVersion: 2;
  eventId: string;
  eventType: TimelineEventType;
  gatewayId: string;
  sessionKey: string;
  turnId: string;
  runId: string;
  messageId: string;
  partId: string;
  attachmentId: string | null;
  seq: number;
  turnSeq: number;
  role: TimelineRole;
  messageState: TimelineMessageState;
  runState: TimelineRunState;
  createdAt: string;
  source: TimelineSource;
  content: TimelineContentBlock[];
  attachment: TimelineAttachment | null;
  error: TimelineError | null;
  toolInvocationId?: string;
  toolState?: ToolState;
  timelineItemKind?: TimelineItemKind;
  timelineResolvesWaiting?: boolean;
  extensions?: Record<string, unknown>;
};

export type TimelineHistoryMessage = {
  turnId: string;
  messageId: string;
  role: TimelineRole;
  messageState: TimelineMessageState;
  createdAt: string;
  content: TimelineContentBlock[];
  partId?: string;
  runId?: string;
  clientMessageId?: string;
  idempotencyKey?: string;
  seq?: number;
  turnSeq?: number;
  attachmentIds?: string[];
};

export type CanonicalTimelineHistorySnapshotPage = {
  protocolVersion: 2;
  eventType: "history.snapshot.page";
  gatewayId: string;
  sessionKey: string;
  source: TimelineSource;
  cursor: string | null;
  hasMore: boolean;
  nextCursor: string | null;
  newestCursor: string | null;
  messages: TimelineHistoryMessage[];
  attachments: TimelineAttachment[];
  extensions?: Record<string, unknown>;
};

const eventTypes = new Set<TimelineEventType>([
  "turn.user.created",
  "message.part.delta",
  "message.completed",
  "run.completed",
  "run.failed",
  "run.aborted",
  "history.snapshot.page",
  "attachment.state.changed",
  "tool.invocation.updated",
]);

const roles = new Set<TimelineRole>(["user", "assistant", "tool", "system"]);
const messageStates = new Set<TimelineMessageState>([
  "pending",
  "streaming",
  "completed",
  "failed",
  "aborted",
]);
const runStates = new Set<TimelineRunState>([
  "inactive",
  "active",
  "completed",
  "failed",
  "aborted",
]);
const sources = new Set<TimelineSource>(["local", "live", "history", "relay-legacy"]);

const canonicalEventFields = new Set([
  "protocolVersion",
  "eventId",
  "eventType",
  "gatewayId",
  "sessionKey",
  "turnId",
  "runId",
  "messageId",
  "partId",
  "attachmentId",
  "seq",
  "turnSeq",
  "role",
  "messageState",
  "runState",
  "createdAt",
  "source",
  "content",
  "attachment",
  "error",
  "toolInvocationId",
  "toolState",
  "timelineItemKind",
  "timelineResolvesWaiting",
]);

const historyPageFields = new Set([
  "protocolVersion",
  "eventType",
  "gatewayId",
  "sessionKey",
  "source",
  "cursor",
  "hasMore",
  "nextCursor",
  "newestCursor",
  "messages",
  "attachments",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid canonical timeline event: missing ${field}`);
  }
  return value;
}

function requiredNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid canonical timeline event: missing ${field}`);
  }
  return value;
}

function parseContentBlocks(value: unknown): TimelineContentBlock[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid canonical timeline event: content must be an array");
  }
  return value.map((block) => {
    if (!isRecord(block) || typeof block.type !== "string" || block.type.length === 0) {
      throw new Error("Invalid canonical timeline event: content block requires type");
    }
    return { ...block, type: block.type };
  });
}

function parseNullableRecord<T extends Record<string, unknown>>(
  value: unknown,
  field: string,
): T | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid canonical timeline event: ${field} must be an object or null`);
  }
  return value as T;
}

function collectExtensions(
  record: Record<string, unknown>,
  knownFields: Set<string>,
): Record<string, unknown> | undefined {
  const extensions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!knownFields.has(key)) {
      extensions[key] = value;
    }
  }
  return Object.keys(extensions).length > 0 ? extensions : undefined;
}

export function parseCanonicalTimelineEvent(input: unknown): CanonicalTimelineEvent {
  if (!isRecord(input)) {
    throw new Error("Invalid canonical timeline event: expected object");
  }

  if (input.protocolVersion !== CANONICAL_TIMELINE_PROTOCOL_VERSION) {
    throw new Error("Invalid canonical timeline event: protocolVersion must be 2");
  }

  const eventType = requiredString(input, "eventType") as TimelineEventType;
  if (!eventTypes.has(eventType)) {
    throw new Error(`Invalid canonical timeline event: unsupported eventType ${eventType}`);
  }

  const role = requiredString(input, "role") as TimelineRole;
  if (!roles.has(role)) {
    throw new Error(`Invalid canonical timeline event: unsupported role ${role}`);
  }

  const messageState = requiredString(input, "messageState") as TimelineMessageState;
  if (!messageStates.has(messageState)) {
    throw new Error(`Invalid canonical timeline event: unsupported messageState ${messageState}`);
  }

  const runState = requiredString(input, "runState") as TimelineRunState;
  if (!runStates.has(runState)) {
    throw new Error(`Invalid canonical timeline event: unsupported runState ${runState}`);
  }

  const source = requiredString(input, "source") as TimelineSource;
  if (!sources.has(source)) {
    throw new Error(`Invalid canonical timeline event: unsupported source ${source}`);
  }

  return {
    protocolVersion: CANONICAL_TIMELINE_PROTOCOL_VERSION,
    eventId: requiredString(input, "eventId"),
    eventType,
    gatewayId: requiredString(input, "gatewayId"),
    sessionKey: requiredString(input, "sessionKey"),
    turnId: requiredString(input, "turnId"),
    runId: requiredString(input, "runId"),
    messageId: requiredString(input, "messageId"),
    partId: requiredString(input, "partId"),
    attachmentId:
      input.attachmentId === undefined || input.attachmentId === null
        ? null
        : requiredString(input, "attachmentId"),
    seq: requiredNumber(input, "seq"),
    turnSeq: requiredNumber(input, "turnSeq"),
    role,
    messageState,
    runState,
    createdAt: requiredString(input, "createdAt"),
    source,
    content: parseContentBlocks(input.content),
    attachment: parseNullableRecord<TimelineAttachment>(input.attachment, "attachment"),
    error: parseNullableRecord<TimelineError>(input.error, "error"),
    ...(typeof input.toolInvocationId === "string" ? { toolInvocationId: input.toolInvocationId } : {}),
    ...(typeof input.toolState === "string" ? { toolState: input.toolState as ToolState } : {}),
    ...(typeof input.timelineItemKind === "string" ? { timelineItemKind: input.timelineItemKind as TimelineItemKind } : {}),
    ...(typeof input.timelineResolvesWaiting === "boolean" ? { timelineResolvesWaiting: input.timelineResolvesWaiting } : {}),
    ...(collectExtensions(input, canonicalEventFields)
      ? { extensions: collectExtensions(input, canonicalEventFields) }
      : {}),
  };
}

export function isCanonicalTimelineEvent(input: unknown): input is CanonicalTimelineEvent {
  try {
    parseCanonicalTimelineEvent(input);
    return true;
  } catch {
    return false;
  }
}

function parseHistoryMessage(input: unknown): TimelineHistoryMessage {
  if (!isRecord(input)) {
    throw new Error("Invalid canonical history snapshot page: message must be an object");
  }
  const role = requiredString(input, "role") as TimelineRole;
  const messageState = requiredString(input, "messageState") as TimelineMessageState;
  if (!roles.has(role) || !messageStates.has(messageState)) {
    throw new Error("Invalid canonical history snapshot page: invalid message role/state");
  }
  return {
    turnId: requiredString(input, "turnId"),
    messageId: requiredString(input, "messageId"),
    role,
    messageState,
    createdAt: requiredString(input, "createdAt"),
    content: parseContentBlocks(input.content),
    ...(typeof input.partId === "string" ? { partId: input.partId } : {}),
    ...(typeof input.runId === "string" ? { runId: input.runId } : {}),
    ...(typeof input.clientMessageId === "string" ? { clientMessageId: input.clientMessageId } : {}),
    ...(typeof input.idempotencyKey === "string" ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(typeof input.seq === "number" && Number.isFinite(input.seq) ? { seq: input.seq } : {}),
    ...(typeof input.turnSeq === "number" && Number.isFinite(input.turnSeq) ? { turnSeq: input.turnSeq } : {}),
    ...(Array.isArray(input.attachmentIds)
      ? { attachmentIds: input.attachmentIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0) }
      : {}),
  };
}

export function parseCanonicalTimelineHistorySnapshotPage(
  input: unknown,
): CanonicalTimelineHistorySnapshotPage {
  if (!isRecord(input)) {
    throw new Error("Invalid canonical history snapshot page: expected object");
  }
  if (input.protocolVersion !== CANONICAL_TIMELINE_PROTOCOL_VERSION) {
    throw new Error("Invalid canonical history snapshot page: protocolVersion must be 2");
  }
  if (input.eventType !== "history.snapshot.page") {
    throw new Error("Invalid canonical history snapshot page: eventType must be history.snapshot.page");
  }
  const source = requiredString(input, "source") as TimelineSource;
  if (!sources.has(source)) {
    throw new Error(`Invalid canonical history snapshot page: unsupported source ${source}`);
  }
  if (!Array.isArray(input.messages)) {
    throw new Error("Invalid canonical history snapshot page: messages must be an array");
  }
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  return {
    protocolVersion: CANONICAL_TIMELINE_PROTOCOL_VERSION,
    eventType: "history.snapshot.page",
    gatewayId: requiredString(input, "gatewayId"),
    sessionKey: requiredString(input, "sessionKey"),
    source,
    cursor: typeof input.cursor === "string" ? input.cursor : null,
    hasMore: Boolean(input.hasMore),
    nextCursor: typeof input.nextCursor === "string" ? input.nextCursor : null,
    newestCursor: typeof input.newestCursor === "string" ? input.newestCursor : null,
    messages: input.messages.map(parseHistoryMessage),
    attachments: attachments.filter(isRecord) as TimelineAttachment[],
    ...(collectExtensions(input, historyPageFields)
      ? { extensions: collectExtensions(input, historyPageFields) }
      : {}),
  };
}

export function createTimelineIdempotencyTracker() {
  const eventIds = new Set<string>();
  const partSeqKeys = new Set<string>();

  return {
    acceptEvent(input: Pick<CanonicalTimelineEvent, "eventId">): { accepted: boolean; reason?: string } {
      if (eventIds.has(input.eventId)) {
        return { accepted: false, reason: "duplicate_event_id" };
      }
      eventIds.add(input.eventId);
      return { accepted: true };
    },
    acceptPartSeq(
      input: Pick<CanonicalTimelineEvent, "messageId" | "partId" | "seq">,
    ): { accepted: boolean; reason?: string } {
      const key = `${input.messageId}\u0000${input.partId}\u0000${input.seq}`;
      if (partSeqKeys.has(key)) {
        return { accepted: false, reason: "duplicate_part_seq" };
      }
      partSeqKeys.add(key);
      return { accepted: true };
    },
  };
}
