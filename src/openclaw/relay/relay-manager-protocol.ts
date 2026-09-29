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
  /** 宿主 OpenClaw 的会话默认值；Relay 据此折叠默认 agent 的 `agent:<id>:` 别名，不再写死 `main`。 */
  | { type: "session_defaults"; defaultAgentId?: string; mainSessionKey: string }
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
  /** Relay hello 校验通过并挂载可靠投递 outbox 后触发；仅此时才算一次成功连接。 */
  onRelayReady?: () => void;
  onDisconnected?: (closeCode: number) => void;
  /** @internal Allows deterministic protocol-negotiation timeout tests. */
  relayHelloTimeoutMs?: number;
  /** @internal 存活检测的 ping 周期与超时（毫秒），仅用于测试。 */
  relayLivenessPingIntervalMs?: number;
  relayLivenessTimeoutMs?: number;
  /** @internal Isolates durable outbox files in tests. */
  reliableOutboxStorageDirectory?: string;
  /** Optional abort signal.  When aborted the relay WebSocket is closed
   *  cleanly (code 1001) and the retry loop stops. */
  signal?: AbortSignal;
}
