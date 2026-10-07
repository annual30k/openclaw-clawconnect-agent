import { HERMES_CRON_JOBS_FILE } from "../runtime/hermes-runtime-process.js";
import { watchHermesCronJobs } from "../runtime/hermes-cron-change-watcher.js";

/**
 * 与 OpenClaw 路径转发宿主 cron 事件时使用的事件名一致。Relay 收到后只把它当作
 * “重新拉取 cron.list”的信号，因此 payload 不携带任务内容，只标明来源与动作。
 */
export const HERMES_CRON_EVENT_NAME = "cron";

export type HermesCronChangedEvent = {
  type: "event";
  event: typeof HERMES_CRON_EVENT_NAME;
  payload: { action: "changed"; source: "hermes" };
};

export type HermesCronChangeRelay = {
  stop(): void;
};

export function buildHermesCronChangedEvent(): HermesCronChangedEvent {
  return {
    type: "event",
    event: HERMES_CRON_EVENT_NAME,
    payload: { action: "changed", source: "hermes" },
  };
}

/**
 * 进程内按 (gatewayId, jobsFile) 记录上一个 Relay 连接结束时的任务库摘要。
 * 重连后首次读取若与之不同，说明断线期间任务有变化，需要补发一次 cron 事件；
 * 进程首次连接没有记录，只建立基线。
 */
const lastDigestByScope = new Map<string, string>();

/**
 * 在一个 Relay 连接的生命周期内监听 Hermes cron 任务库，内容变化时发送一次 cron 事件帧。
 * 监听器的任何错误都只记录日志，不会中断 Relay 连接或 Agent 进程。
 */
export function startHermesCronChangeRelay(options: {
  gatewayId: string;
  send: (message: HermesCronChangedEvent) => void;
  jobsFile?: string;
}): HermesCronChangeRelay {
  const jobsFile = options.jobsFile ?? HERMES_CRON_JOBS_FILE;
  const scopeKey = `${options.gatewayId}\u0000${jobsFile}`;
  let watcher: ReturnType<typeof watchHermesCronJobs> | undefined;
  try {
    watcher = watchHermesCronJobs({
      jobsFile,
      baselineDigest: lastDigestByScope.get(scopeKey),
      onChange: () => options.send(buildHermesCronChangedEvent()),
    });
  } catch (error) {
    console.warn(`[hermes-cron-watch] cannot start cron change watcher: ${String(error)}`);
  }
  return {
    stop(): void {
      if (!watcher) return;
      const digest = watcher.currentDigest();
      if (digest !== undefined) lastDigestByScope.set(scopeKey, digest);
      watcher.close();
      watcher = undefined;
    },
  };
}

/** @internal 测试之间隔离进程内的摘要记录。 */
export function clearHermesCronChangeRelayStateForTests(): void {
  lastDigestByScope.clear();
}
