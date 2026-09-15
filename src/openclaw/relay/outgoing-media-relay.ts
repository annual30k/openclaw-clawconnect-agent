import { existsSync } from "fs";
import { readFile, stat, realpath } from "fs/promises";
import { homedir } from "os";
import { isAbsolute, extname, join, relative, resolve } from "path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "crypto";
import { uploadFileToRelay, type FileUploadRequest, type FileUploadResult } from "../../core/relay/file-upload.js";
import { resolveOpenClawStateDir } from "../runtime/openclaw-paths.js";
import {
  extractOpenClawMessageToolRelation,
  normalizeOpenClawAssistantMediaSidecars,
  normalizeOpenClawAutomaticMediaReplies,
} from "./assistant-media-sidecar.js";
import {
  canonicalizeOpenClawSessionScope,
  canonicalizeSessionKey,
  type GatewaySessionDefaults,
} from "./session-context.js";

const OUTGOING_MEDIA_RE = /\/api\/chat\/media\/outgoing\/[^/]+\/([^/]+)\/full(?:$|[?#])/;
const OPENCLAW_MEDIA_CONTROL_PREFIX_RE = /^MEDIA:\s*(?:file:\/\/|~[\\/]|\/|[A-Za-z]:[\\/]|\\\\)/i;
const OPENCLAW_INPUT_MEDIA_MARKER_RE = /\[media attached:\s+(.+?)\s+\(([^)\r\n]+)\)\s+\|\s+(.+?)\]/g;
const OPENCLAW_DELIVERY_CONTRACT = "openclaw.message-tool-delivery.v1";
const OUTGOING_MEDIA_RECORD_WAIT_DELAYS_MS = [80, 160, 320, 640] as const;

export type OutgoingMediaRelayOptions = {
  relayServerUrl: string;
  relaySecret: string;
  gatewayId: string;
  senderDisplayName?: string;
  recordsDir?: string;
  stateDir?: string;
  cache?: Map<string, FileUploadResult>;
  /**
   * Legacy caller context. Deliberately ignored: attachment publication must
   * come from typed content blocks or structured OpenClaw delivery metadata,
   * never from natural-language intent in this field.
   */
  userMessage?: string;
  /**
   * A live gateway event can arrive a few milliseconds before OpenClaw commits
   * its managed outgoing-media record. Only that file-availability path may
   * briefly wait for the record; this never delays timeline identity, ordering,
   * or message projection correctness.
   */
  waitForOutgoingMediaRecord?: boolean;
  /** Session defaults used to canonicalize OpenClaw relation scopes. */
  sessionDefaults?: GatewaySessionDefaults;
};

type OutgoingMediaOptionsWithSourceRun = OutgoingMediaRelayOptions & {
  sourceRunId?: string;
  sessionKey?: string;
  toolCallId?: string;
};

type OutgoingMediaRecord = {
  attachmentId?: string;
  sessionKey?: string;
  alt?: string;
  original?: {
    path?: string;
    contentType?: string;
    width?: number;
    height?: number;
    sizeBytes?: number;
    filename?: string;
  };
};

type OpenClawDeliveryReceipt = {
  contract: typeof OPENCLAW_DELIVERY_CONTRACT;
  toolName: "message";
  toolCallId: string;
  idempotencyKey: string;
  sourceRunId: string;
  mediaUrls: string[];
};

const inFlightUploadsByCache = new WeakMap<
  Map<string, FileUploadResult>,
  Map<string, Promise<FileUploadResult>>
>();

export async function relayOutgoingMediaInPayload(
  payload: unknown,
  opts: OutgoingMediaRelayOptions,
): Promise<unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const payloadRecord = payload as Record<string, unknown>;
  const message = asRecord(payloadRecord.message);
  const messageRelation = message ? extractOpenClawMessageToolRelation(message) : undefined;
  const sourceRunId = messageRelation?.sourceRunId ?? payloadSourceRunId(payloadRecord);
  let nextMessage: Record<string, unknown> | undefined;
  let messageChanged = false;
  let deliveryBlocks: Record<string, unknown>[] = [];
  if (message) {
    const messageContent = await relayOutgoingMediaContent(
      message.content,
      {
        ...opts,
        sourceRunId,
        sessionKey: canonicalRelationSessionKey(
          firstString(message.sessionKey, message.sessionId, payloadRecord.sessionKey),
          opts,
        ),
        ...(messageRelation?.toolCallId ? { toolCallId: messageRelation.toolCallId } : {}),
      },
    );
    deliveryBlocks = await relayOpenClawDeliveryMedia(message, payloadRecord, opts, sourceRunId);
    const appendedMessage = appendUniqueContentBlocks(
      messageContent.blocks,
      deliveryBlocks,
    );
    const nextMessageContent = appendedMessage.changed ? appendedMessage.blocks : messageContent.content;
    messageChanged = messageContent.changed || appendedMessage.changed;
    if (messageChanged) {
      nextMessage = {
        ...message,
        content: nextMessageContent,
      };
    }
  }
  const timelineEvents = await relayOutgoingMediaInTimelineEvents(payloadRecord.timelineEvents, opts, sourceRunId);
  const deliveryTimelineEvents = relayOpenClawDeliveryMediaInTimelineEvents(
    timelineEvents.events,
    deliveryBlocks,
    sourceRunId,
    opts.sessionDefaults,
  );

  if (
    !messageChanged
    && !timelineEvents.changed
    && !deliveryTimelineEvents.changed
  ) {
    return payload;
  }
  return {
    ...payloadRecord,
    ...(nextMessage ? { message: nextMessage } : {}),
    ...(timelineEvents.changed || deliveryTimelineEvents.changed
      ? { timelineEvents: deliveryTimelineEvents.events }
      : {}),
  };
}

