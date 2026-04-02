import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import {
  buildAttachmentStagingPath,
  resolveAttachmentMimeType,
  type RelayAttachmentLike,
} from "./attachment-staging.js";

const DEFAULT_OUTBOUND_DIR = join(homedir(), ".openclaw", "media", "outbound");

type ChatSendParams = {
  deliver?: unknown;
  message?: unknown;
  attachments?: unknown;
};

type RelayAttachmentPayload = RelayAttachmentLike & {
  content?: unknown;
};

export async function prepareChatSendParams(
  rawParams: unknown,
  options?: {
    outboundDir?: string;
    logger?: Pick<Console, "log" | "error">;
  },
): Promise<unknown> {
  if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
    return rawParams;
  }

  const params: ChatSendParams = { ...(rawParams as Record<string, unknown>) };
  params.deliver = false;

  const attachments = Array.isArray(params.attachments) ? (params.attachments as RelayAttachmentPayload[]) : [];
  if (attachments.length === 0) {
    return params;
  }

  const outboundDir = options?.outboundDir ?? DEFAULT_OUTBOUND_DIR;
  const logger = options?.logger ?? console;
  const fileReferences: string[] = [];

  await mkdir(outboundDir, { recursive: true });

  for (const attachment of attachments) {
    try {
      if (typeof attachment?.content !== "string" || attachment.content.length === 0) {
        throw new Error("attachment content is missing");
      }

      const buffer = Buffer.from(attachment.content, "base64");
      const stagingId = randomUUID();
      const stagedPath = buildAttachmentStagingPath(attachment, outboundDir, stagingId);
      const mimeType = resolveAttachmentMimeType(attachment);

      await mkdir(join(outboundDir, stagingId), { recursive: true });
      await writeFile(stagedPath, buffer);
      logger.log(`[relay] Saved attachment to: ${stagedPath}`);

      fileReferences.push(`[media attached: ${stagedPath} (${mimeType}) | ${stagedPath}]`);
    } catch (error) {
      logger.error(`[relay] Failed to save attachment: ${String(error)}`);
    }
  }

  if (fileReferences.length > 0) {
    const refs = fileReferences.join("\n");
    const message = typeof params.message === "string" ? params.message : "";
    params.message = message ? `${message}\n\n${refs}` : refs;
    logger.log("[relay] Added file references to message");
  }

  return params;
}
