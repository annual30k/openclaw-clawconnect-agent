const GATEWAY_PROFILES = {
    openclaw: {
        type: "openclaw",
        capabilities: ["chat", "skills", "schedules", "logs", "files", "voice_input"],
    },
    hermes: {
        type: "hermes",
        capabilities: ["chat", "files", "logs", "restart", "sessions", "skills", "gateway_service", "voice_input"],
    },
};
export function normalizeGatewayType(value) {
    return value === "hermes" ? "hermes" : "openclaw";
}
export function getGatewayProfile(gatewayType) {
    const profile = GATEWAY_PROFILES[gatewayType];
    return {
        type: profile.type,
        capabilities: [...profile.capabilities],
    };
}
export function gatewayCapabilitiesForType(gatewayType) {
    return getGatewayProfile(gatewayType).capabilities;
}
//# sourceMappingURL=gateway-profiles.js.map