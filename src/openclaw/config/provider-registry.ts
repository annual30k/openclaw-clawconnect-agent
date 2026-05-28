export interface ProviderTypeInfo {
  displayName: string;
  defaultBaseUrl: string;
  api: "anthropic-messages" | "openai-completions" | "openai-responses";
  apiKeyEnvName: string;
  validationPath: string;
  validationAuth: "bearer" | "x-api-key" | "google-query-param" | "none";
  requiresApiKey: boolean;
  allowMultiple: boolean;
  showBaseUrl: boolean;
  showModelId: boolean;
  defaultModelId?: string;
  /**
   * Built-in OpenClaw providers (anthropic, google) — do NOT write a
   * models.providers entry; only write to auth-profiles.json.
   */
  builtIn?: boolean;
}

export const PROVIDER_REGISTRY: Record<string, ProviderTypeInfo> = {
  anthropic: {
    displayName: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    apiKeyEnvName: "ANTHROPIC_API_KEY",
    validationPath: "/v1/models",
    validationAuth: "x-api-key",
    requiresApiKey: true,
    allowMultiple: false,
    showBaseUrl: false,
    showModelId: false,
    defaultModelId: "claude-opus-4-6",
    builtIn: true,
  },
  openai: {
    displayName: "OpenAI",
    defaultBaseUrl: "https://api.openai.com",
    api: "openai-responses",
    apiKeyEnvName: "OPENAI_API_KEY",
    validationPath: "/v1/models",
    validationAuth: "bearer",
    requiresApiKey: true,
    allowMultiple: false,
    showBaseUrl: false,
    showModelId: false,
    defaultModelId: "gpt-4o",
  },
  google: {
    displayName: "Google",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    api: "openai-completions",
    apiKeyEnvName: "GOOGLE_API_KEY",
    validationPath: "/v1beta/models",
    validationAuth: "google-query-param",
    requiresApiKey: true,
    allowMultiple: false,
    showBaseUrl: false,
    showModelId: false,
    defaultModelId: "gemini-2.0-flash",
    builtIn: true,
  },
  openrouter: {
    displayName: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai",
    api: "openai-completions",
    apiKeyEnvName: "OPENROUTER_API_KEY",
    validationPath: "/api/v1/models",
    validationAuth: "bearer",
    requiresApiKey: true,
    allowMultiple: false,
    showBaseUrl: false,
    showModelId: false,
    defaultModelId: "anthropic/claude-opus-4-6",
  },
  ark: {
    displayName: "ByteDance (Ark)",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com",
    api: "openai-completions",
    apiKeyEnvName: "ARK_API_KEY",
    validationPath: "/api/v3/models",
    validationAuth: "bearer",
    requiresApiKey: true,
    allowMultiple: false,
    showBaseUrl: false,
    showModelId: true,   // Ark is a platform; user must specify the model endpoint ID
  },
  moonshot: {
    displayName: "Moonshot (Kimi)",
    defaultBaseUrl: "https://api.moonshot.cn",
    api: "openai-completions",
    apiKeyEnvName: "MOONSHOT_API_KEY",
    validationPath: "/v1/models",
    validationAuth: "bearer",
    requiresApiKey: true,
    allowMultiple: false,
    showBaseUrl: false,
    showModelId: false,
    defaultModelId: "kimi-k2.5",
  },
  siliconflow: {
    displayName: "SiliconFlow",
    defaultBaseUrl: "https://api.siliconflow.cn",
    api: "openai-completions",
    apiKeyEnvName: "SILICONFLOW_API_KEY",
    validationPath: "/v1/models",
    validationAuth: "bearer",
    requiresApiKey: true,
    allowMultiple: false,
    showBaseUrl: false,
    showModelId: false,
    defaultModelId: "Qwen/QwQ-32B",
  },
  ollama: {
    displayName: "Ollama",
    defaultBaseUrl: "http://localhost:11434",
    api: "openai-completions",
    apiKeyEnvName: "OLLAMA_API_KEY",
    validationPath: "/api/tags",
    validationAuth: "none",
    requiresApiKey: false,
    allowMultiple: false,
    showBaseUrl: true,
    showModelId: true,   // User must specify which model they have pulled
  },
  custom: {
    displayName: "Custom",
    defaultBaseUrl: "",
    api: "openai-completions",
    apiKeyEnvName: "CUSTOM_API_KEY",
    validationPath: "/v1/models",
    validationAuth: "bearer",
    requiresApiKey: false,
    allowMultiple: true,
    showBaseUrl: true,
    showModelId: true,
    defaultModelId: "custom-model",
  },
};
