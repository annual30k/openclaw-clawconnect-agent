// Hermes 对话消息准备：附件落盘到 inbox、用户附件标记失活、运行时上下文提示与移动端轮次身份元数据。
import { randomUUID } from "crypto";
import { mkdir, readdir, rm, stat, writeFile } from "fs/promises";
import { join } from "path";
import {
  CLAWCONNECT_MOBILE_BRIDGE_HINT,
  HERMES_INBOX_DIR,
} from "./hermes-runtime-process.js";
import type { HermesUsageSnapshot } from "./hermes-runtime-types.js";
import { readCachedHermesStatusSnapshot } from "./hermes-runtime-usage.js";
import { compactStringArray, sanitizeFileName } from "./hermes-runtime-values.js";

const HERMES_RUNTIME_CONTEXT_CACHE_MAX_AGE_MS = 5 * 60_000;
const HERMES_INBOX_TTL_MS = 24 * 60 * 60 * 1000;
const USER_FILE_MARKER_PREFIX_RE = /\[file attached:/gi;

export type PreparedHermesMessage = {
  apiMessage: string;
  apiInstructions?: string;
  cliMessage: string;
};

export async function prepareRequiredHermesMessage(
  rawMessage: string,
  attachments: unknown,
  sessionKey: string,
  sourceRunId: string | undefined,
): Promise<PreparedHermesMessage> {
  const preparedMessage = await prepareHermesMessage(rawMessage, attachments, sessionKey, sourceRunId);
  if (!preparedMessage.cliMessage.trim()) {
    throw new Error("message_required");
  }
  return preparedMessage;
}

const CLAWCONNECT_MOBILE_TURN_INSTRUCTION =
  "Use [ClawConnect mobile turn] metadata only for ClawConnect file-transfer attribution and message identity. Do not mention it in the answer.";

function buildClawConnectMobileTurnMetadata(sourceRunId: string | undefined, sessionKey: string): string | undefined {
  if (!sourceRunId) {
    return undefined;
  }
  // 这个块是 ClawConnect 和 Hermes history 的稳定身份合同；客户端展示时会剥离它。
  return [
    "[ClawConnect mobile turn]",
    `sourceRunId: ${sourceRunId}`,
    `sessionKey: ${sessionKey}`,
  ].join("\n");
}

async function prepareHermesMessage(
  message: string,
  attachments: unknown,
  sessionKey: string,
  sourceRunId?: string,
): Promise<PreparedHermesMessage> {
  const refs: string[] = [];
  if (Array.isArray(attachments)) {
    await cleanupExpiredHermesInbox();
    const safeSession = sessionKey.replace(/[^\w.-]/g, "_") || "main";
    for (const attachment of attachments) {
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
        continue;
      }
      const record = attachment as Record<string, unknown>;
      if (typeof record.content !== "string" || record.content.length === 0) {
        continue;
      }
      const fileName = sanitizeFileName(
        typeof record.fileName === "string" ? record.fileName
          : typeof record.name === "string" ? record.name
            : `attachment-${randomUUID()}`,
      );
      const dir = join(HERMES_INBOX_DIR, safeSession, randomUUID());
      await mkdir(dir, { recursive: true });
      const filePath = join(dir, fileName);
      await writeFile(filePath, Buffer.from(record.content, "base64"));
      const mimeType = typeof record.mimeType === "string" ? record.mimeType : "application/octet-stream";
      refs.push(`[file attached: ${filePath} (${mimeType})]`);
    }
  }
  const userSections = [sanitizeHermesUserAttachmentMarkers(message).trim()];
  if (refs.length > 0) {
    userSections.push(refs.join("\n"));
  }
  const runtimeHint = buildHermesRuntimeContextHint(
    readCachedHermesStatusSnapshot(HERMES_RUNTIME_CONTEXT_CACHE_MAX_AGE_MS),
  );
  const turnMetadata = buildClawConnectMobileTurnMetadata(sourceRunId, sessionKey);
  const apiMessageSections = [...userSections];
  if (turnMetadata) {
    apiMessageSections.push(turnMetadata);
  }
  const apiInstructionSections = [
    runtimeHint,
    CLAWCONNECT_MOBILE_BRIDGE_HINT,
    turnMetadata ? CLAWCONNECT_MOBILE_TURN_INSTRUCTION : undefined,
  ];
  const cliMessageSections = [
    ...userSections,
    runtimeHint,
    CLAWCONNECT_MOBILE_BRIDGE_HINT,
    turnMetadata
      ? [turnMetadata, CLAWCONNECT_MOBILE_TURN_INSTRUCTION].join("\n")
      : undefined,
  ];
  return {
    apiMessage: apiMessageSections.filter(Boolean).join("\n\n").trim(),
    apiInstructions: apiInstructionSections.filter(Boolean).join("\n\n").trim() || undefined,
    cliMessage: cliMessageSections.filter(Boolean).join("\n\n").trim(),
  };
}

export function sanitizeHermesUserAttachmentMarkers(message: string): string {
  // Hermes 的本地文件提示只能由桥接层生成；让用户输入的同形标记失活，
  // 避免把任意 Host 路径伪装成移动端附件交给运行时读取。
  return message.replace(USER_FILE_MARKER_PREFIX_RE, "［file attached:");
}

export async function cleanupExpiredHermesInbox(
  inboxDir = HERMES_INBOX_DIR,
  nowMs = Date.now(),
  ttlMs = HERMES_INBOX_TTL_MS,
): Promise<void> {
  let sessions;
  try {
    sessions = await readdir(inboxDir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(sessions.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map(async (session) => {
    const sessionDir = join(inboxDir, session.name);
    let runs;
    try {
      runs = await readdir(sessionDir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(runs.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map(async (run) => {
      const runDir = join(sessionDir, run.name);
      try {
        const metadata = await stat(runDir);
        if (nowMs - metadata.mtimeMs >= Math.max(0, ttlMs)) {
          await rm(runDir, { recursive: true, force: true });
        }
      } catch {
        // 清理失败不能阻断当前聊天；下一轮发送会再次尝试。
      }
    }));
  }));
}

export function buildHermesRuntimeContextHint(snapshot: HermesUsageSnapshot): string | undefined {
  const details = compactStringArray([
    snapshot.currentModel ? `model=${snapshot.currentModel}` : undefined,
    snapshot.provider ? `provider=${snapshot.provider}` : undefined,
  ]);
  if (details.length === 0) {
    return undefined;
  }
  return [
    "[Hermes runtime context]",
    `Current runtime: ${details.join(", ")}.`,
    "If the user asks which model or provider is currently being used, answer from this runtime context.",
  ].join("\n");
}
