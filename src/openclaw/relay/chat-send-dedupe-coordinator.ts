import {
  dedupeOpenClawChatSendUserMirrorTranscript,
  type ChatSendUserMirrorDedupeRequest,
} from "./transcript-dedupe.js";
import {
  canonicalizeSessionKey,
  type GatewaySessionDefaults,
} from "./session-context.js";

const CHAT_SEND_MIRROR_DEDUPE_RETRY_DELAYS_MS = [250, 1000, 2500, 5000, 10000, 20000, 30000];

export class OpenClawChatSendDedupeCoordinator {
  private readonly requests = new Map<string, ChatSendUserMirrorDedupeRequest>();
  private readonly runKeys = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<string, number>();
  private readonly running = new Map<string, Promise<boolean>>();

  // OpenClaw 本地 transcript 写入和 relay 回包不是同一事务，必须用 clientRunId 做确定性去重键，
  // 通过有限重试等待落盘；不能用文本相同或时间接近来合并消息。
  constructor(private readonly getSessionDefaults: () => GatewaySessionDefaults) {}

  register(request: ChatSendUserMirrorDedupeRequest, runId?: string): void {
    this.requests.set(request.clientRunId, request);
    if (runId) {
      this.runKeys.set(runId, request.clientRunId);
    }
    this.schedule(request.clientRunId);
  }

  scheduleForRun(runId: string, delayMs = 100): void {
    const clientRunId = this.runKeys.get(runId);
    if (!clientRunId) {
      return;
    }
    this.schedule(clientRunId, delayMs);
  }

  async dedupePendingForSession(rawParams: unknown): Promise<void> {
    const sessionKey = this.resolveRawParamsSessionKey(rawParams);
    const pending = Array.from(this.requests.entries()).filter(([, request]) => {
      const requestSessionKey = canonicalizeSessionKey(
        request.sessionKey ?? this.getSessionDefaults().mainSessionKey,
        this.getSessionDefaults(),
      );
      return requestSessionKey === sessionKey;
    });
    for (const [clientRunId] of pending) {
      await this.runAttempt(clientRunId);
    }
  }

  buildRequest(paramsRecord: Record<string, unknown> | undefined): ChatSendUserMirrorDedupeRequest | undefined {
    if (!paramsRecord) {
      return undefined;
    }
    const message = typeof paramsRecord.message === "string" && paramsRecord.message.trim().length > 0
      ? paramsRecord.message.trim()
      : "";
    const idempotencyKey = typeof paramsRecord.idempotencyKey === "string" && paramsRecord.idempotencyKey.trim().length > 0
      ? paramsRecord.idempotencyKey.trim()
      : "";
    if (!message || !idempotencyKey) {
      return undefined;
    }
    const clientRunId = idempotencyKey.endsWith(":user")
      ? idempotencyKey.slice(0, -":user".length)
      : idempotencyKey;
    if (!clientRunId) {
      return undefined;
    }
    return {
      clientRunId,
      message,
      sessionKey: this.resolveRawParamsSessionKey(paramsRecord),
      senderId: "openclaw-macos",
      senderName: "ClawConnect Agent",
    };
  }

  clearAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.requests.clear();
    this.runKeys.clear();
    this.attempts.clear();
    this.running.clear();
  }

  private clear(clientRunId: string): void {
    const timer = this.timers.get(clientRunId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(clientRunId);
    }
    this.requests.delete(clientRunId);
    this.attempts.delete(clientRunId);
    for (const [runId, mappedClientRunId] of this.runKeys.entries()) {
      if (mappedClientRunId === clientRunId) {
        this.runKeys.delete(runId);
      }
    }
  }

  private schedule(clientRunId: string, delayOverrideMs?: number): void {
    if (!this.requests.has(clientRunId)) {
      return;
    }
    const existing = this.timers.get(clientRunId);
    if (existing) {
      clearTimeout(existing);
    }
    const attempt = this.attempts.get(clientRunId) ?? 0;
    const delayMs = delayOverrideMs ?? CHAT_SEND_MIRROR_DEDUPE_RETRY_DELAYS_MS[Math.min(
      attempt,
      CHAT_SEND_MIRROR_DEDUPE_RETRY_DELAYS_MS.length - 1,
    )];
    const timer = setTimeout(() => {
      this.timers.delete(clientRunId);
      void this.runAttempt(clientRunId).then((changed) => {
        if (changed || !this.requests.has(clientRunId)) {
          return;
        }
        const nextAttempt = attempt + 1;
        if (nextAttempt >= CHAT_SEND_MIRROR_DEDUPE_RETRY_DELAYS_MS.length) {
          this.clear(clientRunId);
          return;
        }
        this.attempts.set(clientRunId, nextAttempt);
        this.schedule(clientRunId);
      });
    }, delayMs);
    timer.unref?.();
    this.timers.set(clientRunId, timer);
  }

  private async runAttempt(clientRunId: string): Promise<boolean> {
    const running = this.running.get(clientRunId);
    if (running) {
      return running;
    }

    const promise = (async () => {
      const request = this.requests.get(clientRunId);
      if (!request) {
        return false;
      }
      try {
        const result = await dedupeOpenClawChatSendUserMirrorTranscript(request, this.getSessionDefaults(), { maxRetries: 2 });
        if (result.changed) {
          console.log(`[relay] removed ${result.removedCount} duplicate OpenClaw prompt mirror(s) from ${result.transcriptPath ?? "transcript"}`);
          this.clear(clientRunId);
          return true;
        }
      } catch (error) {
        console.warn(`[relay] chat.send transcript dedupe failed runId=${clientRunId}: ${String(error)}`);
      }
      return false;
    })().finally(() => {
      this.running.delete(clientRunId);
    });

    this.running.set(clientRunId, promise);
    return promise;
  }

  private resolveRawParamsSessionKey(rawParams: unknown): string {
    const sessionDefaults = this.getSessionDefaults();
    const record = rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
      ? (rawParams as Record<string, unknown>)
      : {};
    const rawSessionKey =
      typeof record.sessionKey === "string" && record.sessionKey.trim().length > 0
        ? record.sessionKey.trim()
        : sessionDefaults.mainSessionKey;
    const normalized = canonicalizeSessionKey(rawSessionKey, sessionDefaults);
    return typeof normalized === "string" && normalized.trim().length > 0
      ? normalized.trim()
      : sessionDefaults.mainSessionKey;
  }
}
