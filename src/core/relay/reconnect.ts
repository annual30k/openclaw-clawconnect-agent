export interface ReconnectOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
}

export interface ReconnectSession {
  /**
   * 连接完成 Relay 握手后调用。之后这条连接再断开时，下一次重试从初始退避重新计数，
   * 而不是沿用之前累积到上限的等待时间。
   */
  markEstablished(): void;
}

/**
 * Implements exponential backoff: 500ms → 1s → 2s → ... → 30s cap.
 * Calls `connect` repeatedly until `connect` returns false (permanent failure)
 * or the loop is aborted.
 *
 * The `connect` callback should return `true` if it attempted a connection
 * and `false` if it should stop retrying. It must call
 * `session.markEstablished()` once the Relay handshake succeeded so that a
 * later drop restarts the backoff from `initialDelayMs`; attempts that never
 * reach the handshake keep growing the delay up to `maxDelayMs`.
 */
export async function withReconnect(
  connect: (session: ReconnectSession) => Promise<boolean>,
  opts: ReconnectOptions = {}
): Promise<void> {
  const initialDelay = opts.initialDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 30_000;
  let attempt = 0;
  let delay = initialDelay;

  while (true) {
    if (opts.signal?.aborted) break;
    let established = false;
    const shouldRetry = await connect({
      markEstablished: () => {
        established = true;
      },
    });
    if (!shouldRetry || opts.signal?.aborted) break;

    // 握手成功过的连接断开属于新的故障周期：退避从头开始，
    // 否则长期运行的进程每次掉线都会先等满上限才重连。
    if (established) {
      attempt = 0;
      delay = initialDelay;
    }

    attempt++;
    opts.onRetry?.(attempt, delay);
    if (!await sleep(delay, opts.signal)) break;
    delay = Math.min(delay * 2, maxDelay);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    // 退避期间进程里可能没有任何其他活动句柄，这个定时器必须保持事件循环存活；
    // 一旦 unref，Node 会在等待中途直接退出，重连循环永远到不了第二次尝试
    //（后台服务表现为被 launchd/systemd 反复拉起，而不是进程内重连）。
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
