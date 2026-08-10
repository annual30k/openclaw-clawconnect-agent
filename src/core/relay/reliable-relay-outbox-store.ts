import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { profileRoot } from "../../config/profile.js";
import {
  setRestrictiveDirPermissions,
  setRestrictiveFilePermissions,
} from "../../platform/service-manager-common.js";
import { normalizeRelayServerIdentity } from "./file-upload-utils.js";

const STORE_VERSION = 1;
const STORE_DIR_NAME = "reliable-outbox-v1";
const COMPACTION_MIN_BYTES = 1024 * 1024;
const COMPACTION_HEADROOM_BYTES = 256 * 1024;
const MAX_JOURNAL_BYTES = 256 * 1024 * 1024;

export type StoredReliableRelayOutboxEntry = {
  key: string;
  message: unknown;
  byteLength: number;
  contentHash: string;
  mode: "event_ack" | "response_ack";
  deliveryId?: string;
};

export interface ReliableRelayOutboxStore {
  load(): readonly StoredReliableRelayOutboxEntry[];
  put(entry: StoredReliableRelayOutboxEntry): void;
  remove(key: string): void;
  close(): void;
}

type JournalHeader = {
  v: typeof STORE_VERSION;
  kind: "header";
  gatewayHash: string;
  generation: number;
};

type JournalPut = {
  v: typeof STORE_VERSION;
  kind: "put";
  entry: StoredReliableRelayOutboxEntry;
};

type JournalRemove = {
  v: typeof STORE_VERSION;
  kind: "remove";
  key: string;
};

type JournalCheckpoint = {
  v: typeof STORE_VERSION;
  kind: "checkpoint";
  count: number;
  digest: string;
};

type ParsedGeneration = {
  path: string;
  generation: number;
  entries: Map<string, StoredReliableRelayOutboxEntry>;
  validBytes: number;
};

export type FileReliableRelayOutboxStoreOptions = {
  directory: string;
  gatewayId: string;
  relayIdentity: string;
  onMaintenanceError?: (error: Error) => void;
};

/**
 * Single-writer, append-only WAL for one profile/gateway outbox.
 *
 * Every mutation is fsync'd before returning. Compaction writes a complete,
 * checkpointed next generation before retiring the previous one, so a crash
 * can leave at most a truncated final record or an incomplete higher
 * generation; startup safely falls back to the newest complete checkpoint.
 *
 * 每次变更返回前必须完成 fsync；压缩时先写完整的新代 checkpoint，再淘汰旧代，
 * 因而崩溃只会留下可忽略的尾部残片或不完整的新代，不会覆盖最后一个有效状态。
 */
export class FileReliableRelayOutboxStore implements ReliableRelayOutboxStore {
  private readonly gatewayHash: string;
  private readonly filePrefix: string;
  private readonly lockPath: string;
  private readonly operationLockPath: string;
  private readonly lockToken = randomUUID();
  private readonly onMaintenanceError?: (error: Error) => void;
  private readonly entries = new Map<string, StoredReliableRelayOutboxEntry>();
  private lockFd?: number;
  private journalFd?: number;
  private journalPath = "";
  private generation = 0;
  private journalBytes = 0;
  private closed = false;
  private failed = false;

