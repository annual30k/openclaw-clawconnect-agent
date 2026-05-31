export type LocalResult =
  | { ok: true; payload?: unknown }
  | { ok: false; error: string };

export type LocalCommandEventPublisher = (event: {
  type: "event";
  event: string;
  payload: unknown;
}) => void;

export type LocalCommandContext = {
  requestId?: string;
  gatewayId?: string;
  publishEvent?: LocalCommandEventPublisher;
  abortSignal?: AbortSignal;
};
