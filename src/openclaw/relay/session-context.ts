import { isAbsolute, join, resolve } from "path";
import { open as openFile, readFile } from "fs/promises";
import { resolveOpenClawStateDir } from "../runtime/openclaw-paths.js";

const TRANSCRIPT_TAIL_CHUNK_BYTES = 64 * 1024;

export type GatewaySessionDefaults = {
  mainSessionKey: string;
  mainKey: string;
  defaultAgentId?: string;
};

export type ContextUsageSnapshot = {
  sessionKey: string;
  currentModel?: string;
  contextUsage?: number;
  contextLimit?: number;
  promptTokens?: number;
  totalTokens?: number;
};

/**
 * OpenClaw 2026.8 stores live session metadata in SQLite instead of the old
 * sessions.json index. Keep usage collection on the public gateway response
 * so it remains compatible with both storage backends.
 */
export function contextUsageSnapshotFromSessionsList(
  payload: unknown,
  sessionKey: string,
  defaults: GatewaySessionDefaults,
): ContextUsageSnapshot | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const sessions = Array.isArray(record.sessions) ? record.sessions : [];
  const targetKeys = sessionKeyCandidates(sessionKey, defaults);
  const session = sessions.find((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const key = typeof (candidate as Record<string, unknown>).key === "string"
      ? (candidate as Record<string, unknown>).key
      : "";
    return [...sessionKeyCandidates(key, defaults)].some((candidateKey) => targetKeys.has(candidateKey));
  }) as Record<string, unknown> | undefined;
  if (!session) {
    return null;
  }

  const payloadDefaults = record.defaults && typeof record.defaults === "object" && !Array.isArray(record.defaults)
    ? record.defaults as Record<string, unknown>
    : {};
  const budget = session.contextBudgetStatus && typeof session.contextBudgetStatus === "object" && !Array.isArray(session.contextBudgetStatus)
    ? session.contextBudgetStatus as Record<string, unknown>
    : {};
  const contextUsage = firstNonNegativeInteger(
    session.inputTokens,
    session.promptTokens,
    budget.estimatedPromptTokens,
    session.totalTokens,
  );
  const contextLimit = firstPositiveInteger(session.contextTokens, payloadDefaults.contextTokens);
  const currentModel = firstNonEmptyString(session.model, session.currentModel, payloadDefaults.model);
  if (contextUsage === undefined && contextLimit === undefined && !currentModel) {
    return null;
  }
  return {
    sessionKey: canonicalizeSessionKey(sessionKey, defaults) as string,
    ...(currentModel ? { currentModel } : {}),
    ...(contextUsage !== undefined ? { contextUsage, promptTokens: contextUsage } : {}),
    ...(contextLimit !== undefined ? { contextLimit } : {}),
  };
}

export function buildContextUsageFingerprint(snapshot: ContextUsageSnapshot): string {
  return JSON.stringify({
    currentModel: snapshot.currentModel ?? null,
    contextUsage: snapshot.promptTokens ?? snapshot.contextUsage ?? null,
    contextLimit: snapshot.contextLimit ?? null,
  });
}

type SessionStoreEntry = {
  sessionId?: string;
  model?: string;
  contextTokens?: number;
  totalTokens?: number | null;
  inputTokens?: number;
  outputTokens?: number;
  sessionFile?: string;
  transcriptPath?: string;
};

export type OpenClawSessionTranscript = {
  sessionKey: string;
  sessionId?: string;
  logPath: string;
};

type TranscriptUsageSnapshot = {
  promptTokens: number;
  total: number;
  model?: string;
};

type NormalizedUsageRecord = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total?: number;
  promptTokens?: number;
};

export const DEFAULT_GATEWAY_SESSION_DEFAULTS: GatewaySessionDefaults = {
  mainSessionKey: "main",
  mainKey: "main",
};

