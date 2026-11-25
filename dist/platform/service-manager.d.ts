import type { ServicePlatform, ServiceStatus } from "./service-manager-common.js";
export type { ServicePlatform, ServiceStatus } from "./service-manager-common.js";
export { buildWindowsDirAclGrants, buildWindowsFileAclGrant, setRestrictiveDirPermissions, setRestrictiveFilePermissions, } from "./service-manager-common.js";
/**
 * launchd 标签是用户级全局的，而 plist 路径跟随 HOME。HOME 被隔离（测试、临时账户）时，
 * 对真实标签执行 unload/remove/kickstart 会误停用户真实正在运行的服务。
 * 只有“本 HOME 下的 plist 存在”或“已加载作业的 plist 正是本 HOME 下这一份”才允许操作。
 */
export declare function shouldManageMacLaunchdJob(input: {
    plistExists: boolean;
    loadedPlistPath?: string;
    plistPath: string;
}): boolean;
export declare function parseLaunchctlPrintPlistPath(output: string): string | undefined;
export declare function macLaunchctlServiceTarget(label: string, uid: number): string;
export declare function getServicePlatform(): ServicePlatform;
export declare function installService(profile?: string): boolean;
export declare function restartService(profile?: string): boolean;
export declare function stopService(profile?: string): boolean;
export declare function uninstallService(profile?: string): boolean;
export declare function getServiceStatus(profile?: string): ServiceStatus;
export declare function getServicePaths(profile?: string): {
    profile: string;
    logPath: string;
    errorLogPath: string;
    macPlistPath: string;
    linuxServiceName: string;
    linuxServicePath: string;
    linuxNohupPidPath: string;
    linuxNohupStartScriptPath: string;
    windowsServicePath: string;
};
export declare const servicePaths: {
    profile: string;
    logPath: string;
    errorLogPath: string;
    macPlistPath: string;
    linuxServiceName: string;
    linuxServicePath: string;
    linuxNohupPidPath: string;
    linuxNohupStartScriptPath: string;
    windowsServicePath: string;
};
