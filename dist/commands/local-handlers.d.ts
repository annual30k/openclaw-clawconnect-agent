export type LocalResult = {
    ok: true;
    payload?: unknown;
} | {
    ok: false;
    error: string;
};
export declare function handleLocalCommand(method: string, params?: unknown): LocalResult | null;
export declare function requestGatewayRestart(source?: string): LocalResult;
