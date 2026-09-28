import { copyFileSync, statSync, truncateSync } from "fs";
import { profileErrorLogPath, profileLogPath } from "./profile.js";

/** 单个日志文件超过该体积即轮转；launchd/systemd/schtasks 都以追加方式重定向 stdout，无法自行轮转。 */
export const PROFILE_LOG_ROTATE_BYTES = 10 * 1024 * 1024;

export type ProfileLogRotationResult = {
  path: string;
  rotated: boolean;
  bytesBefore: number;
};

/**
 * 进程启动时对 profile 日志做一次有界轮转：把超限的当前文件复制为 `<file>.1`（只保留一代），
 * 然后原地截断。原地截断而不是重命名，是因为服务管理器仍持有以 O_APPEND 打开的旧文件描述符，
 * 后续写入会继续落到同一路径；重命名会让新日志写进已被轮转的备份里。
 */
export function rotateProfileLogsIfOversized(
  profile: string | undefined,
  options: { maxBytes?: number; paths?: string[] } = {},
): ProfileLogRotationResult[] {
  const maxBytes = options.maxBytes ?? PROFILE_LOG_ROTATE_BYTES;
  const paths = options.paths ?? [profileLogPath(profile), profileErrorLogPath(profile)];
  return paths.map((path) => rotateLogFileIfOversized(path, maxBytes));
}

export function rotateLogFileIfOversized(path: string, maxBytes: number): ProfileLogRotationResult {
  let bytesBefore = 0;
  try {
    bytesBefore = statSync(path).size;
  } catch {
    return { path, rotated: false, bytesBefore: 0 };
  }
  if (bytesBefore <= maxBytes) {
    return { path, rotated: false, bytesBefore };
  }
  try {
    copyFileSync(path, `${path}.1`);
    truncateSync(path, 0);
    return { path, rotated: true, bytesBefore };
  } catch (error) {
    // 轮转失败不能阻断启动；下次启动会再次尝试。
    console.warn(`[clawconnect] log rotation failed for ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return { path, rotated: false, bytesBefore };
  }
}
