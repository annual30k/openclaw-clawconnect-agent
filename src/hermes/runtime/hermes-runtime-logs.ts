import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { LocalResult } from "../../core/command-types.js";
import { decodeTextBuffer } from "../../platform/text-file-decoder.js";
import {
  errorMessageWithOutput,
  HERMES_LOG_DIR,
  stripAnsi,
} from "./hermes-runtime-process.js";

const DEFAULT_LOG_NAME = "gateway";
const DEFAULT_LINE_LIMIT = 100;
const MAX_LINE_LIMIT = 2000;
const MAX_READ_BYTES = 1024 * 1024;

const HERMES_LOG_FILES = Object.freeze({
  agent: "agent.log",
  errors: "errors.log",
  gateway: "gateway.log",
  gui: "gui.log",
  desktop: "desktop.log",
});

type HermesLogName = keyof typeof HERMES_LOG_FILES;

/**
 * 直接读取 Hermes 日志文件，避免移动端日志能力依赖不同 Hermes 版本的 CLI 子命令。
 * 日志名必须来自固定白名单，不能把远端参数拼成任意宿主机路径。
 */
export function readHermesLogTail(
  params: unknown,
  logDirectory = HERMES_LOG_DIR,
): LocalResult {
  const request = normalizeLogRequest(params);
  if (!request) {
    return { ok: false, error: "invalid_log_name" };
  }

  const logPath = join(logDirectory, HERMES_LOG_FILES[request.logName]);
  if (!existsSync(logPath)) {
    return {
      ok: true,
      payload: emptyLogPayload(logPath),
    };
  }

  try {
    const { buffer, startsMidFile } = readLogTailBuffer(logPath);
    const { text, encoding } = decodeTextBuffer(buffer);
    let lines = splitLogLines(text);

    // 固定大小尾读可能从一行中间开始；该残片不属于一条完整日志，必须丢弃。
    if (startsMidFile && lines.length > 0) {
      lines = lines.slice(1);
    }

    const availableLines = lines.length;
    const startIndex = Math.max(0, availableLines - request.limit);
    const returned = lines.slice(startIndex).map(stripAnsi);
    const truncated = startsMidFile || startIndex > 0;
    const totalLines = startsMidFile
      ? countLogLines(logPath, encoding)
      : availableLines;

    console.log(
      `[clawconnect] Hermes logs read from ${logPath} (encoding=${encoding}, limit=${request.limit}, available=${availableLines})`,
    );
    return {
      ok: true,
      payload: {
        source: "connection",
        logPath,
        lines: returned,
        totalLines,
        returnedLines: returned.length,
        truncated,
        output: `[${logPath}]\n${returned.join("\n")}`,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `hermes_logs_read_failed: ${errorMessageWithOutput(error)}`,
    };
  }
}

function countLogLines(
  logPath: string,
  encoding: "utf8" | "utf16le" | "utf16be",
): number {
  const size = statSync(logPath).size;
  if (size === 0) return 0;

  const fileDescriptor = openSync(logPath, "r");
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  let newlineCount = 0;
  try {
    while (offset < size) {
      const bytesRead = readSync(
        fileDescriptor,
        buffer,
        0,
        Math.min(buffer.length, size - offset),
        offset,
      );
      if (bytesRead <= 0) break;
      if (encoding === "utf8") {
        for (let index = 0; index < bytesRead; index += 1) {
          if (buffer[index] === 0x0a) newlineCount += 1;
        }
      } else {
        for (let index = 0; index + 1 < bytesRead; index += 2) {
          const isLineFeed = encoding === "utf16le"
            ? buffer[index] === 0x0a && buffer[index + 1] === 0x00
            : buffer[index] === 0x00 && buffer[index + 1] === 0x0a;
          if (isLineFeed) newlineCount += 1;
        }
      }
      offset += bytesRead;
    }

    const finalBytes = Buffer.alloc(Math.min(2, size));
    readSync(fileDescriptor, finalBytes, 0, finalBytes.length, size - finalBytes.length);
    return newlineCount + (endsWithLineFeed(finalBytes, encoding) ? 0 : 1);
  } finally {
    closeSync(fileDescriptor);
  }
}

function endsWithLineFeed(
  finalBytes: Buffer,
  encoding: "utf8" | "utf16le" | "utf16be",
): boolean {
  if (encoding === "utf16le") {
    return finalBytes.length >= 2
      && finalBytes[finalBytes.length - 2] === 0x0a
      && finalBytes[finalBytes.length - 1] === 0x00;
  }
  if (encoding === "utf16be") {
    return finalBytes.length >= 2
      && finalBytes[finalBytes.length - 2] === 0x00
      && finalBytes[finalBytes.length - 1] === 0x0a;
  }
  return finalBytes[finalBytes.length - 1] === 0x0a;
}

function normalizeLogRequest(params: unknown): {
  logName: HermesLogName;
  limit: number;
} | null {
  const record = params && typeof params === "object" && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
  const rawLogName = typeof record.logName === "string"
    ? record.logName.trim().toLowerCase()
    : DEFAULT_LOG_NAME;
  if (!Object.hasOwn(HERMES_LOG_FILES, rawLogName)) {
    return null;
  }

  const limit = typeof record.limit === "number" && Number.isFinite(record.limit)
    ? Math.max(1, Math.min(MAX_LINE_LIMIT, Math.floor(record.limit)))
    : DEFAULT_LINE_LIMIT;
  return { logName: rawLogName as HermesLogName, limit };
}

function emptyLogPayload(logPath: string): Record<string, unknown> {
  return {
    source: "connection",
    logPath,
    lines: [],
    totalLines: 0,
    returnedLines: 0,
    truncated: false,
    output: `[${logPath}]`,
  };
}

function readLogTailBuffer(logPath: string): {
  buffer: Buffer;
  startsMidFile: boolean;
} {
  const size = statSync(logPath).size;
  if (size <= MAX_READ_BYTES) {
    return { buffer: readFileSync(logPath), startsMidFile: false };
  }

  const fileDescriptor = openSync(logPath, "r");
  try {
    const buffer = Buffer.alloc(MAX_READ_BYTES);
    readSync(fileDescriptor, buffer, 0, MAX_READ_BYTES, size - MAX_READ_BYTES);
    return { buffer, startsMidFile: true };
  } finally {
    closeSync(fileDescriptor);
  }
}

function splitLogLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}
