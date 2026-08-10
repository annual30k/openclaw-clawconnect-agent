const MIME_BY_EXTENSION: Record<string, string> = {
  ".aac": "audio/aac",
  ".aiff": "audio/aiff",
  ".apk": "application/vnd.android.package-archive",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".dmg": "application/x-apple-diskimage",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".htm": "text/html",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".md": "text/markdown",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".msi": "application/x-msi",
  ".pdf": "application/pdf",
  ".pkg": "application/octet-stream",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rar": "application/vnd.rar",
  ".rtf": "application/rtf",
  ".svg": "image/svg+xml",
  ".tar": "application/x-tar",
  ".tgz": "application/gzip",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".zip": "application/zip",
};

export const DEFAULT_FILE_CHUNK_SIZE = 5 * 1024 * 1024;

export function normalizeSessionKey(sessionKey?: string): string {
  const trimmed = sessionKey?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "main";
}

export function toRelayHttpBase(relayServerUrl: string): string {
  const trimmed = relayServerUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("relay_server_url_required");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (/^wss?:\/\//i.test(trimmed)) {
    return trimmed
      .replace(/^wss:\/\//i, "https://")
      .replace(/^ws:\/\//i, "http://");
  }
  return `http://${trimmed}`;
}

export function normalizeRelayServerIdentity(relayServerUrl: string): string {
  const parsed = new URL(toRelayHttpBase(relayServerUrl));
  const protocol = parsed.protocol.toLowerCase();
  const host = normalizeRelayHost(parsed.hostname);
  const port = parsed.port || (protocol === "https:" ? "443" : "80");
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${protocol}//${host}:${port}${pathname}`;
}

function normalizeRelayHost(hostname: string): string {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower === "::1" || lower === "[::1]") {
    return "127.0.0.1";
  }
  return lower;
}

export function inferMimeType(fileName: string): string {
  const lowerName = fileName.trim().toLowerCase();
  const dotIndex = lowerName.lastIndexOf(".");
  if (dotIndex < 0) {
    return "application/octet-stream";
  }

  const extension = lowerName.slice(dotIndex);
  if (!extension || extension.length > 16) {
    return "application/octet-stream";
  }

  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

export function calculateChunkCount(sizeBytes: number, chunkSize: number): number {
  const normalizedSize = Math.max(0, Math.floor(sizeBytes));
  const normalizedChunkSize = Math.max(1, Math.floor(chunkSize));
  return Math.max(1, Math.ceil(normalizedSize / normalizedChunkSize));
}

export function formatFileSize(sizeBytes: number): string {
  const normalized = Math.max(0, sizeBytes);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = normalized;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}
