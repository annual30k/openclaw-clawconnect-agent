export interface GatewayClientOptions {
    url: string | (() => string);
    token?: string;
    password?: string;
    role?: string;
    scopes?: string[];
    caps?: string[];
    clientMode?: string;
    clientId?: string;
    clientDisplayName?: string;
    clientVersion?: string;
    onConnected: () => void;
    onEvent: (eventName: string, payload: unknown) => void;
    onDisconnected: (reason: string) => void;
}
export declare class OpenClawGatewayClient {
    private readonly opts;
    private ws;
    private pending;
    private backoffMs;
    private stopped;
    private connectNonce;
    private connectSent;
    private storedDeviceToken;
    private connectTimer;
    private tickTimer;
    private lastTick;
    private tickIntervalMs;
    private readonly identity;
    constructor(opts: GatewayClientOptions);
    start(): void;
    stop(): void;
    send(method: string, params?: unknown): void;
    request<T = unknown>(method: string, params?: unknown): Promise<T>;
    private resolveUrl;
    private sendConnect;
    private handleMessage;
    private startTickWatch;
    private scheduleReconnect;
    private teardown;
    private flushPending;
}
