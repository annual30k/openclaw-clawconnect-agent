import { existsSync } from "fs";
import { readFile, stat } from "fs/promises";
import { homedir } from "os";
import { isAbsolute, extname, join, relative, resolve } from "path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "crypto";
import { uploadFileToRelay, type FileUploadRequest, type FileUploadResult } from "../../core/relay/file-upload.js";
import { resolveOpenClawStateDir } from "../runtime/openclaw-paths.js";
import {
  normalizeOpenClawAssistantMediaSidecars,
  normalizeOpenClawAutomaticMediaReplies,
} from "./assistant-media-sidecar.js";

const OUTGOING_MEDIA_RE = /\/api\/chat\/media\/outgoing\/[^/]+\/([^/]+)\/full(?:$|[?#])/;
const OPENCLAW_MEDIA_CONTROL_PREFIX_RE = /^MEDIA:\s*(?:file:\/\/|~[\\/]|\/|[A-Za-z]:[\\/]|\\\\)/i;
const OPENCLAW_INPUT_MEDIA_MARKER_RE = /\[media attached:\s+(.+?)\s+\(([^)\r\n]+)\)\s+\|\s+(.+?)\]/g;

export type OutgoingMediaRelayOptions = {
  relayServerUrl: string;
  relaySecret: string;
  gatewayId: string;
  senderDisplayName?: string;
  recordsDir?: string;
  stateDir?: string;
  cache?: Map<string, FileUploadResult>;
  userMessage?: string;
  /**
   * A live gateway event can arrive a few milliseconds before OpenClaw commits
   * its managed outgoing-media record.  Only that path should briefly wait for
   * the record instead of publishing an unavailable image placeholder.
   */
  waitForOutgoingMediaRecord?: boolean;
};

type OutgoingMediaOptionsWithSourceRun = OutgoingMediaRelayOptions & {
  sourceRunId?: string;
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
  const message = (payload as Record<string, unknown>).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return payload;
  }
  const payloadRecord = payload as Record<string, unknown>;
  const sourceRunId = payloadSourceRunId(payloadRecord);
  const messageContent = await relayOutgoingMediaContent(
    (message as Record<string, unknown>).content,
    { ...opts, sourceRunId },
  );
  const localArtifactBlocks = await relayLocalArtifactPathsInContent(messageContent.blocks, payloadRecord, opts);
  const timelineEvents = await relayOutgoingMediaInTimelineEvents(payloadRecord.timelineEvents, opts, sourceRunId);

  if (!messageContent.changed && localArtifactBlocks.length === 0 && !timelineEvents.changed) {
    return payload;
  }
  return {
    ...payloadRecord,
    message: {
      ...(message as Record<string, unknown>),
      content: localArtifactBlocks.length > 0
        ? [...messageContent.blocks, ...localArtifactBlocks]
        : messageContent.content,
    },
    ...(timelineEvents.changed ? { timelineEvents: timelineEvents.events } : {}),
  };
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
    const sourceRunId = firstString(record.runId, record.turnId, fallbackSourceRunId);
    const content = await relayOutgoingMediaContent(record.content, { ...opts, sourceRunId });
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
  const responseSessionKey = firstString(responseRecord.sessionKey, responseRecord.sessionId);
  const explicitSidecars = normalizeOpenClawAssistantMediaSidecars(messages, responseSessionKey);
  const normalizedMessages = normalizeOpenClawAutomaticMediaReplies(explicitSidecars.messages, responseSessionKey);
  const messageResult = await relayOutgoingMediaInMessageList(normalizedMessages.messages, responseSessionKey, opts);
  const snapshot = responseRecord.timelineSnapshot;
  const snapshotMessages = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? (snapshot as Record<string, unknown>).messages
    : undefined;
  const explicitSnapshotSidecars = Array.isArray(snapshotMessages)
    ? normalizeOpenClawAssistantMediaSidecars(snapshotMessages, responseSessionKey)
    : undefined;
  const normalizedSnapshotMessages = explicitSnapshotSidecars
    ? normalizeOpenClawAutomaticMediaReplies(explicitSnapshotSidecars.messages, responseSessionKey)
    : undefined;
  const snapshotResult = normalizedSnapshotMessages
    ? await relayOutgoingMediaInMessageList(normalizedSnapshotMessages.messages, responseSessionKey, opts)
    : undefined;
  const changed = explicitSidecars.changed
    || normalizedMessages.changed
    || messageResult.changed
    || Boolean(explicitSnapshotSidecars?.changed)
    || Boolean(normalizedSnapshotMessages?.changed)
    || Boolean(snapshotResult?.changed);

  return changed
    ? {
        ...responseRecord,
        messages: messageResult.messages,
        ...(snapshotResult
          ? {
              timelineSnapshot: {
                ...(snapshot as Record<string, unknown>),
                messages: snapshotResult.messages,
              },
            }
          : {}),
      }
    : response;
}

