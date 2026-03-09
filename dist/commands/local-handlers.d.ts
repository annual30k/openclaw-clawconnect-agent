export type LocalResult = {
    ok: true;
    payload?: unknown;
} | {
    ok: false;
    error: string;
};
export declare function handleLocalCommand(method: string): LocalResult | null;