async function relayOpenClawDeliveryMedia(
  message: Record<string, unknown>,
  payload: Record<string, unknown>,
  opts: OutgoingMediaRelayOptions,
  sourceRunId?: string,
): Promise<Record<string, unknown>[]> {
  // `mediaUrls` is a typed OpenClaw delivery projection. Its presence is the
  // producer's explicit publication receipt; assistant text and the original
  // user prompt are intentionally not consulted here.
  if (!sourceRunId) {
    return [];
  }
  const receipt = typedOpenClawDeliveryReceipt(message.openclawDelivery, sourceRunId)
    ?? adaptOpenClawMessageToolDelivery({ message, ...payload }, sourceRunId);
  if (!receipt) {
    return [];
  }

  const paths = trustedDeliverablePaths(receipt.mediaUrls);
  if (paths.length === 0) {
    return [];
  }

  return relayLocalArtifactPaths(paths, payload, opts, receipt.sourceRunId, receipt.toolCallId);
}

/**
 * Adapt the shape emitted by the currently deployed OpenClaw message tool.
 * The installed OpenClaw type declares `openclawDelivery.mediaUrls` only as a
 * display projection. The authoritative toolResult carries the delivery
 * status, tool call, idempotency key, run metadata, and trusted local media
 * list in `details.sourceReply`; only that explicit relation becomes the
 * internal typed v1 receipt. Generic mediaUrls stay inert.
 */
export function adaptOpenClawMessageToolDelivery(
  value: unknown,
  expectedSourceRunId?: string,
): OpenClawDeliveryReceipt | undefined {
  const envelope = asRecord(value);
  if (!envelope) return undefined;
  const candidates = [
    asRecord(envelope.message),
    asRecord(envelope.toolResult),
    ...(Array.isArray(envelope.toolResults) ? envelope.toolResults.map(asRecord) : []),
    envelope.role === "toolResult" || envelope.role === "tool_result" ? envelope : undefined,
  ].filter((candidate): candidate is Record<string, unknown> => Boolean(candidate));

  for (const message of candidates) {
    const details = asRecord(message.details);
    const sourceReply = asRecord(details?.sourceReply);
    const messageDelivery = asRecord(details?.messageDelivery);
    const metadata = asRecord(message.__openclaw);
    const toolName = firstString(message.toolName, message.tool_name);
    const toolCallId = firstString(message.toolCallId, message.tool_call_id);
    const idempotencyKey = firstString(details?.idempotencyKey, message.idempotencyKey, message.idempotency_key);
    const sourceRunId = firstString(
      metadata?.runId,
      metadata?.sourceRunId,
      message.runId,
      message.sourceRunId,
      envelope.runId,
      envelope.sourceRunId,
    );
    const mediaUrls = sourceReply?.mediaUrls;
    const attachments = sourceReply?.attachments;
    const trustedAttachments = Array.isArray(attachments)
      && attachments.length > 0
      && attachments.every((attachment) => asRecord(attachment)?.trustedLocalMedia === true);
    if (
      (message.role !== "toolResult" && message.role !== "tool_result")
      || toolName !== "message"
      || !toolCallId
      || !idempotencyKey
      || !sourceRunId
      || (expectedSourceRunId && sourceRunId !== expectedSourceRunId)
      || details?.status !== "ok"
      || details.deliveryStatus !== "sent"
      || details.sourceReplyDeliveryMode !== "message_tool_only"
      || details.sourceReplyTranscriptOwner !== true
      || details.dryRun === true
      || sourceReply?.trustedLocalMedia !== true
      || !trustedAttachments
      || messageDelivery?.status !== "settled"
      || messageDelivery.partialDelivery !== false
      || !Array.isArray(mediaUrls)
      || !mediaUrls.every((path): path is string => typeof path === "string" && path.trim().length > 0)
    ) {
      continue;
    }
    return {
      contract: OPENCLAW_DELIVERY_CONTRACT,
      toolName: "message",
      toolCallId,
      idempotencyKey,
      sourceRunId,
      mediaUrls: mediaUrls.map((path) => path.trim()),
    };
  }
  return undefined;
}

function typedOpenClawDeliveryReceipt(value: unknown, sourceRunId: string): OpenClawDeliveryReceipt | undefined {
  const delivery = asRecord(value);
  if (!delivery
    || delivery.contract !== OPENCLAW_DELIVERY_CONTRACT
    || delivery.toolName !== "message"
    || typeof delivery.toolCallId !== "string"
    || !delivery.toolCallId.trim()
    || typeof delivery.idempotencyKey !== "string"
    || !delivery.idempotencyKey.trim()
    || delivery.sourceRunId !== sourceRunId
    || !Array.isArray(delivery.mediaUrls)
    || !delivery.mediaUrls.every((path): path is string => typeof path === "string" && path.trim().length > 0)) {
    return undefined;
  }
  return {
    contract: OPENCLAW_DELIVERY_CONTRACT,
    toolName: "message",
    toolCallId: delivery.toolCallId.trim(),
    idempotencyKey: delivery.idempotencyKey.trim(),
    sourceRunId,
    mediaUrls: delivery.mediaUrls.map((path) => path.trim()),
  };
}

