// Hermes 文件发送校验：按 sourceRunId 精确定位当前轮次，只认第一方 send-file 回执与 terminal 结构化结果。
import { stringValue } from "./hermes-runtime-values.js";
import { hermesSourceRunIdFromMessage } from "./hermes-runtime-history-completion.js";
import { readHermesSessionMessages } from "./hermes-runtime-state-db.js";
import {
  clearPendingHermesFileTransfer,
  getPendingHermesFileTransfer,
  recordPendingHermesFileTransfer,
  type PendingHermesFileTransfer,
} from "./hermes-file-transfer-state.js";
import type { HermesFileTransferOutcome } from "../../commands/hermes-file-transfer-outcome.js";

export type HermesChatPreparationPlan = {
  preloadFileTransferSkill: boolean;
  fileTransferMode: "continuation" | undefined;
  pendingFileTransfer?: PendingHermesFileTransfer;
};

const HERMES_FILE_TRANSFER_NOT_SENT_MESSAGE =
  "文件尚未发送：没有检测到可验证的 clawconnect send-file 成功结果，请补充或确认要发送的文件后重试。";
const HERMES_FILE_TRANSFER_CONTENT_MISSING_MESSAGE =
  "本轮没有可显示的结构化回答。";
const HERMES_FILE_TRANSFER_CANCELLED_MESSAGE = "文件发送已取消。";

export async function planHermesChatPreparation(params: {
  message: string;
  gatewayId: string;
  sessionKey: string;
  sessionId?: string;
  sourceRunId?: string;
  fileTransferCapability?: "cli";
}): Promise<HermesChatPreparationPlan> {
  // A continuation is enabled only by a durable host-side pending state from
  // the same gateway/mobile/Hermes session.  The user's wording is deliberately
  // opaque to this router; Hermes receives the full history and decides what it
  // means (including any language, selection, or clarification).
  const pending = params.sessionId
    ? await getPendingHermesFileTransfer({
      gatewayId: params.gatewayId,
      sessionKey: params.sessionKey,
      hermesSessionId: params.sessionId,
      sourceRunId: params.sourceRunId,
    })
    : undefined;
  return {
    // The mobile relay explicitly grants the typed CLI file-transfer
    // capability on every turn. The model/tool protocol, rather than a
    // language-specific intent table, decides whether a send is needed. This
    // deliberately trades the API fast path for a buffered CLI path on mobile
    // turns, where send-file receipts are persisted atomically.
    preloadFileTransferSkill: params.fileTransferCapability === "cli" || pending !== undefined,
    fileTransferMode: pending ? "continuation" : undefined,
    ...(pending ? { pendingFileTransfer: pending } : {}),
  };
}

