import type { RelaySlashCommandDescriptor } from "../../core/relay/slash-command-types.js";

/** Messages the OpenClaw relay client sends to the relay server. */
export type RelayHelloMessage = {
  type: "hello";
  platform: string;
  agentVersion: string;
  capabilities?: string[];
  slashCommands?: readonly RelaySlashCommandDescriptor[];
};

export type OpenClawRelayToServer =
  | RelayHelloMessage
  | { type: "heartbeat" }
  | { type: "gateway_connected" }
  | { type: "gateway_disconnected"; reason: string }
  | { type: "event"; event: string; payload: unknown; deliveryId?: string }
  | {
    type: "res";
    id: string;
    ok: boolean;
    responsePhase?: "accepted" | "terminal";
    payload?: unknown;
    error?: { message?: string };
  };

/** Messages the relay server sends to the OpenClaw relay client. */
export type OpenClawRelayFromServer =
  | { type: "cmd"; id?: string; method: string; params: unknown }
  | {
    type: "hello";
    role: "relay";
    gatewayId: string;
    ok: true;
    protocolCapabilities?: string[];
  }
  | { type: "heartbeat" }
  | { type: "event_ack"; id: string }
  | { type: "response_ack"; id: string; responsePhase?: string };

export interface RelayManagerOptions {
  relayServerUrl: string;
  gatewayId: string;
  relaySecret: string;
  gatewayUrl: string | (() => string);
  gatewayToken?: string;
  gatewayPassword?: string;
  onConnected?: () => void;
  onDisconnected?: () => void;
  /** @internal Allows deterministic protocol-negotiation timeout tests. */
  relayHelloTimeoutMs?: number;
  /** @internal Isolates durable outbox files in tests. */
  reliableOutboxStorageDirectory?: string;
  /** Optional abort signal.  When aborted the relay WebSocket is closed
   *  cleanly (code 1001) and the retry loop stops. */
  signal?: AbortSignal;
}
