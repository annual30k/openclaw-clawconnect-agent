
import { readdirSync, statSync, unlinkSync } from "fs";
import { homedir } from "os";
import { basename, join, resolve } from "path";
import type { LocalResult } from "../../core/command-types.js";
import { HERMES_HOME_DIR, runHermes } from "./hermes-runtime-process.js";
import { runHermesOutput } from "./hermes-runtime-command-utils.js";
import { sanitizeFileName, stringParam, toRecord } from "./hermes-runtime-values.js";

export function runHermesBackupCreate(params: unknown): LocalResult {
  const record = toRecord(params);
  const args = ["backup"];
  const outputPath = normalizeHermesBackupOutputPath(record);
  if (outputPath) args.push("--output", outputPath);
  if (record.quick === true) args.push("--quick");
  const label = stringParam(record, "label", "title");
  if (label) args.push("--label", label);
  const output = runHermes(args, 10 * 60_000);
  const backup = backupRecordFromOutput(output);
  if (!backup) {
    return { ok: false, error: output.trim() || "backup_archive_not_created" };
  }
  return { ok: true, payload: { output, backup, backups: listHermesBackups(), maxBackups: 0 } };
}

function normalizeHermesBackupOutputPath(record: Record<string, unknown>): string | undefined {
  const explicit = stringParam(record, "output", "outputPath");
  if (explicit) {
    return explicit;
  }
  const rawFilename = stringParam(record, "filename");
  if (!rawFilename) {
    return undefined;
  }
  if (rawFilename.startsWith("/") || rawFilename.startsWith("~/")) {
    return rawFilename;
  }
  let filename = sanitizeFileName(rawFilename);
  if (!filename.toLowerCase().endsWith(".zip")) {
    filename = `${filename}.zip`;
  }
  if (!filename.startsWith("hermes-backup")) {
    filename = `hermes-backup-${filename}`;
  }
  return join(homedir(), filename);
}

export function runHermesBackupList(): LocalResult {
  return { ok: true, payload: { backups: listHermesBackups(), maxBackups: 0 } };
}

export function runHermesBackupDelete(params: unknown): LocalResult {
  const id = stringParam(toRecord(params), "backupId", "id", "path");
  if (!id) return { ok: false, error: "backup_id_required" };
  const backup = findHermesBackup(id);
  if (!backup) return { ok: false, error: "backup_not_found" };
  const backupPath = stringParam(backup, "path");
  if (!backupPath) return { ok: false, error: "backup_path_missing" };
  unlinkSync(backupPath);
  return { ok: true, payload: { backup, backups: listHermesBackups(), maxBackups: 0 } };
}

export function runHermesBackupRestore(params: unknown): LocalResult {
  const id = stringParam(toRecord(params), "backupId", "id", "path");
  if (!id) return { ok: false, error: "backup_id_required" };
  const backup = findHermesBackup(id);
  if (!backup) return { ok: false, error: "backup_not_found" };
  const backupPath = stringParam(backup, "path");
  if (!backupPath) return { ok: false, error: "backup_path_missing" };
  const result = runHermesOutput(["import", backupPath, "--force"], 10 * 60_000);
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    payload: {
      ...(toRecord(result.payload)),
      backup,
      backups: listHermesBackups(),
      maxBackups: 0,
    },
  };
}

function backupRecordFromOutput(output: string): Record<string, unknown> | undefined {
  const match = output.match(/Backup complete:\s*(.+\.zip)/);
  const filePath = match?.[1]?.trim();
  return filePath ? backupRecordFromPath(filePath) : undefined;
}

function listHermesBackups(): Array<Record<string, unknown>> {
  const candidates = [homedir(), HERMES_HOME_DIR].flatMap((dir) => {
    try {
      return readdirSync(dir).map((name) => join(dir, name));
    } catch {
      return [];
    }
  });
  return candidates
    .filter((filePath) => basename(filePath).startsWith("hermes-backup") && filePath.endsWith(".zip"))
    .map(backupRecordFromPath)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")));
}

function findHermesBackup(idOrPath: string): Record<string, unknown> | undefined {
  const resolved = idOrPath.startsWith("/") || idOrPath.startsWith("~") ? resolve(idOrPath.replace(/^~(?=\/)/, homedir())) : undefined;
  return listHermesBackups().find((backup) => backup.id === idOrPath || backup.path === idOrPath || backup.path === resolved);
}

function backupRecordFromPath(filePath: string): Record<string, unknown> | undefined {
  try {
    const resolved = resolve(filePath.replace(/^~(?=\/)/, homedir()));
    const stat = statSync(resolved);
    return {
      id: resolved,
      title: basename(resolved),
      filename: basename(resolved),
      path: resolved,
      sizeBytes: stat.size,
      createdAt: stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return undefined;
  }
}
