interface PairOptions {
    server?: string;
    name?: string;
    codeOnly?: boolean;
}
export declare function pairCommand(opts: PairOptions): Promise<void>;
export {};
