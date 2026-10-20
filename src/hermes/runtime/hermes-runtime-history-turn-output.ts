// Hermes 历史投影的"本轮最终回答"决策：与实时路径共用 resolveHermesTurnOutput，保证刷新前后一致。
import { resolveHermesTurnOutput } from "./hermes-runtime-chat-file-transfer.js";
import {
  hermesSourceRunIdFromMessage,
  isTerminalHermesAssistantMessage,
} from "./hermes-runtime-history-completion.js";

export type HermesAssistantRowDecision =
  /** 非 ClawConnect 移动端轮次，或该轮没有 typed 结论：沿用原始行正文。 */
  | { kind: "raw" }
  /** 该轮已有 typed 结论，而这是非最后一个终态助手行：原始散文不可展示。 */
  | { kind: "drop" }
  /** 该轮已有 typed 结论，而这是最后一个终态助手行：用 typed 文本承载，保留该行的稳定身份与顺序。 */
  | { kind: "typed"; text: string };

function roleOf(row: Record<string, unknown>): string {
  return typeof row.role === "string" ? row.role.trim().toLowerCase() : "";
}

function isSameRow(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  if (left === right) return true;
  return left.id !== undefined && left.id !== null && right.id !== undefined && right.id !== null
    && String(left.id) === String(right.id);
}

/**
 * 决定一条终态助手行在移动端历史里应展示什么。
 *
 * 模型在 outcome 工具之后补的收尾散文（"已发送 ✅"、"补充：……"）与 typed assistantText 经常不一致，
 * 实时路径只展示 typed 结论，历史也必须一样，否则刷新会把真正的回答换成收尾话。
 * 判定只依赖结构化事实：该轮用户行里的 sourceRunId、同一轮内的 typed outcome / send-file 回执，
 * 不做任何文本相似度或关键词判断。
 *
 * @param turnRows 该助手行所在用户轮次的全部有效行（用户行在最前）。
 */
export function decideHermesAssistantRow(
  row: Record<string, unknown>,
  turnRows: Array<Record<string, unknown>>,
): HermesAssistantRowDecision {
  const userRow = turnRows.find((candidate) => roleOf(candidate) === "user");
  const sourceRunId = userRow ? hermesSourceRunIdFromMessage(userRow) : undefined;
  if (!sourceRunId) {
    return { kind: "raw" };
  }
  const output = resolveHermesTurnOutput(turnRows, sourceRunId);
  if (output.kind === "none") {
    return { kind: "raw" };
  }
  const terminalRows = turnRows.filter(
    (candidate) => roleOf(candidate) === "assistant" && isTerminalHermesAssistantMessage(candidate),
  );
  const lastTerminal = terminalRows[terminalRows.length - 1];
  if (!lastTerminal || !isSameRow(row, lastTerminal)) {
    return { kind: "drop" };
  }
  return { kind: "typed", text: output.text };
}

/**
 * 在完整的原始行序列（导出回退路径）里，为每个下标计算其所在用户轮次的行。
 * 一次 O(n) 预计算，避免每个助手行都重新扫描整个会话。
 */
export function buildHermesTurnRowResolver(
  records: Array<Record<string, unknown>>,
): (index: number) => Array<Record<string, unknown>> {
  const previousUser: number[] = new Array(records.length).fill(-1);
  const nextUser: number[] = new Array(records.length).fill(records.length);
  let lastUser = -1;
  records.forEach((record, index) => {
    if (roleOf(record) === "user") lastUser = index;
    previousUser[index] = lastUser;
  });
  let upcomingUser = records.length;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    nextUser[index] = upcomingUser;
    if (roleOf(records[index]) === "user") upcomingUser = index;
  }
  return (index) => records.slice(Math.max(previousUser[index], 0), nextUser[index]);
}
