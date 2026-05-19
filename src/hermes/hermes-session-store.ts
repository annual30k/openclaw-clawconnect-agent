import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";

export interface HermesSessionItem {
  sessionKey: string;
  hermesSessionId: string;
  displayName?: string;
  derivedTitle?: string;
  label?: string;
  lastActivityAt?: string;
  kind: "hermes";
}

interface StoredHermesSession {
  sessionKey: string;
  hermesSessionId: string;
  displayName?: string;
  preview?: string;
  lastActivityAt?: string;
  updatedAt: string;
}

interface StoreShape {
  version: 1;
  sessions: Record<string, StoredHermesSession>;
}

const STORE_PATH = process.env.CLAWCONNECT_HERMES_SESSION_STORE
  ?? join(homedir(), ".clawconnect", "hermes", "sessions.json");

const HERMES_ID_PATTERN = /\b\d{8}_\d{6}_[A-Za-z0-9]+\b/;

export async function getMappedHermesSessionId(sessionKey: string): Promise<string | undefined> {
  if (sessionKey.startsWith("hermes:")) {
    return sessionKey.slice("hermes:".length).trim() || undefined;
  }
  const store = await readStore();
  return store.sessions[sessionKey]?.hermesSessionId;
}

export async function rememberHermesSession(sessionKey: string, item: HermesSessionItem): Promise<void> {
  const store = await readStore();
  const now = new Date().toISOString();
  store.sessions[sessionKey] = {
    sessionKey,
    hermesSessionId: item.hermesSessionId,
    displayName: item.displayName ?? item.derivedTitle ?? item.hermesSessionId,
    preview: item.label,
    lastActivityAt: item.lastActivityAt ?? now,
    updatedAt: now,
  };
  await writeStore(store);
}

export async function forgetHermesSession(sessionKeyOrId: string, hermesSessionId?: string): Promise<void> {
  const store = await readStore();
  const normalizedSessionKey = sessionKeyOrId.trim();
  const normalizedHermesId = hermesSessionId?.trim() || normalizedSessionKey;
  let changed = false;

  for (const [key, item] of Object.entries(store.sessions)) {
    if (key === normalizedSessionKey || item.sessionKey === normalizedSessionKey || item.hermesSessionId === normalizedHermesId) {
      delete store.sessions[key];
      changed = true;
    }
  }

  if (changed) {
    await writeStore(store);
  }
}

export async function listStoredHermesSessions(): Promise<HermesSessionItem[]> {
  const store = await readStore();
  return Object.values(store.sessions).map((item) => ({
    sessionKey: item.sessionKey,
    hermesSessionId: item.hermesSessionId,
    displayName: item.displayName,
    derivedTitle: item.displayName,
    label: item.preview,
    lastActivityAt: item.lastActivityAt ?? item.updatedAt,
    kind: "hermes",
  }));
}

export function mergeLiveHermesSessionsWithStoredAliases(
  liveSessions: HermesSessionItem[],
  storedSessions: HermesSessionItem[],
): HermesSessionItem[] {
  if (liveSessions.length === 0) {
    return sortHermesSessions(storedSessions);
  }

  return sortHermesSessions(liveSessions.map((liveSession) => {
    const aliases = storedSessions.filter((stored) => stored.hermesSessionId === liveSession.hermesSessionId);
    const preferredAlias =
      aliases.find((stored) => !stored.sessionKey.toLowerCase().startsWith("hermes:"))
      ?? aliases[0];
    if (!preferredAlias) {
      return liveSession;
    }

    return {
      ...liveSession,
      sessionKey: preferredAlias.sessionKey,
      displayName: liveSession.displayName ?? preferredAlias.displayName,
      derivedTitle: liveSession.derivedTitle ?? preferredAlias.derivedTitle,
      label: liveSession.label ?? preferredAlias.label,
      lastActivityAt: liveSession.lastActivityAt ?? preferredAlias.lastActivityAt,
    };
  }));
}

export function parseHermesSessionsList(output: string, now = new Date()): HermesSessionItem[] {
  const items: HermesSessionItem[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("Title ") || line.startsWith("─")) {
      continue;
    }
    const idMatch = line.match(HERMES_ID_PATTERN);
    if (!idMatch) {
      continue;
    }
    const hermesSessionId = idMatch[0];
    const beforeId = line.slice(0, idMatch.index).trimEnd();
    const columns = beforeId.split(/\s{2,}/).map((value) => value.trim()).filter(Boolean);
    const title = columns[0] && columns[0] !== "—" ? columns[0] : undefined;
    const preview = columns.length > 1 && columns[1] !== "—" ? columns[1] : undefined;
    const lastActiveText = columns.length > 2 ? columns.slice(2).join(" ") : undefined;
    items.push({
      sessionKey: `hermes:${hermesSessionId}`,
      hermesSessionId,
      displayName: title ?? preview ?? hermesSessionId,
      derivedTitle: title ?? preview,
      label: preview,
      lastActivityAt: parseRelativeLastActive(lastActiveText, now),
      kind: "hermes",
    });
  }
  return items;
}

function sortHermesSessions(sessions: HermesSessionItem[]): HermesSessionItem[] {
  return [...sessions].sort((left, right) => {
    const leftTime = left.lastActivityAt ? Date.parse(left.lastActivityAt) : 0;
    const rightTime = right.lastActivityAt ? Date.parse(right.lastActivityAt) : 0;
    return rightTime - leftTime;
  });
}

async function readStore(): Promise<StoreShape> {
  if (!existsSync(STORE_PATH)) {
    return { version: 1, sessions: {} };
  }
  try {
    const raw = await readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    return {
      version: 1,
      sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
    };
  } catch {
    return { version: 1, sessions: {} };
  }
}

async function writeStore(store: StoreShape): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

function parseRelativeLastActive(value: string | undefined, now: Date): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "just now" || normalized === "now") {
    return now.toISOString();
  }
  const match = normalized.match(/^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)\s+ago$/);
  if (!match) {
    return undefined;
  }
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  const ms =
    unit.startsWith("s") ? amount * 1000
      : unit.startsWith("m") ? amount * 60_000
        : unit.startsWith("h") ? amount * 3_600_000
          : amount * 86_400_000;
  return new Date(now.getTime() - ms).toISOString();
}
