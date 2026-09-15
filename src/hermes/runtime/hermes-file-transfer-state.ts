import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * A pending file transfer is a host-side fact, not a guess derived from the
 * assistant's prose.  It records the exact Hermes/mobile scope in which the
 * previous file turn stopped without a typed send-file receipt.
 */
export type PendingHermesFileTransfer = {
  gatewayId: string;
  sessionKey: string;
  hermesSessionId: string;
  sourceRunId: string;
  createdAt: string;
  updatedAt: string;
  continuationTurns: number;
};

type StoreShape = {
  version: 1;
  pending: Record<string, PendingHermesFileTransfer>;
};

export const HERMES_FILE_TRANSFER_PENDING_TTL_MS = 10 * 60_000;
export const HERMES_FILE_TRANSFER_MAX_CONTINUATION_TURNS = 2;

let mutationChain: Promise<void> = Promise.resolve();

function storePath(): string {
  const explicit = process.env.CLAWCONNECT_HERMES_FILE_TRANSFER_STORE?.trim();
  if (explicit) return explicit;
  // Test/diagnostic Hermes binaries are intentionally isolated from the real
  // profile store.  This prevents a fake CLI test from leaving a pending turn
  // that can reroute a later ordinary test (or a user's actual chat).
  const hermesBin = process.env.HERMES_BIN?.trim();
  if (hermesBin) {
    const suffix = createHash("sha256").update(hermesBin).digest("hex").slice(0, 16);
    return join(tmpdir(), `clawconnect-hermes-pending-${suffix}.json`);
  }
  return `${homedir()}/.clawconnect/hermes/pending-file-transfers.json`;
}

export function pendingHermesFileTransferKey(gatewayId: string, sessionKey: string): string {
  return JSON.stringify([gatewayId.trim(), sessionKey.trim()]);
}

export async function getPendingHermesFileTransfer(params: {
  gatewayId: string;
  sessionKey: string;
  hermesSessionId?: string;
  sourceRunId?: string;
  nowMs?: number;
}): Promise<PendingHermesFileTransfer | undefined> {
  const gatewayId = params.gatewayId.trim();
  const sessionKey = params.sessionKey.trim();
  if (!gatewayId || !sessionKey) return undefined;
  const key = pendingHermesFileTransferKey(gatewayId, sessionKey);
  const nowMs = params.nowMs ?? Date.now();
  let expired = false;
  const store = await readStore();
  const pending = store.pending[key];
  if (!pending) return undefined;
  if (isExpired(pending, nowMs)
    || pending.continuationTurns >= HERMES_FILE_TRANSFER_MAX_CONTINUATION_TURNS
    || (params.hermesSessionId && pending.hermesSessionId !== params.hermesSessionId)
    || (params.sourceRunId && pending.sourceRunId === params.sourceRunId)) {
    expired = true;
  }
  if (expired) {
    await mutateStore((next) => {
      delete next.pending[key];
    });
    return undefined;
  }
  return pending;
}

export async function recordPendingHermesFileTransfer(params: {
  gatewayId: string;
  sessionKey: string;
  hermesSessionId?: string;
  sourceRunId?: string;
  nowMs?: number;
  continuation?: boolean;
}): Promise<PendingHermesFileTransfer | undefined> {
  const gatewayId = params.gatewayId.trim();
  const sessionKey = params.sessionKey.trim();
  const hermesSessionId = params.hermesSessionId?.trim() ?? "";
  const sourceRunId = params.sourceRunId?.trim() ?? "";
  if (!gatewayId || !sessionKey || !hermesSessionId || !sourceRunId) return undefined;
  const now = new Date(params.nowMs ?? Date.now()).toISOString();
  const key = pendingHermesFileTransferKey(gatewayId, sessionKey);
  let result: PendingHermesFileTransfer | undefined;
  await mutateStore((store) => {
    const previous = store.pending[key];
    const continuationTurns = params.continuation
      ? (previous?.continuationTurns ?? 0) + 1
      : 0;
    const next: PendingHermesFileTransfer = {
      gatewayId,
      sessionKey,
      hermesSessionId,
      sourceRunId,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      continuationTurns,
    };
    if (continuationTurns >= HERMES_FILE_TRANSFER_MAX_CONTINUATION_TURNS) {
      delete store.pending[key];
      result = undefined;
      return;
    }
    store.pending[key] = next;
    result = next;
  });
  return result;
}

export async function clearPendingHermesFileTransfer(
  gatewayId: string,
  sessionKey: string,
  expectedSourceRunId?: string,
): Promise<void> {
  const key = pendingHermesFileTransferKey(gatewayId, sessionKey);
  await mutateStore((store) => {
    if (expectedSourceRunId && store.pending[key]?.sourceRunId !== expectedSourceRunId) {
      return;
    }
    delete store.pending[key];
  });
}

function isExpired(pending: PendingHermesFileTransfer, nowMs: number): boolean {
  const updatedAt = Date.parse(pending.updatedAt);
  return !Number.isFinite(updatedAt) || nowMs - updatedAt >= HERMES_FILE_TRANSFER_PENDING_TTL_MS;
}

async function readStore(): Promise<StoreShape> {
  const path = storePath();
  if (!existsSync(path)) return { version: 1, pending: {} };
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<StoreShape>;
    return {
      version: 1,
      pending: parsed.pending && typeof parsed.pending === "object" ? parsed.pending : {},
    };
  } catch {
    await quarantineCorruptStore(path);
    return { version: 1, pending: {} };
  }
}

async function writeStore(store: StoreShape): Promise<void> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
  await rename(tempPath, path);
}

async function mutateStore(mutator: (store: StoreShape) => void): Promise<void> {
  const run = mutationChain.then(async () => {
    const store = await readStore();
    mutator(store);
    await writeStore(store);
  });
  mutationChain = run.catch(() => undefined);
  await run;
}

async function quarantineCorruptStore(path: string): Promise<void> {
  try {
    await copyFile(path, `${path}.corrupt-${Date.now()}`);
  } catch {
    // A corrupt-state recovery is best effort; the current turn remains safe.
  }
}
