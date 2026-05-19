interface PairOptions {
    server?: string;
    name?: string;
    codeOnly?: boolean;
    gatewayType?: string;
    profile?: string;
}
export declare function pairCommand(opts: PairOptions): Promise<void>;
export {};
