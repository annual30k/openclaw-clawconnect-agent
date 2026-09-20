import { watch, type FSWatcher } from "node:fs";
import { dirname, basename } from "node:path";
import { createSourceCommitObserver, type SourceCommit } from "../../core/relay/source-commit.js";

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
export function watchOpenClawSourceCommit(options: {
  databasePath: string;
  readCursor: () => SourceCommit | null | Promise<SourceCommit | null>;
  onCommit: (commit: SourceCommit, previousCommittedThroughSeq: number | undefined) => void | Promise<void>;
  onError?: (error: unknown) => void;
  rescanIntervalMs?: number;
  initialWatermarkMode?: "latest" | "from_zero";
}): OpenClawSourceCommitWatcher {
  const observer = createSourceCommitObserver({
    readCursor: options.readCursor,
    onCommit: options.onCommit,
    onError: options.onError,
    initialWatermarkMode: options.initialWatermarkMode,
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
      if (!changedName || String(changedName) === databaseName || String(changedName).startsWith(`${databaseName}-`)) {
        notify();
      }
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
