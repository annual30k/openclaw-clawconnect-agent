export declare function isInstalled(): boolean;
export declare function installCommand(): void;
export declare function restartCommand(): void;
export declare function isActiveMobileChatProcess(env?: NodeJS.ProcessEnv): boolean;
export declare function uninstallCommand(): void;
export declare function stopCommand(): void;
export declare function listResettableProfiles(): string[];
export interface ResetProfileDeps {
    uninstall?: () => void;
    isServiceInstalled?: (profile?: string) => boolean;
}
export declare function resetCommand(deps?: ResetProfileDeps): void;
export declare function resetAllCommand(): void;
export declare function uninstallAllCommand(): void;
