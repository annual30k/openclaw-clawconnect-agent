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
export declare const PROVIDER_REGISTRY: Record<string, ProviderTypeInfo>;
