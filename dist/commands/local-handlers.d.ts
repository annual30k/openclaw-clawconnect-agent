export type LocalResult = {
    ok: true;
    payload?: unknown;
} | {
    ok: false;
    error: string;
};
type GatewayRuntimeState = "running" | "stopped" | "unknown";
export declare function handleLocalCommand(method: string, params?: unknown): LocalResult | null;
export declare function parseGatewayRuntimeState(output: string): GatewayRuntimeState;
export declare function resolveGatewayRemoteRestartAction(runtime: GatewayRuntimeState): "start" | "restart";
export declare function requestGatewayRestart(source?: string): LocalResult;
export declare function requestGatewayRemoteRestart(source?: string): LocalResult;
export {};
