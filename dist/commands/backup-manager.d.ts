export interface BackupRecord {
    id: string;
    title: string;
    detail: string;
    filename: string;
    sizeBytes: number;
    createdAt: string;
    updatedAt: string;
}
export interface BackupListResult {
    backups: BackupRecord[];
    maxBackups: number;
}
export interface BackupMutationResult extends BackupListResult {
    backup: BackupRecord;
}
export declare function listBackups(): BackupListResult;
export declare function createBackup(params: unknown): BackupMutationResult;
export declare function updateBackup(params: unknown): BackupMutationResult;
export declare function deleteBackup(params: unknown): BackupMutationResult;
export declare function restoreBackup(params: unknown): BackupMutationResult;