export async function readContextUsageSnapshot(
  sessionKey: string,
  defaults: GatewaySessionDefaults,
): Promise<ContextUsageSnapshot | null> {
  const entry = await readSessionStoreEntry(sessionKey, defaults);
  if (!entry) {
    return null;
  }

  const contextLimit = toPositiveInteger(entry.contextTokens);
  let currentModel = typeof entry.model === "string" && entry.model.trim().length > 0 ? entry.model.trim() : undefined;
  let contextUsage = deriveStoredContextUsage(entry);
  let promptTokens: number | undefined;
  let totalTokens: number | undefined;

  if (typeof entry.sessionId === "string" && entry.sessionId.trim().length > 0) {
      const transcriptUsage = await readUsageFromSessionLog(sessionKey, entry.sessionId.trim(), entry, defaults);
      if (transcriptUsage) {
        if (contextUsage === undefined || contextUsage === 0 || transcriptUsage.promptTokens > contextUsage) {
          contextUsage = transcriptUsage.promptTokens;
        }
        promptTokens = transcriptUsage.promptTokens;
        totalTokens = transcriptUsage.total;
        if (!currentModel && transcriptUsage.model) {
          currentModel = transcriptUsage.model;
        }
      }
  }

  if (contextUsage !== undefined && contextUsage > 0) {
    if (promptTokens === undefined || promptTokens === 0) {
      promptTokens = contextUsage;
    }
    if (totalTokens === undefined || totalTokens === 0) {
      totalTokens = contextUsage;
    }
  }

  if (!currentModel && !contextLimit && contextUsage === undefined) {
    return null;
  }

  return {
    sessionKey,
    currentModel,
    contextUsage,
    contextLimit,
    promptTokens,
    totalTokens,
  };
}

export function extractGatewaySessionDefaults(rawPayload: unknown): GatewaySessionDefaults | null {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return null;
  }
  const payload = rawPayload as Record<string, unknown>;
  const snapshot =
    payload.snapshot && typeof payload.snapshot === "object" && !Array.isArray(payload.snapshot)
      ? (payload.snapshot as Record<string, unknown>)
      : undefined;
  const sessionDefaultsRaw =
    snapshot?.sessionDefaults && typeof snapshot.sessionDefaults === "object" && !Array.isArray(snapshot.sessionDefaults)
      ? (snapshot.sessionDefaults as Record<string, unknown>)
      : snapshot?.sessiondefaults && typeof snapshot.sessiondefaults === "object" && !Array.isArray(snapshot.sessiondefaults)
        ? (snapshot.sessiondefaults as Record<string, unknown>)
        : undefined;

  const mainSessionKey =
    typeof sessionDefaultsRaw?.mainSessionKey === "string"
      ? sessionDefaultsRaw.mainSessionKey.trim()
      : "";
  const mainKey = typeof sessionDefaultsRaw?.mainKey === "string" ? sessionDefaultsRaw.mainKey.trim() : "";
  const defaultAgentId = typeof sessionDefaultsRaw?.defaultAgentId === "string"
    ? sessionDefaultsRaw.defaultAgentId.trim()
    : "";

  if (mainSessionKey) {
    return {
      mainSessionKey,
      mainKey: mainKey || "main",
      defaultAgentId: defaultAgentId || undefined,
    };
  }

  const config =
    payload.config && typeof payload.config === "object" && !Array.isArray(payload.config)
      ? (payload.config as Record<string, unknown>)
      : undefined;
  const session =
    config?.session && typeof config.session === "object" && !Array.isArray(config.session)
      ? (config.session as Record<string, unknown>)
      : undefined;
  const scope = typeof session?.scope === "string" ? session.scope.trim() : "";
  if (scope === "global") {
    return {
      mainSessionKey: "global",
      mainKey: "global",
    };
  }

  return null;
}

