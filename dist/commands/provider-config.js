import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { PROVIDER_REGISTRY } from "./provider-registry.js";
const OPENCLAW_DIR = join(homedir(), ".openclaw");
const OPENCLAW_CONFIG = join(OPENCLAW_DIR, "openclaw.json");
const AGENTS_DIR = join(OPENCLAW_DIR, "agents");
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function maskKey(key) {
    if (key.length <= 8)
        return key.slice(0, 2) + "***" + key.slice(-2);
    return key.slice(0, 4) + "***" + key.slice(-4);
}
async function resolveAgentId() {
    try {
        const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
        const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
        if (dirs.length > 0)
            return dirs[0];
    }
    catch {
        // agents dir missing or unreadable
    }
    return "main";
}
async function readJson(filePath) {
    try {
        const raw = await readFile(filePath, "utf-8");
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
async function writeJson(filePath, data) {
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}
function getNestedObj(root, keys) {
    let cur = root;
    for (const key of keys) {
        if (cur[key] == null || typeof cur[key] !== "object" || Array.isArray(cur[key])) {
            cur[key] = {};
        }
        cur = cur[key];
    }
    return cur;
}
function authProfilesPath(agentId) {
    return join(AGENTS_DIR, agentId, "agent", "auth-profiles.json");
}
/** Extract the first model ID from a provider's models array in openclaw.json */
function extractModelId(providerRaw) {
    const models = providerRaw["models"];
    if (Array.isArray(models) && models.length > 0) {
        const first = models[0];
        return typeof first["id"] === "string" ? first["id"] : null;
    }
    return null;
}
/** Infer provider type from its id in models.providers */
function inferType(id) {
    // custom providers have ids like "custom-<uuid>"
    if (id.startsWith("custom-"))
        return "custom";
    return id;
}
function readStringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === "string" && item.length > 0);
}
function modelContextWindow(modelRaw) {
    const candidates = ["contextWindow", "context_window", "contextLength", "context_length", "maxInputTokens"];
    for (const key of candidates) {
        const value = modelRaw[key];
        if (typeof value === "string" && value.trim().length > 0)
            return value.trim();
        if (typeof value === "number" && Number.isFinite(value))
            return String(value);
    }
    return "--";
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function listProviderEntries() {
    const config = await readJson(OPENCLAW_CONFIG);
    const agentId = await resolveAgentId();
    const authProfiles = await readJson(authProfilesPath(agentId));
    const profiles = authProfiles["profiles"] ?? {};
    // Determine current default
    const agents = config["agents"] ?? {};
    const defaults = agents["defaults"] ?? {};
    const model = defaults["model"] ?? {};
    const primaryModel = typeof model["primary"] === "string" ? model["primary"] : "";
    const entries = [];
    // --- Providers from models.providers (non-builtIn) ---
    const models = config["models"] ?? {};
    const providers = models["providers"] ?? {};
    for (const [id, providerRaw] of Object.entries(providers)) {
        const p = providerRaw ?? {};
        const type = inferType(id);
        const info = PROVIDER_REGISTRY[type];
        const baseUrl = typeof p["baseUrl"] === "string" ? p["baseUrl"] : "";
        const modelId = extractModelId(p);
        // auth-profiles key is "${id}:default"
        const profileKey = `${id}:default`;
        const profileRaw = profiles[profileKey];
        const profile = profileRaw != null && typeof profileRaw === "object" && !Array.isArray(profileRaw)
            ? profileRaw
            : null;
        const apiKey = profile != null && typeof profile["key"] === "string" ? profile["key"] : null;
        const hasKey = apiKey != null && apiKey.length > 0;
        const keyMasked = hasKey ? maskKey(apiKey) : null;
        const isDefault = primaryModel === id || primaryModel.startsWith(`${id}/`);
        entries.push({
            id,
            type,
            name: info?.displayName ?? type,
            baseUrl,
            modelId,
            keyMasked,
            hasKey,
            isDefault,
        });
    }
    // --- Built-in providers (anthropic, google) — detected via auth-profiles ---
    for (const [type, info] of Object.entries(PROVIDER_REGISTRY)) {
        if (!info.builtIn)
            continue;
        const profileKey = `${type}:default`;
        const profileRaw = profiles[profileKey];
        if (profileRaw == null)
            continue; // not configured
        const profile = typeof profileRaw === "object" && !Array.isArray(profileRaw)
            ? profileRaw
            : null;
        const apiKey = profile != null && typeof profile["key"] === "string" ? profile["key"] : null;
        const hasKey = apiKey != null && apiKey.length > 0;
        const keyMasked = hasKey ? maskKey(apiKey) : null;
        const isDefault = primaryModel === type || primaryModel.startsWith(`${type}/`);
        entries.push({
            id: type,
            type,
            name: info.displayName,
            baseUrl: info.defaultBaseUrl,
            modelId: info.defaultModelId ?? null,
            keyMasked,
            hasKey,
            isDefault,
        });
    }
    return entries;
}
export async function listConfiguredModels() {
    const config = await readJson(OPENCLAW_CONFIG);
    const agents = config["agents"] ?? {};
    const defaults = agents["defaults"] ?? {};
    const modelDefaults = defaults["model"] ?? {};
    const primaryModel = typeof modelDefaults["primary"] === "string" ? modelDefaults["primary"] : "";
    const entries = [];
    const seen = new Set();
    const models = config["models"] ?? {};
    const providers = models["providers"] ?? {};
    const modelAliases = defaults["models"] ?? {};
    for (const [fullKey, aliasRaw] of Object.entries(modelAliases)) {
        const slashIndex = fullKey.indexOf("/");
        if (slashIndex <= 0 || slashIndex >= fullKey.length - 1)
            continue;
        const providerId = fullKey.slice(0, slashIndex);
        const modelId = fullKey.slice(slashIndex + 1);
        const aliasObj = aliasRaw != null && typeof aliasRaw === "object" && !Array.isArray(aliasRaw)
            ? aliasRaw
            : {};
        const alias = typeof aliasObj["alias"] === "string" && aliasObj["alias"].trim().length > 0
            ? aliasObj["alias"].trim()
            : modelId;
        if (seen.has(fullKey))
            continue;
        seen.add(fullKey);
        const providerConfig = providers[providerId] ?? {};
        const configuredModels = Array.isArray(providerConfig["models"]) ? providerConfig["models"] : [];
        const modelRecord = configuredModels.find((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry))
                return false;
            const record = entry;
            return record["id"] === modelId;
        });
        const info = PROVIDER_REGISTRY[inferType(providerId)];
        entries.push({
            providerId,
            provider: info?.displayName ?? providerId,
            modelId,
            alias,
            name: alias,
            contextWindow: modelRecord ? modelContextWindow(modelRecord) : "--",
            tags: modelRecord ? [modelId, ...readStringArray(modelRecord["tags"])] : [modelId],
            isSelected: false,
            isDefault: fullKey === primaryModel,
        });
    }
    return entries;
}
export async function addProvider(params) {
    const { id, type, apiKey, baseUrl, api, apiKeyEnvName, modelId } = params;
    const info = PROVIDER_REGISTRY[type];
    // --- Update openclaw.json (skip for builtIn providers) ---
    if (!info?.builtIn) {
        const config = await readJson(OPENCLAW_CONFIG);
        const models = getNestedObj(config, ["models"]);
        const providers = getNestedObj(models, ["providers"]);
        // "apiKey" is the env var name reference (not the actual key value)
        const providerEntry = { type, baseUrl, api, apiKey: apiKeyEnvName };
        if (modelId !== undefined && modelId.length > 0) {
            providerEntry["models"] = [{ id: modelId, name: modelId }];
        }
        providers[id] = providerEntry;
        await writeJson(OPENCLAW_CONFIG, config);
    }
    // --- Update auth-profiles.json (only if apiKey provided) ---
    if (apiKey != null && apiKey.length > 0) {
        const agentId = await resolveAgentId();
        const profilesPath = authProfilesPath(agentId);
        const profilesDir = join(AGENTS_DIR, agentId, "agent");
        await mkdir(profilesDir, { recursive: true });
        const authProfiles = await readJson(profilesPath);
        const profiles = getNestedObj(authProfiles, ["profiles"]);
        // Profile key is "${id}:default" — for builtIn, id === type
        const profileKey = `${id}:default`;
        profiles[profileKey] = { type: "api_key", provider: type, key: apiKey };
        await writeJson(profilesPath, authProfiles);
    }
}
export async function deleteProvider(id) {
    const type = inferType(id);
    const info = PROVIDER_REGISTRY[type];
    // --- Update openclaw.json (skip for builtIn) ---
    if (!info?.builtIn) {
        const config = await readJson(OPENCLAW_CONFIG);
        const models = getNestedObj(config, ["models"]);
        const providers = getNestedObj(models, ["providers"]);
        delete providers[id];
        await writeJson(OPENCLAW_CONFIG, config);
    }
    // --- Update auth-profiles.json ---
    const agentId = await resolveAgentId();
    const profilesPath = authProfilesPath(agentId);
    const authProfiles = await readJson(profilesPath);
    const profiles = getNestedObj(authProfiles, ["profiles"]);
    const profileKey = `${id}:default`;
    if (profileKey in profiles) {
        delete profiles[profileKey];
        await writeJson(profilesPath, authProfiles);
    }
}
export async function setDefaultProvider(id) {
    const type = inferType(id);
    const info = PROVIDER_REGISTRY[type];
    // Determine the model ID for this provider
    let modelId = null;
    if (info?.builtIn) {
        // Built-in providers: use registry default, no models.providers entry
        modelId = info.defaultModelId ?? null;
    }
    else {
        // Read from models.providers entry
        const config = await readJson(OPENCLAW_CONFIG);
        const models = config["models"] ?? {};
        const providers = models["providers"] ?? {};
        const providerRaw = providers[id] ?? {};
        modelId = extractModelId(providerRaw) ?? info?.defaultModelId ?? null;
    }
    const primary = modelId ? `${id}/${modelId}` : id;
    const config = await readJson(OPENCLAW_CONFIG);
    const agents = getNestedObj(config, ["agents"]);
    const defaults = getNestedObj(agents, ["defaults"]);
    const model = getNestedObj(defaults, ["model"]);
    model["primary"] = primary;
    await writeJson(OPENCLAW_CONFIG, config);
}
export async function setDefaultModel(providerId, modelId) {
    const config = await readJson(OPENCLAW_CONFIG);
    const agents = getNestedObj(config, ["agents"]);
    const defaults = getNestedObj(agents, ["defaults"]);
    const model = getNestedObj(defaults, ["model"]);
    model["primary"] = `${providerId}/${modelId}`;
    await writeJson(OPENCLAW_CONFIG, config);
}
//# sourceMappingURL=provider-config.js.map