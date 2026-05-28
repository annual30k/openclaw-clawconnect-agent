export interface ReconnectOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, delayMs: number) => void;
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
    const shouldRetry = await connect();
    if (!shouldRetry) break;

    attempt++;
    opts.onRetry?.(attempt, delay);
    await sleep(delay);
    delay = Math.min(delay * 2, maxDelay);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