function relayOpenClawDeliveryMediaInTimelineEvents(
  events: unknown,
  blocks: Record<string, unknown>[],
  sourceRunId?: string,
  sessionDefaults?: GatewaySessionDefaults,
): { events: unknown; changed: boolean } {
  if (!Array.isArray(events) || blocks.length === 0 || !sourceRunId) {
    return { events, changed: false };
  }

  let changed = false;
  const nextEvents = events.map((event) => {
    const record = asRecord(event);
    if (!record || record.eventType !== "message.completed" || record.role !== "assistant") {
      return event;
    }
    const eventRunId = firstString(record.runId);
    const eventTurnId = firstString(record.turnId);
    const matchesSourceRun = eventRunId === sourceRunId || (!eventRunId && eventTurnId === sourceRunId);
    if (!matchesSourceRun) {
      return event;
    }
    if (!Array.isArray(record.content)) {
      return event;
    }

    const eventRelation = extractOpenClawMessageToolRelation(record);
    const eventScope = canonicalizeOpenClawSessionScope(
      firstString(record.sessionKey, record.sessionId),
      sessionDefaults,
    );
    const matchingEvents = events.filter((candidate) => {
      const candidateRecord = asRecord(candidate);
      if (!candidateRecord || candidateRecord.eventType !== "message.completed" || candidateRecord.role !== "assistant") {
        return false;
      }
      if (eventScope) {
        const candidateScope = canonicalizeOpenClawSessionScope(
          firstString(candidateRecord.sessionKey, candidateRecord.sessionId),
          sessionDefaults,
        );
        if (candidateScope !== eventScope) return false;
      }
      const eventRunId = firstString(candidateRecord.runId);
      const eventTurnId = firstString(candidateRecord.turnId);
      return eventRunId === sourceRunId || (!eventRunId && eventTurnId === sourceRunId);
    });
    const relationBlocks = blocks.filter((block) => {
      const relation = extractOpenClawMessageToolRelation(block);
      if (relation?.sourceRunId !== sourceRunId || !relation.toolCallId) return false;
      if (!eventScope) return true;
      const blockScope = canonicalizeOpenClawSessionScope(
        firstString(block.sessionKey, block.sessionId),
        sessionDefaults,
      );
      return !blockScope || blockScope === eventScope;
    });
    let eventBlocks = blocks;
    if (relationBlocks.length > 0) {
      if (!eventRelation?.toolCallId) {
        // A run-level completion can own delivery blocks only when it is the
        // sole completion for that run. Otherwise association is ambiguous;
        // do not duplicate the media onto every assistant row.
        if (matchingEvents.length !== 1) return event;
      } else {
        const matchingRelation = relationBlocks.filter((block) => (
          extractOpenClawMessageToolRelation(block)?.toolCallId === eventRelation.toolCallId
        ));
        if (matchingRelation.length === 0) return event;
        eventBlocks = matchingRelation;
      }
    }

    const appended = appendUniqueContentBlocks(record.content, eventBlocks);
    const attachmentIds = attachmentIdsFromContent(appended.blocks);
    const currentAttachmentIds = Array.isArray(record.attachmentIds)
      ? record.attachmentIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const attachmentIdsChanged = JSON.stringify(currentAttachmentIds) !== JSON.stringify(attachmentIds);
    if (!appended.changed && !attachmentIdsChanged) {
      return event;
    }

    changed = true;
    const { attachmentIds: _staleAttachmentIds, ...eventWithoutAttachmentIds } = record;
    return {
      ...eventWithoutAttachmentIds,
      content: appended.blocks,
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    };
  });
  return { events: changed ? nextEvents : events, changed };
}

function appendUniqueContentBlocks(
  content: unknown[],
  additions: unknown[],
): { blocks: unknown[]; changed: boolean } {
  if (additions.length === 0) return { blocks: content, changed: false };
  const existingIdentities = new Set(
    content.map(contentBlockIdentity).filter((identity): identity is string => Boolean(identity)),
  );
  const blocks = [...content];
  let changed = false;
  for (const addition of additions) {
    const identity = contentBlockIdentity(addition);
    if (identity && existingIdentities.has(identity)) continue;
    blocks.push(addition);
    if (identity) existingIdentities.add(identity);
    changed = true;
  }
  return { blocks, changed };
}

function contentBlockIdentity(block: unknown): string | undefined {
  const record = asRecord(block);
  if (!record) return undefined;
  const sourceRunId = firstString(record.sourceRunId, record.source_run_id);
  const toolCallId = firstString(record.toolCallId, record.tool_call_id, record.sourceToolCallId, record.source_tool_call_id);
  const mediaId = firstString(
    record.attachmentId,
    record.attachment_id,
    record.fileId,
    record.file_id,
    record.artifactId,
    record.artifact_id,
    record.url,
    record.openUrl,
    record.downloadUrl,
    record.downloadPath,
    record.download_path,
  );
  if (sourceRunId && toolCallId) {
    return `openclaw-tool-call\u0000${sourceRunId}\u0000${toolCallId}\u0000${mediaId ?? "media"}`;
  }
  return mediaId;
}

