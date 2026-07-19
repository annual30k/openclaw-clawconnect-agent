import { createHash } from "node:crypto";

const DEFAULT_TERMINAL_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_TERMINAL_ENTRIES = 512;

export interface ChatSendIdempotencyRequest {
  gatewayId: string;
  sessionKey: string;
  idempotencyKey: string;
  fingerprint: string;
}

export type ChatSendTerminalResult =
  | { status: "completed" }
  | { status: "failed"; error: unknown }
  | { status: "released" };

export type ChatSendIdempotencyClaim<T> =
  | {
    status: "started";
    promise: Promise<T>;
    terminal: Promise<ChatSendTerminalResult>;
    accept: (value: T) => void;
    complete: (error?: unknown) => void;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
    release: () => void;
  }
  | {
    status: "reused";
    promise: Promise<T>;
    terminal: Promise<ChatSendTerminalResult>;
  };

type ChatSendIdempotencyEntry<T> = {
  fingerprint: string;
  promise: Promise<T>;
  terminal: Promise<ChatSendTerminalResult>;
  settledAtMs?: number;
};

export class ChatSendIdempotencyConflictError extends Error {
  constructor() {
    super("chat_send_idempotency_conflict");
    this.name = "ChatSendIdempotencyConflictError";
  }
}

/**
 * Relay 可能在响应丢失后重投 chat.send。这里用客户端稳定幂等键挡住第二次模型调用，
 * 并短期保留成功或失败结果；同一个键若对应不同请求则必须显式拒绝，不能猜测合并。
 */
export class ChatSendIdempotencyGuard<T> {
  private readonly entries = new Map<string, ChatSendIdempotencyEntry<T>>();
  private readonly terminalTtlMs: number;
  private readonly maxTerminalEntries: number;
  private readonly now: () => number;

  constructor(options?: {
    terminalTtlMs?: number;
    maxTerminalEntries?: number;
    now?: () => number;
  }) {
    this.terminalTtlMs = Math.max(0, options?.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS);
    this.maxTerminalEntries = Math.max(1, options?.maxTerminalEntries ?? DEFAULT_MAX_TERMINAL_ENTRIES);
    this.now = options?.now ?? Date.now;
  }

  claim(request: ChatSendIdempotencyRequest): ChatSendIdempotencyClaim<T> {
    this.prune();
    const key = buildExecutionKey(request);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== request.fingerprint) {
        throw new ChatSendIdempotencyConflictError();
      }
      return { status: "reused", promise: existing.promise, terminal: existing.terminal };
    }

    let resolvePromise!: (value: T) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    let resolveTerminal!: (result: ChatSendTerminalResult) => void;
    const terminalPromise = new Promise<ChatSendTerminalResult>((resolve) => {
      resolveTerminal = resolve;
    });
    // 终态失败也要进入短期缓存；内部观察拒绝，避免首次请求没有复用方时产生未处理拒绝。
    void promise.catch(() => undefined);

    const entry: ChatSendIdempotencyEntry<T> = {
      fingerprint: request.fingerprint,
      promise,
      terminal: terminalPromise,
    };
    this.entries.set(key, entry);
    let responseSettled = false;
    let terminal = false;
    const settleResponse = (callback: () => void): void => {
      if (responseSettled) {
        return;
      }
      responseSettled = true;
      callback();
    };
    const markTerminal = (result: ChatSendTerminalResult): void => {
      if (terminal) {
        return;
      }
      terminal = true;
      resolveTerminal(result);
      entry.settledAtMs = this.now();
      this.pruneTerminalLimit();
    };

    return {
      status: "started",
      promise,
      terminal: terminalPromise,
      // Hermes 必须先回 accepted 再执行可能很长的模型调用；accept 只固定响应，
      // complete 才启动终态 TTL，避免长回答期间缓存过期后重跑模型。
      accept: (value) => settleResponse(() => resolvePromise(value)),
      complete: (error) => markTerminal(error === undefined
        ? { status: "completed" }
        : { status: "failed", error }),
      resolve: (value) => {
        settleResponse(() => resolvePromise(value));
        markTerminal({ status: "completed" });
      },
      reject: (error) => {
        settleResponse(() => rejectPromise(error));
        markTerminal({ status: "failed", error });
      },
      release: () => {
        if (this.entries.get(key) !== entry || terminal) {
          return;
        }
        this.entries.delete(key);
        settleResponse(() => rejectPromise(new Error("chat_send_idempotency_released")));
        terminal = true;
        resolveTerminal({ status: "released" });
      },
    };
  }

  execute(
    request: ChatSendIdempotencyRequest,
    start: () => Promise<T>,
  ): { status: "started" | "reused"; promise: Promise<T> } {
    const claim = this.claim(request);
    if (claim.status === "started") {
      void Promise.resolve()
        .then(start)
        .then(claim.resolve, claim.reject);
    }
    return { status: claim.status, promise: claim.promise };
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(): void {
    const expirationBoundaryMs = this.now() - this.terminalTtlMs;
    for (const [key, entry] of this.entries.entries()) {
      if (entry.settledAtMs !== undefined && entry.settledAtMs <= expirationBoundaryMs) {
        this.entries.delete(key);
      }
    }
    this.pruneTerminalLimit();
  }

  private pruneTerminalLimit(): void {
    const terminalEntries = Array.from(this.entries.entries())
      .filter(([, entry]) => entry.settledAtMs !== undefined)
      .sort((left, right) => (left[1].settledAtMs ?? 0) - (right[1].settledAtMs ?? 0));
    const excessCount = terminalEntries.length - this.maxTerminalEntries;
    for (let index = 0; index < excessCount; index += 1) {
      const key = terminalEntries[index]?.[0];
      if (key) {
        this.entries.delete(key);
      }
    }
  }
}

