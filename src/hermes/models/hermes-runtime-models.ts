import type { LocalResult } from "../../commands/local-runtime.js";
import {
  errorMessageWithOutput,
  runHermes,
  runHermesPython,
} from "./hermes-runtime-process.js";
import {
  normalizeModelId,
  normalizedProviderMatches,
  readHermesConfigSnapshot,
  readHermesStatusSnapshot,
} from "./hermes-runtime-usage.js";
import {
  compactStringArray,
  stringValue,
  toRecord,
} from "./hermes-runtime-values.js";

type HermesModelListItem = {
  providerId: string;
  provider: string;
  modelId: string;
  alias: string;
  name: string;
  contextWindow: string;
  tags: string[];
  isSelected: boolean;
  isDefault: boolean;
};

export async function runHermesModelList(): Promise<LocalResult> {
  try {
    const config = readHermesConfigSnapshot();
    const current = readHermesStatusSnapshot();
    const payload = readHermesModelOptionsPayload();
    return hermesModelListResultFromPayload(payload, current, config);
  } catch (error) {
    return { ok: false, error: errorMessageWithOutput(error) };
  }
}

export async function runHermesModelSelect(params: unknown): Promise<LocalResult> {
  const record = params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
  const providerId = typeof record.providerId === "string" ? record.providerId.trim() : "";
  const modelId = typeof record.modelId === "string" ? record.modelId.trim() : "";
  const modelAlias = typeof record.modelAlias === "string" ? record.modelAlias.trim() : "";
  const modelName = typeof record.modelName === "string" ? record.modelName.trim() : "";
  const resolvedModel = modelId || modelAlias || modelName;
  if (!resolvedModel) {
    return { ok: false, error: "modelId is required" };
  }

  try {
    runHermes(["config", "set", "model.default", resolvedModel], 10_000);
    if (providerId) {
      runHermes(["config", "set", "model.provider", providerId], 10_000);
    }
    const snapshot = readHermesStatusSnapshot();
    return {
      ok: true,
      payload: {
        providerId: providerId || snapshot.provider,
        modelId: resolvedModel,
        modelAlias: modelAlias || modelName || resolvedModel,
        currentModel: snapshot.currentModel ?? resolvedModel,
        provider: snapshot.provider ?? providerId,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function hermesModelListResultFromPayload(
  payload: unknown,
  current: { currentModel?: string; provider?: string } = {},
  config: { model?: string; provider?: string } = {},
): LocalResult {
  const items = dedupeModelItems(modelItemsFromHermesModelOptionsPayload(payload, current, config));
  if (items.length === 0) {
    return {
      ok: false,
      error: hermesInventoryError(payload) ?? "Hermes model inventory returned no configured usable models.",
    };
  }

  return { ok: true, payload: { items } };
}

function readHermesModelOptionsPayload(): Record<string, unknown> {
  const output = runHermesPython([
    "import json",
    "from hermes_cli.inventory import build_models_payload, load_picker_context",
    "print(json.dumps(build_models_payload(load_picker_context(), max_models=200), ensure_ascii=False))",
  ].join("\n"));
  return toRecord(JSON.parse(output));
}

export function modelItemsFromHermesModelOptionsPayload(
  payload: unknown,
  current: { currentModel?: string; provider?: string } = {},
  config: { model?: string; provider?: string } = {},
): HermesModelListItem[] {
  const record = toRecord(payload);
  const providers = Array.isArray(record.providers) ? record.providers.map(toRecord) : [];
  const selectedProvider = stringValue(record.provider) ?? current.provider ?? config.provider;
  const selectedModel = stringValue(record.model) ?? current.currentModel ?? config.model;
  const items: HermesModelListItem[] = [];

  for (const provider of providers) {
    const providerId = stringValue(provider.slug)
      ?? stringValue(provider.providerId)
      ?? stringValue(provider.id)
      ?? stringValue(provider.name);
    if (!providerId) {
      continue;
    }
    const providerName = stringValue(provider.name) ?? providerId;
    const models = Array.isArray(provider.models)
      ? provider.models.filter((model): model is string => typeof model === "string" && model.trim().length > 0)
      : [];
    const providerIsSelected = provider.is_current === true || normalizedProviderMatches(providerId, selectedProvider);

    for (const modelId of models) {
      const selected = providerIsSelected && normalizeModelId(modelId) === normalizeModelId(selectedModel);
      items.push({
        providerId,
        provider: providerName,
        modelId,
        alias: modelId,
        name: modelId,
        contextWindow: "--",
        tags: compactStringArray([
          modelId,
          stringValue(provider.source),
          provider.is_user_defined === true ? "user-config" : undefined,
        ]),
        isSelected: selected,
        isDefault: selected,
      });
    }
  }

  return items;
}

function dedupeModelItems(items: HermesModelListItem[]): HermesModelListItem[] {
  const seen = new Set<string>();
  const result: HermesModelListItem[] = [];
  for (const item of items) {
    const key = `${item.providerId}\0${item.modelId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function hermesInventoryError(payload: unknown): string | undefined {
  const record = toRecord(payload);
  return stringValue(record.error)
    ?? stringValue(record.message)
    ?? stringValue(record.detail);
}
