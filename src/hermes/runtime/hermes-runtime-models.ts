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
    return { ok: false, error: errorMessageWithOutput(error) };
  }
}

export function hermesModelAssignmentScript(providerId: string, modelId: string): string {
  return [
    "from hermes_cli.inventory import load_picker_context",
    "from hermes_cli.providers import resolve_provider_full",
    "ctx = load_picker_context()",
    `provider = ${JSON.stringify(providerId)}`,
    `model_id = ${JSON.stringify(modelId)}`,
    "provider_def = resolve_provider_full(provider, ctx.user_providers, ctx.custom_providers)",
    "base_url = provider_def.base_url if provider_def is not None else \"\"",
    "apply_sync = None",
    "for mod_name in (\"hermes_cli.web_server_config\", \"hermes_cli.web_server\"):",
    "    try:",
    "        mod = __import__(mod_name, fromlist=[\"_apply_model_assignment_sync\"])",
    "        candidate = getattr(mod, \"_apply_model_assignment_sync\", None)",
    "        if callable(candidate):",
    "            apply_sync = candidate",
    "            break",
    "    except Exception:",
    "        continue",
    "if apply_sync is not None:",
    "    try:",
    "        apply_sync(\"main\", provider, model_id, \"\", base_url)",
    "    except Exception as exc:",
    "        detail = getattr(exc, \"detail\", None)",
    "        if detail:",
    "            raise RuntimeError(str(detail)) from exc",
    "        raise",
    "else:",
    "    from hermes_cli.config import load_config",
    "    from hermes_cli.model_switch import persist_model_selection, switch_model",
    "    cfg = load_config()",
    "    model_cfg = cfg.get(\"model\") if isinstance(cfg.get(\"model\"), dict) else {}",
    "    is_bare_custom = provider.strip().lower() in {\"custom\", \"local\"}",
    "    result = switch_model(",
    "        raw_input=model_id,",
    "        explicit_provider=provider,",
    "        is_global=True,",
    "        current_provider=str(model_cfg.get(\"provider\") or \"\"),",
    "        current_model=str(model_cfg.get(\"default\") or \"\"),",
    "        current_base_url=base_url if is_bare_custom else str(model_cfg.get(\"base_url\") or \"\"),",
    "        current_api_key=\"\",",
    "        user_providers=ctx.user_providers,",
    "        custom_providers=ctx.custom_providers,",
    "    )",
    "    if not result.success:",
    "        raise RuntimeError(result.error_message or \"model switch rejected\")",
    "    persist_model_selection(result)",
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
  const hasQualifiedSelection = Boolean(selectedProvider && selectedModel);
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
    const providerIsSelected = hasQualifiedSelection
      ? normalizedProviderMatches(providerId, selectedProvider)
      : provider.is_current === true;

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
