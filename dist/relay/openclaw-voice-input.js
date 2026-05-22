import { prepareVoiceSendParams } from "./voice-input.js";
export async function prepareOpenClawVoiceInputCommand(params, options) {
    const voiceParamsRecord = params && typeof params === "object" && !Array.isArray(params)
        ? params
        : {};
    const voiceSessionKey = typeof voiceParamsRecord.sessionKey === "string" && voiceParamsRecord.sessionKey.trim().length > 0
        ? voiceParamsRecord.sessionKey.trim()
        : options.sessionDefaults.mainSessionKey;
    return {
        method: "chat.send",
        params: await prepareVoiceSendParams(params),
        run: {
            runId: options.requestId ?? `voice-${Date.now()}`,
            sessionKey: voiceSessionKey,
        },
    };
}
//# sourceMappingURL=openclaw-voice-input.js.map