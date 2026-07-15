import type { GatewaySessionDefaults } from "./session-context.js";
import { prepareVoiceSendParams } from "../../core/relay/voice-input.js";

export type PreparedOpenClawVoiceInput = {
  method: "chat.send";
  params: unknown;
  run: {
    runId: string;
    sessionKey: string;
  };
};

export async function prepareOpenClawVoiceInputCommand(
  params: unknown,
  options: {
    requestId?: string;
    sessionDefaults: GatewaySessionDefaults;
  },
): Promise<PreparedOpenClawVoiceInput> {
  const voiceParamsRecord = params && typeof params === "object" && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
  const voiceSessionKey = typeof voiceParamsRecord.sessionKey === "string" && voiceParamsRecord.sessionKey.trim().length > 0
    ? voiceParamsRecord.sessionKey.trim()
    : options.sessionDefaults.mainSessionKey;
  const idempotencyKey = typeof voiceParamsRecord.idempotencyKey === "string"
    ? voiceParamsRecord.idempotencyKey.trim()
    : "";
  const requestId = typeof options.requestId === "string" ? options.requestId.trim() : "";

  return {
    method: "chat.send",
    params: await prepareVoiceSendParams(params),
    run: {
      // 移动端本地语音 echo 只能依赖幂等键与服务端转写确定性对账，不能改用 relay envelope id。
      runId: idempotencyKey || requestId || `voice-${Date.now()}`,
      sessionKey: voiceSessionKey,
    },
  };
}
