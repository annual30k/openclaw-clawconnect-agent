import { prepareVoiceSendParams } from "../core/relay/voice-input.js";
export async function prepareHermesVoiceInputCommand(params, options) {
    return {
        method: "chat.send",
        params: await prepareVoiceSendParams(params),
        run: {
            runId: resolveHermesVoiceInputRunId(params, options.requestId),
            sessionKey: resolveHermesVoiceInputSessionKey(params),
        },
    };
}
export function resolveHermesVoiceInputRunId(params, requestId) {
    const record = params && typeof params === "object" && !Array.isArray(params)
        ? params
        : {};
    const idempotencyKey = typeof record.idempotencyKey === "string" ? record.idempotencyKey.trim() : "";
    const relayRequestId = typeof requestId === "string" ? requestId.trim() : "";
    return idempotencyKey || relayRequestId || `hermes-${Date.now()}`;
}
export function resolveHermesVoiceInputSessionKey(params) {
    const record = params && typeof params === "object" && !Array.isArray(params)
        ? params
        : {};
    const sessionKey = typeof record.sessionKey === "string" ? record.sessionKey.trim() : "";
    return sessionKey || "main";
}
//# sourceMappingURL=hermes-voice-input.js.map