export function canonicalizeSessionKey(rawValue: unknown, defaults: GatewaySessionDefaults): string | unknown {
  if (typeof rawValue !== "string") {
    return rawValue;
  }
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return trimmed;
  }

  const mainKey = defaults.mainKey || "main";
  const isMainAlias =
    trimmed === "main" ||
    trimmed === mainKey ||
    trimmed === defaults.mainSessionKey ||
    (defaults.defaultAgentId
      ? trimmed === `agent:${defaults.defaultAgentId}:main` || trimmed === `agent:${defaults.defaultAgentId}:${mainKey}`
      : false);

  return isMainAlias ? defaults.mainSessionKey : trimmed;
}

export function canonicalizeRelayParams(
  method: string,
  rawParams: unknown,
  defaults: GatewaySessionDefaults,
): unknown {
  if (!shouldCanonicalizeSessionKey(method)) {
    return rawParams;
  }
  if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
    return rawParams;
  }
  const params = rawParams as Record<string, unknown>;
  if (!("sessionKey" in params)) {
    return rawParams;
  }
  return {
    ...params,
    sessionKey: canonicalizeSessionKey(params.sessionKey, defaults),
  };
}

export async function resolveOpenClawSessionTranscript(
  sessionKey: string,
  defaults: GatewaySessionDefaults,
): Promise<OpenClawSessionTranscript | null> {
  const normalizedSessionKey = canonicalizeSessionKey(sessionKey, defaults);
  if (typeof normalizedSessionKey !== "string" || normalizedSessionKey.trim().length === 0) {
    return null;
  }

  const resolvedSessionKey = normalizedSessionKey.trim();
  const entry = await readSessionStoreEntry(resolvedSessionKey, defaults);
  if (!entry) {
    return null;
  }

  const sessionId = typeof entry.sessionId === "string" && entry.sessionId.trim().length > 0
    ? entry.sessionId.trim()
    : undefined;
  const explicitLogPath =
    typeof entry.sessionFile === "string" && entry.sessionFile.trim().length > 0
      ? entry.sessionFile.trim()
      : typeof entry.transcriptPath === "string" && entry.transcriptPath.trim().length > 0
        ? entry.transcriptPath.trim()
        : undefined;
  if (!sessionId && !explicitLogPath) {
    return null;
  }

  return {
    sessionKey: resolvedSessionKey,
    ...(sessionId ? { sessionId } : {}),
    logPath: resolveSessionLogPath(resolvedSessionKey, sessionId ?? "session", entry, defaults),
  };
}

function toFiniteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

function toNonNegativeInteger(value: unknown): number | undefined {
  const normalized = toFiniteInteger(value);
  return typeof normalized === "number" && normalized >= 0 ? normalized : undefined;
}

function toPositiveInteger(value: unknown): number | undefined {
  const normalized = toNonNegativeInteger(value);
  return typeof normalized === "number" && normalized > 0 ? normalized : undefined;
}

function firstNonNegativeInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const normalized = toNonNegativeInteger(value);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

function firstPositiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const normalized = toPositiveInteger(value);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function sessionKeyCandidates(rawValue: unknown, defaults: GatewaySessionDefaults): Set<string> {
  if (typeof rawValue !== "string" || !rawValue.trim()) return new Set();
  const key = canonicalizeSessionKey(rawValue, defaults);
  if (typeof key !== "string" || !key.trim()) return new Set();
  const normalized = key.trim();
  const result = new Set([normalized]);
  const qualified = normalized.match(/^agent:[^:]+:(.+)$/)?.[1];
  if (qualified) {
    result.add(qualified);
  } else {
    result.add(`agent:${defaults.defaultAgentId || "main"}:${normalized}`);
  }
  return result;
}

function resolveAgentIdFromSessionKey(sessionKey: string, defaults: GatewaySessionDefaults): string {
  const match = sessionKey.match(/^agent:([^:]+):/);
  if (match?.[1]) {
    return match[1];
  }
  return defaults.defaultAgentId || "main";
}

function resolveOpenClawHome(): string {
  return resolveOpenClawStateDir();
}

