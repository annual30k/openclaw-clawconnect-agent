import { statSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

/**
 * 源提交游标读取专用的只读连接缓存。
 *
 * 每个会话都有一个 source-commit watcher，且都监听同一个 OpenClaw 数据库目录。
 * 若每次读游标都新开、关闭连接并重新编译 SQL，开关连接本身会改动 -wal/-shm，
 * 再触发所有 watcher 读取，形成自激循环把 agent CPU 打满（实测 80%~98%），
 * 命令无法响应而超时。这里每个数据库只保持一个只读连接与两条预编译语句。
 *
 * 数据库文件被原子替换时 inode 会变化：每次读取前比较 inode/dev，变化即重开，
 * 绝不从已被替换的旧文件读出过期水位。
 */
export type OpenClawSourceCursorStatements = {
  /** 按会话键查当前 sessionId。 */
  sessionNode: StatementSync;
  /** 查某个 sessionId 已提交的最大 seq。 */
  committedThroughSeq: StatementSync;
  /** 查某个 sessionId 的原地改写代号；旧版 OpenClaw 没有该表时为 undefined。 */
  rewriteGeneration?: StatementSync;
};

type CachedConnection = {
  database: DatabaseSync;
  ino: number;
  dev: number;
  statements: OpenClawSourceCursorStatements;
};

const connections = new Map<string, CachedConnection>();

function closeQuietly(database: DatabaseSync): void {
  try {
    database.close();
  } catch {
    // 连接已失效时关闭失败无需处理，缓存条目随后被移除。
  }
}

/** 返回当前文件对应的缓存语句；文件不存在时返回 undefined。打开或编译失败会抛错。 */
export function openClawSourceCursorStatements(databasePath: string): OpenClawSourceCursorStatements | undefined {
  let ino: number;
  let dev: number;
  try {
    const stats = statSync(databasePath);
    ino = stats.ino;
    dev = stats.dev;
  } catch {
    forgetOpenClawSourceCursorConnection(databasePath);
    return undefined;
  }
  const cached = connections.get(databasePath);
  if (cached && cached.ino === ino && cached.dev === dev) return cached.statements;
  if (cached) forgetOpenClawSourceCursorConnection(databasePath);

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const statements: OpenClawSourceCursorStatements = {
      sessionNode: database.prepare(`
        SELECT current_session_id
        FROM session_nodes
        WHERE session_key = ?
        LIMIT 1
      `),
      committedThroughSeq: database.prepare(`
        SELECT MAX(seq) AS committed_through_seq
        FROM transcript_events
        WHERE session_id = ?
      `),
    };
    const hasRewriteWatermarks = database.prepare(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type = 'table' AND name = 'transcript_rewrite_watermarks'
    `).get() !== undefined;
    if (hasRewriteWatermarks) {
      statements.rewriteGeneration = database.prepare(`
        SELECT generation
        FROM transcript_rewrite_watermarks
        WHERE session_id = ?
      `);
    }
    connections.set(databasePath, { database, ino, dev, statements });
    return statements;
  } catch (error) {
    closeQuietly(database);
    throw error;
  }
}

/** 读取出错时丢弃该连接，下一次读取重新打开，避免一直复用损坏的句柄。 */
export function forgetOpenClawSourceCursorConnection(databasePath: string): void {
  const cached = connections.get(databasePath);
  if (!cached) return;
  connections.delete(databasePath);
  closeQuietly(cached.database);
}

export function closeOpenClawSourceCursorConnections(): void {
  for (const databasePath of [...connections.keys()]) forgetOpenClawSourceCursorConnection(databasePath);
}
