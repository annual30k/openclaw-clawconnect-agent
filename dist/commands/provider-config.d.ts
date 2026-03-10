export interface ProviderEntry {
    id: string;
    type: string;
    name: string;
    baseUrl: string;
    modelId: string | null;
    keyMasked: string | null;
    hasKey: boolean;
    isDefault: boolean;
}
export interface ConfiguredModelEntry {
    providerId: string;
    provider: string;
    modelId: string;
    alias: string;
    name: string;
    contextWindow: string;
    tags: string[];
    isSelected: boolean;
    isDefault: boolean;
}
export declare function listProviderEntries(): Promise<ProviderEntry[]>;
export declare function listConfiguredModels(): Promise<ConfiguredModelEntry[]>;
export declare function addProvider(params: {
    id: string;
    type: string;
    apiKey: string | null;
    baseUrl: string;
    api: string;
    apiKeyEnvName: string;
    modelId?: string;
}): Promise<void>;
export declare function deleteProvider(id: string): Promise<void>;
export declare function setDefaultProvider(id: string): Promise<void>;
export declare function setDefaultModel(providerId: string, modelId: string): Promise<void>;
