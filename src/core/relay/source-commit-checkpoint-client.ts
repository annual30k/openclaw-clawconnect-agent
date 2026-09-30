import { randomUUID } from "node:crypto";
import type { SourceCommit } from "./source-commit.js";

/** Relay 在 hello 中声明该能力后才支持按持久化水位续传。 */
export const RELAY_SOURCE_COMMIT_RESUME_CAPABILITY = "source_commit_resume_v1";
export const SOURCE_COMMIT_CHECKPOINT_QUERY_TYPE = "source_commit_checkpoint_query";
export const SOURCE_COMMIT_CHECKPOINT_RESPONSE_TYPE = "source_commit_checkpoint";
/** 仅用于连接存活：超时后本次解析失败，由下一次源通知重试；不参与任何顺序判定。 */
export const SOURCE_COMMIT_CHECKPOINT_QUERY_TIMEOUT_MS = 30_000;

export type SourceCommitCheckpointQuery = {
  type: typeof SOURCE_COMMIT_CHECKPOINT_QUERY_TYPE;
  requestId: string;
  scope: Pick<SourceCommit, "gatewayType" | "producerId" | "sourceSessionId" | "sourceOrderScope" | "sourceGeneration">;
};

export type SourceCommitCheckpointResponse = {
  type: typeof SOURCE_COMMIT_CHECKPOINT_RESPONSE_TYPE;
  requestId: string;
  status: "found" | "missing" | "owner_mismatch" | "invalid_request";
  committedThroughSeq?: number;
};

type PendingQuery = {
  resolve: (watermark: number | undefined) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type SourceCommitCheckpointClientOptions = {
  /** 直接写入当前 Relay socket；返回 false 表示本次未能写出。 */
  send: (query: SourceCommitCheckpointQuery) => boolean;
  timeoutMs?: number;
  createRequestId?: () => string;
};

export function isSourceCommitCheckpointResponse(value: unknown): value is SourceCommitCheckpointResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === SOURCE_COMMIT_CHECKPOINT_RESPONSE_TYPE
    && typeof record.requestId === "string"
    && typeof record.status === "string";
}

/**
 * 单条 Relay 连接内的源投影水位查询客户端。
 *
 * - hello 协商完成前的查询会等待协商结果，保证续传决策基于本连接对端的真实能力；
 * - 旧 Relay 不支持续传时返回 `undefined`，调用方按原语义从序号 0 投影（向后兼容）；
 * - `missing` 表示 Relay 没有该作用域的投影，同样从 0 开始；
 * - 归属冲突、非法请求、写失败、超时和连接关闭一律抛错：起点未知时绝不猜测。
 */
export function createSourceCommitCheckpointClient(options: SourceCommitCheckpointClientOptions) {
  const timeoutMs = options.timeoutMs ?? SOURCE_COMMIT_CHECKPOINT_QUERY_TIMEOUT_MS;
  const createRequestId = options.createRequestId ?? (() => `source-checkpoint-${randomUUID()}`);
  const pending = new Map<string, PendingQuery>();
  let closedError: Error | undefined;
  let resolveNegotiation!: (supported: boolean) => void;
  let rejectNegotiation!: (error: Error) => void;
  const negotiation = new Promise<boolean>((resolve, reject) => {
    resolveNegotiation = resolve;
    rejectNegotiation = reject;
  });
  // 连接在协商前关闭时，没有等待者也不能产生未处理的 rejection。
  negotiation.catch(() => undefined);

  const query = (cursor: SourceCommit): Promise<number | undefined> => new Promise((resolve, reject) => {
    if (closedError) {
      reject(closedError);
      return;
    }
    const requestId = createRequestId();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`source commit checkpoint query timed out scope=${cursor.sourceOrderScope}`));
    }, timeoutMs);
    timer.unref?.();
    pending.set(requestId, { resolve, reject, timer });
    const sent = options.send({
      type: SOURCE_COMMIT_CHECKPOINT_QUERY_TYPE,
      requestId,
      scope: {
        gatewayType: cursor.gatewayType,
        producerId: cursor.producerId,
        sourceSessionId: cursor.sourceSessionId,
        sourceOrderScope: cursor.sourceOrderScope,
        sourceGeneration: cursor.sourceGeneration,
      },
    });
    if (!sent) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(new Error("source commit checkpoint query was not sent"));
    }
  });

  return {
    /** hello 协商完成时调用一次；重复调用无副作用。 */
    markRelayHello(protocolCapabilities: unknown): void {
      const capabilities = Array.isArray(protocolCapabilities) ? protocolCapabilities : [];
      resolveNegotiation(capabilities.includes(RELAY_SOURCE_COMMIT_RESUME_CAPABILITY));
    },

    async resolveWatermark(cursor: SourceCommit): Promise<number | undefined> {
      const supported = await negotiation;
      if (!supported) return undefined;
      return query(cursor);
    },

    /** 返回 true 表示该帧是水位查询响应并已处理。 */
    handleResponse(message: unknown): boolean {
      if (!isSourceCommitCheckpointResponse(message)) return false;
      const entry = pending.get(message.requestId);
      if (!entry) return true;
      pending.delete(message.requestId);
      clearTimeout(entry.timer);
      if (message.status === "missing") {
        entry.resolve(undefined);
        return true;
      }
      const seq = message.committedThroughSeq;
      if (message.status === "found" && typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0) {
        entry.resolve(seq);
        return true;
      }
      entry.reject(new Error(`source commit checkpoint query failed status=${message.status}`));
      return true;
    },

    close(reason = "relay connection closed"): void {
      if (closedError) return;
      closedError = new Error(`source commit checkpoint client closed: ${reason}`);
      rejectNegotiation(closedError);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(closedError);
      }
      pending.clear();
    },
  };
}

export type SourceCommitCheckpointClient = ReturnType<typeof createSourceCommitCheckpointClient>;
