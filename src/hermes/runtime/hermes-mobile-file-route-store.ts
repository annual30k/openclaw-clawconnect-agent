import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type HermesMobileFileRoute = {
  hermesSessionId: string;
  gatewayId: string;
  sessionKey: string;
  sourceRunId: string;
  expiresAt: string;
};

type StoreShape = {
  version: 1;
  routes: Record<string, HermesMobileFileRoute>;
};

export const HERMES_MOBILE_FILE_ROUTE_TTL_MS = 10 * 60_000;

let mutationChain: Promise<void> = Promise.resolve();

function storePath(): string {
  return process.env.CLAWCONNECT_HERMES_MOBILE_FILE_ROUTE_STORE?.trim()
    || join(homedir(), ".clawconnect", "hermes", "mobile-file-routes.json");
}

export async function registerHermesMobileFileRoute(params: {
  hermesSessionId: string;
  gatewayId: string;
  sessionKey: string;
  sourceRunId: string;
  nowMs?: number;
}): Promise<HermesMobileFileRoute | undefined> {
  const hermesSessionId = params.hermesSessionId.trim();
  const gatewayId = params.gatewayId.trim();
  const sessionKey = params.sessionKey.trim();
  const sourceRunId = params.sourceRunId.trim();
  if (!hermesSessionId || !gatewayId || !sessionKey || !sourceRunId) return undefined;
  const nowMs = params.nowMs ?? Date.now();
  const route: HermesMobileFileRoute = {
    hermesSessionId,
    gatewayId,
    sessionKey,
    sourceRunId,
    expiresAt: new Date(nowMs + HERMES_MOBILE_FILE_ROUTE_TTL_MS).toISOString(),
  };
  await mutateStore((store) => {
    pruneExpiredRoutes(store, nowMs);
    store.routes[hermesSessionId] = route;
  });
  return route;
}

export async function readHermesMobileFileRoute(
  hermesSessionId: string,
  nowMs = Date.now(),
): Promise<HermesMobileFileRoute | undefined> {
  const normalizedSessionId = hermesSessionId.trim();
  if (!normalizedSessionId) return undefined;
  const store = await readStore();
  const route = store.routes[normalizedSessionId];
  if (!route || isExpired(route, nowMs)) return undefined;
  return route;
}

export async function clearHermesMobileFileRoute(
  hermesSessionId: string,
  expectedSourceRunId: string,
): Promise<void> {
  const normalizedSessionId = hermesSessionId.trim();
  const normalizedSourceRunId = expectedSourceRunId.trim();
  if (!normalizedSessionId || !normalizedSourceRunId) return;
  await mutateStore((store) => {
    if (store.routes[normalizedSessionId]?.sourceRunId === normalizedSourceRunId) {
      delete store.routes[normalizedSessionId];
    }
  });
}

function isExpired(route: HermesMobileFileRoute, nowMs: number): boolean {
  const expiresAt = Date.parse(route.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= nowMs;
}

function pruneExpiredRoutes(store: StoreShape, nowMs: number): void {
  for (const [sessionId, route] of Object.entries(store.routes)) {
    if (isExpired(route, nowMs)) delete store.routes[sessionId];
  }
}

async function readStore(): Promise<StoreShape> {
  const path = storePath();
  if (!existsSync(path)) return { version: 1, routes: {} };
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<StoreShape>;
    return {
      version: 1,
      routes: parsed.routes && typeof parsed.routes === "object" ? parsed.routes : {},
    };
  } catch {
    await quarantineCorruptStore(path);
    return { version: 1, routes: {} };
  }
}

async function writeStore(store: StoreShape): Promise<void> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
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
    // Route recovery is best effort; an unreadable lease must fail closed.
  }
}
