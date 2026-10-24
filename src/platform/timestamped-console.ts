const PATCHED_METHODS = ["log", "info", "warn", "error", "debug"] as const;
const PATCHED_MARK = Symbol.for("clawconnect.timestampedConsole");

type PatchedMethod = (typeof PATCHED_METHODS)[number];
type ConsoleTarget = Pick<Console, PatchedMethod>;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * 带本地时区偏移的 ISO 8601 时间戳（例如 2026-10-22T11:55:03.123+08:00）。
 * 不使用 UTC：运维直接在本机看日志，UTC 与本地时间混用会让故障时间线难以对齐。
 */
export function formatLogTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
    + `${sign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;
}

/**
 * 给常驻进程的控制台输出统一加时间戳前缀。
 * - 首个参数是字符串时拼进该字符串，保留 `%s` 等格式化占位符的语义；否则前缀作为独立参数。
 * - `status` 只用 includes / 子串匹配解析日志，前缀不影响健康判断。
 * - 幂等：重复安装不会叠加前缀。
 */
export function installTimestampedConsole(
  target: ConsoleTarget = console,
  now: () => Date = () => new Date(),
): void {
  const marked = target as unknown as Record<symbol, boolean>;
  if (marked[PATCHED_MARK]) return;
  marked[PATCHED_MARK] = true;

  for (const method of PATCHED_METHODS) {
    const original = target[method].bind(target) as (...args: unknown[]) => void;
    target[method] = (...args: unknown[]): void => {
      const prefix = `[${formatLogTimestamp(now())}]`;
      if (typeof args[0] === "string") {
        original(`${prefix} ${args[0]}`, ...args.slice(1));
        return;
      }
      original(prefix, ...args);
    };
  }
}
