export interface ReconnectOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
}

/**
 * Implements exponential backoff: 500ms → 1s → 2s → ... → 30s cap.
 * Calls `connect` repeatedly until `connect` returns false (permanent failure)
 * or the returned WebSocket connection stays alive.
 *
 * The `connect` callback should return `true` if it attempted a connection
 * and `false` if it should stop retrying.
 */
export async function withReconnect(
  connect: () => Promise<boolean>,
  opts: ReconnectOptions = {}
): Promise<void> {
  const initialDelay = opts.initialDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 30_000;
  let attempt = 0;
  let delay = initialDelay;

  while (true) {
    if (opts.signal?.aborted) break;
    const shouldRetry = await connect();
    if (!shouldRetry || opts.signal?.aborted) break;

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
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
