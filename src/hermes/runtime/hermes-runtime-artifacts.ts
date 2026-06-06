
import { existsSync } from "fs";
import { homedir } from "os";
import { extname, join, resolve } from "path";

const DELIVERABLE_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".svg",
  ".mp4", ".mov", ".avi", ".mkv", ".webm",
  ".mp3", ".wav", ".ogg", ".m4a", ".flac",
  ".pdf", ".docx", ".doc", ".odt", ".rtf", ".txt", ".md",
  ".xlsx", ".xls", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml",
  ".pptx", ".ppt", ".odp", ".zip", ".tar", ".gz", ".tgz", ".bz2", ".7z",
  ".html", ".htm",
];

const deliverableExtensionPattern = DELIVERABLE_EXTENSIONS
  .map((extension) => extension.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .sort((a, b) => b.length - a.length)
  .join("|");

const deliverablePathRegexSource = String.raw`(?:~|\/)[^\n"'` + "`" + String.raw`<>|]*?\.(?:${deliverableExtensionPattern})(?=$|[\s).,"'` + "`" + String.raw`，。；;:：!?？])`;
const deliverablePathRegex = new RegExp(String.raw`(?:^|[\s("'` + "`" + String.raw`:：])(${deliverablePathRegexSource})`, "gi");

export function extractDeliverablePaths(
  text: string,
  options: { userMessage?: string } = {},
): string[] {
  if (options.userMessage !== undefined && !hasDeliverableSendIntent(options.userMessage)) {
    return [];
  }

  const allowed = new Set(DELIVERABLE_EXTENSIONS);
  const paths = new Set<string>();
  for (const match of text.matchAll(deliverablePathRegex)) {
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

  const deliverableWords = [
    "文件", "图片", "照片", "图", "附件", "文档", "报告", "表格", "截图", "压缩包", "备份", "录音", "音频", "视频",
    "file", "image", "photo", "picture", "attachment", "document", "report", "spreadsheet", "screenshot", "archive",
    "zip", "pdf", "doc", "docx", "xlsx", "ppt", "pptx",
  ].join("|");
  const sendVerbs = [
    "发", "发送", "传", "上传", "转发", "分享", "发给", "传给", "send", "upload", "attach", "share", "deliver",
  ].join("|");

  const pathIntentPattern = new RegExp(
    `(?:(${sendVerbs}).{0,80}${deliverablePathRegexSource}|${deliverablePathRegexSource}.{0,80}(${sendVerbs}))`,
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
