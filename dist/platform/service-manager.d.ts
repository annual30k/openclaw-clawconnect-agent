import type { ServicePlatform, ServiceStatus } from "./service-manager-common.js";
export type { ServicePlatform, ServiceStatus } from "./service-manager-common.js";
export declare function getServicePlatform(): ServicePlatform;
export declare function installService(): boolean;
export declare function restartService(): boolean;
export declare function stopService(): boolean;
export declare function uninstallService(): boolean;
export declare function getServiceStatus(): ServiceStatus;
export declare const servicePaths: {
    logPath: string;
    errorLogPath: string;
    macPlistPath: string;
    linuxServicePath: string;
    linuxNohupPidPath: string;
    linuxNohupStartScriptPath: string;
};