export function buildChatSendIdempotencyRequest(params: {
  gatewayId: string;
  sessionKey: string;
  idempotencyKey: unknown;
  payload: unknown;
}): ChatSendIdempotencyRequest | undefined {
  const gatewayId = params.gatewayId.trim();
  const sessionKey = params.sessionKey.trim();
  const idempotencyKey = typeof params.idempotencyKey === "string"
    ? params.idempotencyKey.trim()
    : "";
  if (!gatewayId || !sessionKey || !idempotencyKey) {
    return undefined;
  }
  return {
    gatewayId,
    sessionKey,
    idempotencyKey,
    fingerprint: createHash("sha256")
      .update(canonicalJson(params.payload))
      .digest("hex"),
  };
}

export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const serialize = (current: unknown, inArray = false): string | undefined => {
    if (current === null) {
      return "null";
    }
    if (typeof current === "string" || typeof current === "boolean") {
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      return Number.isFinite(current) ? JSON.stringify(current) : "null";
    }
    if (typeof current === "bigint") {
      return JSON.stringify(current.toString());
    }
    if (typeof current === "undefined" || typeof current === "function" || typeof current === "symbol") {
      return inArray ? "null" : undefined;
    }
    if (typeof current !== "object") {
      return JSON.stringify(String(current));
    }
    if (seen.has(current)) {
      throw new TypeError("chat_send_idempotency_payload_is_cyclic");
    }
    seen.add(current);
    let serialized: string;
    if (Array.isArray(current)) {
      serialized = `[${current.map((item) => serialize(item, true) ?? "null").join(",")}]`;
    } else {
      const fields = Object.keys(current as Record<string, unknown>)
        .sort()
        .flatMap((key) => {
          const field = serialize((current as Record<string, unknown>)[key]);
          return field === undefined ? [] : [`${JSON.stringify(key)}:${field}`];
        });
      serialized = `{${fields.join(",")}}`;
    }
    seen.delete(current);
    return serialized;
  };
  return serialize(value) ?? "null";
}

function buildExecutionKey(request: ChatSendIdempotencyRequest): string {
  return canonicalJson([
    request.gatewayId,
    request.sessionKey,
    request.idempotencyKey,
  ]);
}