async function relayOutgoingMediaInTimelineEvents(
  events: unknown,
  opts: OutgoingMediaRelayOptions,
  fallbackSourceRunId?: string,
): Promise<{ events: unknown; changed: boolean }> {
  if (!Array.isArray(events)) return { events, changed: false };
  let changed = false;
  const nextEvents = await Promise.all(events.map(async (event) => {
    const record = asRecord(event);
    if (!record || !Array.isArray(record.content)) return event;
    const eventRelation = extractOpenClawMessageToolRelation(record);
    const sourceRunId = eventRelation?.sourceRunId
      ?? firstString(record.runId, record.turnId, fallbackSourceRunId);
    const sessionKey = canonicalRelationSessionKey(
      firstString(record.sessionKey, record.sessionId),
      opts,
    );
    const content = await relayOutgoingMediaContent(record.content, {
      ...opts,
      sourceRunId,
      ...(sessionKey ? { sessionKey } : {}),
      ...(eventRelation?.toolCallId ? { toolCallId: eventRelation.toolCallId } : {}),
    });
    if (!content.changed) return event;
    changed = true;
    const { attachmentIds: _staleAttachmentIds, ...eventWithoutAttachmentIds } = record;
    const attachmentIds = attachmentIdsFromContent(content.content);
    return {
      ...eventWithoutAttachmentIds,
      content: content.content,
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    };
  }));
  return { events: changed ? nextEvents : events, changed };
}

async function relayOutgoingMediaContent(
  content: unknown,
  opts: OutgoingMediaOptionsWithSourceRun,
): Promise<{ content: unknown; blocks: unknown[]; changed: boolean }> {
  if (typeof content === "string") {
    const sanitized = stripOpenClawMediaControlLines(content);
    const blocks = sanitized ? [{ type: "text", text: sanitized }] : [];
    return { content: sanitized, blocks, changed: sanitized !== content };
  }
  if (!Array.isArray(content)) return { content, blocks: [], changed: false };

  let changed = false;
  const relayedContent = (await Promise.all(content.map(async (block) => {
    const nextBlock = await relayOutgoingMediaBlock(block, opts);
    changed ||= nextBlock !== block;
    return nextBlock;
  }))).filter((block): block is unknown => block !== undefined);
  const sanitized = sanitizeOpenClawMediaControlBlocks(relayedContent);
  return { content: sanitized.content, blocks: sanitized.content, changed: changed || sanitized.changed };
}

export async function relayOutgoingMediaInHistoryResponse(
  response: unknown,
  opts: OutgoingMediaRelayOptions,
): Promise<unknown> {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return response;
  }
  const messages = (response as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) {
    return response;
  }

  const responseRecord = response as Record<string, unknown>;
  const responseSessionKey = canonicalRelationSessionKey(
    firstString(responseRecord.sessionKey, responseRecord.sessionId),
    opts,
  );
  const snapshot = responseRecord.timelineSnapshot;
  const snapshotMessages = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? (snapshot as Record<string, unknown>).messages
    : undefined;
  const projectionV3 = Array.isArray(snapshotMessages)
    && snapshotMessages.some((message) => (
      Boolean(message) && typeof message === "object" && (message as Record<string, unknown>).projectionVersion === 3
    ));
  const projectionOptions = projectionV3 ? { projectionVersion: 3 as const } : undefined;
  const relationOptions = {
    ...(projectionOptions ?? {}),
    ...(opts.sessionDefaults ? { sessionDefaults: opts.sessionDefaults } : {}),
  };
  const explicitSidecars = normalizeOpenClawAssistantMediaSidecars(messages, responseSessionKey, relationOptions);
  const normalizedMessages = normalizeOpenClawAutomaticMediaReplies(
    explicitSidecars.messages,
    responseSessionKey,
    relationOptions,
  );
  const messageResult = await relayOutgoingMediaInMessageList(normalizedMessages.messages, responseSessionKey, opts);
  const explicitSnapshotSidecars = Array.isArray(snapshotMessages)
    ? normalizeOpenClawAssistantMediaSidecars(snapshotMessages, responseSessionKey, relationOptions)
    : undefined;
  const normalizedSnapshotMessages = explicitSnapshotSidecars
    ? normalizeOpenClawAutomaticMediaReplies(
      explicitSnapshotSidecars.messages,
      responseSessionKey,
      relationOptions,
    )
    : undefined;
  const snapshotResult = normalizedSnapshotMessages
    ? await relayOutgoingMediaInMessageList(normalizedSnapshotMessages.messages, responseSessionKey, opts)
    : undefined;
  // The history projector builds the canonical snapshot before this relay
  // enriches the provider rows. Reuse the already-relayed row by its explicit
  // source identity so the canonical timeline receives the same attachment
  // blocks without re-reading local paths or merging by run/text/time.
  const reconciledSnapshot = snapshotResult
    ? reconcileHistorySnapshotWithRelayedMessages(snapshotResult.messages, messageResult.messages)
    : undefined;
  const changed = explicitSidecars.changed
    || normalizedMessages.changed
    || messageResult.changed
    || Boolean(explicitSnapshotSidecars?.changed)
    || Boolean(normalizedSnapshotMessages?.changed)
    || Boolean(snapshotResult?.changed)
    || Boolean(reconciledSnapshot?.changed);

  return changed
    ? {
        ...responseRecord,
        messages: messageResult.messages,
        ...(reconciledSnapshot
          ? {
              timelineSnapshot: {
                ...(snapshot as Record<string, unknown>),
                messages: reconciledSnapshot.messages,
              },
            }
          : {}),
      }
    : response;
}

