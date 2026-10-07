import { watch, type FSWatcher } from "node:fs";
import { dirname, basename } from "node:path";
import {
  createSourceCommitObserver,
  type SourceCommit,
  type SourceCommitWatermarkResolver,
} from "../../core/relay/source-commit.js";

export type OpenClawSourceCommitWatcher = {
  notify(): void;
  rescan(): void;
  close(): void;
};

/**
 * SQLite/WAL notifications are only wake-up signals. The caller supplies an
 * authoritative cursor reader, which is read synchronously in a serialized
 * observer. Watching both the database directory and the database file keeps
 * the observer alive across SQLite WAL rotation and atomic replacement. The
 * low-frequency anti-entropy rescan is deliberately only a liveness aid: the
 * cursor reader still owns identity/order and the observer only advances after
 * the downstream append path succeeds.
 */
export function watchOpenClawSourceCommit<TCursor extends SourceCommit = SourceCommit>(options: {
  databasePath: string;
  readCursor: () => TCursor | null | Promise<TCursor | null>;
  onCommit: (commit: TCursor, previousCommittedThroughSeq: number | undefined) => void | Promise<void>;
  /** 宿主原地改写代号（见 createSourceCommitObserver）。 */
  rewriteGenerationOf?: (cursor: TCursor) => string | undefined;
  onRewrite?: (cursor: TCursor) => void | Promise<void>;
  onError?: (error: unknown) => void;
  rescanIntervalMs?: number;
  /** 解析每个源作用域的续传起点；缺省时从序号 0 开始投影。 */
  resolveInitialWatermark?: SourceCommitWatermarkResolver<TCursor>;
}): OpenClawSourceCommitWatcher {
  const observer = createSourceCommitObserver<TCursor>({
    readCursor: options.readCursor,
    onCommit: options.onCommit,
    onError: options.onError,
    resolveInitialWatermark: options.resolveInitialWatermark,
    rewriteGenerationOf: options.rewriteGenerationOf,
    onRewrite: options.onRewrite,
  });
  const watchers: FSWatcher[] = [];
  const watchedDirectory = dirname(options.databasePath);
  const databaseName = basename(options.databasePath);
  const notify = (): void => observer.notify();
  const rescanIntervalMs = options.rescanIntervalMs ?? 5_000;
  let rescanTimer: ReturnType<typeof setInterval> | undefined;

  // Directory events cover create/rename/reopen and -wal/-shm churn. The
  // direct file watch reduces latency for ordinary commits. Neither watcher
  // performs correctness work; the cursor reader remains authoritative.
  try {
    watchers.push(watch(watchedDirectory, (_eventType, changedName) => {
      if (isSourceCommitSignal(changedName, databaseName)) notify();
    }));
  } catch {
    // The caller still gets an immediate rescan and can continue using live
    // gateway events if the source is not present yet.
  }
  try {
    watchers.push(watch(options.databasePath, notify));
  } catch {
    // The directory watch can be re-established when the file appears.
  }

  if (Number.isFinite(rescanIntervalMs) && rescanIntervalMs > 0) {
    // Node's fs.watch can coalesce/drop SQLite WAL notifications. This timer
    // is intentionally low frequency and does not participate in ordering.
    rescanTimer = setInterval(notify, Math.floor(rescanIntervalMs));
    rescanTimer.unref?.();
  }
  observer.rescan();
  return {
    notify,
    rescan: observer.rescan,
    close(): void {
      for (const fileWatcher of watchers) fileWatcher.close();
      if (rescanTimer) clearInterval(rescanTimer);
      observer.close();
    },
  };
}

/**
 * 只有主库与 -wal 的变化可能代表新提交。-shm 是 WAL 索引，读者读取时也会改写，
 * 若把它当作信号，游标读取本身就会不断触发新的读取。目录事件缺少文件名时保守地视为信号。
 */
export function isSourceCommitSignal(changedName: string | Buffer | null, databaseName: string): boolean {
  if (!changedName) return true;
  const name = String(changedName);
  return name === databaseName || name === `${databaseName}-wal` || name === `${databaseName}-journal`;
}