async function relayOutgoingMediaInMessageList(
  messages: unknown[],
  sessionKey: string | undefined,
  opts: OutgoingMediaRelayOptions,
): Promise<{ messages: unknown[]; changed: boolean }> {
  let changed = false;
  const nextMessages = await Promise.all(messages.map(async (message) => {
    const restoredMessage = restoreOpenClawInputMediaInHistoryMessage(message);
    const wrapperInput = sessionKey ? { sessionKey, message: restoredMessage } : { message: restoredMessage };
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
    const sessionKey = record.sessionKey?.trim();
    if (!filePath || !sessionKey) {
      console.warn(`[relay] outgoing media record is incomplete attachment=${attachmentId}`);
      return undefined;
    }
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
    messageRecord?.messageId,
    messageRecord?.id,
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
  const delaysMs = options.waitForOutgoingMediaRecord ? [80, 160, 320, 640] : [];
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

async function relayLocalArtifactPathsInContent(
  content: unknown[],
  payload: Record<string, unknown>,
  opts: OutgoingMediaRelayOptions,
): Promise<Record<string, unknown>[]> {
  if (opts.userMessage === undefined) {
    return [];
  }
  if (content.some(isUploadedMediaBlock)) {
    return [];
  }
  const text = content
    .map((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        return "";
      }
      const record = block as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
  const paths = extractDeliverablePaths(text, opts.userMessage);
  if (paths.length === 0) {
    return [];
  }

  const sessionKey = firstString(payload.sessionKey, (payload.message as Record<string, unknown> | undefined)?.sessionKey) ?? "main";
  const runId = payloadSourceRunId(payload);
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
        };
      const upload = await cachedUpload(opts, cacheKey, request);
      blocks.push(uploadToContentBlock(upload));
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

function uploadToContentBlock(upload: FileUploadResult): Record<string, unknown> {
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

const DELIVERABLE_EXTENSION_PATTERN = DELIVERABLE_EXTENSIONS
  .map((extension) => extension.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .sort((a, b) => b.length - a.length)
  .join("|");

const DELIVERABLE_PATH_START = String.raw`(?:~[\\/]|\/|[A-Za-z]:[\\/]|\\\\[^\\/\s"'` + "`" + String.raw`<>|]+[\\/])`;
const DELIVERABLE_PATH_REGEX_SOURCE = DELIVERABLE_PATH_START + String.raw`[^\n"'` + "`" + String.raw`<>|]*?\.(?:${DELIVERABLE_EXTENSION_PATTERN})(?=$|[\s).,"'` + "`" + String.raw`，。；;:：!?？])`;
const DELIVERABLE_PATH_REGEX = new RegExp(String.raw`(?:^|[\s("'` + "`" + String.raw`:：])(${DELIVERABLE_PATH_REGEX_SOURCE})`, "gi");

export function extractDeliverablePathCandidates(text: string): string[] {
  return [...text.matchAll(DELIVERABLE_PATH_REGEX)].map((match) => match[1]);
}

function extractDeliverablePaths(text: string, userMessage?: string): string[] {
  if (userMessage !== undefined && !hasDeliverableSendIntent(userMessage)) {
    return [];
  }
  const allowed = new Set(DELIVERABLE_EXTENSIONS);
  const paths = new Set<string>();
  for (const rawPath of extractDeliverablePathCandidates(text)) {
    const absolutePath = rawPath.startsWith("~/") || rawPath.startsWith("~\\")
      ? join(homedir(), rawPath.slice(2))
      : rawPath;
    if (allowed.has(extname(absolutePath).toLowerCase()) && existsSync(resolve(absolutePath))) {
      paths.add(resolve(absolutePath));
    }
  }
  return [...paths];
}

function hasDeliverableSendIntent(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (!text) {
    return false;
  }
  if (/(不要|不用|别|无需|不需要).{0,20}(发|发送|传|上传|转发|分享|附件|attach|send|upload|share|deliver)/.test(text)
    || /(只要|仅要).{0,20}(路径|文件名|名字|文本|文字)/.test(text)
    || /\b(do not|don't|dont|no need to|without|not need to)\b.{0,30}\b(send|upload|attach|share|deliver)\b/.test(text)
    || /\bonly\b.{0,30}\b(path|filename|file name|text)\b/.test(text)) {
    return false;
  }
  const sendVerbs = [
    "发", "发送", "传", "上传", "转发", "分享", "发给", "传给", "send", "upload", "attach", "share", "deliver",
  ].join("|");
  const deliverableWords = [
    "文件", "图片", "照片", "图", "附件", "文档", "报告", "表格", "截图", "压缩包", "备份", "录音", "音频", "视频",
    "file", "image", "photo", "picture", "attachment", "document", "report", "spreadsheet", "screenshot", "archive",
    "zip", "pdf", "doc", "docx", "xlsx", "ppt", "pptx",
  ].join("|");
  const pathIntentPattern = new RegExp(
    `(?:(${sendVerbs}).{0,80}${DELIVERABLE_PATH_REGEX_SOURCE}|${DELIVERABLE_PATH_REGEX_SOURCE}.{0,80}(${sendVerbs}))`,
  );
  if (pathIntentPattern.test(text)) {
    return true;
  }
  if (new RegExp(`(你.{0,6}(能|可以|会)|能不能|可不可以|能否|是否|会不会|支持).{0,30}(${sendVerbs}).{0,30}(${deliverableWords}).{0,8}(吗|么|嘛|\\?|？)?`).test(text)) {
    return false;
  }
  const directChinesePatterns = [
    new RegExp(`(把|将).{0,50}(${deliverableWords}).{0,30}(${sendVerbs})(给我|到手机|到移动端|过来|回来|一下|给这边)?`),
    new RegExp(`(${sendVerbs})(这张|这个|这份|该|那张|那份|一张|几张|一些|些|一下)?[^，。,.!?？]{0,24}(${deliverableWords})(给我|到手机|到移动端|过来|回来|一下|给这边)?`),
    new RegExp(`(${sendVerbs})(给我|到手机|到移动端|过来|回来).{0,50}(${deliverableWords})?`),
    new RegExp(`(给我|帮我).{0,20}(${sendVerbs}).{0,50}(${deliverableWords})`),
  ];
  if (directChinesePatterns.some((pattern) => pattern.test(text))) {
    return true;
  }
  const englishPatterns = [
    new RegExp(`\\b(send|upload|attach|share|deliver)\\b.{0,50}\\b(${deliverableWords})\\b`),
    new RegExp(`\\b(${deliverableWords})\\b.{0,50}\\b(send|upload|attach|share|deliver)\\b`),
  ];
  return englishPatterns.some((pattern) => pattern.test(text));
}
