import type { LocalCommandContext, LocalResult } from "../../core/command-types.js";
import {
  assertThinkingLevelAllowed,
  buildThinkingStatePayload,
  parseThinkingGetParams,
  parseThinkingSetParams,
  type ThinkingStatePayload,
} from "../../core/thinking-level.js";
import {
  forgetHermesSessionReasoningLevels,
  readHermesSessionReasoningLevel,
  rememberHermesSessionReasoningLevel,
} from "../hermes-session-reasoning-store.js";
import {
  buildHermesApiHeaders,
  fetchWithTimeout,
  readHermesApiConfig,
  readJsonResponse,
} from "./hermes-runtime-api-client.js";
import { resolveHermesRuntimeExecutionMode } from "./hermes-runtime-api-settings.js";
import { HERMES_THINKING_LEVELS, readHermesDefaultThinkingLevel } from "./hermes-runtime-reasoning.js";

export const HERMES_THINKING_GET_METHOD = "hermes.thinking.get";
export const HERMES_THINKING_SET_METHOD = "hermes.thinking.set";

const HERMES_MODEL_OPTIONS_PATH = "/api/model/options";
const HERMES_MODEL_OPTIONS_TIMEOUT_MS = 2_500;

export async function runHermesThinkingGet(
  params: unknown,
  context: LocalCommandContext = {},
): Promise<LocalResult> {
  try {
    const { sessionKey } = parseThinkingGetParams(params);
    return { ok: true, payload: await readHermesThinkingState(context.gatewayId, sessionKey) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * 写入流程：基于当前读状态校验 → 写入/清除 ClawConnect 本地覆盖 → 重新读取并返回。
 * level 为 null 时清除覆盖，后续对话不再附带 reasoning 参数，由 Hermes 使用 config.yaml 默认值。
 */
export async function runHermesThinkingSet(
  params: unknown,
  context: LocalCommandContext = {},
): Promise<LocalResult> {
  try {
    const { sessionKey, level } = parseThinkingSetParams(params);
    const current = await readHermesThinkingState(context.gatewayId, sessionKey);
    assertThinkingLevelAllowed(level, current.levels);
    if (level === null) {
      await forgetHermesSessionReasoningLevels(context.gatewayId, [sessionKey]);
    } else {
      await rememberHermesSessionReasoningLevel(context.gatewayId, sessionKey, level);
    }
    return { ok: true, payload: await readHermesThinkingState(context.gatewayId, sessionKey) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function readHermesThinkingState(
  gatewayId: string | undefined,
  sessionKey: string,
): Promise<ThinkingStatePayload> {
  const supported = await probeHermesModelReasoningSupport();
  return buildThinkingStatePayload({
    sessionKey,
    supported,
    level: (await readHermesSessionReasoningLevel(gatewayId, sessionKey)) ?? null,
    defaultLevel: readHermesDefaultThinkingLevel(),
    // 模型明确不支持思考时不提供可选等级，任何非 null 写入都会被确定性拒绝。
    levels: supported ? HERMES_THINKING_LEVELS : [],
  });
}

/**
 * 通过 API Server 的模型清单判断当前模型是否支持思考。
 * 只有清单明确给出 reasoning === false 时才视为不支持；API 未配置、请求失败或找不到模型时
 * 返回 true，因为 Hermes 会在下游自行钳制不支持的 effort，隐藏控件比无效设置代价更大。
 */
async function probeHermesModelReasoningSupport(): Promise<boolean> {
  if (resolveHermesRuntimeExecutionMode() !== "api") {
    return true;
  }
  const config = readHermesApiConfig();
  if (!config) {
    return true;
  }
  try {
    const response = await fetchWithTimeout(`${config.baseUrl}${HERMES_MODEL_OPTIONS_PATH}`, {
      headers: buildHermesApiHeaders(config),
    }, HERMES_MODEL_OPTIONS_TIMEOUT_MS);
    if (!response.ok) {
      return true;
    }
    return parseHermesModelReasoningSupport(await readJsonResponse(response)) ?? true;
  } catch {
    return true;
  }
}

/**
 * 解析 GET /api/model/options：按当前 provider 精确匹配 providers[].slug，
 * 再按当前 model 精确读取 capabilities[model].reasoning；任一环节缺失返回 undefined。
 */
export function parseHermesModelReasoningSupport(payload: unknown): boolean | undefined {
  const record = toRecord(payload);
  const provider = nonEmptyString(record.provider);
  const model = nonEmptyString(record.model);
  if (!provider || !model || !Array.isArray(record.providers)) {
    return undefined;
  }
  const providerRow = record.providers
    .map(toRecord)
    .find((row) => nonEmptyString(row.slug) === provider);
  const reasoning = toRecord(toRecord(providerRow?.capabilities)[model]).reasoning;
  return typeof reasoning === "boolean" ? reasoning : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
