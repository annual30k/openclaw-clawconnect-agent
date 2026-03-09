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
export declare function withReconnect(connect: () => Promise<boolean>, opts?: ReconnectOptions): Promise<void>;
