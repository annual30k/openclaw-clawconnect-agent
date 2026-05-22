export type GatewayType = "openclaw" | "hermes";

export type GatewayProfile = {
  type: GatewayType;
  capabilities: string[];
};

const GATEWAY_PROFILES: Record<GatewayType, GatewayProfile> = {
  openclaw: {
    type: "openclaw",
    capabilities: ["chat", "skills", "schedules", "logs", "files", "voice_input"],
  },
  hermes: {
    type: "hermes",
    capabilities: ["chat", "files", "logs", "restart", "sessions", "skills", "gateway_service", "voice_input"],
  },
};

export function normalizeGatewayType(value: string | undefined): GatewayType {
  return value === "hermes" ? "hermes" : "openclaw";
}

export function getGatewayProfile(gatewayType: GatewayType): GatewayProfile {
  const profile = GATEWAY_PROFILES[gatewayType];
  return {
    type: profile.type,
    capabilities: [...profile.capabilities],
  };
}

export function gatewayCapabilitiesForType(gatewayType: GatewayType): string[] {
  return getGatewayProfile(gatewayType).capabilities;
}