  constructor(private readonly options: FileReliableRelayOutboxStoreOptions) {
    this.gatewayHash = createHash("sha256")
      .update(normalizeRelayServerIdentity(options.relayIdentity))
      .update("\u0000")
      .update(options.gatewayId)
      .digest("hex");
    this.filePrefix = `${this.gatewayHash}.`;
    this.lockPath = join(options.directory, `${this.gatewayHash}.lock`);
    this.operationLockPath = operationLockPath(options.directory);
    this.onMaintenanceError = options.onMaintenanceError;

    try {
      mkdirSync(options.directory, { recursive: true, mode: 0o700 });
      setRestrictiveDirPermissions(options.directory);
      this.acquireOperationLock();
      try {
        this.acquireLock();
        this.openNewestGeneration();
      } finally {
        this.releaseOperationLock();
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  load(): readonly StoredReliableRelayOutboxEntry[] {
    this.assertUsable();
    return [...this.entries.values()];
  }

  put(entry: StoredReliableRelayOutboxEntry): void {
    this.assertUsable();
    if (this.entries.has(entry.key)) {
      throw new Error(`reliable_outbox_store_duplicate_put key=${entry.key}`);
    }
    this.append({ v: STORE_VERSION, kind: "put", entry });
    this.entries.set(entry.key, entry);
    this.compactIfNeeded();
  }

  remove(key: string): void {
    this.assertUsable();
    if (!this.entries.has(key)) {
      throw new Error(`reliable_outbox_store_missing_remove key=${key}`);
    }
    this.append({ v: STORE_VERSION, kind: "remove", key });
    this.entries.delete(key);
    this.compactIfNeeded();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.journalFd !== undefined) {
      try { closeSync(this.journalFd); } catch { /* best effort */ }
      this.journalFd = undefined;
    }
    if (this.lockFd !== undefined) {
      try { closeSync(this.lockFd); } catch { /* best effort */ }
      this.lockFd = undefined;
    }
    try {
      const lock = JSON.parse(readFileSync(this.lockPath, "utf8")) as { token?: unknown };
      if (lock.token === this.lockToken) unlinkSync(this.lockPath);
    } catch {
      // A crashed process leaves a stale lock which the next owner repairs.
    }
  }

  private acquireLock(): void {
    // 操作锁把“检查旧 owner → 删除陈旧锁 → 创建新 owner”串成单写者临界区，
    // 防止两个重启进程同时清理同一把陈旧锁后双写 WAL。
    if (existsSync(this.lockPath)) {
      const owner = readLockOwner(this.lockPath);
      if (owner.status !== "stale") {
        throw new Error(`reliable_outbox_store_locked gatewayHash=${this.gatewayHash}`);
      }
      unlinkSync(this.lockPath);
    }
    let fd: number | undefined;
    try {
      fd = openSync(this.lockPath, "wx", 0o600);
      writeAll(fd, Buffer.from(JSON.stringify({
        v: STORE_VERSION,
        pid: process.pid,
        token: this.lockToken,
        createdAt: Date.now(),
      }), "utf8"));
      fsyncSync(fd);
      setRestrictiveFilePermissions(this.lockPath);
      this.lockFd = fd;
      fd = undefined;
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* best effort */ }
        try { unlinkSync(this.lockPath); } catch { /* best effort */ }
      }
    }
  }