function normalizeHermesRole(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export async function verifyHermesFileTransferIfRequired(params: {
  plan: HermesChatPreparationPlan;
  gatewayId: string;
  sessionKey: string;
  sessionId?: string;
  sourceRunId?: string;
  output?: string;
}): Promise<{ verifiedFileTransferCount?: number; output?: string }> {
  if (!params.plan.preloadFileTransferSkill) {
    return {};
  }
  const messages = params.sessionId ? await readHermesSessionMessages(params.sessionId) : undefined;
  const evidence = params.sourceRunId
    ? collectHermesFileTransferEvidence(messages, params.sourceRunId)
    : [];
  if (evidence.length > 0) {
    await clearPendingHermesFileTransfer(
      params.gatewayId,
      params.sessionKey,
      params.plan.pendingFileTransfer?.sourceRunId,
    );
    return {
      verifiedFileTransferCount: evidence.length,
      output: `已发送 ${evidence.length} 个文件，请查收。`,
    };
  }
  const outcome = params.sourceRunId
    ? collectHermesFileTransferOutcome(messages, params.sourceRunId)
    : undefined;
  if (outcome?.kind === "clarification") {
    if (params.sessionId && params.sourceRunId) {
      await recordPendingHermesFileTransfer({
        gatewayId: params.gatewayId,
        sessionKey: params.sessionKey,
        hermesSessionId: params.sessionId,
        sourceRunId: params.sourceRunId,
        continuation: false,
      });
    }
    // Only the typed content field is displayable. Raw assistant prose is
    // deliberately discarded, and this outcome is never delivery evidence.
    return {
      output: outcome.assistantText ?? HERMES_FILE_TRANSFER_CONTENT_MISSING_MESSAGE,
    };
  }
  if (outcome?.kind === "cancelled") {
    await clearPendingHermesFileTransfer(
      params.gatewayId,
      params.sessionKey,
      params.plan.pendingFileTransfer?.sourceRunId,
    );
    return {
      output: outcome.assistantText ?? HERMES_FILE_TRANSFER_CANCELLED_MESSAGE,
    };
  }
  if (outcome?.kind === "ordinary") {
    await clearPendingHermesFileTransfer(
      params.gatewayId,
      params.sessionKey,
      params.plan.pendingFileTransfer?.sourceRunId,
    );
    // Ordinary chat is shown only through the typed assistantText field. The
    // model's ordinary label is routing metadata, never proof of delivery.
    return {
      output: outcome.assistantText ?? HERMES_FILE_TRANSFER_CONTENT_MISSING_MESSAGE,
    };
  }
  if (outcome?.kind === "attempted") {
    await clearPendingHermesFileTransfer(
      params.gatewayId,
      params.sessionKey,
      params.plan.pendingFileTransfer?.sourceRunId,
    );
    return {
      verifiedFileTransferCount: 0,
      output: HERMES_FILE_TRANSFER_NOT_SENT_MESSAGE,
    };
  }
  if (params.sourceRunId && hasHermesSendFileAttempt(messages, params.sourceRunId)) {
    return {
      verifiedFileTransferCount: 0,
      output: HERMES_FILE_TRANSFER_NOT_SENT_MESSAGE,
    };
  }
  // File-transfer capability is available on every mobile turn, but capability
  // alone does not turn ordinary chat into a file operation. Preserve the Host
  // answer unless this exact turn emitted a typed outcome or actually invoked
  // the first-party terminal command. This keeps failure closed around a real
  // send attempt without replacing unrelated Hermes replies.
  return {};
}

function hasHermesSendFileAttempt(
  messages: Array<Record<string, unknown>> | undefined,
  sourceRunId: string,
): boolean {
  const currentIndex = currentHermesTurnIndex(messages, sourceRunId);
  if (currentIndex < 0 || !messages) return false;
  for (const message of messages.slice(currentIndex + 1)) {
    if (normalizeHermesRole(message.role) === "user") break;
    if (normalizeHermesRole(message.role) !== "assistant") continue;
    const rawToolCalls = typeof message.tool_calls === "string"
      ? parseJsonValue(message.tool_calls)
      : message.tool_calls;
    if (!Array.isArray(rawToolCalls)) continue;
    for (const rawToolCall of rawToolCalls) {
      const toolCall = rawToolCall && typeof rawToolCall === "object" && !Array.isArray(rawToolCall)
        ? rawToolCall as Record<string, unknown>
        : undefined;
      const fn = toolCall?.function && typeof toolCall.function === "object" && !Array.isArray(toolCall.function)
        ? toolCall.function as Record<string, unknown>
        : undefined;
      const functionName = normalizeHermesRole(fn?.name);
      if (functionName === "clawconnect_send_file") return true;
      if (functionName !== "terminal") continue;
      const rawArguments = typeof fn?.arguments === "string"
        ? parseJsonValue(fn.arguments)
        : fn?.arguments;
      const args = rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)
        ? rawArguments as Record<string, unknown>
        : undefined;
      if (typeof args?.command === "string" && isClawConnectSendFileCommand(args.command)) {
        return true;
      }
    }
  }
  return false;
}

