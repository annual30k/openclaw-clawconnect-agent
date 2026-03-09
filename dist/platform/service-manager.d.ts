export type ServicePlatform = "macos" | "linux" | "unsupported";
export interface ServiceStatus {
    platform: ServicePlatform;
    installed: boolean;
    running: boolean;
    serviceName: string;
    manager: string;
    servicePath?: string;
    logPath: string;
    startHint?: string;
}
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
