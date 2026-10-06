import { createHash } from "node:crypto";
import type { SourceCommit } from "./source-commit.js";

/**
 * 源投影分页大小。Relay 对每一行投影都要做查重、排序绑定、账本与同步日志写入，
 * 单帧行数越多，排在它后面的命令响应等得越久。20 行在 Relay 上约 0.1 秒（数据库部分），
 * 配合下方的单帧流控，补齐期间命令响应实测 p95 < 0.4 秒。
 */
export const SOURCE_COMMIT_PAGE_LIMIT = 20;
/** 只用于连接存活：Relay 迟迟不确认时放弃本页，由下一次源通知重试；不参与顺序判定。 */
export const SOURCE_COMMIT_ACK_TIMEOUT_MS = 60_000;
const DELIVERY_ID_PREFIX = "source-commit-";

/**
 * 源投影帧的投递 ID：同一页（同一作用域、同一水位、同一组事件）永远得到同一个 ID，
 * 重放时 Relay 收到的是同一身份；不同页绝不碰撞。
 */
export function sourceCommitDeliveryId(
  commit: Pick<SourceCommit, "gatewayId" | "sourceOrderScope" | "sourceGeneration" | "committedThroughSeq" | "sourceRevision">,
  eventIds: readonly string[],
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([
      commit.gatewayId,
      commit.sourceOrderScope,
      commit.sourceGeneration,
      commit.committedThroughSeq,
      commit.sourceRevision,
      ...eventIds,
    ]))
    .digest("hex")
    .slice(0, 40);
  return `${DELIVERY_ID_PREFIX}${digest}`;
}

type AckWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type SourceCommitPublishFlowOptions = {
  /** 当前连接是否由 Relay 声明了事件确认（acknowledged 模式）；旧 Relay 不等待确认。 */
  isAcknowledged: () => boolean;
  ackTimeoutMs?: number;
};

/**
 * 单条 Relay 连接上的源投影流控。
 *
 * Relay 按网关串行处理宿主帧，源投影帧又是其中最重的一类。若所有会话同时补齐，
 * Relay 队列会堆满投影帧，命令响应只能排在后面而超时，确认超时又触发重连风暴。
 * 这里保证：任意时刻至多一个源投影帧在 Relay 队列中（全局 FIFO 闸门，按调用顺序执行），
 * 且下一帧必须等上一帧被 Relay 持久化确认后才发送。命令响应因此最多等待一帧。
 */
export function createSourceCommitPublishFlow(options: SourceCommitPublishFlowOptions) {
  const ackTimeoutMs = options.ackTimeoutMs ?? SOURCE_COMMIT_ACK_TIMEOUT_MS;
  const waiters = new Map<string, AckWaiter>();
  let gateTail: Promise<void> = Promise.resolve();
  let closedError: Error | undefined;

  function waitForAck(deliveryId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(deliveryId);
        reject(new Error(`source commit relay ack timed out deliveryId=${deliveryId}`));
      }, ackTimeoutMs);
      timer.unref?.();
      waiters.set(deliveryId, { resolve, reject, timer });
    });
  }

  async function publishNow(deliveryId: string, send: (deliveryId?: string) => Promise<void>): Promise<void> {
    if (closedError) throw closedError;
    if (!options.isAcknowledged()) {
      await send(undefined);
      return;
    }
    // 先登记再发送：确认可能在发送回调之前到达。
    const acknowledged = waitForAck(deliveryId);
    try {
      await send(deliveryId);
    } catch (error) {
      const waiter = waiters.get(deliveryId);
      if (waiter) {
        clearTimeout(waiter.timer);
        waiters.delete(deliveryId);
      }
      acknowledged.catch(() => undefined);
      throw error;
    }
    await acknowledged;
  }

  return {
    /** 按调用顺序串行执行；前一帧失败不阻塞后续帧，失败由各自的调用方处理。 */
    publish(deliveryId: string, send: (deliveryId?: string) => Promise<void>): Promise<void> {
      const run = gateTail.then(() => publishNow(deliveryId, send));
      gateTail = run.then(() => undefined, () => undefined);
      return run;
    },

    /** 收到 Relay 的 event_ack；返回 true 表示命中了等待中的源投影帧。 */
    acknowledge(deliveryId: string): boolean {
      const waiter = waiters.get(deliveryId);
      if (!waiter) return false;
      clearTimeout(waiter.timer);
      waiters.delete(deliveryId);
      waiter.resolve();
      return true;
    },

    close(reason = "relay connection closed"): void {
      if (closedError) return;
      closedError = new Error(`source commit publish flow closed: ${reason}`);
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(closedError);
      }
      waiters.clear();
    },

    pendingAckCount(): number {
      return waiters.size;
    },
  };
}

export type SourceCommitPublishFlow = ReturnType<typeof createSourceCommitPublishFlow>;
