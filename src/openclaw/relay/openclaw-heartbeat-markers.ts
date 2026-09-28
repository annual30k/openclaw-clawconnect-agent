/**
 * OpenClaw 内部心跳在 transcript 中留下的精确标记。
 *
 * 历史投影（chat-history）与实时转发（relay-manager）必须共用这一组精确匹配规则，
 * 否则同一轮次会出现“实时看不到、刷新后出现”或相反的漂移。禁止前缀 / 包含匹配：
 * 形似的用户文本（如 "[OpenClaw heartbeat poll] please explain"）和带附加内容的
 * 确认回复都是真实聊天内容，必须原样保留。
 */
const OPENCLAW_HEARTBEAT_PROMPT_TEXTS: ReadonlySet<string> = new Set([
  "[OpenClaw heartbeat poll]",
  "OpenClaw heartbeat poll",
]);

const OPENCLAW_HEARTBEAT_ACK_TEXTS: ReadonlySet<string> = new Set([
  "HEARTBEAT_OK",
  "HEARTBEAT OK",
]);

export function normalizeOpenClawHeartbeatMarkerText(text: string | undefined): string {
  return (text ?? "").replace(/\r/g, "").trim();
}

/** 用户侧提示是否恰好是 OpenClaw 的心跳轮询标记。 */
export function isOpenClawHeartbeatPromptText(text: string | undefined): boolean {
  return OPENCLAW_HEARTBEAT_PROMPT_TEXTS.has(normalizeOpenClawHeartbeatMarkerText(text));
}

/** 助手回复是否恰好是纯确认回执（不含任何附加告警文本）。 */
export function isOpenClawHeartbeatAckText(text: string | undefined): boolean {
  return OPENCLAW_HEARTBEAT_ACK_TEXTS.has(normalizeOpenClawHeartbeatMarkerText(text));
}

export interface OpenClawHeartbeatChatEventInput {
  /** 触发该运行的用户提示；网关自行发起的运行可能没有。 */
  promptText?: string;
  /** 事件携带的累计助手文本。 */
  assistantText?: string;
  /** 规范化后的聊天事件状态，例如 delta / final / error / aborted。 */
  chatState: string;
}

/**
 * 实时聊天事件是否属于应当对移动端隐藏的心跳内部过程。
 *
 * 与历史过滤保持一致：
 * - 已知用户提示且不是心跳标记 => 真实聊天轮次，绝不隐藏（即使助手恰好回复 HEARTBEAT_OK）。
 * - 心跳轮次的流式片段、失败 / 中止终态、空 final 以及纯确认 final => 隐藏。
 * - 心跳轮次里带有非确认文本的 final 是真实告警，历史会保留，实时同样必须发布。
 * - 提示未知时只隐藏恰好等于确认回执的文本。
 */
export function shouldSuppressOpenClawHeartbeatChatEvent(input: OpenClawHeartbeatChatEventInput): boolean {
  const promptText = normalizeOpenClawHeartbeatMarkerText(input.promptText);
  if (promptText.length > 0 && !isOpenClawHeartbeatPromptText(promptText)) {
    return false;
  }
  if (isOpenClawHeartbeatAckText(input.assistantText)) {
    return true;
  }
  if (promptText.length === 0) {
    return false;
  }
  if (input.chatState !== "final") {
    return true;
  }
  return normalizeOpenClawHeartbeatMarkerText(input.assistantText).length === 0;
}
