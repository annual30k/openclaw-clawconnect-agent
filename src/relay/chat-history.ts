export type HistoryMessage = {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  timestamp?: number;
  stopReason?: string;
  errorMessage?: string;
};

export type HistoryResponse = {
  sessionKey?: string;
  sessionId?: string;
  messages?: HistoryMessage[];
};

export type ChatHistoryOutcome =
  | { kind: "final"; text: string }
  | { kind: "error"; errorMessage: string }
  | null;

export type ChatRunContext = {
  sessionKey: string;
  requestedAtMs: number;
  promptText?: string;
};

export function extractHistoryOutcome(
  history: HistoryResponse | undefined,
  context: ChatRunContext,
): ChatHistoryOutcome {
  const messages = history?.messages ?? [];
  if (messages.length === 0) {
    return null;
  }

  const userIndex = findHistoryUserIndex(messages, context);
  if (userIndex === -1) {
    return null;
  }

  let latestError: string | null = null;
  for (let index = userIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "assistant") {
      continue;
    }
    const text = extractHistoryMessageText(message);
    if (text.length > 0) {
      return { kind: "final", text };
    }
    if (
      typeof message.errorMessage === "string" &&
      message.errorMessage.trim().length > 0 &&
      (message.stopReason === "error" || !message.stopReason)
    ) {
      latestError = message.errorMessage.trim();
    }
  }

  return latestError ? { kind: "error", errorMessage: latestError } : null;
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function extractHistoryMessageText(message: HistoryMessage | undefined): string {
  const content = Array.isArray(message?.content) ? message.content : [];
  const parts = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text?.trim() ?? "")
    .filter((text) => text.length > 0);
  return parts.join("\n\n");
}

function findHistoryUserIndex(messages: HistoryMessage[], context: ChatRunContext): number {
  const normalizedPrompt = context.promptText?.trim();
  const notBeforeMs = context.requestedAtMs - 1_000;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") {
      continue;
    }
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : Number.NaN;
    if (Number.isFinite(timestamp) && timestamp < notBeforeMs) {
      continue;
    }
    const text = extractHistoryMessageText(message);
    if (!normalizedPrompt || text === normalizedPrompt) {
      return index;
    }
  }

  return -1;
}
