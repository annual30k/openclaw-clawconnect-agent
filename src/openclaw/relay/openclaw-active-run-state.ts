import { createHash } from "node:crypto";
import { copyFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getActiveProfile, profileDisplayName } from "../../config/profile.js";

/**
 * Cross-process audit/state for the mobile turn identity observed by the Relay
 * manager. Ownership is keyed by the complete Host session (including
 * `agent:<agentId>:`), not by the Relay display alias. A child `send-file`
 * process must still carry an explicit session/sourceRunId (or use the native
 * message-tool receipt); this store is never a latest/unique binding oracle.
 * It never reads a transcript or interprets command text.
 */
export type OpenClawActiveRun = {
  profile: string;
  gatewayId: string;
  sessionKey: string;
  sourceRunId: string;
  providerRunId?: string;
  state: "active" | "terminal";
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export const OPENCLAW_ACTIVE_RUN_TTL_MS = 10 * 60_000;
export const OPENCLAW_TERMINAL_RUN_GRACE_MS = 60_000;

// Serializes only this process. The per-record lock below is the cross-process
// guard; a single aggregate JSON file would let manager/CLI read-modify-write
// operations overwrite each other's unrelated runs.
let mutationChain: Promise<void> = Promise.resolve();

/** Exact Host ownership key. Relay display canonicalization is separate. */
export function normalizeOpenClawHostSessionKey(sessionKey: string): string {
  return sessionKey.trim() || "main";
}

export function openClawRunScopeKey(params: {
  profile?: string;
  gatewayId: string;
  sessionKey: string;
}): string {
  return JSON.stringify([
    profileDisplayName(params.profile ?? getActiveProfile()),
    params.gatewayId.trim(),
    normalizeOpenClawHostSessionKey(params.sessionKey),
  ]);
}

/** Map a Host key to the mobile/Relay display alias only at the upload boundary. */
export function canonicalOpenClawRelaySessionKey(sessionKey: string): string {
  const normalized = normalizeOpenClawHostSessionKey(sessionKey);
  const match = /^agent:[^:]+:(.+)$/i.exec(normalized);
  return (match?.[1] ?? normalized) || "main";
}

export async function recordOpenClawActiveRun(params: {
  profile?: string;
  gatewayId: string;
  sessionKey: string;
  sourceRunId: string;
  providerRunId?: string;
  nowMs?: number;
}): Promise<OpenClawActiveRun | undefined> {
  const gatewayId = params.gatewayId.trim();
  const sourceRunId = params.sourceRunId.trim();
  const sessionKey = normalizeOpenClawHostSessionKey(params.sessionKey);
  if (!gatewayId || !sourceRunId) return undefined;

  const nowMs = params.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const run: OpenClawActiveRun = {
    profile: profileDisplayName(params.profile ?? getActiveProfile()),
    gatewayId,
    sessionKey,
    sourceRunId,
    ...(params.providerRunId?.trim() ? { providerRunId: params.providerRunId.trim() } : {}),
    state: "active",
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(nowMs + OPENCLAW_ACTIVE_RUN_TTL_MS).toISOString(),
  };
  await mutateStore(async () => {
    const path = recordPath(run);
    await withRecordLock(path, async () => {
      await writeRecordAtomic(path, run);
    });
  });
  return run;
}

export async function updateOpenClawActiveRunProviderId(params: {
  profile?: string;
  gatewayId: string;
  sessionKey: string;
  sourceRunId: string;
  providerRunId: string;
  nowMs?: number;
}): Promise<void> {
  const sourceRunId = params.sourceRunId.trim();
  const providerRunId = params.providerRunId.trim();
  if (!sourceRunId || !providerRunId) return;
  const candidate = {
    profile: profileDisplayName(params.profile ?? getActiveProfile()),
    gatewayId: params.gatewayId.trim(),
    sessionKey: normalizeOpenClawHostSessionKey(params.sessionKey),
    sourceRunId,
  };
  const nowMs = params.nowMs ?? Date.now();
  await mutateStore(async () => {
    const path = recordPath(candidate);
    await withRecordLock(path, async () => {
      const existing = await readRecord(path);
      if (!existing || isExpired(existing, nowMs)) {
        if (existing) await unlink(path).catch(() => undefined);
        return;
      }
      existing.providerRunId = providerRunId;
      existing.updatedAt = new Date(nowMs).toISOString();
      await writeRecordAtomic(path, existing);
    });
  });
}

/** Return only the explicitly named run; never select a latest/unique candidate. */
export async function resolveOpenClawActiveRun(params: {
  profile?: string;
  gatewayId: string;
  sessionKey: string;
  sourceRunId: string;
  nowMs?: number;
}): Promise<OpenClawActiveRun | undefined> {
  const gatewayId = params.gatewayId.trim();
  const sessionKey = normalizeOpenClawHostSessionKey(params.sessionKey);
  if (!gatewayId) return undefined;
  const nowMs = params.nowMs ?? Date.now();
  const profile = profileDisplayName(params.profile ?? getActiveProfile());
  const requestedSourceRunId = params.sourceRunId.trim();
  if (!gatewayId || !requestedSourceRunId) return undefined;
  const runs = await readRuns();
  for (const { path, run } of runs) {
    if (isExpired(run, nowMs)) {
      await removeExpiredRecord(path, run, nowMs);
      continue;
    }
    if (
      run.profile === profile
      && run.gatewayId === gatewayId
      && run.sessionKey === sessionKey
      && run.sourceRunId === requestedSourceRunId
    ) {
      return run;
    }
  }
  return undefined;
}

export async function markOpenClawActiveRunTerminal(params: {
  profile?: string;
  gatewayId: string;
  sessionKey: string;
  sourceRunId: string;
  nowMs?: number;
}): Promise<void> {
  const sourceRunId = params.sourceRunId.trim();
  if (!sourceRunId) return;
  const nowMs = params.nowMs ?? Date.now();
  const candidate = {
    profile: profileDisplayName(params.profile ?? getActiveProfile()),
    gatewayId: params.gatewayId.trim(),
    sessionKey: normalizeOpenClawHostSessionKey(params.sessionKey),
    sourceRunId,
  };
  await mutateStore(async () => {
    const path = recordPath(candidate);
    await withRecordLock(path, async () => {
      const existing = await readRecord(path);
      if (!existing || isExpired(existing, nowMs)) {
        if (existing) await unlink(path).catch(() => undefined);
        return;
      }
      existing.state = "terminal";
      existing.updatedAt = new Date(nowMs).toISOString();
      existing.expiresAt = new Date(nowMs + OPENCLAW_TERMINAL_RUN_GRACE_MS).toISOString();
      await writeRecordAtomic(path, existing);
    });
  });
}

export async function clearOpenClawActiveRun(params: {
  profile?: string;
  gatewayId: string;
  sessionKey: string;
  sourceRunId?: string;
}): Promise<void> {
  const profile = profileDisplayName(params.profile ?? getActiveProfile());
  const gatewayId = params.gatewayId.trim();
  const sessionKey = normalizeOpenClawHostSessionKey(params.sessionKey);
  const requestedSourceRunId = params.sourceRunId?.trim();
  await mutateStore(async () => {
    for (const { path, run } of await readRuns()) {
      if (
        run.profile !== profile
        || run.gatewayId !== gatewayId
        || run.sessionKey !== sessionKey
        || (requestedSourceRunId && run.sourceRunId !== requestedSourceRunId)
      ) continue;
      await withRecordLock(path, async () => {
        const current = await readRecord(path);
        if (current && current.sourceRunId === run.sourceRunId) await unlink(path).catch(() => undefined);
      });
    }
  });
}

type StoredRun = { path: string; run: OpenClawActiveRun };

function recordKey(run: Pick<OpenClawActiveRun, "profile" | "gatewayId" | "sessionKey" | "sourceRunId">): string {
  return createHash("sha256")
    .update(JSON.stringify([run.profile, run.gatewayId, run.sessionKey, run.sourceRunId]))
    .digest("hex");
}

function recordPath(run: Pick<OpenClawActiveRun, "profile" | "gatewayId" | "sessionKey" | "sourceRunId">): string {
  return join(storeDirectory(), `${recordKey(run)}.json`);
}

function storeDirectory(): string {
  const configured = process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE?.trim();
  return configured
    ? `${configured}.records`
    : join(homedir(), ".clawconnect", "openclaw", "active-runs");
}

function isExpired(run: OpenClawActiveRun, nowMs: number): boolean {
  const expiresAt = Date.parse(run.expiresAt);
  return !Number.isFinite(expiresAt) || nowMs >= expiresAt;
}

async function readRuns(): Promise<StoredRun[]> {
  const directory = storeDirectory();
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    return [];
  }
  const runs: StoredRun[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    const run = await readRecord(path);
    if (run) runs.push({ path, run });
  }
  return runs;
}