function resolveSessionsDir(sessionKey: string, defaults: GatewaySessionDefaults): string {
  return join(resolveOpenClawHome(), "agents", resolveAgentIdFromSessionKey(sessionKey, defaults), "sessions");
}

async function readSessionStoreEntry(
  sessionKey: string,
  defaults: GatewaySessionDefaults,
): Promise<SessionStoreEntry | null> {
  const storePath = join(resolveSessionsDir(sessionKey, defaults), "sessions.json");
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, SessionStoreEntry>;
    const directEntry = parsed?.[sessionKey];
    if (directEntry && typeof directEntry === "object") {
      return directEntry;
    }

    const agentId = resolveAgentIdFromSessionKey(sessionKey, defaults);
    const agentQualifiedKey = sessionKey.startsWith("agent:")
      ? undefined
      : `agent:${agentId}:${sessionKey}`;
    if (agentQualifiedKey) {
      const agentQualifiedEntry = parsed?.[agentQualifiedKey];
      if (agentQualifiedEntry && typeof agentQualifiedEntry === "object") {
        return agentQualifiedEntry;
      }
    }

    const mainAliases = new Set([sessionKey, defaults.mainSessionKey, defaults.mainKey, "main"]);
    const defaultAgentMainKey = defaults.defaultAgentId ? `agent:${defaults.defaultAgentId}:main` : undefined;
    if (defaultAgentMainKey) {
      const defaultEntry = parsed?.[defaultAgentMainKey];
      if (defaultEntry && typeof defaultEntry === "object" && mainAliases.has(sessionKey)) {
        return defaultEntry;
      }
    }

    if (mainAliases.has(sessionKey)) {
      const mainEntry = Object.entries(parsed).find(([key]) => key.endsWith(":main"))?.[1];
      if (mainEntry && typeof mainEntry === "object") {
        return mainEntry;
      }

      const firstEntry = Object.values(parsed).find((value) => value && typeof value === "object");
      return firstEntry ?? null;
    }

    return null;
  } catch {
    return null;
  }
}

function normalizeUsageRecord(rawUsage: unknown): NormalizedUsageRecord | undefined {
  if (!rawUsage || typeof rawUsage !== "object" || Array.isArray(rawUsage)) {
    return undefined;
  }
  const usage = rawUsage as Record<string, unknown>;
  const hasKnownField =
    Object.prototype.hasOwnProperty.call(usage, "input") ||
    Object.prototype.hasOwnProperty.call(usage, "output") ||
    Object.prototype.hasOwnProperty.call(usage, "cacheRead") ||
    Object.prototype.hasOwnProperty.call(usage, "cacheWrite") ||
    Object.prototype.hasOwnProperty.call(usage, "total") ||
    Object.prototype.hasOwnProperty.call(usage, "totalTokens") ||
    Object.prototype.hasOwnProperty.call(usage, "total_tokens") ||
    Object.prototype.hasOwnProperty.call(usage, "promptTokens") ||
    Object.prototype.hasOwnProperty.call(usage, "prompt_tokens");

  if (!hasKnownField) {
    return undefined;
  }

  const input = toNonNegativeInteger(usage.input) ?? 0;
  const output = toNonNegativeInteger(usage.output) ?? 0;
  const cacheRead = toNonNegativeInteger(usage.cacheRead) ?? 0;
  const cacheWrite = toNonNegativeInteger(usage.cacheWrite) ?? 0;
  const total =
    toNonNegativeInteger(usage.total) ??
    toNonNegativeInteger(usage.totalTokens) ??
    toNonNegativeInteger(usage.total_tokens);
  const promptTokens =
    toNonNegativeInteger(usage.promptTokens) ??
    toNonNegativeInteger(usage.prompt_tokens);

  return {
    input: Math.max(0, input),
    output: Math.max(0, output),
    cacheRead: Math.max(0, cacheRead),
    cacheWrite: Math.max(0, cacheWrite),
    total,
    promptTokens,
  };
}

