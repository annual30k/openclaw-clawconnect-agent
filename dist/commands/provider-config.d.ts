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
export declare function listProviderEntries(): Promise<ProviderEntry[]>;
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