function reconcileHistorySnapshotWithRelayedMessages(
  snapshotMessages: unknown[],
  relayedMessages: unknown[],
): { messages: unknown[]; changed: boolean } {
  const bySourceIdentity = new Map<string, Record<string, unknown>>();
  for (const message of relayedMessages) {
    const record = asRecord(message);
    const identity = historySourceIdentity(record);
    if (record && identity) bySourceIdentity.set(identity, record);
  }

  let changed = false;
  const messages = snapshotMessages.map((message) => {
    const record = asRecord(message);
    const source = record ? bySourceIdentity.get(historySourceIdentity(record) ?? "") : undefined;
    if (!record || !source || !Array.isArray(source.content) || source.content.length === 0) {
      return message;
    }
    const content = source.content;
    const attachmentIds = attachmentIdsFromContent(content);
    const currentContent = Array.isArray(record.content) ? record.content : undefined;
    const currentAttachmentIds = Array.isArray(record.attachmentIds) ? record.attachmentIds : undefined;
    if (
      JSON.stringify(currentContent) === JSON.stringify(content)
      && JSON.stringify(currentAttachmentIds ?? []) === JSON.stringify(attachmentIds)
    ) {
      return message;
    }
    changed = true;
    return {
      ...record,
      content,
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    };
  });
  return { messages: changed ? messages : snapshotMessages, changed };
}

function historySourceIdentity(record: Record<string, unknown> | undefined): string | undefined {
  return firstString(
    record?.sourceMessageId,
    record?.id,
    record?.messageId,
    record?.message_id,
  );
}

async function relayOutgoingMediaInMessageList(
  messages: unknown[],
  sessionKey: string | undefined,
  opts: OutgoingMediaRelayOptions,
): Promise<{ messages: unknown[]; changed: boolean }> {
  let changed = false;
  const nextMessages = await Promise.all(messages.map(async (message) => {
    const restoredMessage = restoreOpenClawInputMediaInHistoryMessage(message);
    const wrapperInput = sessionKey
      ? { sessionKey: canonicalRelationSessionKey(sessionKey, opts), message: restoredMessage }
      : { message: restoredMessage };
    const wrapper = await relayOutgoingMediaInPayload(wrapperInput, opts) as Record<string, unknown>;
    const nextMessage = wrapper.message ?? message;
    changed ||= nextMessage !== message;
    return nextMessage;
  }));
  return { messages: nextMessages, changed };
}

function restoreOpenClawInputMediaInHistoryMessage(message: unknown): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message)) return message;
  const record = message as Record<string, unknown>;
  if (record.role !== "user" || !Array.isArray(record.content) || record.content.some(isUploadedMediaBlock)) {
    return message;
  }
  const sourceRunId = firstString(record.runId, record.turnId, record.idempotencyKey, record.clientMessageId, record.messageId, record.id);
  if (!sourceRunId) return message;

  const mediaPaths: string[] = [];
  let changed = false;
  const sanitizedContent = record.content.flatMap((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return [block];
    const contentBlock = block as Record<string, unknown>;
    if (contentBlock.type !== "text" || typeof contentBlock.text !== "string") return [block];
    const text = contentBlock.text;
    const sanitized = text.replace(OPENCLAW_INPUT_MEDIA_MARKER_RE, (_marker, firstPath: string, _mime: string, secondPath: string) => {
      const path = secondPath.trim() || firstPath.trim();
      if (isAbsoluteHostPath(path)) mediaPaths.push(path);
      return "";
    }).replace(/\n{3,}/g, "\n\n").trim();
    if (sanitized === text) return [block];
    changed = true;
    return sanitized ? [{ ...contentBlock, text: sanitized }] : [];
  });
  if (!changed || mediaPaths.length === 0) return message;

  // 用户入站附件在 chat.send 前已经由 Relay 持久化为 canonical timeline block。
  // Host history 这里只移除 OpenClaw 内部路径标记，绝不能读取或重新上传路径；
  // Relay 会用稳定 sourceRunId 把原始 canonical 附件合回这条 user 记录。
  return { ...record, content: sanitizedContent };
}

