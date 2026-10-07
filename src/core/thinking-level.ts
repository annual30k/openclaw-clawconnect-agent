/**
 * 会话级“思考等级”（reasoning effort）宿主命令的公共契约。
 *
 * OpenClaw 的 `pocketclaw.thinking.*` 与 Hermes 的 `hermes.thinking.*` 返回同一种载荷，
 * Relay 与各移动端按此结构解析；字段名属于对外协议，修改前必须同步 Relay/客户端。
 */
export type ThinkingStatePayload = {
  /** 原样回显请求中的会话键。 */
  sessionKey: string;
  /** 当前模型是否支持调整思考等级。 */
  supported: boolean;
  /** 会话显式覆盖值；null 表示跟随默认值。 */
  level: string | null;
  /** level 为 null 时生效的默认等级。 */
  defaultLevel: string | null;
  /** 实际生效等级：level ?? defaultLevel。 */
  effectiveLevel: string | null;
  /** 当前模型允许的等级 ID，按展示顺序排列。 */
  levels: string[];
};

export type ThinkingGetParams = {
  sessionKey: string;
};

export type ThinkingSetParams = {
  sessionKey: string;
  level: string | null;
};

/** 表示“关闭思考”的等级 ID（OpenClaw 词表）。 */
export const THINKING_LEVEL_OFF = "off";

const THINKING_LEVEL_NOT_SUPPORTED_PREFIX = "thinking_level_not_supported:";

export function buildThinkingStatePayload(input: {
  sessionKey: string;
  supported: boolean;
  level: string | null;
  defaultLevel: string | null;
  levels: readonly string[];
}): ThinkingStatePayload {
  return {
    sessionKey: input.sessionKey,
    supported: input.supported,
    level: input.level,
    defaultLevel: input.defaultLevel,
    effectiveLevel: input.level ?? input.defaultLevel,
    levels: [...input.levels],
  };
}

/** 只要存在 off 以外的等级，就认为模型可以调整思考强度。 */
export function hasAdjustableThinkingLevel(levels: readonly string[]): boolean {
  return levels.some((level) => level !== THINKING_LEVEL_OFF);
}

/**
 * 写入前的确定性校验：null 表示清除覆盖，始终允许；
 * 其他值必须精确出现在当前模型的 levels 中，否则抛出契约约定的错误消息。
 */
export function assertThinkingLevelAllowed(level: string | null, levels: readonly string[]): void {
  if (level !== null && !levels.includes(level)) {
    throw new Error(`${THINKING_LEVEL_NOT_SUPPORTED_PREFIX}${level}`);
  }
}

export function parseThinkingGetParams(params: unknown): ThinkingGetParams {
  return { sessionKey: requireSessionKey(params) };
}

export function parseThinkingSetParams(params: unknown): ThinkingSetParams {
  const sessionKey = requireSessionKey(params);
  const record = toRecord(params);
  // level 字段必须显式给出：缺省值不能被解释为“清除覆盖”，避免误删用户设置。
  if (!("level" in record)) {
    throw new Error("thinking_level_required");
  }
  const rawLevel = record.level;
  if (rawLevel === null) {
    return { sessionKey, level: null };
  }
  if (typeof rawLevel !== "string" || !rawLevel.trim()) {
    throw new Error("thinking_level_invalid");
  }
  return { sessionKey, level: rawLevel.trim() };
}

function requireSessionKey(params: unknown): string {
  const sessionKey = toRecord(params).sessionKey;
  if (typeof sessionKey !== "string" || !sessionKey.trim()) {
    throw new Error("session_key_required");
  }
  return sessionKey.trim();
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