  private acquireOperationLock(): void {
    try {
      mkdirSync(this.operationLockPath, { mode: 0o700 });
      setRestrictiveDirPermissions(this.operationLockPath);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new Error("reliable_outbox_store_operation_locked");
      }
      throw error;
    }
  }

  private releaseOperationLock(): void {
    try { rmSync(this.operationLockPath, { recursive: true, force: true }); } catch { /* fail closed next time */ }
  }

  private openNewestGeneration(): void {
    const candidates = this.generationPaths();
    const parsed: ParsedGeneration[] = [];
    const errors: Error[] = [];
    for (const candidate of candidates) {
      try {
        parsed.push(parseGeneration(candidate.path, candidate.generation, this.gatewayHash));
      } catch (error) {
        errors.push(asError(error));
      }
    }
    parsed.sort((left, right) => right.generation - left.generation);
    const newest = parsed[0];
    if (!newest) {
      if (candidates.length > 0) {
        throw new Error(`reliable_outbox_store_corrupt: ${errors.map((error) => error.message).join("; ")}`);
      }
      this.activateNewGeneration(1, new Map());
      return;
    }

    if (statSync(newest.path).size !== newest.validBytes) {
      const repairFd = openSync(newest.path, "r+");
      try {
        ftruncateSync(repairFd, newest.validBytes);
        fsyncSync(repairFd);
      } finally {
        closeSync(repairFd);
      }
    }
    this.entries.clear();
    for (const [key, entry] of newest.entries) this.entries.set(key, entry);
    this.generation = newest.generation;
    this.journalPath = newest.path;
    this.journalFd = openSync(newest.path, "a");
    this.journalBytes = newest.validBytes;
    this.removeInactiveGenerations(newest.path);
  }

  private generationPaths(): Array<{ path: string; generation: number }> {
    const pattern = new RegExp(`^${this.gatewayHash}\\.(\\d+)\\.wal$`);
    const result: Array<{ path: string; generation: number }> = [];
    for (const name of readdirSync(this.options.directory)) {
      const match = pattern.exec(name);
      if (!match) continue;
      const generation = Number(match[1]);
      if (!Number.isSafeInteger(generation) || generation < 1) continue;
      result.push({ path: join(this.options.directory, name), generation });
    }
    return result;
  }

  private append(record: JournalPut | JournalRemove): void {
    const fd = this.journalFd;
    if (fd === undefined) throw new Error("reliable_outbox_store_not_open");
    const bytes = encodeRecord(record);
    const previousBytes = this.journalBytes;
    try {
      writeAll(fd, bytes);
      fsyncSync(fd);
      this.journalBytes += bytes.byteLength;
    } catch (error) {
      // 写入或 fsync 失败时回滚到上一次已提交边界；回滚也失败则永久停用本实例。
      try {
        ftruncateSync(fd, previousBytes);
        fsyncSync(fd);
      } catch {
        this.failed = true;
      }
      throw new Error(`reliable_outbox_store_write_failed: ${asError(error).message}`);
    }
  }

  private compactIfNeeded(): void {
    const liveBytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.byteLength, 0);
    const threshold = Math.max(COMPACTION_MIN_BYTES, (liveBytes * 2) + COMPACTION_HEADROOM_BYTES);
    if (this.entries.size > 0 && this.journalBytes <= threshold) return;
    try {
      // 新代完整持久化后才切换 fd；压缩失败不撤销已经写入旧 WAL 的业务变更。
      this.activateNewGeneration(this.nextGeneration(), this.entries);
    } catch (error) {
      this.reportMaintenanceError(asError(error));
    }
  }

  private activateNewGeneration(
    generation: number,
    entries: ReadonlyMap<string, StoredReliableRelayOutboxEntry>,
  ): void {
    const path = join(this.options.directory, `${this.filePrefix}${generation}.wal`);
    let fd: number | undefined;
    try {
      fd = openSync(path, "ax", 0o600);
      writeAll(fd, encodeRecord({
        v: STORE_VERSION,
        kind: "header",
        gatewayHash: this.gatewayHash,
        generation,
      } satisfies JournalHeader));
      for (const entry of entries.values()) {
        writeAll(fd, encodeRecord({ v: STORE_VERSION, kind: "put", entry } satisfies JournalPut));
      }
      writeAll(fd, encodeRecord({
        v: STORE_VERSION,
        kind: "checkpoint",
        count: entries.size,
        digest: stateDigest(entries),
      } satisfies JournalCheckpoint));
      fsyncSync(fd);
      setRestrictiveFilePermissions(path);
      fsyncDirectory(this.options.directory);
      const bytes = fstatSync(fd).size;
      const oldFd = this.journalFd;
      this.journalFd = fd;
      this.journalPath = path;
      this.journalBytes = bytes;
      this.generation = generation;
      fd = undefined;
      if (oldFd !== undefined) {
        try { closeSync(oldFd); } catch { /* the new generation is already durable */ }
      }
      this.removeInactiveGenerations(path);
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* best effort */ }
      }
      try { rmSync(path, { force: true }); } catch { /* best effort */ }
      throw error;
    }
  }

  private removeInactiveGenerations(activePath: string): void {
    const previous = this.generationPaths()
      .filter((candidate) => candidate.path !== activePath && candidate.generation < this.generation)
      .sort((left, right) => right.generation - left.generation)[0]?.path;
    for (const candidate of this.generationPaths()) {
      if (candidate.path === activePath || candidate.path === previous) continue;
      try { unlinkSync(candidate.path); } catch { /* startup can retry */ }
    }
  }

  private nextGeneration(): number {
    return Math.max(this.generation, ...this.generationPaths().map((candidate) => candidate.generation)) + 1;
  }

  private assertUsable(): void {
    if (this.closed) throw new Error("reliable_outbox_store_closed");
    if (this.failed) throw new Error("reliable_outbox_store_failed");
  }

  private reportMaintenanceError(error: Error): void {
    if (this.onMaintenanceError) {
      try {
        this.onMaintenanceError(error);
        return;
      } catch {
        // Observability must not affect a mutation already committed to WAL.
      }
    }
    console.warn(`[relay] reliable outbox compaction deferred: ${error.message}`);
  }
}

export function reliableRelayOutboxStorageDirectory(profile?: string): string {
  return join(profileRoot(profile), STORE_DIR_NAME);
}

export function clearReliableRelayOutboxStorage(profile?: string): void {
  const directory = reliableRelayOutboxStorageDirectory(profile);
  const lockPath = operationLockPath(directory);
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(lockPath, { mode: 0o700 });
    setRestrictiveDirPermissions(lockPath);
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new Error("reliable_outbox_store_operation_locked");
    throw error;
  }
  try {
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".lock")) continue;
      const owner = readLockOwner(join(directory, name));
      if (owner.status !== "stale") {
        throw new Error(`reliable_outbox_store_in_use lock=${name}`);
      }
    }
    rmSync(directory, { recursive: true, force: true });
  } finally {
    try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* fail closed */ }
  }
}

