type HealthState = {
    kind: "ok" | "warn" | "error" | "unknown";
    detail?: string;
};
type GatewayType = "openclaw" | "hermes";
export declare function statusCommand(): void;
export declare function readHealth(logPath: string, gatewayType?: GatewayType): {
    relay: HealthState;
    gateway: HealthState;
};
export {};
