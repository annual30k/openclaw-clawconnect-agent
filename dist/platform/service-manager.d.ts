import type { ServicePlatform, ServiceStatus } from "./service-manager-common.js";
export type { ServicePlatform, ServiceStatus } from "./service-manager-common.js";
export { buildWindowsDirAclGrants, buildWindowsFileAclGrant, setRestrictiveDirPermissions, setRestrictiveFilePermissions, } from "./service-manager-common.js";
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
    linuxServicePath: string;
    linuxNohupPidPath: string;
    linuxNohupStartScriptPath: string;
    windowsServicePath: string;
};
