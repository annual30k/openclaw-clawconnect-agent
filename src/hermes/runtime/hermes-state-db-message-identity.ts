export type HermesStateDbMessageIdentityRole = "user" | "assistant" | "tool" | "system";

export function hermesStateDbMessageId(params: {
  sessionId: string;
  rowId: number | string;
  role: HermesStateDbMessageIdentityRole;
}): string {
  return `hermes-db-${params.sessionId}-message-${params.rowId}-${params.role}`;
}

export function hermesStateDbHistoryMessageId(params: {
  sessionId: string;
  rowId: number | string;
  role: HermesStateDbMessageIdentityRole;
  mobileRunId?: string;
}): string {
  const mobileRunId = params.mobileRunId?.trim();
  if (mobileRunId && (params.role === "user" || params.role === "assistant")) {
    return `${params.role}-${mobileRunId}`;
  }
  return hermesStateDbMessageId(params);
}
