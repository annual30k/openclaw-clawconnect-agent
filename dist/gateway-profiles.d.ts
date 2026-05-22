export type GatewayType = "openclaw" | "hermes";
export type GatewayProfile = {
    type: GatewayType;
    capabilities: string[];
};
export declare function normalizeGatewayType(value: string | undefined): GatewayType;
export declare function getGatewayProfile(gatewayType: GatewayType): GatewayProfile;
export declare function gatewayCapabilitiesForType(gatewayType: GatewayType): string[];
