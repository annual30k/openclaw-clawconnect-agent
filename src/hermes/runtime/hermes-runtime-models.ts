import type { LocalResult } from "../../core/command-types.js";
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
  firstPositiveInteger,
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
    if (providerId) {
      // 使用 Hermes 官方模型赋值入口，跨 provider 时会同步清理旧 base_url/api_key/api_mode。
      runHermesPython(hermesModelAssignmentScript(providerId, resolvedModel));
    } else {
      runHermes(["config", "set", "model.default", resolvedModel], 10_000);
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

export function hermesModelAssignmentScript(providerId: string, modelId: string): string {
  return [
    "from hermes_cli.inventory import load_picker_context",
    "from hermes_cli.providers import resolve_provider_full",
    "from hermes_cli.web_server import _apply_model_assignment_sync",
    "ctx = load_picker_context()",
    `provider = ${JSON.stringify(providerId)}`,
    "provider_def = resolve_provider_full(provider, ctx.user_providers, ctx.custom_providers)",
    "base_url = provider_def.base_url if provider_def is not None else \"\"",
    `_apply_model_assignment_sync("main", provider, ${JSON.stringify(modelId)}, "", base_url)`,
  ].join("\n");
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
  // Hermes picker inventory 在切换后可能滞后；运行时状态和持久化配置代表已接受的选择，必须优先。
  const selectedProvider = current.provider ?? config.provider ?? stringValue(record.provider);
  const selectedModel = current.currentModel ?? config.model ?? stringValue(record.model);
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
    const models = Array.isArray(provider.models) ? provider.models : [];
    const providerIsSelected = provider.is_current === true || normalizedProviderMatches(providerId, selectedProvider);

    for (const modelEntry of models) {
      const model = hermesModelEntry(modelEntry);
      if (!model) {
        continue;
      }
      const { modelId, alias, name, contextWindow, tags } = model;
      const selected = providerIsSelected && normalizeModelId(modelId) === normalizeModelId(selectedModel);
      items.push({
        providerId,
        provider: providerName,
        modelId,
        alias,
        name,
        contextWindow,
        tags: compactStringArray([
          modelId,
          stringValue(provider.source),
          provider.is_user_defined === true ? "user-config" : undefined,
          ...tags,
        ]),
        isSelected: selected,
        isDefault: selected,
      });
    }
  }

  return items;
}

function hermesModelEntry(entry: unknown): {
  modelId: string;
  alias: string;
  name: string;
  contextWindow: string;
  tags: string[];
} | undefined {
  if (typeof entry === "string") {
    const modelId = entry.trim();
    if (!modelId) {
      return undefined;
    }
    return {
      modelId,
      alias: modelId,
      name: modelId,
      contextWindow: "--",
      tags: [],
    };
  }

  const record = toRecord(entry);
  const modelId = stringValue(record.id)
    ?? stringValue(record.modelId)
    ?? stringValue(record.model_id)
    ?? stringValue(record.model)
    ?? stringValue(record.name)
    ?? stringValue(record.alias);
  if (!modelId) {
    return undefined;
  }
  const alias = stringValue(record.alias) ?? stringValue(record.modelAlias) ?? modelId;
  const name = stringValue(record.name) ?? alias;
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  return {
    modelId,
    alias,
    name,
    contextWindow: hermesModelContextWindow(record) ?? "--",
    tags,
  };
}

function hermesModelContextWindow(record: Record<string, unknown>): string | undefined {
  const limit = toRecord(record.limit);
  const parsed = firstPositiveInteger(
    record.contextWindow,
    record.context_window,
    record.contextLength,
    record.context_length,
    record.contextTokens,
    record.context_tokens,
    record.maxInputTokens,
    record.max_input_tokens,
    record.maxContextTokens,
    record.max_context_tokens,
    limit.context,
    limit.input,
  );
  return parsed !== undefined ? String(parsed) : undefined;
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
