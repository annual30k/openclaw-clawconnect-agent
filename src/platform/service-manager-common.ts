import { execFileSync, execSync } from "child_process";
import { chmodSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type ServicePlatform = "macos" | "linux" | "windows" | "unsupported";

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

export const LOG_DIR = join(homedir(), ".clawconnect");
export const LOG_PATH = join(LOG_DIR, "clawconnect.log");
export const ERROR_LOG_PATH = join(LOG_DIR, "clawconnect-error.log");

export const LINUX_SERVICE_NAME = "clawconnect-agent.service";
export const LINUX_SYSTEMD_USER_DIR = join(homedir(), ".config", "systemd", "user");
export const LINUX_SERVICE_PATH = join(LINUX_SYSTEMD_USER_DIR, LINUX_SERVICE_NAME);
export const LINUX_NOHUP_PID_PATH = join(LOG_DIR, "clawconnect.pid");
export const LINUX_NOHUP_START_SCRIPT_PATH = join(LOG_DIR, "clawconnect-start.sh");

export function detectPlatform(): ServicePlatform {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "windows";
  return "unsupported";
}

export function shellEscape(arg: string): string {
  if (process.platform === "win32") {
    // Windows CMD escaping: wrap in double quotes and escape internal double quotes with \".
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function run(command: string, stdio: "pipe" | "inherit" = "pipe"): Buffer | string {
  return execSync(command, { stdio });
}

export function commandExists(command: string): boolean {
  try {
    if (process.platform === "win32") {
      run(`where ${command}`, "pipe");
    } else {
      run(`command -v ${command}`, "pipe");
    }
    return true;
  } catch {
    return false;
  }
}

export function resolveServiceEntryPath(scriptPath: string): string {
  const normalizedScriptPath = scriptPath.replace(/\\/g, "/");
  const distIndexPath = normalizedScriptPath.replace(/\/src\/index\.(ts|js)$/, "/dist/index.js");
  if (distIndexPath !== normalizedScriptPath && existsSync(distIndexPath)) {
    // If we're on Windows, we might want to return the native path.
    return process.platform === "win32" ? distIndexPath.replace(/\//g, "\\") : distIndexPath;
  }
  return scriptPath;
}

export function getProgramArgs(): string[] {
  const nodeBin = process.execPath;
  const scriptPath = resolveServiceEntryPath(process.argv[1]);
  return nodeBin === scriptPath ? [scriptPath, "run"] : [nodeBin, scriptPath, "run"];
}

export function ensureLogDir(): void {
  mkdirSync(LOG_DIR, { recursive: true });
}

export function ensureWindowsConsoleUtf8(): void {
  if (process.platform !== "win32") return;
  try {
    execFileSync("chcp", ["65001"], { stdio: "ignore" });
  } catch {
    try {
      // Fallback: some Windows versions expose chcp only through cmd
      execFileSync("cmd", ["/c", "chcp", "65001"], { stdio: "ignore" });
    } catch {
      // Non-fatal: legacy Windows without UTF-8 console support
    }
  }
}

/**
 * Restrict a file's permissions to the owning user only.
 *
 * - On Unix: chmod 0o600 (owner read + write).
 * - On Windows: `icacls` removes inherited ACEs and grants only the
 *   current user Read + Write access.  This prevents other processes
 *   (including other user sessions) from reading sensitive tokens or
 *   private keys, closing the false‑security gap where `{ mode: 0o600 }`
 *   is silently ignored on Windows.
 *
 * The call is best‑effort — failures are silently caught.
 */
export function setRestrictiveFilePermissions(filePath: string): void {
  if (process.platform !== "win32") {
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // best effort
    }
    return;
  }

  // Windows: icacls — ditch inherited ACEs, grant current user only
  try {
    const username = process.env.USERNAME;
    if (!username) return;
    execFileSync(
      "icacls",
      [filePath, "/inheritance:r", "/grant", `${username}:(R,W)`],
      { stdio: "pipe", timeout: 5000 },
    );
  } catch {
    // best effort
  }
}

/**
 * Restrict a directory's permissions to the owning user only, with
 * inheritance so that newly‑created children also carry the restriction.
 *
 * - On Unix: chmod 0o700 (owner read + write + execute/traverse).
 * - On Windows: `icacls` removes inherited ACEs and grants the current
 *   user Read, Write, and eXecute (traverse) rights, inherited by both
 *   child files (OI) and child directories (CI).
 */
export function setRestrictiveDirPermissions(dirPath: string): void {
  if (process.platform !== "win32") {
    try {
      chmodSync(dirPath, 0o700);
    } catch {
      // best effort
    }
    return;
  }

  try {
    const username = process.env.USERNAME;
    if (!username) return;
    execFileSync(
      "icacls",
      [dirPath, "/inheritance:r", "/grant", `${username}:(OI)(CI)(RX,W)`],
      { stdio: "pipe", timeout: 5000 },
    );
  } catch {
    // best effort
  }
}
