import { execSync } from "child_process";
import { existsSync } from "fs";
import { dirname } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import type { LocalResult } from "./local-handlers.js";
import { PROVIDER_REGISTRY } from "./provider-registry.js";
import {
  listProviderEntries,
  addProvider,
  deleteProvider,
  setDefaultProvider,
} from "./provider-config.js";

// ---------------------------------------------------------------------------
// Subprocess env (mirrors local-handlers.ts)
// ---------------------------------------------------------------------------

const NODE_BIN_DIR = dirname(process.execPath);

const SUBPROCESS_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: homedir(),
  PATH: [
    NODE_BIN_DIR,
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    process.env.PATH ?? "/usr/bin:/bin",
  ].join(":"),
};

function resolveOpenclawBin(): string {
  try {
    const p = execSync("which openclaw", { stdio: "pipe", env: SUBPROCESS_ENV, timeout: 3000 })
      .toString().trim();
    if (p && existsSync(p)) return p;
  } catch { /* fall through */ }
  return "openclaw";
}

let cachedOpenclawBin: string | null = null;

function getOpenclawBin(): string {
  if (cachedOpenclawBin == null) {
    cachedOpenclawBin = resolveOpenclawBin();
  }
  return cachedOpenclawBin;
}

function restartGateway(): void {
  try {
    execSync(`"${getOpenclawBin()}" gateway restart`, { stdio: "pipe", env: SUBPROCESS_ENV });
    console.log("[provider] gateway restarted");
  } catch (err) {
    console.warn("[provider] gateway restart failed:", String(err));
  }
}

// ---------------------------------------------------------------------------
// HTTP key validation
// ---------------------------------------------------------------------------

async function validateApiKey(
  type: string,
  apiKey: string,
  baseUrl: string
): Promise<{ ok: boolean; error?: string }> {
  const info = PROVIDER_REGISTRY[type];
  if (!info) return { ok: false, error: `Unknown provider type: ${type}` };
  if (!info.requiresApiKey || !apiKey) return { ok: true };

  return new Promise((resolve) => {
    try {
      const url = new URL(info.validationPath, baseUrl);
      if (info.validationAuth === "google-query-param") {
        url.searchParams.set("key", apiKey);
      }

      const headers: Record<string, string> = {};
      if (info.validationAuth === "bearer") {
        headers["Authorization"] = `Bearer ${apiKey}`;
      } else if (info.validationAuth === "x-api-key") {
        headers["x-api-key"] = apiKey;
        headers["anthropic-version"] = "2023-06-01";
      }

      // Use http or https based on protocol
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = url.protocol === "https:" ? require("https") : require("http");
      const req = mod.get(
        {
          hostname: url.hostname,
          port: url.port || undefined,
          path: url.pathname + url.search,
          headers,
        },
        (res: { statusCode?: number; resume: () => void }) => {
          res.resume(); // drain body
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve({ ok: true });
          } else if (status === 401 || status === 403) {
            resolve({ ok: false, error: "API Key 无效" });
          } else {
            resolve({ ok: false, error: `验证失败 (HTTP ${status})` });
          }
        }
      );
      req.setTimeout(10_000, () => {
        req.destroy();
        resolve({ ok: false, error: "验证超时" });
      });
      req.on("error", (e: Error) => resolve({ ok: false, error: e.message }));
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function cmdList(): Promise<LocalResult> {
  try {
    const providers = await listProviderEntries();
    return { ok: true, payload: { providers } };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function cmdValidateKey(params: Record<string, unknown>): Promise<LocalResult> {
  try {
    const type = params.type as string;
    const apiKey = params.apiKey as string;
    const baseUrl = (params.baseUrl as string | undefined) ?? PROVIDER_REGISTRY[type]?.defaultBaseUrl ?? "";
    const result = await validateApiKey(type, apiKey, baseUrl);
    if (result.ok) return { ok: true };
    return { ok: false, error: result.error ?? "验证失败" };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function cmdAdd(params: Record<string, unknown>): Promise<LocalResult> {
  try {
    const type = params.type as string;
    const apiKey = (params.apiKey as string | null | undefined) ?? null;
    const info = PROVIDER_REGISTRY[type];
    if (!info) return { ok: false, error: `Unknown provider type: ${type}` };

    const baseUrl = (params.baseUrl as string | undefined) || info.defaultBaseUrl;
    const modelId = (params.modelId as string | undefined) ?? info.defaultModelId;

    // Validate key before writing config
    if (info.requiresApiKey && apiKey) {
      const v = await validateApiKey(type, apiKey, baseUrl);
      if (!v.ok) return { ok: false, error: v.error ?? "API Key 无效" };
    }

    // custom providers get a UUID suffix; id and apiKeyEnvName share the same UUID so they're traceable
    const uuid = info.allowMultiple ? randomUUID() : null;
    const id = uuid ? `custom-${uuid}` : type;
    const apiKeyEnvName = uuid
      ? `CUSTOM_${uuid.replace(/-/g, "_").toUpperCase()}_API_KEY`
      : info.apiKeyEnvName;

    await addProvider({ id, type, apiKey, baseUrl, api: info.api, apiKeyEnvName, modelId });
    restartGateway();
    return { ok: true, payload: { id } };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function cmdDelete(params: Record<string, unknown>): Promise<LocalResult> {
  try {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id required" };
    await deleteProvider(id);
    restartGateway();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function cmdSetDefault(params: Record<string, unknown>): Promise<LocalResult> {
  try {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id required" };
    await setDefaultProvider(id);
    restartGateway();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

export function handleProviderCommand(
  method: string,
  params: unknown
): Promise<LocalResult> | null {
  if (!method.startsWith("clawpilot.provider.") && !method.startsWith("pocketclaw.provider.") && !method.startsWith("clawconnect.provider.")) return null;
  const p = (params ?? {}) as Record<string, unknown>;

  switch (method) {
    case "clawconnect.provider.list":
    case "pocketclaw.provider.list":
    case "clawpilot.provider.list":       return cmdList();
    case "clawconnect.provider.validateKey":
    case "pocketclaw.provider.validateKey":
    case "clawpilot.provider.validateKey": return cmdValidateKey(p);
    case "clawconnect.provider.add":
    case "pocketclaw.provider.add":
    case "clawpilot.provider.add":        return cmdAdd(p);
    case "clawconnect.provider.delete":
    case "pocketclaw.provider.delete":
    case "clawpilot.provider.delete":     return cmdDelete(p);
    case "clawconnect.provider.setDefault":
    case "pocketclaw.provider.setDefault":
    case "clawpilot.provider.setDefault": return cmdSetDefault(p);
    default:
      return Promise.resolve({ ok: false, error: `Unknown provider command: ${method}` });
  }
}
