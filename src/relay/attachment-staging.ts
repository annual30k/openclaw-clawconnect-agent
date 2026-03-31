import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface RelayAttachmentLike {
  fileName?: unknown;
  name?: unknown;
  filename?: unknown;
  mimeType?: unknown;
  contentType?: unknown;
  type?: unknown;
}

export function resolveAttachmentMimeType(attachment: RelayAttachmentLike): string {
  const rawMimeType = firstString(attachment.mimeType, attachment.contentType, attachment.type);
  return rawMimeType || "application/octet-stream";
}

export function resolveAttachmentFileName(attachment: RelayAttachmentLike): string {
  const mimeType = resolveAttachmentMimeType(attachment).toLowerCase();
  const originalName = sanitizeFileName(firstString(attachment.fileName, attachment.name, attachment.filename));
  if (originalName) {
    if (extname(originalName)) {
      return originalName;
    }
    return `${originalName}${extensionForMimeType(mimeType)}`;
  }

  return `attachment${extensionForMimeType(mimeType)}`;
}

export function buildAttachmentStagingPath(
  attachment: RelayAttachmentLike,
  outboundDir: string,
  uniqueId: string = randomUUID(),
): string {
  return join(outboundDir, uniqueId, resolveAttachmentFileName(attachment));
}

export function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  if (!normalized) {
    return ".bin";
  }

  if (normalized === "image/png") return ".png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return ".jpg";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/heic") return ".heic";
  if (normalized === "image/heif") return ".heif";
  if (normalized === "image/bmp") return ".bmp";
  if (normalized === "image/avif") return ".avif";
  if (normalized === "image/svg+xml") return ".svg";

  if (normalized === "video/mp4") return ".mp4";
  if (normalized === "video/quicktime") return ".mov";
  if (normalized === "video/webm") return ".webm";

  if (normalized === "audio/mpeg") return ".mp3";
  if (normalized === "audio/mp4") return ".m4a";
  if (normalized === "audio/aac") return ".aac";
  if (normalized === "audio/wav" || normalized === "audio/x-wav") return ".wav";

  if (normalized === "application/pdf") return ".pdf";
  if (normalized === "application/msword") return ".doc";
  if (normalized === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return ".docx";
  if (normalized === "application/vnd.ms-powerpoint") return ".ppt";
  if (normalized === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return ".pptx";
  if (normalized === "application/vnd.ms-excel") return ".xls";
  if (normalized === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return ".xlsx";
  if (normalized === "application/zip") return ".zip";
  if (normalized === "application/gzip") return ".gz";
  if (normalized === "application/x-tar") return ".tar";
  if (normalized === "application/vnd.rar") return ".rar";
  if (normalized === "application/x-apple-diskimage") return ".dmg";
  if (normalized === "application/json") return ".json";
  if (normalized === "text/plain") return ".txt";

  if (normalized.startsWith("image/")) return ".bin";
  if (normalized.startsWith("video/")) return ".bin";
  if (normalized.startsWith("audio/")) return ".bin";

  return ".bin";
}

function sanitizeFileName(value?: unknown): string | undefined {
  const trimmed = firstString(value)?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalizedSeparators = trimmed.replace(/\\/g, "/");
  const leaf = basename(normalizedSeparators)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return leaf || undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}
