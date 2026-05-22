import type { GatewaySessionDefaults } from "./session-context.js";
export type PreparedOpenClawVoiceInput = {
    method: "chat.send";
    params: unknown;
    run: {
        runId: string;
        sessionKey: string;
    };
};
export declare function prepareOpenClawVoiceInputCommand(params: unknown, options: {
    requestId?: string;
    sessionDefaults: GatewaySessionDefaults;
}): Promise<PreparedOpenClawVoiceInput>;
