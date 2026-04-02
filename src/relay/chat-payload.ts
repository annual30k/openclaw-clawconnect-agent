const ASSISTANT_CHAT_STATES = new Set([
  "delta",
  "streaming",
  "in_progress",
  "final",
  "done",
  "completed",
  "complete",
  "error",
  "failed",
  "fail",
  "aborted",
]);

export function normalizeChatEventPayload(rawPayload: unknown): unknown {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return rawPayload;
  }
  const payload = { ...(rawPayload as Record<string, unknown>) };
  const stateRaw = typeof payload.state === "string" ? payload.state.trim().toLowerCase() : "";
  const phaseRaw = typeof payload.phase === "string" ? payload.phase.trim().toLowerCase() : "";
  const hasState = stateRaw.length > 0;

  if (!hasState && phaseRaw) {
    if (phaseRaw.includes("delta") || phaseRaw.includes("stream")) {
      payload.state = "delta";
    } else if (phaseRaw.includes("final") || phaseRaw.includes("complete") || phaseRaw.includes("done")) {
      payload.state = "final";
    } else if (phaseRaw.includes("error") || phaseRaw.includes("fail")) {
      payload.state = "error";
    }
  }

  const resolvedTimestamp =
    normalizeTimestamp(payload.ts)
    ?? normalizeTimestamp(payload.timestamp)
    ?? normalizeTimestamp(
      payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)
        ? (payload.message as Record<string, unknown>).timestamp
        : undefined,
    );
  if (resolvedTimestamp !== undefined) {
    payload.ts = resolvedTimestamp;
  }

  const hasMessage = payload.message && typeof payload.message === "object" && !Array.isArray(payload.message);
  const text = typeof payload.text === "string" ? payload.text : undefined;
  const delta = typeof payload.delta === "string" ? payload.delta : undefined;
  const streamText = text ?? delta;
  if (!hasMessage && streamText && streamText.length > 0) {
    const role = typeof payload.role === "string" && payload.role.trim() ? payload.role.trim() : undefined;
    payload.message = {
      ...(role ? { role } : {}),
      ...(resolvedTimestamp !== undefined ? { timestamp: resolvedTimestamp } : {}),
      content: [{ type: "text", text: streamText }],
    };
  }

  return payload;
}

export function extractChatText(rawPayload: unknown): string {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return "";
  }
  const payload = rawPayload as Record<string, unknown>;
  const message =
    payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)
      ? (payload.message as Record<string, unknown>)
      : undefined;
  const content = Array.isArray(message?.content) ? message?.content : [];
  const blockText = content.find((block) => {
    return Boolean(block) && typeof block === "object" && !Array.isArray(block) && (block as Record<string, unknown>).type === "text";
  }) as Record<string, unknown> | undefined;
  if (typeof blockText?.text === "string" && blockText.text.trim().length > 0) {
    return blockText.text;
  }
  if (typeof payload.text === "string" && payload.text.trim().length > 0) {
    return payload.text;
  }
  if (typeof payload.delta === "string" && payload.delta.trim().length > 0) {
    return payload.delta;
  }
  const data =
    payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : undefined;
  if (typeof data?.text === "string" && data.text.trim().length > 0) {
    return data.text;
  }
  if (typeof data?.delta === "string" && data.delta.trim().length > 0) {
    return data.delta;
  }
  return "";
}

export function normalizeChatState(rawPayload: unknown): string {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return "";
  }
  const payload = rawPayload as Record<string, unknown>;
  const data =
    payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : undefined;
  const rawState =
    typeof payload.state === "string" ? payload.state
      : typeof payload.phase === "string" ? payload.phase
        : typeof data?.phase === "string" ? data.phase
          : "";
  return rawState.trim().toLowerCase();
}

export function extractChatRole(rawPayload: unknown): string {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return "";
  }
  const payload = rawPayload as Record<string, unknown>;
  if (typeof payload.role === "string" && payload.role.trim()) {
    return payload.role.trim().toLowerCase();
  }
  const message =
    payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)
      ? (payload.message as Record<string, unknown>)
      : undefined;
  if (typeof message?.role === "string" && message.role.trim()) {
    return message.role.trim().toLowerCase();
  }
  return ASSISTANT_CHAT_STATES.has(normalizeChatState(rawPayload)) ? "assistant" : "";
}

export function withMessageText(rawPayload: unknown, text: string): unknown {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload) || !text.trim()) {
    return rawPayload;
  }
  const payload = { ...(rawPayload as Record<string, unknown>) };
  const existingMessage =
    payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)
      ? (payload.message as Record<string, unknown>)
      : undefined;
  const timestamp =
    typeof payload.ts === "number" && Number.isFinite(payload.ts) && payload.ts > 0
      ? payload.ts
      : typeof existingMessage?.timestamp === "number" && Number.isFinite(existingMessage.timestamp) && existingMessage.timestamp > 0
        ? existingMessage.timestamp
        : undefined;
  payload.message = {
    ...(typeof existingMessage?.role === "string" && existingMessage.role.trim() ? { role: existingMessage.role.trim() } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    content: [{ type: "text", text }],
  };
  if (timestamp !== undefined && payload.ts === undefined) {
    payload.ts = timestamp;
  }
  return payload;
}

export function appendUniqueSuffix(base: string, suffix: string): string {
  if (!suffix) {
    return base;
  }
  if (!base) {
    return suffix;
  }
  if (base.endsWith(suffix)) {
    return base;
  }
  const maxOverlap = Math.min(base.length, suffix.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (base.slice(-overlap) === suffix.slice(0, overlap)) {
      return base + suffix.slice(overlap);
    }
  }
  return base + suffix;
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value > 10_000_000_000 ? value : value * 1000);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed > 10_000_000_000 ? parsed : parsed * 1000);
    }
  }
  return undefined;
}
