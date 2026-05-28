
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import {
  HERMES_HOME_DIR,
  HERMES_LOG_DIR,
  HERMES_MODELS_DEV_CACHE_FILE,
  runHermes,
  stripAnsi,
} from "./hermes-runtime-process.js";
import type { HermesUsageSnapshot } from "./hermes-runtime-types.js";
import {
  booleanValue,
  compactStringArray,
  firstNonNegativeInteger,
  firstPositiveInteger,
  mergeHermesUsageSnapshots,
  nonNegativeInteger,
  parseJsonObject,
  parseMaybeJsonObject,
  stringValue,
  toRecord,
} from "./hermes-runtime-values.js";
import {
  listStoredHermesSessions,
  mergeLiveHermesSessionsWithStoredAliases,
  parseHermesSessionsList,
} from "../hermes-session-store.js";

export async function listHermesSessions(): Promise<ReturnType<typeof parseHermesSessionsList>> {
  const output = runHermes(["sessions", "list"]);
  const parsed = parseHermesSessionsList(output);
  const stored = await listStoredHermesSessions();
  return mergeLiveHermesSessionsWithStoredAliases(parsed, stored);
}

export function readHermesStatusSnapshot(): HermesUsageSnapshot {
  try {
    return enrichHermesUsageSnapshot(parseHermesStatusSnapshot(runHermes(["status"], 10_000)));
  } catch {
    return {};
  }
}

export async function collectHermesUsageSnapshot(hermesSessionId?: string): Promise<HermesUsageSnapshot> {
  const status = readHermesStatusSnapshot();
  const sessionId = hermesSessionId ?? (await latestHermesSessionId());
  if (!sessionId) {
    return status;
  }
  try {
    const output = runHermes(["sessions", "export", "-", "--session-id", sessionId], 10 * 60_000);
    return enrichHermesUsageSnapshot(mergeHermesUsageSnapshots(
      status,
      parseHermesSessionUsageSnapshot(output),
      { hermesSessionId: sessionId },
    ));
  } catch {
    return {
      ...status,
      hermesSessionId: sessionId,
    };
  }
}

export function parseHermesStatusSnapshot(output: string): HermesUsageSnapshot {
  const snapshot: HermesUsageSnapshot = {};
  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    const model = line.match(/^Model:\s*(.+)$/i)?.[1]?.trim();
    if (model && model !== "--") {
      snapshot.currentModel = model;
      continue;
    }
    const provider = line.match(/^Provider:\s*(.+)$/i)?.[1]?.trim();
    if (provider && provider !== "--") {
      snapshot.provider = provider;
    }
  }
  return snapshot;
}

export function parseHermesSessionUsageSnapshot(output: string): HermesUsageSnapshot {
  const record = parseJsonObject(output);
  if (!record) {
    return {};
  }
  const modelConfig = parseMaybeJsonObject(record.model_config);
  return mergeHermesUsageSnapshots({
    currentModel: stringValue(record.model) ?? stringValue(record.currentModel) ?? stringValue(record.current_model),
    contextUsage: firstNonNegativeInteger(
      record.input_tokens,
      record.prompt_tokens,
      record.contextUsage,
      record.context_usage,
    ),
    contextLimit: firstPositiveInteger(
      record.contextLimit,
      record.context_limit,
      record.maxInputTokens,
      record.max_input_tokens,
      record.contextWindow,
      record.context_window,
      record.contextTokens,
      record.context_tokens,
      modelConfig?.contextLimit,
      modelConfig?.context_limit,
      modelConfig?.maxInputTokens,
      modelConfig?.max_input_tokens,
      modelConfig?.contextWindow,
      modelConfig?.context_window,
      modelConfig?.contextTokens,
      modelConfig?.context_tokens,
      modelConfig?.maxContextTokens,
      modelConfig?.max_context_tokens,
    ),
  });
}

