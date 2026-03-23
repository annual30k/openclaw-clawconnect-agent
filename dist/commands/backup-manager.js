import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { homedir } from "node:os";
const OPENCLAW_DIR = join(homedir(), ".openclaw");
const OPENCLAW_CONFIG = join(OPENCLAW_DIR, "openclaw.json");
const BACKUP_ROOT = join(homedir(), ".clawconnect", "backups", "openclaw");
const BACKUP_META_FILENAME = "backup.meta.json";
const MAX_BACKUPS = 5;
const MAX_TITLE_LENGTH = 80;
const MAX_DETAIL_LENGTH = 512;
const MAX_FILENAME_LENGTH = 120;
function fail(code, message) {
    throw new Error(`${code}: ${message}`);
}
function ensureBackupRoot() {
    mkdirSync(BACKUP_ROOT, { recursive: true });
}
function normalizeText(value) {
    return typeof value === "string" ? value.trim() : "";
}
function limitText(value, max) {
    if (value.length <= max)
        return value;
    return value.slice(0, max).trimEnd();
}
function formatTimestamp(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function formatFilenameStamp(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
function defaultTitle(date) {
    return `备份 ${formatTimestamp(date)}`;
}
function defaultFilename(date) {
    return `openclaw-${formatFilenameStamp(date)}.json`;
}
function sanitizeTitle(value, fallback) {
    const normalized = limitText(normalizeText(value), MAX_TITLE_LENGTH);
    return normalized || fallback;
}
function sanitizeDetail(value) {
    return limitText(normalizeText(value), MAX_DETAIL_LENGTH);
}
function sanitizeFilename(value, fallback) {
    const raw = normalizeText(value);
    const normalized = raw
        .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\.+$/g, "");
    const candidate = normalized || fallback;
    const withExtension = extname(candidate) ? candidate : `${candidate}.json`;
    const cleaned = withExtension
        .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "-")
        .replace(/\s+/g, " ")
        .trim();
    if (!cleaned || cleaned === "." || cleaned === ".." || cleaned === BACKUP_META_FILENAME) {
        return fallback;
    }
    if (cleaned.length <= MAX_FILENAME_LENGTH) {
        return cleaned;
    }
    const extension = extname(cleaned);
    const base = extension ? cleaned.slice(0, -extension.length) : cleaned;
    const remaining = Math.max(1, MAX_FILENAME_LENGTH - extension.length);
    return `${base.slice(0, remaining)}${extension}`;
}
function normalizeIsoString(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    if (!trimmed)
        return undefined;
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed))
        return undefined;
    return new Date(parsed).toISOString();
}
function hashContent(content) {
    return createHash("sha256").update(content, "utf8").digest("hex");
}
function resolvePayloadPath(dirPath, preferredFilename) {
    if (!existsSync(dirPath)) {
        return null;
    }
    if (preferredFilename) {
        const preferredPath = join(dirPath, preferredFilename);
        if (existsSync(preferredPath) && statSync(preferredPath).isFile()) {
            return { path: preferredPath, filename: preferredFilename, usedPreferred: true };
        }
    }
    const fallbackFile = readdirSync(dirPath, { withFileTypes: true })
        .find((entry) => entry.isFile() && entry.name !== BACKUP_META_FILENAME && !entry.name.startsWith("."))
        ?.name;
    if (!fallbackFile) {
        return null;
    }
    const fallbackPath = join(dirPath, fallbackFile);
    return existsSync(fallbackPath) && statSync(fallbackPath).isFile()
        ? { path: fallbackPath, filename: fallbackFile, usedPreferred: false }
        : null;
}
function readStoredBackup(dirName) {
    const dirPath = join(BACKUP_ROOT, dirName);
    const metaPath = join(dirPath, BACKUP_META_FILENAME);
    if (!existsSync(metaPath)) {
        return null;
    }
    let rawMeta = "";
    try {
        rawMeta = readFileSync(metaPath, "utf8");
    }
    catch {
        return null;
    }
    let meta;
    try {
        meta = JSON.parse(rawMeta);
    }
    catch {
        return null;
    }
    const payload = resolvePayloadPath(dirPath, typeof meta.filename === "string" ? meta.filename : undefined);
    if (!payload) {
        return null;
    }
    const payloadStat = statSync(payload.path);
    const payloadContent = readFileSync(payload.path, "utf8");
    const createdAt = normalizeIsoString(meta.createdAt) ?? new Date(payloadStat.mtimeMs).toISOString();
    const updatedAt = normalizeIsoString(meta.updatedAt) ?? createdAt;
    const fallbackDate = new Date(createdAt);
    const filename = payload.usedPreferred
        ? sanitizeFilename(typeof meta.filename === "string" ? meta.filename : payload.filename, payload.filename)
        : payload.filename;
    return {
        id: normalizeText(meta.id) || dirName,
        title: sanitizeTitle(meta.title, defaultTitle(fallbackDate)),
        detail: sanitizeDetail(meta.detail),
        filename,
        sizeBytes: Number.isFinite(Number(meta.sizeBytes)) && Number(meta.sizeBytes) > 0 ? Math.round(Number(meta.sizeBytes)) : Buffer.byteLength(payloadContent, "utf8"),
        createdAt,
        updatedAt,
        dirPath,
        metaPath,
        payloadPath: payload.path,
    };
}
function readStoredBackups() {
    if (!existsSync(BACKUP_ROOT)) {
        return [];
    }
    const backups = readdirSync(BACKUP_ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => readStoredBackup(entry.name))
        .filter((entry) => Boolean(entry))
        .sort((left, right) => {
        const leftCreated = Date.parse(left.createdAt);
        const rightCreated = Date.parse(right.createdAt);
        if (leftCreated !== rightCreated) {
            return rightCreated - leftCreated;
        }
        const leftUpdated = Date.parse(left.updatedAt);
        const rightUpdated = Date.parse(right.updatedAt);
        if (leftUpdated !== rightUpdated) {
            return rightUpdated - leftUpdated;
        }
        return right.id.localeCompare(left.id);
    });
    return backups;
}
function saveBackupMeta(backup) {
    const meta = {
        version: 1,
        id: backup.id,
        title: backup.title,
        detail: backup.detail,
        filename: backup.filename,
        sizeBytes: backup.sizeBytes,
        createdAt: backup.createdAt,
        updatedAt: backup.updatedAt,
    };
    writeFileSync(backup.metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}
function publicBackupRecord(backup) {
    return {
        id: backup.id,
        title: backup.title,
        detail: backup.detail,
        filename: backup.filename,
        sizeBytes: backup.sizeBytes,
        createdAt: backup.createdAt,
        updatedAt: backup.updatedAt,
    };
}
function loadBackupOrThrow(backupId) {
    const backup = readStoredBackups().find((entry) => entry.id === backupId);
    if (!backup) {
        fail("backup_not_found", `Backup not found: ${backupId}`);
    }
    return backup;
}
function parseBackupInput(params) {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        return {};
    }
    const record = params;
    return {
        title: record.title,
        detail: record.detail,
        filename: record.filename,
    };
}
function parseBackupIdInput(params) {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
        fail("backup_id_required", "backupId is required");
    }
    const record = params;
    const candidate = normalizeText(record.backupId) || normalizeText(record.id);
    if (!candidate) {
        fail("backup_id_required", "backupId is required");
    }
    return candidate;
}
function renamePayloadFile(backup, nextFilename) {
    if (backup.filename === nextFilename) {
        return backup.filename;
    }
    const nextPayloadPath = join(backup.dirPath, nextFilename);
    const tempPath = join(backup.dirPath, `.tmp-${randomUUID()}-${nextFilename}`);
    renameSync(backup.payloadPath, tempPath);
    renameSync(tempPath, nextPayloadPath);
    return nextFilename;
}
function enforceBackupLimit(backups) {
    if (backups.length <= MAX_BACKUPS) {
        return;
    }
    for (const backup of backups.slice(MAX_BACKUPS)) {
        rmSync(backup.dirPath, { recursive: true, force: true });
    }
}
function readOpenclawConfigSnapshot() {
    if (!existsSync(OPENCLAW_CONFIG)) {
        fail("openclaw_config_not_found", `openclaw config not found: ${OPENCLAW_CONFIG}`);
    }
    return readFileSync(OPENCLAW_CONFIG, "utf8");
}
export function listBackups() {
    return {
        backups: readStoredBackups().map(publicBackupRecord),
        maxBackups: MAX_BACKUPS,
    };
}
export function createBackup(params) {
    ensureBackupRoot();
    const input = parseBackupInput(params);
    const now = new Date();
    const createdAt = now.toISOString();
    const content = readOpenclawConfigSnapshot();
    const id = `backup_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const dirPath = join(BACKUP_ROOT, id);
    mkdirSync(dirPath, { recursive: true });
    const filename = sanitizeFilename(input.filename, defaultFilename(now));
    const backup = {
        id,
        title: sanitizeTitle(input.title, defaultTitle(now)),
        detail: sanitizeDetail(input.detail),
        filename,
        sizeBytes: Buffer.byteLength(content, "utf8"),
        createdAt,
        updatedAt: createdAt,
        dirPath,
        metaPath: join(dirPath, BACKUP_META_FILENAME),
        payloadPath: join(dirPath, filename),
    };
    writeFileSync(backup.payloadPath, content, "utf8");
    saveBackupMeta(backup);
    const backups = readStoredBackups();
    enforceBackupLimit(backups);
    const refreshed = readStoredBackups();
    const created = refreshed.find((entry) => entry.id === id);
    if (!created) {
        fail("backup_storage_error", "Unable to persist backup");
    }
    return {
        backup: publicBackupRecord(created),
        backups: refreshed.map(publicBackupRecord),
        maxBackups: MAX_BACKUPS,
    };
}
export function updateBackup(params) {
    const input = parseBackupInput(params);
    const backupId = parseBackupIdInput(params);
    const existing = loadBackupOrThrow(backupId);
    const now = new Date().toISOString();
    const nextTitle = sanitizeTitle(input.title, existing.title);
    const nextDetail = sanitizeDetail(input.detail ?? existing.detail);
    const nextFilename = sanitizeFilename(input.filename ?? existing.filename, existing.filename);
    const nextPayloadName = renamePayloadFile(existing, nextFilename);
    const updated = {
        ...existing,
        title: nextTitle,
        detail: nextDetail,
        filename: nextPayloadName,
        updatedAt: now,
        payloadPath: join(existing.dirPath, nextPayloadName),
        sizeBytes: statSync(join(existing.dirPath, nextPayloadName)).size,
    };
    saveBackupMeta(updated);
    const backups = readStoredBackups();
    return {
        backup: publicBackupRecord(updated),
        backups: backups.map(publicBackupRecord),
        maxBackups: MAX_BACKUPS,
    };
}
export function deleteBackup(params) {
    const backupId = parseBackupIdInput(params);
    const existing = loadBackupOrThrow(backupId);
    rmSync(existing.dirPath, { recursive: true, force: true });
    const backups = readStoredBackups();
    return {
        backup: publicBackupRecord(existing),
        backups: backups.map(publicBackupRecord),
        maxBackups: MAX_BACKUPS,
    };
}
export function restoreBackup(params) {
    const backupId = parseBackupIdInput(params);
    const existing = loadBackupOrThrow(backupId);
    if (!existsSync(OPENCLAW_DIR)) {
        fail("openclaw_config_dir_not_found", `openclaw config dir not found: ${OPENCLAW_DIR}`);
    }
    copyFileSync(existing.payloadPath, OPENCLAW_CONFIG);
    const backups = readStoredBackups();
    return {
        backup: publicBackupRecord(existing),
        backups: backups.map(publicBackupRecord),
        maxBackups: MAX_BACKUPS,
    };
}
//# sourceMappingURL=backup-manager.js.map