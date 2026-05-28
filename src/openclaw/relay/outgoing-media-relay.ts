import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { uploadFileToRelay, type FileUploadResult } from "../../core/relay/file-upload.js";

const OUTGOING_MEDIA_RE = /\/api\/chat\/media\/outgoing\/[^/]+\/([^/]+)\/full(?:$|[?#])/;

export type OutgoingMediaRelayOptions = {
  relayServerUrl: string;
  relaySecret: string;
  gatewayId: string;
  senderDisplayName?: string;
  recordsDir?: string;
  cache?: Map<string, FileUploadResult>;
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
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return payload;
  }

  let changed = false;
  const nextContent = await Promise.all(content.map(async (block) => {
    const nextBlock = await relayOutgoingMediaBlock(block, opts);
    changed ||= nextBlock !== block;
    return nextBlock;
  }));

  if (!changed) {
    return payload;
  }
  return {
    ...(payload as Record<string, unknown>),
    message: {
      ...(message as Record<string, unknown>),
      content: nextContent,
    },
  };
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

  let changed = false;
  const nextMessages = await Promise.all(messages.map(async (message) => {
    const wrapper = await relayOutgoingMediaInPayload({ message }, opts) as Record<string, unknown>;
    const nextMessage = wrapper.message ?? message;
    changed ||= nextMessage !== message;
    return nextMessage;
  }));

  return changed
    ? { ...(response as Record<string, unknown>), messages: nextMessages }
    : response;
}

async function relayOutgoingMediaBlock(block: unknown, opts: OutgoingMediaRelayOptions): Promise<unknown> {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return block;
  }
  const source = block as Record<string, unknown>;
  const url = firstString(source.url, source.openUrl, source.downloadUrl, source.download_path, source.downloadPath);
  const attachmentId = outgoingAttachmentId(url);
  if (!attachmentId) {
    return block;
  }

  try {
    const record = await readOutgoingMediaRecord(attachmentId, opts.recordsDir);
    const filePath = record.original?.path?.trim();
    const sessionKey = record.sessionKey?.trim();
    if (!filePath || !sessionKey) {
      return block;
    }
    const cacheKey = `${opts.gatewayId}:${sessionKey}:${attachmentId}`;
    let upload = opts.cache?.get(cacheKey);
    if (!upload) {
      upload = await uploadFileToRelay({
        relayServerUrl: opts.relayServerUrl,
        relaySecret: opts.relaySecret,
        gatewayId: opts.gatewayId,
        sessionKey,
        filePath,
        senderDisplayName: opts.senderDisplayName,
      });
      opts.cache?.set(cacheKey, upload);
    }

    return {
      ...source,
      type: typeof source.type === "string" && source.type.trim() ? source.type : "image",
      fileId: upload.fileId,
      fileName: record.alt || upload.fileName,
      mimeType: record.original?.contentType || upload.mimeType,
      sizeBytes: record.original?.sizeBytes || upload.sizeBytes,
      imageWidth: record.original?.width || upload.imageWidth,
      imageHeight: record.original?.height || upload.imageHeight,
      downloadUrl: upload.downloadPath,
      downloadPath: upload.downloadPath,
      expiresAt: upload.expiresAt,
      gatewayId: upload.gatewayId,
      sessionKey: upload.sessionKey,
    };
  } catch (error) {
    console.warn(`[relay] failed to publish outgoing media attachment ${attachmentId}: ${String(error)}`);
    return block;
  }
}

function outgoingAttachmentId(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  const match = OUTGOING_MEDIA_RE.exec(url);
  return match?.[1]?.trim() || undefined;
}

async function readOutgoingMediaRecord(attachmentId: string, recordsDir?: string): Promise<OutgoingMediaRecord> {
  const root = recordsDir ?? join(homedir(), ".openclaw", "media", "outgoing", "records");
  const raw = await readFile(join(root, `${attachmentId}.json`), "utf8");
  return JSON.parse(raw) as OutgoingMediaRecord;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}
