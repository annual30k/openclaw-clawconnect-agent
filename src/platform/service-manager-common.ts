import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

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
  return "unsupported";
}

export function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function run(command: string, stdio: "pipe" | "inherit" = "pipe"): void {
  execSync(command, { stdio });
}

export function commandExists(command: string): boolean {
  try {
    run(`command -v ${command}`, "pipe");
    return true;
  } catch {
    return false;
  }
}

export function resolveServiceEntryPath(scriptPath: string): string {
  const normalizedScriptPath = scriptPath.replace(/\\/g, "/");
  const distIndexPath = normalizedScriptPath.replace(/\/src\/index\.(ts|js)$/, "/dist/index.js");
  if (distIndexPath !== normalizedScriptPath && existsSync(distIndexPath)) {
    return distIndexPath;
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
