import type { LocalResult } from "../../core/command-types.js";
import {
  assertThinkingLevelAllowed,
  buildThinkingStatePayload,
  hasAdjustableThinkingLevel,
  parseThinkingGetParams,
  parseThinkingSetParams,
  type ThinkingStatePayload,
} from "../../core/thinking-level.js";

export const OPENCLAW_THINKING_GET_METHOD = "pocketclaw.thinking.get";
export const OPENCLAW_THINKING_SET_METHOD = "pocketclaw.thinking.set";

const SESSIONS_LIST_METHOD = "sessions.list";
const SESSIONS_PATCH_METHOD = "sessions.patch";
const SESSIONS_LIST_SEARCH_LIMIT = 20;

/** 只依赖网关 RPC 的最小接口，便于测试注入假客户端。 */
export interface OpenClawThinkingGatewayClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

type OpenClawThinkingSource = {
  level: string | null;
  defaultLevel: string | null;
  levels: string[];
};

/**
 * 处理 OpenClaw 会话思考等级命令；非本模块方法返回 null，交由后续路由处理。
 * sessionKey 已由 Relay 映射为宿主会话键（如 agent:main:mobile-abc），此处不再改写。
 */
export function handleOpenClawThinkingCommand(
  method: string,
  params: unknown,
  gatewayClient: OpenClawThinkingGatewayClient | null,
): Promise<LocalResult> | null {
  if (method !== OPENCLAW_THINKING_GET_METHOD && method !== OPENCLAW_THINKING_SET_METHOD) {
    return null;
  }
  return runThinkingCommand(method, params, gatewayClient);
}

async function runThinkingCommand(
  method: string,
  params: unknown,
  gatewayClient: OpenClawThinkingGatewayClient | null,
): Promise<LocalResult> {
  try {
    if (!gatewayClient) {
      throw new Error("gateway not connected");
    }
    const payload = method === OPENCLAW_THINKING_GET_METHOD
      ? await readOpenClawThinkingState(gatewayClient, parseThinkingGetParams(params).sessionKey)
      : await setOpenClawThinkingLevel(gatewayClient, parseThinkingSetParams(params));
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function readOpenClawThinkingState(
  gatewayClient: OpenClawThinkingGatewayClient,
  sessionKey: string,
): Promise<ThinkingStatePayload> {
  const response = await gatewayClient.request(SESSIONS_LIST_METHOD, {
    search: sessionKey,
    limit: SESSIONS_LIST_SEARCH_LIMIT,
    includeGlobal: true,
    includeUnknown: true,
  });
  const source = resolveThinkingSource(response, sessionKey);
  return buildThinkingStatePayload({
    sessionKey,
    supported: hasAdjustableThinkingLevel(source.levels),
    ...source,
  });
}

/**
 * 写入流程：先用当前读状态校验等级 → sessions.patch → 重新读取并返回网关的权威状态。
 * 不用本地拼装结果，避免网关对等级做了归一化或拒绝时客户端看到错误状态。
 */
export async function setOpenClawThinkingLevel(
  gatewayClient: OpenClawThinkingGatewayClient,
  params: { sessionKey: string; level: string | null },
): Promise<ThinkingStatePayload> {
  const current = await readOpenClawThinkingState(gatewayClient, params.sessionKey);
  assertThinkingLevelAllowed(params.level, current.levels);
  await gatewayClient.request(SESSIONS_PATCH_METHOD, {
    key: params.sessionKey,
    thinkingLevel: params.level,
  });
  return await readOpenClawThinkingState(gatewayClient, params.sessionKey);
}

/**
 * sessions.list 的 search 是子串匹配，必须按 key 精确相等选行（取响应顺序中的第一条），
 * 不能取“第一条匹配”或“最相似”的行；会话尚未创建时退回 defaults 且 level 为 null。
 */
function resolveThinkingSource(response: unknown, sessionKey: string): OpenClawThinkingSource {
  const record = toRecord(response);
  const sessions = Array.isArray(record.sessions) ? record.sessions : [];
  const row = sessions
    .map(toRecord)
    .find((session) => session.key === sessionKey);
  if (row) {
    return {
      level: nonEmptyString(row.thinkingLevel),
      defaultLevel: nonEmptyString(row.thinkingDefault),
      levels: parseThinkingLevelIds(row.thinkingLevels),
    };
  }
  const defaults = toRecord(record.defaults);
  return {
    level: null,
    defaultLevel: nonEmptyString(defaults.thinkingDefault),
    levels: parseThinkingLevelIds(defaults.thinkingLevels),
  };
}

/** thinkingLevels 形如 [{ id, label }]；保留网关顺序并去重。 */
function parseThinkingLevelIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids: string[] = [];
  for (const entry of value) {
    const id = typeof entry === "string" ? nonEmptyString(entry) : nonEmptyString(toRecord(entry).id);
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
