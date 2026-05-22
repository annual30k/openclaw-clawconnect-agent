import { prepareVoiceSendParams } from "../relay/voice-input.js";
export async function prepareHermesVoiceInputCommand(params, options) {
    return {
        method: "chat.send",
        params: await prepareVoiceSendParams(params),
        run: {
            runId: options.requestId ?? `hermes-${Date.now()}`,
            sessionKey: resolveHermesVoiceInputSessionKey(params),
        },
    };
}
export function resolveHermesVoiceInputSessionKey(params) {
    const record = params && typeof params === "object" && !Array.isArray(params)
        ? params
        : {};
    const sessionKey = typeof record.sessionKey === "string" ? record.sessionKey.trim() : "";
    return sessionKey || "main";
}
//# sourceMappingURL=hermes-voice-input.js.map