import { createHash } from "node:crypto";
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

/** jobs.json 不存在时的内容摘要哨兵；与任何真实文件内容的 sha256 都不可能相同。 */
export const HERMES_CRON_JOBS_MISSING_DIGEST = "missing";

export type HermesCronChangeWatcher = {
  /** 立即同步读取一次任务文件并与基线比较；内容变化时触发一次 onChange。 */
  checkNow(): void;
  /** 当前基线摘要；未完成首次读取或读取失败且无基线时为 undefined。 */
  currentDigest(): string | undefined;
  close(): void;
};

export type HermesCronChangeWatcherOptions = {
  /** Hermes cron 任务库文件，即 `runHermesCronList` 读取的 `<hermesHome>/cron/jobs.json`。 */
  jobsFile: string;
  /** 内容确实变化时调用；每次变化恰好调用一次。 */
  onChange: () => void;
  /**
   * 上一个连接周期结束时的摘要。提供时，首次读取若与之不同会触发一次 onChange，
   * 用来补发断线期间发生的任务变化；未提供时首次读取只建立基线，不触发。
   */
  baselineDigest?: string;
  logWarning?: (message: string) => void;
};

/**
 * 监听 Hermes cron 任务库的内容变化。
 *
 * 正确性只由“文件内容 sha256 摘要是否与基线不同”决定：fs.watch 通知仅是唤醒信号，
 * 重复、合并或额外的通知（例如同目录 ticker_heartbeat、executions.db 的写入）都只会
 * 触发一次重新读取，摘要相同即不发事件，因此同一份内容永远不会重复通知。
 *
 * 监听的是 jobs.json 所在目录而非文件本身：Hermes 以“写临时文件再 rename”的方式原子替换
 * jobs.json，文件级 watch 会停留在被替换掉的旧 inode 上，目录级 watch 才能持续看到新文件。
 * 同时监听上一级目录（Hermes home），当 cron 目录稍后被创建或被删除重建时重新挂载目录监听。
 * 若 Hermes home 本身尚不存在，则只记录日志；下次 Relay 连接会重新创建本监听器。
 */
export function watchHermesCronJobs(options: HermesCronChangeWatcherOptions): HermesCronChangeWatcher {
  const cronDirectory = dirname(options.jobsFile);
  const cronDirectoryName = basename(cronDirectory);
  const hermesHomeDirectory = dirname(cronDirectory);
  const logWarning = options.logWarning ?? ((message: string) => console.warn(`[hermes-cron-watch] ${message}`));
  let baselineDigest = options.baselineDigest;
  let baselineEstablished = false;
  let closed = false;
  let pendingCheck: ReturnType<typeof setImmediate> | undefined;
  let cronDirectoryWatcher: FSWatcher | undefined;
  let hermesHomeWatcher: FSWatcher | undefined;

  const checkNow = (): void => {
    if (closed) return;
    const digest = readJobsDigest(options.jobsFile, logWarning);
    if (digest === undefined) return;
    const hadBaseline = baselineEstablished || baselineDigest !== undefined;
    const changed = hadBaseline && digest !== baselineDigest;
    baselineDigest = digest;
    baselineEstablished = true;
    if (!changed) return;
    try {
      options.onChange();
    } catch (error) {
      logWarning(`change listener failed: ${errorMessage(error)}`);
    }
  };

  // 同一事件循环轮次内的多次通知只合并为一次读取；这只是减少重复 I/O，
  // 是否发事件仍完全由摘要比较决定。
  const scheduleCheck = (): void => {
    if (closed || pendingCheck) return;
    pendingCheck = setImmediate(() => {
      pendingCheck = undefined;
      checkNow();
    });
  };

  const closeCronDirectoryWatcher = (): void => {
    cronDirectoryWatcher?.close();
    cronDirectoryWatcher = undefined;
  };

  const armCronDirectoryWatcher = (): void => {
    closeCronDirectoryWatcher();
    try {
      const directoryWatcher = watch(cronDirectory, () => scheduleCheck());
      directoryWatcher.on("error", (error) => {
        logWarning(`cron directory watch failed: ${errorMessage(error)}`);
        if (cronDirectoryWatcher === directoryWatcher) closeCronDirectoryWatcher();
        scheduleCheck();
      });
      cronDirectoryWatcher = directoryWatcher;
    } catch (error) {
      if (!isMissingPathError(error)) logWarning(`cannot watch cron directory: ${errorMessage(error)}`);
    }
  };

  try {
    hermesHomeWatcher = watch(hermesHomeDirectory, (_eventType, changedName) => {
      // cron 目录被创建、删除或替换时重新挂载目录监听，并重新比较内容。
      if (changedName !== null && String(changedName) !== cronDirectoryName) return;
      if (closed) return;
      armCronDirectoryWatcher();
      scheduleCheck();
    });
    hermesHomeWatcher.on("error", (error) => {
      logWarning(`Hermes home watch failed: ${errorMessage(error)}`);
      hermesHomeWatcher?.close();
      hermesHomeWatcher = undefined;
    });
  } catch (error) {
    logWarning(`cannot watch Hermes home; cron changes resume on next relay connect: ${errorMessage(error)}`);
  }
  armCronDirectoryWatcher();
  checkNow();

  return {
    checkNow,
    currentDigest: () => baselineDigest,
    close(): void {
      if (closed) return;
      closed = true;
      if (pendingCheck) clearImmediate(pendingCheck);
      pendingCheck = undefined;
      closeCronDirectoryWatcher();
      hermesHomeWatcher?.close();
      hermesHomeWatcher = undefined;
    },
  };
}

/** 读取失败（非“不存在”）时返回 undefined，保留原基线，不把未知状态当成变化。 */
function readJobsDigest(jobsFile: string, logWarning: (message: string) => void): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(jobsFile)).digest("hex");
  } catch (error) {
    if (isMissingPathError(error)) return HERMES_CRON_JOBS_MISSING_DIGEST;
    logWarning(`cannot read cron jobs file: ${errorMessage(error)}`);
    return undefined;
  }
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