async function relayOutgoingMediaBlock(block: unknown, opts: OutgoingMediaOptionsWithSourceRun): Promise<unknown> {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return block;
  }
  const source = block as Record<string, unknown>;
  const url = firstString(source.url, source.openUrl, source.downloadUrl, source.download_path, source.downloadPath);
  if (url?.startsWith("media://inbound/") && opts.sessionKey && opts.sourceRunId) {
    const attachmentId = `openclaw-input-${createHash("sha256").update(JSON.stringify([opts.sessionKey, opts.sourceRunId, url])).digest("hex").slice(0, 32)}`;
    try {
      const root = await realpath(join(opts.stateDir ?? resolveOpenClawStateDir(), "media", "inbound"));
      const filePath = await realpath(resolve(root, decodeURIComponent(url.slice("media://inbound/".length))));
      const pathWithinRoot = relative(root, filePath);
      if (!pathWithinRoot || pathWithinRoot.startsWith("..") || isAbsolute(pathWithinRoot)) throw new Error("invalid_managed_media_path");
      const cacheKey = await outgoingFileCacheKey({ gatewayId: opts.gatewayId, sessionKey: opts.sessionKey, identity: attachmentId, filePath, sourceRunId: opts.sourceRunId });
      const upload = await cachedUpload(opts, cacheKey, {
        relayServerUrl: opts.relayServerUrl, relaySecret: opts.relaySecret,
        gatewayId: opts.gatewayId, sessionKey: opts.sessionKey, filePath,
        sourceRunId: opts.sourceRunId, timelineDelivery: "embedded",
        sourceRole: "user",
      });
      return {
        ...uploadToContentBlock(upload),
        attachmentId,
        fileName: source.fileName || upload.fileName,
        ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
      };
    } catch {
      return {
        type: source.type,
        attachmentId,
        fileName: source.fileName || "图片",
        ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
        transferState: "expired",
        isRemoteExpired: true,
        attachmentStatusText: "图片文件暂不可用",
      };
    }
  }
  const attachmentId = outgoingAttachmentId(url);
  if (!attachmentId) {
    return block;
  }
  if (isUploadedMediaBlock(block)) {
    return block;
  }

  try {
    const record = await readOutgoingMediaRecordWhenReady(attachmentId, opts);
    const filePath = record.original?.path?.trim();
    const rawSessionKey = record.sessionKey?.trim();
    if (!filePath || !rawSessionKey) {
      console.warn(`[relay] outgoing media record is incomplete attachment=${attachmentId}`);
      return undefined;
    }
    const sessionKey = canonicalRelationSessionKey(rawSessionKey, opts) ?? rawSessionKey;
    const cacheKey = await outgoingFileCacheKey({
      gatewayId: opts.gatewayId,
      sessionKey,
      identity: `attachment:${attachmentId}`,
      filePath,
      sourceRunId: opts.sourceRunId,
    });
    const upload = await cachedUpload(opts, cacheKey, {
      relayServerUrl: opts.relayServerUrl,
      relaySecret: opts.relaySecret,
      gatewayId: opts.gatewayId,
      sessionKey,
      filePath,
      senderDisplayName: opts.senderDisplayName,
      sourceRunId: opts.sourceRunId,
      timelineDelivery: "embedded",
      sourceRole: "assistant",
    });

    return {
      ...source,
      type: typeof source.type === "string" && source.type.trim() ? source.type : "image",
      attachmentId,
      fileId: upload.fileId,
      fileName: record.alt || upload.fileName,
      mimeType: record.original?.contentType || upload.mimeType,
      byteSize: record.original?.sizeBytes || upload.sizeBytes,
      sizeBytes: record.original?.sizeBytes || upload.sizeBytes,
      width: record.original?.width || upload.imageWidth,
      height: record.original?.height || upload.imageHeight,
      imageWidth: record.original?.width || upload.imageWidth,
      imageHeight: record.original?.height || upload.imageHeight,
      downloadUrl: upload.downloadPath,
      downloadPath: upload.downloadPath,
      expiresAt: upload.expiresAt,
      sourceRunId: upload.sourceRunId,
      ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
      sourceRole: upload.sourceRole ?? "assistant",
      gatewayId: upload.gatewayId,
      sessionKey: upload.sessionKey,
      transferState: "available",
    };
  } catch (error) {
    console.warn(`[relay] failed to publish outgoing media attachment ${attachmentId}: ${String(error)}`);
    // The desktop may clean up an outgoing-media record before the Relay has
    // uploaded it. Keep a stable, explicit unavailable attachment instead of
    // deleting the only content of an otherwise valid assistant reply.
    const {
      url: _url,
      openUrl: _openUrl,
      downloadUrl: _downloadUrl,
      download_path: _downloadPath,
      downloadPath: _downloadPathCamel,
      ...unavailableSource
    } = source;
    return {
      ...unavailableSource,
      type: typeof source.type === "string" && source.type.trim() ? source.type : "image",
      attachmentId,
      fileName: firstString(source.fileName, source.alt, "图片"),
      ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
      transferState: "expired",
      isRemoteExpired: true,
      attachmentStatusText: "图片文件在桌面端已不可用",
      uploadStatusText: "图片文件在桌面端已不可用",
    };
  }
}

function outgoingAttachmentId(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  const match = OUTGOING_MEDIA_RE.exec(url);
  return match?.[1]?.trim() || undefined;
}

function payloadSourceRunId(payload: Record<string, unknown>): string | undefined {
  const message = payload.message;
  const messageRecord = message && typeof message === "object" && !Array.isArray(message)
    ? message as Record<string, unknown>
    : undefined;
  const metadata = asRecord(messageRecord?.__openclaw);
  const inputId = firstString(messageRecord?.idempotencyKey, metadata?.idempotencyKey);
  return firstString(
    payload.sourceRunId,
    payload.source_run_id,
    payload.runId,
    payload.turnId,
    payload.messageId,
    payload.id,
    messageRecord?.sourceRunId,
    messageRecord?.source_run_id,
    messageRecord?.runId,
    messageRecord?.turnId,
    metadata?.runId,
    inputId?.replace(/:user$/, ""),
    messageRecord?.messageId,
    messageRecord?.id,
    metadata?.id,
  );
}

async function readOutgoingMediaRecord(
  attachmentId: string,
  options: Pick<OutgoingMediaRelayOptions, "recordsDir" | "stateDir">,
): Promise<OutgoingMediaRecord> {
  const stateDir = options.stateDir ?? resolveOpenClawStateDir();
  const recordsDir = options.recordsDir ?? join(stateDir, "media", "outgoing", "records");
  try {
    const raw = await readFile(join(recordsDir, `${attachmentId}.json`), "utf8");
    return JSON.parse(raw) as OutgoingMediaRecord;
  } catch (error) {
    // A caller that supplies recordsDir is explicitly testing or using the
    // legacy JSON store; it must not read the host's normal state database.
    if (options.recordsDir || !isFileNotFoundError(error)) throw error;
  }

  return readSqliteOutgoingMediaRecord(attachmentId, stateDir);
}

