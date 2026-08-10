export const RELAY_RELIABLE_DELIVERY_ACK_CAPABILITY = "reliable_delivery_ack_v1";
export const RELAY_HELLO_NEGOTIATION_TIMEOUT_MS = 10_000;

export type RelayReliableDeliveryMode = "acknowledged" | "legacy_write_confirmed";

export type RelayHelloDeliveryDeclaration = {
  type?: unknown;
  role?: unknown;
  gatewayId?: unknown;
  ok?: unknown;
  protocolCapabilities?: readonly string[];
};

export function isValidRelayHello(
  hello: RelayHelloDeliveryDeclaration,
  expectedGatewayId: string,
): boolean {
  return hello.type === "hello"
    && hello.role === "relay"
    && hello.ok === true
    && typeof hello.gatewayId === "string"
    && hello.gatewayId.trim() === expectedGatewayId.trim();
}

/**
 * Relay 必须在 hello.protocolCapabilities 中声明版本化 token，Agent 才进入 ACK 保留模式。
 * 已收到但未声明能力的 hello 明确代表旧协议；单纯等待超时绝不用于降级判断。
 */
export function reliableDeliveryModeFromRelayHello(
  hello: RelayHelloDeliveryDeclaration,
): RelayReliableDeliveryMode {
  const capabilities = new Set(
    Array.isArray(hello.protocolCapabilities)
      ? hello.protocolCapabilities.filter((value): value is string => typeof value === "string")
      : [],
  );
  return capabilities.has(RELAY_RELIABLE_DELIVERY_ACK_CAPABILITY)
    ? "acknowledged"
    : "legacy_write_confirmed";
}

export function relayHelloDeclaresReliableDeliveryAcks(
  hello: RelayHelloDeliveryDeclaration,
): boolean {
  return reliableDeliveryModeFromRelayHello(hello) === "acknowledged";
}
