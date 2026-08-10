import { type ClawConnectConfig } from "../config/config.js";
interface PairOptions {
    server?: string;
    name?: string;
    codeOnly?: boolean;
    gatewayType?: string;
    profile?: string;
}
export declare function pairCommand(opts: PairOptions): Promise<void>;
export declare function sameRelayServer(left: string, right: string): boolean;
export declare function shouldReuseExistingPairing(config: ClawConnectConfig | null, gatewayType: "openclaw" | "hermes", requestedRelayServerUrl: string): boolean;
export { normalizeRelayServerIdentity } from "../core/relay/file-upload-utils.js";
