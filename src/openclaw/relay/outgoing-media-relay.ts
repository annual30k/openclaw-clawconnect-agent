import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { extname, join, resolve } from "path";
import { uploadFileToRelay, type FileUploadRequest, type FileUploadResult } from "../../core/relay/file-upload.js";

const OUTGOING_MEDIA_RE = /\/api\/chat\/media\/outgoing\/[^/]+\/([^/]+)\/full(?:$|[?#])/;

export type OutgoingMediaRelayOptions = {
  relayServerUrl: string;
  relaySecret: string;
  gatewayId: string;
  senderDisplayName?: string;
  recordsDir?: string;
  cache?: Map<string, FileUploadResult>;
  userMessage?: string;
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
  const localArtifactBlocks = await relayLocalArtifactPathsInContent(nextContent, payload as Record<string, unknown>, opts);

  if (!changed && localArtifactBlocks.length === 0) {
    return payload;
  }
  return {
    ...(payload as Record<string, unknown>),
    message: {
      ...(message as Record<string, unknown>),
      content: [...nextContent, ...localArtifactBlocks],
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
      gatewayId: upload.gatewayId,
      sessionKey: upload.sessionKey,
      transferState: "available",
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

async function relayLocalArtifactPathsInContent(
  content: unknown[],
  payload: Record<string, unknown>,
  opts: OutgoingMediaRelayOptions,
): Promise<Record<string, unknown>[]> {
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
  const runId = firstString(payload.runId, (payload.message as Record<string, unknown> | undefined)?.runId);
  const blocks: Record<string, unknown>[] = [];
  for (const filePath of paths) {
    try {
      const cacheKey = `${opts.gatewayId}:${sessionKey}:artifact:${filePath}`;
      let upload = opts.cache?.get(cacheKey);
      if (!upload) {
        const request: FileUploadRequest = {
          relayServerUrl: opts.relayServerUrl,
          relaySecret: opts.relaySecret,
          gatewayId: opts.gatewayId,
          sessionKey,
          filePath,
          senderDisplayName: opts.senderDisplayName,
          sourceRunId: runId,
        };
        upload = await uploadFileToRelay(request);
        opts.cache?.set(cacheKey, upload);
      }
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

function uploadToContentBlock(upload: FileUploadResult): Record<string, unknown> {
  const type = upload.mimeType.startsWith("image/")
    ? "image"
    : upload.mimeType.startsWith("audio/")
      ? "audio"
      : "file";
  return compact({
    type,
    attachmentId: upload.fileId,
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
    gatewayId: upload.gatewayId,
    sessionKey: upload.sessionKey,
    status: "available",
    transferState: "available",
  });
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

const DELIVERABLE_PATH_REGEX_SOURCE = String.raw`(?:~|\/)[^\n"'` + "`" + String.raw`<>|]*?\.(?:${DELIVERABLE_EXTENSION_PATTERN})(?=$|[\s).,"'` + "`" + String.raw`，。；;:：!?？])`;
const DELIVERABLE_PATH_REGEX = new RegExp(String.raw`(?:^|[\s("'` + "`" + String.raw`:：])(${DELIVERABLE_PATH_REGEX_SOURCE})`, "gi");

function extractDeliverablePaths(text: string, userMessage?: string): string[] {
  if (userMessage !== undefined && !hasDeliverableSendIntent(userMessage)) {
    return [];
  }
  const allowed = new Set(DELIVERABLE_EXTENSIONS);
  const paths = new Set<string>();
  for (const match of text.matchAll(DELIVERABLE_PATH_REGEX)) {
    const rawPath = match[1];
    const absolutePath = rawPath.startsWith("~/") ? join(homedir(), rawPath.slice(2)) : rawPath;
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