async function readOutgoingMediaRecordWhenReady(
  attachmentId: string,
  options: OutgoingMediaRelayOptions,
): Promise<OutgoingMediaRecord> {
  // OpenClaw emits the assistant-media event before its SQLite transaction is
  // occasionally visible to another process.  Retrying only live event
  // enrichment avoids making ordinary history reads slower for genuinely
  // expired media while giving the transaction up to roughly one second to
  // become observable.
  const delaysMs = options.waitForOutgoingMediaRecord
    ? OUTGOING_MEDIA_RECORD_WAIT_DELAYS_MS
    : [];
  let lastError: unknown;
  for (const delayMs of [...delaysMs, 0]) {
    if (delayMs > 0) {
      await wait(delayMs);
    }
    try {
      return await readOutgoingMediaRecord(attachmentId, options);
    } catch (error) {
      lastError = error;
      if (!isFileNotFoundError(error)) throw error;
    }
  }
  throw lastError;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function readSqliteOutgoingMediaRecord(attachmentId: string, stateDir: string): OutgoingMediaRecord {
  const database = new DatabaseSync(join(stateDir, "state", "openclaw.sqlite"), { readOnly: true });
  try {
    const row = database.prepare(`
      SELECT
        session_key,
        alt,
        original_media_root,
        original_media_id,
        original_media_subdir,
        original_content_type,
        original_width,
        original_height,
        original_size_bytes,
        original_filename
      FROM managed_outgoing_image_records
      WHERE attachment_id = ? AND cleanup_pending = 0
    `).get(attachmentId) as Record<string, unknown> | undefined;
    if (!row) {
      const error = new Error(`OpenClaw outgoing media record was not found: ${attachmentId}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }

    const mediaRoot = requiredRecordString(row, "original_media_root");
    const mediaId = requiredRecordString(row, "original_media_id");
    const mediaSubdir = requiredRecordString(row, "original_media_subdir");
    if (!isAbsolute(mediaRoot) || mediaSubdir !== "outgoing/originals" || mediaId !== mediaId.split(/[\\/]/).pop()) {
      throw new Error(`OpenClaw outgoing media record is unsafe: ${attachmentId}`);
    }
    const originalsDir = resolve(mediaRoot, "outgoing", "originals");
    const filePath = resolve(mediaRoot, mediaSubdir, mediaId);
    const relativePath = relative(originalsDir, filePath);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`OpenClaw outgoing media path is outside the managed originals directory: ${attachmentId}`);
    }

    return {
      attachmentId,
      sessionKey: requiredRecordString(row, "session_key"),
      alt: optionalRecordString(row.alt),
      original: {
        path: filePath,
        contentType: optionalRecordString(row.original_content_type),
        width: optionalRecordNumber(row.original_width),
        height: optionalRecordNumber(row.original_height),
        sizeBytes: optionalRecordNumber(row.original_size_bytes),
        filename: optionalRecordString(row.original_filename),
      },
    };
  } finally {
    database.close();
  }
}

function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function requiredRecordString(row: Record<string, unknown>, field: string): string {
  const value = optionalRecordString(row[field]);
  if (!value) throw new Error(`OpenClaw outgoing media record is missing ${field}`);
  return value;
}

function optionalRecordString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalRecordNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function relayLocalArtifactPaths(
  paths: string[],
  payload: Record<string, unknown>,
  opts: OutgoingMediaRelayOptions,
  sourceRunIdOverride?: string,
  toolCallId?: string,
): Promise<Record<string, unknown>[]> {
  const messageRecord = asRecord(payload.message);
  const rawSessionKey = firstString(
    messageRecord?.sessionKey,
    messageRecord?.sessionId,
    payload.sessionKey,
  ) ?? "main";
  const sessionKey = canonicalRelationSessionKey(rawSessionKey, opts) ?? rawSessionKey;
  const runId = sourceRunIdOverride ?? payloadSourceRunId(payload);
  const blocks: Record<string, unknown>[] = [];
  for (const filePath of paths) {
    try {
      const cacheKey = await outgoingFileCacheKey({
        gatewayId: opts.gatewayId,
        sessionKey,
        identity: `artifact:${filePath}`,
        filePath,
        sourceRunId: runId,
      });
      const request: FileUploadRequest = {
        relayServerUrl: opts.relayServerUrl,
        relaySecret: opts.relaySecret,
        gatewayId: opts.gatewayId,
        sessionKey,
        filePath,
        senderDisplayName: opts.senderDisplayName,
        sourceRunId: runId,
        timelineDelivery: "embedded",
        sourceRole: "assistant",
      };
      const upload = await cachedUpload(opts, cacheKey, request);
      blocks.push(uploadToContentBlock(upload, toolCallId));
    } catch (error) {
      console.warn(`[relay] failed to publish local artifact ${filePath}: ${String(error)}`);
    }
  }
  return blocks;
}

function isUploadedMediaBlock(block: unknown): boolean {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return false;
  }
  const record = block as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
  return ["image", "file", "voice", "audio"].includes(type) && typeof record.fileId === "string" && record.fileId.trim().length > 0;
}

function attachmentIdsFromContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids = new Set<string>();
  for (const block of content) {
    const record = asRecord(block);
    for (const attachmentId of [
      firstString(record?.attachmentId, record?.attachment_id),
      firstString(record?.fileId, record?.file_id),
    ]) {
      if (attachmentId) ids.add(attachmentId);
    }
  }
  return [...ids];
}

function uploadToContentBlock(upload: FileUploadResult, toolCallId?: string): Record<string, unknown> {
  const type = upload.mimeType.startsWith("image/")
    ? "image"
    : upload.mimeType.startsWith("audio/")
      ? "audio"
      : "file";
  return compact({
    type,
    attachmentId: stableRelayAttachmentId(upload),
    fileId: upload.fileId,
    fileName: upload.fileName,
    name: upload.fileName,
    mimeType: upload.mimeType,
    byteSize: upload.sizeBytes,
    sizeBytes: upload.sizeBytes,
    durationMs: upload.durationMs,
    width: upload.imageWidth,
    height: upload.imageHeight,
    imageWidth: upload.imageWidth,
    imageHeight: upload.imageHeight,
    downloadUrl: upload.downloadPath,
    downloadPath: upload.downloadPath,
    expiresAt: upload.expiresAt,
    sourceRunId: upload.sourceRunId,
    ...(toolCallId ? { toolCallId } : {}),
    sourceRole: upload.sourceRole,
    sha256: upload.sha256,
    contentHash: upload.sha256,
    gatewayId: upload.gatewayId,
    sessionKey: upload.sessionKey,
    status: "available",
    transferState: "available",
  });
}

function stableRelayAttachmentId(upload: FileUploadResult): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([
      "relay-file-attachment-v3",
      upload.gatewayId.trim(),
      upload.sessionKey.trim(),
      upload.fileId.trim(),
    ]))
    .digest("hex")
    .slice(0, 24);
  return `att_${digest}`;
}

async function outgoingFileCacheKey(input: {
  gatewayId: string;
  sessionKey: string;
  identity: string;
  filePath: string;
  sourceRunId?: string;
}): Promise<string> {
  const metadata = await stat(input.filePath);
  return JSON.stringify([
    "openclaw-outgoing-file-v2",
    input.gatewayId,
    input.sessionKey,
    input.identity,
    input.sourceRunId?.trim() || "no-source-run",
    metadata.size,
    metadata.mtimeMs,
    metadata.ctimeMs,
  ]);
}

async function cachedUpload(
  opts: OutgoingMediaRelayOptions,
  cacheKey: string,
  request: FileUploadRequest,
): Promise<FileUploadResult> {
  const cached = opts.cache?.get(cacheKey);
  if (cached) return cached;

  const idempotencyKey = `openclaw-outgoing:${createHash("sha256").update(cacheKey).digest("hex")}`;
  if (!opts.cache) {
    return uploadFileToRelay({ ...request, idempotencyKey });
  }
  let inFlight = inFlightUploadsByCache.get(opts.cache);
  if (!inFlight) {
    inFlight = new Map();
    inFlightUploadsByCache.set(opts.cache, inFlight);
  }
  const existing = inFlight.get(cacheKey);
  if (existing) return existing;

  const pending = uploadFileToRelay({ ...request, idempotencyKey });
  inFlight.set(cacheKey, pending);
  try {
    const uploaded = await pending;
    opts.cache.set(cacheKey, uploaded);
    return uploaded;
  } finally {
    inFlight.delete(cacheKey);
  }
}

function canonicalRelationSessionKey(
  rawSessionKey: string | undefined,
  opts: Pick<OutgoingMediaRelayOptions, "sessionDefaults">,
): string | undefined {
  if (!rawSessionKey) return undefined;
  const gatewayKey = opts.sessionDefaults
    ? canonicalizeSessionKey(rawSessionKey, opts.sessionDefaults)
    : rawSessionKey;
  if (typeof gatewayKey !== "string" || !gatewayKey.trim()) return undefined;
  return canonicalizeOpenClawSessionScope(gatewayKey, opts.sessionDefaults);
}

function sanitizeOpenClawMediaControlBlocks(content: unknown[]): { content: unknown[]; changed: boolean } {
  let changed = false;
  const nextContent: unknown[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      nextContent.push(block);
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type !== "text" || typeof record.text !== "string") {
      nextContent.push(block);
      continue;
    }
    const text = record.text;
    const sanitizedText = stripOpenClawMediaControlLines(text);
    if (sanitizedText === text) {
      nextContent.push(block);
      continue;
    }
    changed = true;
    // OpenClaw 的 MEDIA:/... 是内部桥接标记，不能显示成聊天文本，也不能从历史回放再次触发本地路径上传。
    if (!sanitizedText.trim()) {
      continue;
    }
    nextContent.push({ ...record, text: sanitizedText });
  }
  return { content: nextContent, changed };
}

function stripOpenClawMediaControlLines(text: string): string {
  if (!text.includes("MEDIA:")) {
    return text;
  }
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const stripped = normalized
    .split("\n")
    .filter((line) => !OPENCLAW_MEDIA_CONTROL_PREFIX_RE.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return stripped;
}

function isAbsoluteHostPath(value: string): boolean {
  return value.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\[^\\/]/.test(value);
}

function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

const DELIVERABLE_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".svg",
  ".mp4", ".mov", ".avi", ".mkv", ".webm",
  ".mp3", ".wav", ".ogg", ".m4a", ".flac",
  ".pdf", ".docx", ".doc", ".odt", ".rtf", ".txt", ".md",
  ".xlsx", ".xls", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml",
  ".pptx", ".ppt", ".odp", ".zip", ".tar", ".gz", ".tgz", ".bz2", ".7z",
  ".html", ".htm",
];

function trustedDeliverablePaths(values: unknown[]): string[] {
  const paths = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const filePath = trustedDeliverablePath(value);
    if (filePath) paths.add(filePath);
  }
  return [...paths];
}

function trustedDeliverablePath(rawPath: string): string | undefined {
  const candidate = rawPath.trim();
  if (!candidate) return undefined;
  if (!candidate.startsWith("~/") && !candidate.startsWith("~\\") && !isAbsoluteHostPath(candidate)) {
    return undefined;
  }
  const expandedPath = candidate.startsWith("~/") || candidate.startsWith("~\\")
    ? join(homedir(), candidate.slice(2))
    : candidate;
  if (!DELIVERABLE_EXTENSIONS.includes(extname(expandedPath).toLowerCase())) {
    return undefined;
  }
  const filePath = resolve(expandedPath);
  return existsSync(filePath) ? filePath : undefined;
}