function derivePromptTokens(usage: NormalizedUsageRecord): number | undefined {
  if (usage.promptTokens !== undefined) {
    return usage.promptTokens;
  }
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

function resolveSessionLogPath(
  sessionKey: string,
  sessionId: string,
  entry: SessionStoreEntry | null,
  defaults: GatewaySessionDefaults,
): string {
  const sessionsDir = resolveSessionsDir(sessionKey, defaults);
  const candidate =
    typeof entry?.sessionFile === "string" && entry.sessionFile.trim().length > 0
      ? entry.sessionFile.trim()
      : typeof entry?.transcriptPath === "string" && entry.transcriptPath.trim().length > 0
        ? entry.transcriptPath.trim()
        : "";

  if (!candidate) {
    return join(sessionsDir, `${sessionId}.jsonl`);
  }

  return isAbsolute(candidate) ? candidate : resolve(sessionsDir, candidate);
}

async function readFileTail(filePath: string, maxBytes = TRANSCRIPT_TAIL_CHUNK_BYTES): Promise<string | null> {
  const handle = await openFile(filePath, "r");
  try {
    const stats = await handle.stat();
    const size = Math.max(0, Math.floor(stats.size));
    if (size === 0) {
      return null;
    }
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const offset = Math.max(0, size - length);
    await handle.read(buffer, 0, length, offset);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readUsageFromSessionLog(
  sessionKey: string,
  sessionId: string,
  entry: SessionStoreEntry | null,
  defaults: GatewaySessionDefaults,
): Promise<TranscriptUsageSnapshot | null> {
  const logPath = resolveSessionLogPath(sessionKey, sessionId, entry, defaults);

  try {
    const tail = await readFileTail(logPath);
    if (!tail) {
      return null;
    }

    const offset = tail.indexOf("\n");
    const lines = (offset > 0 ? tail.slice(offset + 1) : tail).split(/\n+/);
    let lastUsage: NormalizedUsageRecord | undefined;
    let model: string | undefined;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const message =
          parsed.message && typeof parsed.message === "object" && !Array.isArray(parsed.message)
            ? (parsed.message as Record<string, unknown>)
            : undefined;
        const usage = normalizeUsageRecord(message?.usage ?? parsed.usage);
        if (usage) {
          lastUsage = usage;
        }
        if (typeof message?.model === "string" && message.model.trim().length > 0) {
          model = message.model.trim();
        } else if (typeof parsed.model === "string" && parsed.model.trim().length > 0) {
          model = parsed.model.trim();
        }
      } catch {
        // Ignore malformed transcript lines.
      }
    }

    if (!lastUsage) {
      return null;
    }

    const promptTokens = derivePromptTokens(lastUsage) ?? lastUsage.total ?? lastUsage.input + lastUsage.output;
    const total = lastUsage.total ?? promptTokens + lastUsage.output;

    return {
      promptTokens,
      total,
      model,
    };
  } catch {
    return null;
  }
}

function deriveStoredContextUsage(entry: SessionStoreEntry | null): number | undefined {
  if (!entry) {
    return undefined;
  }
  const total = toNonNegativeInteger(entry.totalTokens);
  if (typeof total === "number") {
    return total;
  }
  const input = toFiniteInteger(entry.inputTokens) ?? 0;
  const output = toFiniteInteger(entry.outputTokens) ?? 0;
  const fallback = input + output;
  if (fallback > 0) {
    return fallback;
  }
  if (
    Object.prototype.hasOwnProperty.call(entry, "inputTokens") ||
    Object.prototype.hasOwnProperty.call(entry, "outputTokens") ||
    Object.prototype.hasOwnProperty.call(entry, "totalTokens")
  ) {
    return 0;
  }
  return undefined;
}

function shouldCanonicalizeSessionKey(method: string): boolean {
  return method === "chat.send" || method === "chat.history" || method === "chat.abort" || method === "agent";
}
