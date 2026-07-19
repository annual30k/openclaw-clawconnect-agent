import { createReadStream } from "fs";
import { stat, open, type FileHandle } from "fs/promises";
import { basename, resolve } from "path";
import { createHash, randomUUID } from "crypto";
import {
  DEFAULT_FILE_CHUNK_SIZE,
  calculateChunkCount,
  inferMimeType,
  toRelayHttpBase,
} from "./file-upload-utils.js";

export interface FileUploadRequest {
  relayServerUrl: string;
  relaySecret: string;
  gatewayId: string;
  sessionKey: string;
  filePath: string;
  senderDisplayName?: string;
  durationMs?: number;
  transcript?: string;
  sourceRunId?: string;
  sourceRole?: "user" | "assistant";
  idempotencyKey?: string;
}

export interface FileUploadDependencies {
  fetchImpl?: typeof fetch;
}

export interface FileUploadResult {
  filePath: string;
  absolutePath: string;
  gatewayId: string;
  sessionKey: string;
  fileId: string;
  uploadId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  durationMs?: number;
  imageWidth?: number;
  imageHeight?: number;
  sha256: string;
  chunkSize: number;
  totalChunks: number;
  sourceRunId?: string;
  expiresAt: string;
  downloadPath: string;
  downloadUrl: string;
  senderDisplayName?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

type FileUploadInitResponse = {
  fileId: string;
  uploadId: string;
  chunkSize: number;
  expiresAt: string;
  uploadUrl: string;
};

type FileUploadCompleteResponse = {
  ok: boolean;
  payload: {
    fileId: string;
    gatewayId: string;
    sessionKey: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    durationMs?: number;
    imageWidth?: number;
    imageHeight?: number;
    sha256: string;
    origin: string;
    senderDisplayName?: string;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    status: string;
    storagePath: string;
    downloadPath: string;
    downloadUrl?: string;
    chunkSize: number;
    totalChunks: number;
    sourceRunId?: string;
  };
};

class RelayRequestError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly responseBody: string,
    requestLabel: string,
  ) {
    super(`${requestLabel} failed (${statusCode}): ${responseBody}`);
    this.name = "RelayRequestError";
  }
}

const JSON_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
} as const;

