import {
  extractChatRole,
  extractChatText,
} from "./chat-payload.js";

export type OfficeActivityKind =
  | "idle"
  | "writing"
  | "researching"
  | "executing"
  | "syncing"
  | "offline"
  | "error";

export interface OfficeStreamPayload {
  sessionKey?: string;
  currentModel?: string;
  contextUsage?: number;
  contextLimit?: number;
  office: {
    kind: OfficeActivityKind;
    title: string;
    detail: string;
    phase?: string;
    text?: string;
    toolName?: string;
    toolCallId?: string;
    progress?: number;
    updatedAt: string;
  };
}

export function buildOfficeEventPayload(
  eventName: string,
  payload: unknown,
  nowIso: () => string = () => new Date().toISOString(),
): OfficeStreamPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const data = getObject(record.data);
  const office = getObject(record.office);
  const sessionKey = stringValue(record.sessionKey) ?? stringValue(office?.sessionKey);
  const currentModel = stringValue(record.currentModel) ?? stringValue(record.model);
  const contextUsage = numberValue(record.contextUsage)
    ?? numberValue(record.promptTokens)
    ?? numberValue(record.inputTokens);
  const contextLimit = numberValue(record.contextLimit)
    ?? numberValue(record.maxInputTokens)
    ?? numberValue(record.max_input_tokens);
  const role = extractChatRole(record);
  const text = extractChatText(record);
  const phase = normalizePhaseValue(
    stringValue(record.state)
      ?? stringValue(record.phase)
      ?? stringValue(data?.phase)
      ?? stringValue(office?.phase),
  );
  const toolName = stringValue(office?.toolName)
    ?? stringValue(office?.tool_name)
    ?? stringValue(data?.toolName)
    ?? stringValue(data?.tool_name);
  const toolCallId = stringValue(office?.toolCallId)
    ?? stringValue(office?.tool_call_id)
    ?? stringValue(data?.toolCallId)
    ?? stringValue(data?.tool_call_id);

  const kind = resolveKind(eventName, phase, role, toolName);
  const title = resolveTitle(kind);
  const detail = resolveDetail(kind, {
    eventName,
    text,
    currentModel,
    contextUsage,
    contextLimit,
    toolName,
    phase,
    office,
    record,
  });
  const progress = resolveProgress(kind, phase);

  return {
    ...(sessionKey ? { sessionKey } : {}),
    ...(currentModel ? { currentModel } : {}),
    ...(contextUsage !== undefined ? { contextUsage } : {}),
    ...(contextLimit !== undefined ? { contextLimit } : {}),
    office: {
      kind,
      title,
      detail,
      ...(phase ? { phase } : {}),
      ...(text ? { text } : {}),
      ...(toolName ? { toolName } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(progress !== undefined ? { progress } : {}),
      updatedAt: nowIso(),
    },
  };
}

function resolveKind(
  eventName: string,
  phase: string,
  role: string,
  toolName: string | undefined,
): OfficeActivityKind {
  const loweredTool = toolName?.toLowerCase() ?? "";
  if (eventName === "gateway_disconnected") {
    return "offline";
  }
  if (eventName === "gateway_connected" || eventName === "context_usage") {
    return "syncing";
  }
  if (phase.includes("error") || phase.includes("fail")) {
    return "error";
  }
  if (phase.includes("final") || phase.includes("complete") || phase.includes("done") || phase.includes("end")) {
    return "idle";
  }
  if (phase.includes("sync") || phase.includes("waiting")) {
    return "syncing";
  }
  if (loweredTool.includes("search") || loweredTool.includes("browse") || loweredTool.includes("research") || loweredTool.includes("web")) {
    return "researching";
  }
  if (loweredTool.includes("code") || loweredTool.includes("shell") || loweredTool.includes("run") || loweredTool.includes("exec")) {
    return "executing";
  }
  if (phase.includes("stream") || phase.includes("delta") || phase.includes("progress") || phase.includes("write")) {
    return eventName === "agent" ? "executing" : "writing";
  }
  if (role === "user") {
    return "writing";
  }
  return "idle";
}

function resolveTitle(kind: OfficeActivityKind): string {
  switch (kind) {
    case "idle":
      return "待命中";
    case "writing":
      return "写作中";
    case "researching":
      return "检索中";
    case "executing":
      return "执行中";
    case "syncing":
      return "同步中";
    case "offline":
      return "离线";
    case "error":
      return "异常";
  }
}

function resolveDetail(
  kind: OfficeActivityKind,
  context: {
    eventName: string;
    text?: string;
    currentModel?: string;
    contextUsage?: number;
    contextLimit?: number;
    toolName?: string;
    phase: string;
    office?: Record<string, unknown>;
    record: Record<string, unknown>;
  },
): string {
  const officeDetail = stringValue(context.office?.detail);
  if (officeDetail) {
    return officeDetail;
  }
  const officeText = stringValue(context.office?.text);
  if (officeText) {
    return officeText;
  }
  const dataText = stringValue(context.record.text) ?? stringValue(getObject(context.record.data)?.text);
  const messageText = stringValue(getObject(context.record.message)?.text);
  const text = context.text || dataText || messageText;

  switch (kind) {
    case "idle":
      if (context.currentModel) {
        return `模型 ${context.currentModel} 正在待命`;
      }
      return "等待下一次任务";
    case "writing":
      return text || "正在整理回复";
    case "researching":
      if (context.toolName) {
        return `正在检索 ${context.toolName}`;
      }
      return text || "正在检索资料";
    case "executing":
      if (context.toolName) {
        return `正在执行 ${context.toolName}`;
      }
      return text || "正在执行工具";
    case "syncing":
      if (context.contextUsage !== undefined && context.contextLimit !== undefined) {
        return `${formatCount(context.contextUsage)} / ${formatCount(context.contextLimit)}`;
      }
      return text || "正在同步状态";
    case "offline":
      return "主机暂时离线";
    case "error":
      return text || stringValue(context.record.errorMessage) || stringValue(context.record.error) || "发生错误";
  }
}

function resolveProgress(kind: OfficeActivityKind, phase: string): number | undefined {
  if (phase.includes("final") || phase.includes("complete") || phase.includes("done")) {
    return 1;
  }
  if (phase.includes("error") || phase.includes("fail")) {
    return 1;
  }
  switch (kind) {
    case "idle":
      return 0;
    case "writing":
      return 0.42;
    case "researching":
      return 0.55;
    case "executing":
      return 0.72;
    case "syncing":
      return 0.36;
    case "offline":
      return 0;
    case "error":
      return 1;
  }
}

function getObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function normalizePhaseValue(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function formatCount(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round((value / 1_000_000) * 10) / 10}m`;
  }
  if (value >= 1_000) {
    return `${Math.round((value / 1_000) * 10) / 10}k`;
  }
  return String(value);
}
