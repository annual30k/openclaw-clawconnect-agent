function nonEmpty(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
export function resolveMobileChatRun(params) {
    return {
        runId: nonEmpty(params.preferredRunId) ?? nonEmpty(params.requestId) ?? `${params.fallbackPrefix}-${Date.now()}`,
        sessionKey: nonEmpty(params.sessionKey) ?? "main",
    };
}
export function buildMobileAssistantDeltaPayload(params) {
    return {
        runId: params.run.runId,
        sessionKey: params.run.sessionKey,
        state: "delta",
        role: "assistant",
        seq: params.seq,
        ts: params.timestampMs,
        delta: params.delta,
        message: {
            role: "assistant",
            timestamp: params.timestampMs,
            content: [{ type: "text", text: params.delta }],
        },
    };
}
export function buildMobileAssistantStreamingPayload(params) {
    return {
        runId: params.run.runId,
        sessionKey: params.run.sessionKey,
        state: "streaming",
        role: "assistant",
        ...(params.seq !== undefined ? { seq: params.seq } : {}),
        message: {
            role: "assistant",
            content: [{ type: "text", text: params.text }],
        },
    };
}
export function buildMobileAssistantFinalPayload(params) {
    return {
        runId: params.run.runId,
        sessionKey: params.run.sessionKey,
        state: "final",
        role: "assistant",
        ...(params.currentModel !== undefined ? { currentModel: params.currentModel } : {}),
        ...(params.provider !== undefined ? { provider: params.provider } : {}),
        ...(params.contextUsage !== undefined ? { contextUsage: params.contextUsage } : {}),
        ...(params.contextLimit !== undefined ? { contextLimit: params.contextLimit } : {}),
        message: {
            role: "assistant",
            content: [{ type: "text", text: params.text }],
        },
    };
}
export function buildMobileAssistantErrorPayload(params) {
    return {
        runId: params.run.runId,
        sessionKey: params.run.sessionKey,
        state: "error",
        role: "assistant",
        errorMessage: params.errorMessage,
        message: {
            role: "assistant",
            content: [{ type: "text", text: params.errorMessage }],
        },
    };
}
//# sourceMappingURL=mobile-chat-run-bridge.js.map