import { readdir, readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export async function inferLatestOpenClawSessionKey(sessionStoreRoot = join(homedir(), ".openclaw")): Promise<string | undefined> {
  const agentsDir = join(sessionStoreRoot, "agents");
  let agentEntries;
  try {
    agentEntries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  let latestSessionKey: string | undefined;
  let latestUpdatedAt = -1;

  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory()) {
      continue;
    }

    const sessionsPath = join(agentsDir, agentEntry.name, "sessions", "sessions.json");
    let rawStore: string;
    try {
      rawStore = await readFile(sessionsPath, "utf8");
    } catch {
      continue;
    }

    let parsedStore: unknown;
    try {
      parsedStore = JSON.parse(rawStore);
    } catch {
      continue;
    }
    if (!parsedStore || typeof parsedStore !== "object" || Array.isArray(parsedStore)) {
      continue;
    }

    for (const [sessionKey, value] of Object.entries(parsedStore as Record<string, unknown>)) {
      if (!sessionKey.startsWith(`agent:${agentEntry.name}:`)) {
        continue;
      }

      const updatedAt = extractSessionUpdatedAt(value);
      if (updatedAt === undefined || updatedAt <= latestUpdatedAt) {
        continue;
      }

      latestSessionKey = sessionKey;
      latestUpdatedAt = updatedAt;
    }
  }

  return latestSessionKey;
}

function extractSessionUpdatedAt(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const candidateValues = [record.updatedAt, record.startedAt];
  for (const candidate of candidateValues) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string") {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}