export function readHermesConfigSnapshot(): { model?: string; provider?: string; providers: string[] } {
  try {
    const raw = readFileSync(join(HERMES_HOME_DIR, "config.yaml"), "utf8");
    const model = raw.match(/^\s{2}default:\s*(.+)\s*$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
    const provider = raw.match(/^\s{2}provider:\s*(.+)\s*$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
    const providers: string[] = [];
    const providerBlock = raw.match(/^providers:\s*\n([\s\S]*?)(?=^[^\s#][^:\n]*:|\Z)/m)?.[1] ?? "";
    for (const match of providerBlock.matchAll(/^\s{2}([^:\s][^:]*):\s*$/gm)) {
      providers.push(match[1].trim());
    }
    return { model, provider, providers };
  } catch {
    return { providers: [] };
  }
}

export function hermesConfiguredProviderIds(config: { provider?: string; providers: string[] }, currentProvider?: string): string[] {
  const ids: string[] = [];
  for (const candidate of [config.provider, ...config.providers]) {
    if (candidate && candidate.trim().length > 0 && !ids.some((id) => normalizedProviderMatches(id, candidate))) {
      ids.push(candidate.trim());
    }
  }
  if (currentProvider && !ids.some((id) => normalizedProviderMatches(id, currentProvider))) {
    ids.push(currentProvider.trim());
  }
  return ids;
}

export function isHermesChatModel(modelId: string, modelRecord: Record<string, unknown>): boolean {
  const family = stringValue(modelRecord.family)?.toLowerCase() ?? "";
  const normalizedId = modelId.toLowerCase();
  if (family.includes("embedding") || normalizedId.includes("embedding")) {
    return false;
  }
  const modalities = toRecord(modelRecord.modalities);
  const output = Array.isArray(modalities.output) ? modalities.output : undefined;
  return !output || output.includes("text");
}

async function latestHermesSessionId(): Promise<string | undefined> {
  const sessions = await listHermesSessions();
  return sessions[0]?.hermesSessionId;
}

function enrichHermesUsageSnapshot(snapshot: HermesUsageSnapshot): HermesUsageSnapshot {
  if (!snapshot.currentModel || snapshot.contextLimit !== undefined) {
    return snapshot;
  }
  const contextLimit = readHermesContextLimit(snapshot.currentModel, snapshot.provider);
  return contextLimit !== undefined ? { ...snapshot, contextLimit } : snapshot;
}

export function readHermesContextLimit(model: string, provider?: string): number | undefined {
  return readHermesContextLimitFromLogs(model)
    ?? readHermesContextLimitFromModelsDevCache(model, provider);
}

function readHermesContextLimitFromLogs(model: string): number | undefined {
  const normalizedModel = normalizeModelId(model);
  try {
    const logFiles = readdirSync(HERMES_LOG_DIR)
      .filter((name) => name.endsWith(".log"))
      .map((name) => join(HERMES_LOG_DIR, name))
      .sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs);
    let latest: number | undefined;
    for (const filePath of logFiles) {
      const content = readFileSync(filePath, "utf8");
      const pattern = /Cached context length\s+([^\s@]+)@[^\n]*?->\s*([\d,]+)\s*tokens/gi;
      for (const match of content.matchAll(pattern)) {
        if (normalizeModelId(match[1]) !== normalizedModel) {
          continue;
        }
        const parsed = nonNegativeInteger(match[2]?.replace(/,/g, ""));
        if (parsed !== undefined && parsed > 0) {
          latest = parsed;
        }
      }
    }
    return latest;
  } catch {
    return undefined;
  }
}

function readHermesContextLimitFromModelsDevCache(model: string, provider?: string): number | undefined {
  try {
    const raw = readFileSync(HERMES_MODELS_DEV_CACHE_FILE, "utf8");
    const cache = JSON.parse(raw) as unknown;
    if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
      return undefined;
    }
    const providerId = hermesModelsDevProviderId(provider);
    if (!providerId) {
      return undefined;
    }
    const providerRecord = toRecord((cache as Record<string, unknown>)[providerId]);
    const models = toRecord(providerRecord.models);
    const normalizedModel = normalizeModelId(model);
    for (const [candidate, entry] of Object.entries(models)) {
      if (normalizeModelId(candidate) !== normalizedModel) {
        continue;
      }
      const limit = toRecord(toRecord(entry).limit);
      const parsed = firstPositiveInteger(
        limit.context,
        limit.input,
        toRecord(entry).context_window,
        toRecord(entry).contextWindow,
      );
      if (parsed !== undefined) {
        return parsed;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function hermesModelsDevProviderId(provider?: string): string | undefined {
  const normalized = provider?.toLowerCase() ?? "";
  if (normalized.includes("openai")) {
    return "openai";
  }
  if (normalized.includes("minimax")) {
    return "minimax";
  }
  if (normalized.includes("anthropic")) {
    return "anthropic";
  }
  if (normalized.includes("google") || normalized.includes("gemini")) {
    return "google";
  }
  if (normalized.includes("deepseek")) {
    return "deepseek";
  }
  if (normalized.includes("openrouter")) {
    return "openrouter";
  }
  const explicitProvider = provider?.trim().toLowerCase();
  return explicitProvider || undefined;
}

export function normalizeModelId(model: string | undefined): string {
  const normalized = model?.trim().toLowerCase() ?? "";
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

export function normalizeProviderId(provider: string | undefined): string {
  return provider?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "") ?? "";
}

export function normalizedProviderMatches(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeProviderId(left);
  const normalizedRight = normalizeProviderId(right);
  return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
}
