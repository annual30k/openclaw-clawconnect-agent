export type PreparedHermesVoiceInput = {
    method: "chat.send";
    params: unknown;
    run: {
        runId: string;
        sessionKey: string;
    };
};
export declare function prepareHermesVoiceInputCommand(params: unknown, options: {
    requestId?: string;
}): Promise<PreparedHermesVoiceInput>;
export declare function resolveHermesVoiceInputSessionKey(params: unknown): string;