export async function uploadFileToRelay(
  opts: FileUploadRequest,
  deps: FileUploadDependencies = {},
): Promise<FileUploadResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const relayServerUrl = opts.relayServerUrl.trim();
  const relaySecret = opts.relaySecret.trim();
  const gatewayId = opts.gatewayId.trim();
  const sessionKey = opts.sessionKey.trim();

  if (!relayServerUrl) {
    throw new Error("relay_server_url_required");
  }
  if (!relaySecret) {
    throw new Error("relay_secret_required");
  }
  if (!gatewayId) {
    throw new Error("gateway_id_required");
  }
  if (!sessionKey) {
    throw new Error("session_key_required");
  }

  const clientCreatedAt = new Date().toISOString();
  const uploadIdempotencyKey = normalizeOptionalText(opts.idempotencyKey) ?? randomUUID();

  const absolutePath = resolve(opts.filePath);
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(absolutePath);
  } catch {
    throw new Error(`file_not_found: ${absolutePath}`);
  }
  if (!fileStat.isFile()) {
    throw new Error(`not_a_regular_file: ${absolutePath}`);
  }

  const fileName = basename(absolutePath);
  const mimeType = inferMimeType(fileName);
  const sizeBytes = Math.max(0, Math.floor(fileStat.size));
  const imageDimensions = mimeType.startsWith("image/")
    ? await readImageDimensions(absolutePath, sizeBytes)
    : undefined;
  const sha256 = await computeSha256(absolutePath);
  const relayBaseUrl = toRelayHttpBase(relayServerUrl);
  const uploadInitUrl = new URL(`/api/host/gateways/${encodeURIComponent(gatewayId)}/files/init`, relayBaseUrl).toString();

  const init = await retryOperation(
    "init upload",
    () =>
      requestJson<FileUploadInitResponse>(fetchImpl, uploadInitUrl, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          secret: relaySecret,
          sessionKey,
          fileName,
          mimeType,
          sizeBytes,
          durationMs: opts.durationMs,
          imageWidth: imageDimensions?.width,
          imageHeight: imageDimensions?.height,
          sha256,
          senderDisplayName: opts.senderDisplayName,
          transcript: typeof opts.transcript === "string" ? opts.transcript.trim() : undefined,
          sourceRunId: normalizeOptionalText(opts.sourceRunId),
          sourceRole: opts.sourceRole,
          clientCreatedAt,
          idempotencyKey: uploadIdempotencyKey,
        }),
      }, "init upload"),
  );

  const chunkSize = Math.max(1, Math.floor(init.chunkSize || DEFAULT_FILE_CHUNK_SIZE));
  const totalChunks = calculateChunkCount(sizeBytes, chunkSize);
  const uploadUrl = init.uploadUrl.trim();
  if (!uploadUrl) {
    throw new Error("upload_url_missing");
  }
  const completeUrl = new URL(uploadUrl.replace(/\/chunks$/, "/complete"), relayBaseUrl).toString();

  const handle = await open(absolutePath, "r");
  try {
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
      const start = chunkIndex * chunkSize;
      const length = Math.max(0, Math.min(chunkSize, sizeBytes - start));
      const chunk = await readChunk(handle, start, length);
      const chunkUrl = new URL(`${uploadUrl}/${chunkIndex}`, relayBaseUrl).toString();

      await retryOperation(
        `upload chunk ${chunkIndex + 1}/${totalChunks}`,
        () =>
          requestJson<{ ok: boolean }>(fetchImpl, chunkUrl, {
            method: "PUT",
            headers: {
              "Content-Type": "application/octet-stream",
              Accept: "application/json",
            },
            body: chunk as unknown as BodyInit,
          }, `upload chunk ${chunkIndex + 1}/${totalChunks}`),
      );

    }
  } finally {
    await handle.close();
  }

  const complete = await retryOperation(
    "complete upload",
    () =>
      requestJson<FileUploadCompleteResponse>(fetchImpl, completeUrl, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ totalChunks }),
      }, "complete upload"),
  );

  if (!complete.ok) {
    throw new Error("upload_not_completed");
  }

  const payload = complete.payload;
  const downloadPath = (payload.downloadUrl?.trim() || payload.downloadPath.trim()).trim();
  const downloadUrl = new URL(downloadPath, relayBaseUrl).toString();

  return {
    filePath: opts.filePath,
    absolutePath,
    gatewayId: payload.gatewayId || gatewayId,
    sessionKey: payload.sessionKey || sessionKey,
    fileId: payload.fileId,
    uploadId: init.uploadId,
    fileName: payload.fileName,
    mimeType: payload.mimeType,
    sizeBytes: payload.sizeBytes,
    durationMs: payload.durationMs,
    imageWidth: payload.imageWidth,
    imageHeight: payload.imageHeight,
    sha256: payload.sha256,
    chunkSize,
    totalChunks,
    sourceRunId: normalizeOptionalText(payload.sourceRunId) ?? normalizeOptionalText(opts.sourceRunId),
    expiresAt: payload.expiresAt,
    downloadPath,
    downloadUrl,
    senderDisplayName: payload.senderDisplayName,
    status: payload.status,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
  };
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function computeSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);

  try {
    for await (const chunk of stream) {
      hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } catch (error) {
    throw new Error(`sha256_failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return hash.digest("hex");
}

async function readImageDimensions(filePath: string, fileSize: number): Promise<{ width: number; height: number } | undefined> {
  const maxBytes = Math.min(Math.max(0, Math.floor(fileSize)), 256 * 1024);
  if (maxBytes === 0) {
    return undefined;
  }

  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    let bytesRead = 0;

    while (bytesRead < maxBytes) {
      const { bytesRead: chunkRead } = await handle.read(buffer, bytesRead, maxBytes - bytesRead, bytesRead);
      if (chunkRead <= 0) {
        break;
      }
      bytesRead += chunkRead;

      const dimensions = parseImageDimensions(buffer.subarray(0, bytesRead));
      if (dimensions) {
        return dimensions;
      }
    }

    return parseImageDimensions(buffer.subarray(0, bytesRead));
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

function parseImageDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  return (
    parsePngDimensions(buffer) ??
    parseGifDimensions(buffer) ??
    parseWebpDimensions(buffer) ??
    parseJpegDimensions(buffer) ??
    parseBmpDimensions(buffer)
  );
}

function parsePngDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 24) {
    return undefined;
  }
  if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) {
    return undefined;
  }
  if (buffer.readUInt32BE(12) !== 0x49484452) {
    return undefined;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function parseGifDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 10) {
    return undefined;
  }
  const signature = buffer.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") {
    return undefined;
  }
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function parseWebpDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 30) {
    return undefined;
  }
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    return undefined;
  }

  const chunkType = buffer.toString("ascii", 12, 16);
  if (chunkType === "VP8X") {
    const width = readUInt24LE(buffer, 24) + 1;
    const height = readUInt24LE(buffer, 27) + 1;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }

  if (chunkType === "VP8L") {
    if (buffer.length < 25 || buffer[20] !== 0x2f) {
      return undefined;
    }
    const packed = buffer.readUInt32LE(21);
    const width = (packed & 0x3fff) + 1;
    const height = ((packed >> 14) & 0x3fff) + 1;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }

  if (chunkType === "VP8 ") {
    if (buffer.length < 30 || buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) {
      return undefined;
    }
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }

  return undefined;
}

function parseBmpDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 26 || buffer.toString("ascii", 0, 2) !== "BM") {
    return undefined;
  }

  const width = buffer.readInt32LE(18);
  const height = Math.abs(buffer.readInt32LE(22));
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function parseJpegDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return undefined;
  }

  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    let markerOffset = offset + 1;
    while (markerOffset < buffer.length && buffer[markerOffset] === 0xff) {
      markerOffset += 1;
    }
    if (markerOffset >= buffer.length) {
      return undefined;
    }

    const marker = buffer[markerOffset];
    if (marker === 0xda || marker === 0xd9) {
      return undefined;
    }
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset = markerOffset + 1;
      continue;
    }

    if (markerOffset + 2 >= buffer.length) {
      return undefined;
    }

    const segmentLength = buffer.readUInt16BE(markerOffset + 1);
    if (segmentLength < 2) {
      return undefined;
    }

    const segmentEnd = markerOffset + 1 + segmentLength;
    if (segmentEnd > buffer.length) {
      return undefined;
    }

    if (isStartOfFrameMarker(marker)) {
      if (segmentLength < 7) {
        return undefined;
      }
      const height = buffer.readUInt16BE(markerOffset + 4);
      const width = buffer.readUInt16BE(markerOffset + 6);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }

    offset = segmentEnd;
  }

  return undefined;
}

function isStartOfFrameMarker(marker: number): boolean {
  switch (marker) {
    case 0xc0:
    case 0xc1:
    case 0xc2:
    case 0xc3:
    case 0xc5:
    case 0xc6:
    case 0xc7:
    case 0xc9:
    case 0xca:
    case 0xcb:
    case 0xcd:
    case 0xce:
    case 0xcf:
      return true;
    default:
      return false;
  }
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  if (offset + 2 >= buffer.length) {
    return 0;
  }
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

async function readChunk(handle: FileHandle, start: number, length: number): Promise<Buffer> {
  if (length <= 0) {
    return Buffer.alloc(0);
  }

  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;

  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
    if (bytesRead <= 0) {
      break;
    }
    offset += bytesRead;
  }

  return offset === length ? buffer : buffer.subarray(0, offset);
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  requestLabel: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new Error(`${requestLabel} failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const responseText = await response.text();
  if (!response.ok) {
    throw new RelayRequestError(response.status, responseText.trim() || response.statusText || "request failed", requestLabel);
  }

  if (!responseText.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(responseText) as T;
  } catch (error) {
    throw new Error(`${requestLabel} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function retryOperation<T>(
  label: string,
  operation: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts) {
        throw new Error(`${label} failed after ${attempts} attempts: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!shouldRetry(error)) {
        throw error;
      }
      await delay(250 * attempt);
    }
  }

  throw new Error(`${label} failed`);
}

function shouldRetry(error: unknown): boolean {
  if (error instanceof RelayRequestError) {
    return error.statusCode >= 500 || error.statusCode === 408 || error.statusCode === 429;
  }

  if (error instanceof Error) {
    return /ECONNRESET|EPIPE|ETIMEDOUT|fetch failed|socket hang up/i.test(error.message);
  }

  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