async function readRecord(path: string): Promise<OpenClawActiveRun | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<OpenClawActiveRun>;
    if (
      typeof parsed.profile !== "string"
      || typeof parsed.gatewayId !== "string"
      || typeof parsed.sessionKey !== "string"
      || typeof parsed.sourceRunId !== "string"
      || (parsed.state !== "active" && parsed.state !== "terminal")
      || typeof parsed.createdAt !== "string"
      || typeof parsed.updatedAt !== "string"
      || typeof parsed.expiresAt !== "string"
    ) return undefined;
    return parsed as OpenClawActiveRun;
  } catch {
    await quarantineCorruptStore(path);
    return undefined;
  }
}

async function writeRecordAtomic(path: string, run: OpenClawActiveRun): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(run, null, 2), "utf8");
  await rename(tempPath, path);
}

async function removeExpiredRecord(path: string, run: OpenClawActiveRun, nowMs: number): Promise<void> {
  await withRecordLock(path, async () => {
    const current = await readRecord(path);
    if (current && current.sourceRunId === run.sourceRunId && isExpired(current, nowMs)) {
      await unlink(path).catch(() => undefined);
    }
  });
}

async function mutateStore(mutator: () => Promise<void>): Promise<void> {
  const run = mutationChain.then(mutator);
  mutationChain = run.catch(() => undefined);
  await run;
}

async function withRecordLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      try {
        const lockAgeMs = Date.now() - (await stat(lockPath)).mtimeMs;
        if (lockAgeMs > 30_000) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        // A concurrent owner may have released the lock between stat/unlink.
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  if (!handle) throw new Error("openclaw_active_run_lock_timeout");
  try {
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST";
}

async function quarantineCorruptStore(path: string): Promise<void> {
  try {
    await copyFile(path, `${path}.corrupt-${Date.now()}`);
  } catch {
    // Best effort only; fail closed when the state cannot be read.
  }
}
