import { createReadStream } from "fs";
import { readdir, readFile, stat, open, type FileHandle } from "fs/promises";
import { basename, join, resolve } from "path";
import { createHash } from "crypto";
import { homedir } from "os";
import { readConfig, type ClawaiConfig } from "../config/config.js";
import {
  DEFAULT_FILE_CHUNK_SIZE,
  calculateChunkCount,
  formatFileSize,
  inferMimeType,
  normalizeSessionKey,
  toRelayHttpBase,
} from "./send-file-utils.js";

export interface SendFileCommandOptions {
  filePath: string;
  gateway?: string;
  session?: string;
  json?: boolean;
}

export interface SendFileCommandDependencies {
  loadConfig?: () => ClawaiConfig;
  fetchImpl?: typeof fetch;
  stdout?: Pick<NodeJS.WritableStream, "write">;
  stderr?: Pick<NodeJS.WritableStream, "write">;
  sessionStoreRoot?: string;
}

export interface SendFileResult {
  filePath: string;
  absolutePath: string;
  gatewayId: string;
  sessionKey: string;
  fileId: string;
  uploadId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  chunkSize: number;
  totalChunks: number;
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

export async function sendFileCommand(
  opts: SendFileCommandOptions,
  deps: SendFileCommandDependencies = {},
): Promise<SendFileResult> {
  const loadConfig = deps.loadConfig ?? readConfig;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  const config = loadConfig();
  const relayServerUrl = config.relayServerUrl?.trim();
  const relaySecret = config.relaySecret?.trim();
  const gatewayId = (opts.gateway?.trim() || config.gatewayId?.trim() || "").trim();

  if (!relayServerUrl) {
    throw new Error("relay_server_url_required");
  }
  if (!relaySecret) {
    throw new Error("relay_secret_required");
  }
  if (!gatewayId) {
    throw new Error("gateway_id_required");
  }

  const clientCreatedAt = new Date().toISOString();

  const sessionKey = await resolveTargetSessionKey(opts.session, deps.sessionStoreRoot);
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
  const sha256 = await computeSha256(absolutePath);
  const relayBaseUrl = toRelayHttpBase(relayServerUrl);
  const uploadInitUrl = new URL(`/api/host/gateways/${encodeURIComponent(gatewayId)}/files/init`, relayBaseUrl).toString();

  writeLog(stderr, `[send-file] preparing ${fileName} (${formatFileSize(sizeBytes)}) for gateway ${gatewayId} session ${sessionKey}`);

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
          sha256,
          senderDisplayName: config.displayName,
          clientCreatedAt,
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
  let uploadedBytes = 0;
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

      uploadedBytes += chunk.length;
      writeLog(
        stderr,
        `[send-file] uploaded chunk ${chunkIndex + 1}/${totalChunks} (${formatFileSize(uploadedBytes)}/${formatFileSize(sizeBytes)})`,
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

  const result: SendFileResult = {
    filePath: opts.filePath,
    absolutePath,
    gatewayId: payload.gatewayId || gatewayId,
    sessionKey: payload.sessionKey || sessionKey,
    fileId: payload.fileId,
    uploadId: init.uploadId,
    fileName: payload.fileName,
    mimeType: payload.mimeType,
    sizeBytes: payload.sizeBytes,
    sha256: payload.sha256,
    chunkSize,
    totalChunks,
    expiresAt: payload.expiresAt,
    downloadPath,
    downloadUrl,
    senderDisplayName: payload.senderDisplayName,
    status: payload.status,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
  };

  if (opts.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    writeLog(stdout, `[send-file] uploaded ${result.fileName}`);
    writeLog(stdout, `  gateway: ${result.gatewayId}`);
    writeLog(stdout, `  session: ${result.sessionKey}`);
    writeLog(stdout, `  file id: ${result.fileId}`);
    writeLog(stdout, `  size: ${formatFileSize(result.sizeBytes)}`);
    writeLog(stdout, `  download: ${result.downloadUrl}`);
    writeLog(stdout, `  expires: ${result.expiresAt}`);
  }

  return result;
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

async function resolveTargetSessionKey(explicitSessionKey: string | undefined, sessionStoreRoot?: string): Promise<string> {
  const trimmedExplicit = explicitSessionKey?.trim() ?? "";
  if (trimmedExplicit) {
    return normalizeSessionKey(trimmedExplicit);
  }

  const inferredSessionKey = await inferLatestSessionKeyFromStore(sessionStoreRoot ?? join(homedir(), ".openclaw"));
  return normalizeSessionKey(inferredSessionKey ?? "main");
}

async function inferLatestSessionKeyFromStore(sessionStoreRoot: string): Promise<string | undefined> {
  const agentsDir = join(sessionStoreRoot, "agents");
  let agentEntries;
  try {
    agentEntries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  let latestSessionKey: string | undefined;
  let latestUpdatedAt = -1;

  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) {
      continue;
    }

    const sessionsPath = join(agentsDir, agentEntry.name, "sessions", "sessions.json");
    let rawStore: string;
    try {
      rawStore = await readFile(sessionsPath, "utf8");
    } catch {
      continue;
    }

    let parsedStore: unknown;
    try {
      parsedStore = JSON.parse(rawStore);
    } catch {
      continue;
    }
    if (!parsedStore || typeof parsedStore !== "object" || Array.isArray(parsedStore)) {
      continue;
    }

    for (const [sessionKey, value] of Object.entries(parsedStore as Record<string, unknown>)) {
      if (!sessionKey.startsWith(`agent:${agentEntry.name}:`)) {
        continue;
      }

      const updatedAt = extractSessionUpdatedAt(value);
      if (updatedAt === undefined || updatedAt <= latestUpdatedAt) {
        continue;
      }

      latestSessionKey = sessionKey;
      latestUpdatedAt = updatedAt;
    }
  }

  return latestSessionKey;
}

function extractSessionUpdatedAt(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const candidateValues = [record.updatedAt, record.startedAt];
  for (const candidate of candidateValues) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string") {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
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

function writeLog(stream: Pick<NodeJS.WritableStream, "write">, message: string): void {
  stream.write(`${message}\n`);
}
