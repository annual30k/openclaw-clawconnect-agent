export type LocalResult =
  | { ok: true; payload?: unknown }
  | { ok: false; error: string };

export type LocalCommandEventPublisher = (event: {
  type: "event";
  event: string;
  payload: unknown;
}) => void | AssistantStreamEmitResult | Promise<void | AssistantStreamEmitResult>;

export type LocalCommandContext = {
  requestId?: string;
  gatewayId?: string;
  publishEvent?: LocalCommandEventPublisher;
  abortSignal?: AbortSignal;
};
import type { AssistantStreamEmitResult } from "./relay/assistant-stream-coalescer.js";
