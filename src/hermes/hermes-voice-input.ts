import { prepareVoiceSendParams } from "../relay/voice-input.js";

export type PreparedHermesVoiceInput = {
  method: "chat.send";
  params: unknown;
  run: {
    runId: string;
    sessionKey: string;
  };
};

export async function prepareHermesVoiceInputCommand(
  params: unknown,
  options: {
    requestId?: string;
  },
): Promise<PreparedHermesVoiceInput> {
  return {
    method: "chat.send",
    params: await prepareVoiceSendParams(params),
    run: {
      runId: options.requestId ?? `hermes-${Date.now()}`,
      sessionKey: resolveHermesVoiceInputSessionKey(params),
    },
  };
}

export function resolveHermesVoiceInputSessionKey(params: unknown): string {
  const record = params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
  const sessionKey = typeof record.sessionKey === "string" ? record.sessionKey.trim() : "";
  return sessionKey || "main";
}