function isClawConnectSendFileCommand(command: string): boolean {
  return /(?:^|[\s;&|])(?:["'][^"']*clawconnect["']|[^\s;&|]*clawconnect)\s+send-file(?:\s|$)/i.test(command);
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** Read only first-party terminal outcome records for the exact current turn. */
export function collectHermesFileTransferOutcome(
  messages: Array<Record<string, unknown>> | undefined,
  sourceRunId: string,
): HermesFileTransferOutcome | undefined {
  const currentIndex = currentHermesTurnIndex(messages, sourceRunId);
  if (currentIndex < 0 || !messages) return undefined;
  const outcomes: HermesFileTransferOutcome[] = [];
  for (const message of messages.slice(currentIndex + 1)) {
    if (normalizeHermesRole(message.role) === "user") break;
    if (normalizeHermesRole(message.role) !== "tool" || normalizeHermesRole(message.tool_name) !== "terminal") continue;
    for (const record of terminalResultRecords(message)) {
      if (
        record.protocol !== "clawconnect.hermes-file-transfer-outcome.v1"
        || record.sourceRunId !== sourceRunId
        || record.sourceRole !== "assistant"
        || record.status !== "completed"
        || record.exit_code !== 0
        || (record.kind !== "ordinary" && record.kind !== "clarification" && record.kind !== "attempted" && record.kind !== "cancelled")
      ) continue;
      const assistantText = typeof record.assistantText === "string" ? record.assistantText.trim() : "";
      if (record.kind !== "attempted" && !assistantText) continue;
      outcomes.push({
        protocol: "clawconnect.hermes-file-transfer-outcome.v1",
        kind: record.kind,
        sourceRunId,
        sourceRole: "assistant",
        status: "completed",
        ...(assistantText ? { assistantText } : {}),
      });
    }
  }
  if (outcomes.length !== 1) return undefined;
  return outcomes[0];
}

export function collectHermesFileTransferEvidence(
  messages: Array<Record<string, unknown>> | undefined,
  sourceRunId: string,
): string[] {
  if (!messages) {
    return [];
  }
  const currentIndex = currentHermesTurnIndex(messages, sourceRunId);
  if (currentIndex < 0) {
    return [];
  }
  const ids = new Set<string>();
  for (const message of messages.slice(currentIndex + 1)) {
    if (normalizeHermesRole(message.role) === "user") {
      break;
    }
    if (normalizeHermesRole(message.role) !== "tool") continue;
    const toolName = normalizeHermesRole(message.tool_name);
    if (toolName === "clawconnect_send_file") {
      const receipt = parseJsonRecord(stringValue(message.content) ?? "");
      if (receipt?.ok === true
        && receipt.sourceRunId === sourceRunId
        && receipt.status === "completed"
        && typeof receipt.fileId === "string"
        && /^file_[a-z0-9]+$/i.test(receipt.fileId)) {
        ids.add(receipt.fileId);
      }
      continue;
    }
    // Only the legacy first-party terminal result is additional evidence. A
    // delegate summary, wrapper output, or assistant claim cannot manufacture
    // an attachment by repeating the command name and a success word.
    if (toolName !== "terminal") continue;
    for (const record of terminalResultRecords(message)) {
      if (record.sourceRunId !== sourceRunId
        || record.sourceRole !== "assistant"
        || record.status !== "completed"
        || record.exit_code !== 0
        || typeof record.fileId !== "string"
        || !/^file_[a-z0-9]+$/i.test(record.fileId)) {
        continue;
      }
      ids.add(record.fileId);
    }
  }
  return [...ids];
}

function currentHermesTurnIndex(
  messages: Array<Record<string, unknown>> | undefined,
  sourceRunId: string,
): number {
  if (!messages || !sourceRunId.trim()) return -1;
  let currentIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (normalizeHermesRole(message?.role) === "user" && hermesSourceRunIdFromMessage(message) === sourceRunId) {
      currentIndex = index;
    }
  }
  return currentIndex;
}

function terminalResultRecords(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = stringValue(message.content);
  if (!content) {
    return [];
  }
  const outer = parseJsonRecord(content);
  if (!outer) {
    return [];
  }
  const records: Array<Record<string, unknown>> = [outer];
  const output = stringValue(outer.output);
  if (output) {
    for (const fragment of extractJsonObjects(output)) {
      const record = parseJsonRecord(fragment);
      if (record) {
        // Hermes stores the command envelope's exit_code beside the textual
        // send-file JSON payload; the payload itself carries the Relay fields.
        records.push(record.exit_code === undefined && outer.exit_code !== undefined
          ? { ...record, exit_code: outer.exit_code }
          : record);
      }
    }
  }
  return records;
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function extractJsonObjects(value: string): string[] {
  const fragments: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        fragments.push(value.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return fragments;
}
