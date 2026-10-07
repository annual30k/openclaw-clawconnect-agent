import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THINKING_LEVEL_OFF } from "../../core/thinking-level.js";
import { readHermesSessionReasoningLevel } from "../hermes-session-reasoning-store.js";
import { readHermesConfigBlockScalars } from "./hermes-runtime-api-settings.js";
import { resolveHermesHomeDir } from "./hermes-runtime-paths.js";

/**
 * Hermes 思考等级与契约词表之间的映射。
 *
 * 契约使用 OpenClaw 词表（off|minimal|...），Hermes 使用 reasoning effort（none|minimal|...），
 * 两者仅在“关闭”上不同：契约 off ⇔ Hermes none。其余等级 ID 原样传递。
 */

/** 支持调整时向移动端提供的 Hermes 等级，按强度递增排列。 */
export const HERMES_THINKING_LEVELS: readonly string[] = [
  THINKING_LEVEL_OFF,
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** config.yaml 未配置或无法识别 agent.reasoning_effort 时，Hermes 使用 medium。 */
export const HERMES_DEFAULT_THINKING_LEVEL = "medium";

const HERMES_REASONING_EFFORT_NONE = "none";
const HERMES_REASONING_CONFIG_BLOCK = "agent";
const HERMES_REASONING_CONFIG_KEY = "reasoning_effort";
/** 与 Hermes parse_reasoning_effort 一致：这些值表示关闭思考。 */
const HERMES_DISABLED_REASONING_VALUES = new Set(["none", "false", "disabled"]);
/** 与 Hermes VALID_REASONING_EFFORTS 一致的可识别等级。 */
const HERMES_VALID_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

/** 契约等级 → Hermes effort（off 映射为 none）。 */
export function hermesReasoningEffortForLevel(level: string): string {
  return level === THINKING_LEVEL_OFF ? HERMES_REASONING_EFFORT_NONE : level;
}

/**
 * Hermes 配置值 → 契约等级，规则镜像 Hermes parse_reasoning_effort：
 * 关闭类取值映射为 off；可识别等级原样返回；空值或未知值回落到默认 medium。
 */
export function thinkingLevelFromHermesReasoningConfig(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (HERMES_DISABLED_REASONING_VALUES.has(normalized)) {
    return THINKING_LEVEL_OFF;
  }
  return HERMES_VALID_REASONING_EFFORTS.has(normalized) ? normalized : HERMES_DEFAULT_THINKING_LEVEL;
}

/** 读取 Hermes 全局默认思考等级（config.yaml 的 agent.reasoning_effort）。 */
export function readHermesDefaultThinkingLevel(hermesHome = resolveHermesHomeDir()): string {
  let content: string;
  try {
    content = readFileSync(join(hermesHome, "config.yaml"), "utf8");
  } catch {
    return HERMES_DEFAULT_THINKING_LEVEL;
  }
  const agentValues = readHermesConfigBlockScalars(content, HERMES_REASONING_CONFIG_BLOCK);
  return thinkingLevelFromHermesReasoningConfig(agentValues[HERMES_REASONING_CONFIG_KEY]);
}

/** 返回会话显式覆盖对应的 Hermes effort；没有覆盖时返回 undefined，发送时不附加任何参数。 */
export async function resolveHermesSessionReasoningEffort(
  gatewayId: string | undefined,
  sessionKey: string,
): Promise<string | undefined> {
  const level = await readHermesSessionReasoningLevel(gatewayId, sessionKey);
  return level ? hermesReasoningEffortForLevel(level) : undefined;
}

/** API Server 会话流请求体中的单次覆盖字段。 */
export function buildHermesApiReasoningBody(
  reasoningEffort: string | undefined,
): { model_options?: { reasoning_effort: string } } {
  return reasoningEffort ? { model_options: { reasoning_effort: reasoningEffort } } : {};
}

/** CLI 模式下的单次覆盖参数。 */
export function buildHermesCliReasoningArgs(reasoningEffort: string | undefined): string[] {
  return reasoningEffort ? ["--reasoning", reasoningEffort] : [];
}
