import { copyFileSync, existsSync, readdirSync, unlinkSync } from "fs";
import { dirname, join } from "path";

export const REGISTRATION_BACKUP_PREFIX = "config.json.server-switch-";
export const REGISTRATION_BACKUP_SUFFIX = ".bak";
/** 每个 profile 只保留最近几份重新注册前的配置备份，避免反复配对后备份无限堆积。 */
export const REGISTRATION_BACKUP_RETENTION = 5;

/** 重新注册会覆盖凭证，先把旧配置备份，再按保留数量清理更早的备份。 */
export function backupConfigBeforeRegistration(
  configPath: string,
  now: Date = new Date(),
  retention: number = REGISTRATION_BACKUP_RETENTION,
): string | undefined {
  if (!existsSync(configPath)) {
    return undefined;
  }
  const backupPath = join(
    dirname(configPath),
    `${REGISTRATION_BACKUP_PREFIX}${formatBackupTimestamp(now)}${REGISTRATION_BACKUP_SUFFIX}`,
  );
  copyFileSync(configPath, backupPath);
  pruneRegistrationBackups(dirname(configPath), retention);
  return backupPath;
}

/**
 * 删除超出保留数量的重新注册备份，返回被删除的文件名。
 * 文件名时间戳为 YYYYMMDD-HHMMSS，字典序即时间序，排序结果与文件系统遍历顺序无关。
 * 只处理本模块生成的备份，其他 .bak 文件（迁移、手工备份）一律保留。
 */
export function pruneRegistrationBackups(directory: string, retention: number = REGISTRATION_BACKUP_RETENTION): string[] {
  const backups = readdirSync(directory)
    .filter((name) => name.startsWith(REGISTRATION_BACKUP_PREFIX) && name.endsWith(REGISTRATION_BACKUP_SUFFIX))
    .sort();
  const stale = backups.slice(0, Math.max(0, backups.length - Math.max(0, retention)));
  for (const name of stale) {
    unlinkSync(join(directory, name));
  }
  return stale;
}

function formatBackupTimestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}
