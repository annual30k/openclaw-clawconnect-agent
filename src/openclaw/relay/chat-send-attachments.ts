import { createHash, randomUUID } from "crypto";
import { mkdir, readdir, rm, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import {
  buildAttachmentStagingPath,
  resolveAttachmentMimeType,
  type RelayAttachmentLike,
} from "../../core/relay/attachment-staging.js";

const DEFAULT_OUTBOUND_DIR = join(homedir(), ".openclaw", "media", "outbound");
const DEFAULT_STAGING_TTL_MS = 24 * 60 * 60 * 1000;
const USER_MEDIA_MARKER_PREFIX_RE = /\[media attached:/gi;
const CLIENT_ONLY_CHAT_SEND_FIELDS = [
  "runId",
  "run_id",
  "requestId",
  "request_id",
  "clientRunId",
  "client_run_id",
] as const;

type ChatSendParams = {
  deliver?: unknown;
  message?: unknown;
  attachments?: unknown;
};

type RelayAttachmentPayload = RelayAttachmentLike & {
  content?: unknown;
  fileId?: unknown;
  sha256?: unknown;
  sourceRunId?: unknown;
  sizeBytes?: unknown;
};

export async function prepareChatSendParams(
  rawParams: unknown,
  options?: {
    outboundDir?: string;
    logger?: Pick<Console, "log" | "error">;
    relayServerUrl?: string;
    relaySecret?: string;
    fetchImpl?: typeof fetch;
    nowMs?: number;
    stagingTtlMs?: number;
  },
): Promise<unknown> {
  if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
    return rawParams;
  }

  const params: ChatSendParams = { ...(rawParams as Record<string, unknown>) };
  for (const key of CLIENT_ONLY_CHAT_SEND_FIELDS) {
    delete (params as Record<string, unknown>)[key];
  }
  params.deliver = false;
  if (typeof params.message === "string") {
    params.message = sanitizeUserSuppliedMediaMarkers(params.message);
  }

  const attachments = Array.isArray(params.attachments) ? (params.attachments as RelayAttachmentPayload[]) : [];
  if (attachments.length === 0) {
    return params;
  }

  const outboundDir = options?.outboundDir ?? DEFAULT_OUTBOUND_DIR;
  const logger = options?.logger ?? console;
  const fileReferences: string[] = [];
  const stagingErrors: Error[] = [];

  await cleanupExpiredAttachmentStagingDirs(
    outboundDir,
    options?.nowMs ?? Date.now(),
    options?.stagingTtlMs ?? DEFAULT_STAGING_TTL_MS,
  );
  await mkdir(outboundDir, { recursive: true });

  for (const attachment of attachments) {
    try {
      const buffer = await resolveAttachmentBytes(attachment, options);
      const stagingId = randomUUID();
      const stagedPath = buildAttachmentStagingPath(attachment, outboundDir, stagingId);
      const mimeType = resolveAttachmentMimeType(attachment);

      await mkdir(join(outboundDir, stagingId), { recursive: true });
      await writeFile(stagedPath, buffer);
      logger.log(`[relay] Saved attachment to: ${stagedPath}`);

      fileReferences.push(`[media attached: ${stagedPath} (${mimeType}) | ${stagedPath}]`);
    } catch (error) {
      logger.error(`[relay] Failed to save attachment: ${String(error)}`);
      stagingErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (stagingErrors.length > 0) {
    throw new Error(`attachment staging failed: ${stagingErrors[0]?.message ?? "unknown error"}`);
  }

  if (fileReferences.length > 0) {
    const refs = fileReferences.join("\n");
    const message = typeof params.message === "string" ? params.message : "";
    params.message = message ? `${message}\n\n${refs}` : refs;
    logger.log("[relay] Added file references to message");
  }
  delete params.attachments;

  return params;
}

async function resolveAttachmentBytes(
  attachment: RelayAttachmentPayload,
  options: Parameters<typeof prepareChatSendParams>[1],
): Promise<Buffer> {
  const fileId = optionalString(attachment.fileId);
  if (!fileId) {
    if (typeof attachment.content !== "string" || attachment.content.length === 0) {
      throw new Error("attachment content is missing");
    }
    return Buffer.from(attachment.content, "base64");
  }

  const relayServerUrl = optionalString(options?.relayServerUrl);
  const relaySecret = optionalString(options?.relaySecret);
  if (!relayServerUrl || !relaySecret) {
    throw new Error("canonical attachment relay credentials are missing");
  }
  const fetchImpl = options?.fetchImpl ?? fetch;
  const relayBaseUrl = new URL(relayServerUrl);
  const downloadUrl = new URL(`/api/mobile/files/${encodeURIComponent(fileId)}`, relayBaseUrl);
  const response = await fetchImpl(downloadUrl, {
    headers: {
      Accept: "application/octet-stream",
      "X-Relay-Secret": relaySecret,
    },
  });
  if (!response.ok) {
    throw new Error(`canonical attachment download failed (${response.status})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const expectedSize = optionalPositiveInteger(attachment.sizeBytes);
  if (expectedSize !== undefined && buffer.length !== expectedSize) {
    throw new Error("canonical attachment size mismatch");
  }
  const expectedSha256 = optionalString(attachment.sha256)?.toLowerCase();
  if (expectedSha256) {
    const actualSha256 = createHash("sha256").update(buffer).digest("hex");
    if (actualSha256 !== expectedSha256) {
      throw new Error("canonical attachment sha256 mismatch");
    }
  }
  return buffer;
}

function sanitizeUserSuppliedMediaMarkers(message: string): string {
  // OpenClaw 的媒体标记只能由本桥接层生成；用户输入同形文本必须失活，
  // 否则历史恢复可能把普通文字误解释为 Host 本地文件路径。
  return message.replace(USER_MEDIA_MARKER_PREFIX_RE, "［media attached:");
}

export async function cleanupExpiredAttachmentStagingDirs(
  outboundDir: string,
  nowMs = Date.now(),
  ttlMs = DEFAULT_STAGING_TTL_MS,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(outboundDir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map(async (entry) => {
    const directory = join(outboundDir, entry.name);
    try {
      const metadata = await stat(directory);
      if (nowMs - metadata.mtimeMs >= Math.max(0, ttlMs)) {
        await rm(directory, { recursive: true, force: true });
      }
    } catch {
      // 清理失败不能阻断当前聊天发送；下一轮发送会继续尝试。
    }
  }));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
}
