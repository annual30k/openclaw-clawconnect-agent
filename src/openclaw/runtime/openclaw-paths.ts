import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type OpenClawPathEnvironment = Partial<Pick<NodeJS.ProcessEnv,
  | "OPENCLAW_HOME"
  | "OPENCLAW_STATE_DIR"
  | "OPENCLAW_CONFIG_PATH"
  | "CLAWCONNECT_OPENCLAW_HOME"
>>;

export interface OpenClawPathOptions {
  env?: OpenClawPathEnvironment;
  systemHome?: string;
}

/**
 * OpenClaw 官方允许安装方式和运行用户独立于状态目录。
 * 所有 ClawConnect 功能必须经过同一解析器，避免连接端口正确但日志、会话或备份仍误读 ~/.openclaw。
 */
export function resolveOpenClawStateDir(options: OpenClawPathOptions = {}): string {
  const env = options.env ?? process.env;
  const systemHome = options.systemHome ?? homedir();
  const explicitStateDir = firstNonEmpty(env.OPENCLAW_STATE_DIR, env.CLAWCONNECT_OPENCLAW_HOME);
  if (explicitStateDir) {
    return resolveConfiguredPath(explicitStateDir, systemHome);
  }

  const openClawHome = firstNonEmpty(env.OPENCLAW_HOME);
  return openClawHome
    ? join(resolveConfiguredPath(openClawHome, systemHome), ".openclaw")
    : join(systemHome, ".openclaw");
}

export function resolveOpenClawConfigPath(options: OpenClawPathOptions = {}): string {
  const env = options.env ?? process.env;
  const systemHome = options.systemHome ?? homedir();
  const explicitConfigPath = firstNonEmpty(env.OPENCLAW_CONFIG_PATH);
  return explicitConfigPath
    ? resolveConfiguredPath(explicitConfigPath, systemHome)
    : join(resolveOpenClawStateDir({ env, systemHome }), "openclaw.json");
}

export function resolveOpenClawConfigDir(options: OpenClawPathOptions = {}): string {
  return dirname(resolveOpenClawConfigPath(options));
}

export function resolveOpenClawAgentsDir(options: OpenClawPathOptions = {}): string {
  return join(resolveOpenClawStateDir(options), "agents");
}

export function resolveConfiguredPath(value: string, systemHome = homedir()): string {
  const trimmed = value.trim();
  if (trimmed === "~") {
    return systemHome;
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(systemHome, trimmed.slice(2));
  }
  return resolve(trimmed);
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}
