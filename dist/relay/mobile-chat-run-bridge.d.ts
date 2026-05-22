export type MobileChatRun = {
    runId: string;
    sessionKey: string;
};
export type MobileAssistantUsage = {
    currentModel?: string;
    provider?: string;
    contextUsage?: number;
    contextLimit?: number;
};
export declare function resolveMobileChatRun(params: {
    preferredRunId?: string;
    requestId?: string;
    sessionKey?: string;
    fallbackPrefix: string;
}): MobileChatRun;
export declare function buildMobileAssistantDeltaPayload(params: {
    run: MobileChatRun;
    seq: number;
    timestampMs: number;
    delta: string;
}): {
    runId: string;
    sessionKey: string;
    state: string;
    role: string;
    seq: number;
    ts: number;
    delta: string;
    message: {
        role: string;
        timestamp: number;
        content: {
            type: string;
            text: string;
        }[];
    };
};
export declare function buildMobileAssistantStreamingPayload(params: {
    run: MobileChatRun;
    seq?: number;
    text: string;
}): {
    message: {
        role: string;
        content: {
            type: string;
            text: string;
        }[];
    };
    seq?: number | undefined;
    runId: string;
    sessionKey: string;
    state: string;
    role: string;
};
export declare function buildMobileAssistantFinalPayload(params: {
    run: MobileChatRun;
    text: string;
} & MobileAssistantUsage): {
    message: {
        role: string;
        content: {
            type: string;
            text: string;
        }[];
    };
    contextLimit?: number | undefined;
    contextUsage?: number | undefined;
    provider?: string | undefined;
    currentModel?: string | undefined;
    runId: string;
    sessionKey: string;
    state: string;
    role: string;
};
export declare function buildMobileAssistantErrorPayload(params: {
    run: MobileChatRun;
    errorMessage: string;
}): {
    runId: string;
    sessionKey: string;
    state: string;
    role: string;
    errorMessage: string;
    message: {
        role: string;
        content: {
            type: string;
            text: string;
        }[];
    };
};