function parseGeneration(path: string, generation: number, gatewayHash: string): ParsedGeneration {
  if (statSync(path).size > MAX_JOURNAL_BYTES) throw new Error(`journal_too_large generation=${generation}`);
  const file = readFileSync(path);
  const lastNewline = file.lastIndexOf(0x0a);
  if (lastNewline < 0) throw new Error(`journal_missing_header generation=${generation}`);
  const validBytes = lastNewline + 1;
  const lines = file.subarray(0, validBytes).toString("utf8").split("\n");
  lines.pop();
  const entries = new Map<string, StoredReliableRelayOutboxEntry>();
  let checkpointSeen = false;

  for (let index = 0; index < lines.length; index += 1) {
    let value: unknown;
    try {
      value = JSON.parse(lines[index]!);
    } catch {
      throw new Error(`journal_invalid_json generation=${generation} line=${index + 1}`);
    }
    const record = asRecord(value);
    if (!record || record.v !== STORE_VERSION) {
      throw new Error(`journal_invalid_version generation=${generation} line=${index + 1}`);
    }
    if (index === 0) {
      if (record.kind !== "header" || record.gatewayHash !== gatewayHash || record.generation !== generation) {
        throw new Error(`journal_invalid_header generation=${generation}`);
      }
      continue;
    }
    if (record.kind === "put") {
      const entry = parseStoredEntry(record.entry, generation, index + 1);
      if (entries.has(entry.key)) throw new Error(`journal_duplicate_put generation=${generation} key=${entry.key}`);
      entries.set(entry.key, entry);
      continue;
    }
    if (record.kind === "remove") {
      if (!checkpointSeen || typeof record.key !== "string" || !entries.delete(record.key)) {
        throw new Error(`journal_invalid_remove generation=${generation} line=${index + 1}`);
      }
      continue;
    }
    if (record.kind === "checkpoint") {
      if (checkpointSeen || record.count !== entries.size || record.digest !== stateDigest(entries)) {
        throw new Error(`journal_invalid_checkpoint generation=${generation}`);
      }
      checkpointSeen = true;
      continue;
    }
    throw new Error(`journal_invalid_record generation=${generation} line=${index + 1}`);
  }
  if (!checkpointSeen) throw new Error(`journal_incomplete_generation generation=${generation}`);
  return { path, generation, entries, validBytes };
}

function parseStoredEntry(value: unknown, generation: number, line: number): StoredReliableRelayOutboxEntry {
  const entry = asRecord(value);
  if (
    !entry
    || typeof entry.key !== "string"
    || typeof entry.byteLength !== "number"
    || typeof entry.contentHash !== "string"
    || (entry.mode !== "event_ack" && entry.mode !== "response_ack")
    || !Object.prototype.hasOwnProperty.call(entry, "message")
    || (entry.deliveryId !== undefined && typeof entry.deliveryId !== "string")
  ) {
    throw new Error(`journal_invalid_entry generation=${generation} line=${line}`);
  }
  return entry as StoredReliableRelayOutboxEntry;
}

function stateDigest(entries: ReadonlyMap<string, StoredReliableRelayOutboxEntry>): string {
  return createHash("sha256")
    .update(JSON.stringify([...entries.values()].map((entry) => [entry.key, entry.contentHash])))
    .digest("hex");
}

function encodeRecord(record: JournalHeader | JournalPut | JournalRemove | JournalCheckpoint): Buffer {
  return Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new Error("reliable_outbox_store_zero_byte_write");
    offset += written;
  }
}

function fsyncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch {
    // Windows does not consistently permit directory handles; file fsync is
    // still honored there. POSIX platforms get the directory-entry barrier.
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function readLockOwner(path: string): { status: "active" | "stale" | "unknown" } {
  try {
    const lock = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    if (Number.isSafeInteger(lock.pid) && Number(lock.pid) > 0) {
      return { status: processIsAlive(Number(lock.pid)) ? "active" : "stale" };
    }
  } catch {
    // Age check below distinguishes an in-progress write from stale garbage.
  }
  // 无法验证 owner 身份时必须 fail closed，不能猜测为陈旧锁后删除。
  return { status: "unknown" };
}

function operationLockPath(directory: string): string {
  return join(dirname(directory), `${basename(directory)}.operation-lock`);
}

function errorCode(value: unknown): string | undefined {
  return value && typeof value === "object" && "code" in value
    ? String((value as { code?: unknown }).code)
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
