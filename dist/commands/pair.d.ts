import { type ClawConnectConfig } from "../config/config.js";
interface PairOptions {
    server?: string;
    name?: string;
    codeOnly?: boolean;
    gatewayType?: string;
    profile?: string;
}
export declare function pairCommand(opts: PairOptions): Promise<void>;
/** 配对请求的时间上限：代理/NAT 卡住连接时必须给出明确失败，而不是让命令无限挂起。 */
export declare const PAIR_REQUEST_TIMEOUT_MS = 20000;
export declare function postRelayJson(httpBase: string, path: string, body: unknown, fetchImpl?: typeof fetch, timeoutMs?: number): Promise<Response>;
export type ProfileConfigEntry = {
    profile: string | undefined;
    config: ClawConnectConfig;
};
/**
 * 找出已在同一 Relay 上注册了同类型网关的其他 profile。
 * 同一台主机只有一个本地 OpenClaw/Hermes 运行时，重复注册只会产生两个指向同一运行时的网关。
 * 多个冲突时按 profile 名排序取第一个（default 最前），结果与目录遍历顺序无关。
 */
export declare function findConflictingRegistration(currentProfile: string | undefined, gatewayType: "openclaw" | "hermes", relayServerUrl: string, candidates: ProfileConfigEntry[]): ProfileConfigEntry | undefined;
export declare function sameRelayServer(left: string, right: string): boolean;
export declare function shouldReuseExistingPairing(config: ClawConnectConfig | null, gatewayType: "openclaw" | "hermes", requestedRelayServerUrl: string): boolean;
export { normalizeRelayServerIdentity } from "../core/relay/file-upload-utils.js";
