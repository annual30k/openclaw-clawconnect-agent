
import { execFile as execFileCb, execFileSync, execSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { delimiter, dirname, join } from "path";
import { promisify } from "util";
import { buildExecutableInvocation, type ProcessInvocation } from "../../platform/process-invocation.js";
import { resolveConfiguredPath } from "../../openclaw/runtime/openclaw-paths.js";
import {
  getHermesBinCandidates,
  resolveHermesHomeDir,
  resolveHermesPythonBin,
  type HermesPathOptions,
} from "./hermes-runtime-paths.js";

const execFile = promisify(execFileCb);

export const IS_WINDOWS = process.platform === "win32";
export const HERMES_INBOX_DIR = join(homedir(), ".clawconnect", "hermes", "inbox");
export const HERMES_HOME_DIR = resolveHermesHomeDir();
export const HERMES_CRON_JOBS_FILE = join(HERMES_HOME_DIR, "cron", "jobs.json");
export const HERMES_LOG_DIR = join(HERMES_HOME_DIR, "logs");
export const HERMES_AGENT_LOG_FILE = join(HERMES_LOG_DIR, "agent.log");
export const HERMES_MODELS_DEV_CACHE_FILE = join(HERMES_HOME_DIR, "models_dev_cache.json");
export const DEFAULT_TIMEOUT_MS = 120_000;
export const CHAT_TIMEOUT_MS = 30 * 60_000;
const HERMES_EXEC_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const HERMES_ERROR_OUTPUT_LIMIT_BYTES = 16 * 1024;
export const HERMES_TYPING_MARKER = "[[clawlink:typing]]";
export const CLAWCONNECT_MOBILE_BRIDGE_HINT = [
  "[ClawConnect mobile bridge]",
  "You are connected to a mobile chat client through ClawConnect.",
  "When the latest user request explicitly asks you to send, upload, attach, or share a local host image or file, use your Hermes file-transfer skill if it is installed.",
  "The host-side delivery command is: clawconnect send-file --profile hermes --json <absolute-local-path>.",
  "Do not rely on final-answer local file paths as mobile attachments; after a successful send-file call, summarize what was sent.",
  "If the user is asking about capabilities, skills, file listings, or past work, do not repeat old file paths as sendable attachments.",
  "Do not say you cannot send attachments merely because you are running in a CLI environment.",
].join(" ");

export const SUBPROCESS_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = {};
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (upper === "PATH") continue;
    if (!seen.has(upper)) {
      seen.add(upper);
      env[key] = value;
    }
  }
  env.HOME = homedir();
  env.HERMES_HOME = HERMES_HOME_DIR;
  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  env.PATH = [
    dirname(process.execPath),
    join(HERMES_HOME_DIR, "bin"),
    join(HERMES_HOME_DIR, "hermes-agent", "venv", IS_WINDOWS ? "Scripts" : "bin"),
    join(homedir(), ".local", "bin"),
    join(homedir(), ".npm-global", "bin"),
    process.env.PNPM_HOME,
    join(homedir(), ".local", "share", "pnpm"),
    ...(IS_WINDOWS ? [] : [
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
      "/usr/bin",
      "/bin",
    ]),
    process.env.PATH ?? "",
  ].filter(Boolean).join(delimiter);
  return env;
})();

export interface HermesBinResolutionOptions extends HermesPathOptions {
  resolveOnPath?: () => string | undefined;
}

export function resolveHermesBin(options: HermesBinResolutionOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const systemHome = options.systemHome ?? homedir();
  const exists = options.exists ?? existsSync;
  const explicit = env.HERMES_BIN?.trim();
  const explicitPath = explicit ? resolveConfiguredPath(explicit, systemHome) : undefined;
  if (explicitPath && exists(explicitPath)) {
    return explicitPath;
  }

  const candidates = getHermesBinCandidates({ ...options, env, platform, systemHome, exists });
  if (platform === "win32") {
    // Windows 原生安装自带可直接传递 argv 的 hermes.exe。必须先于 PATH 中的旧版
    // hermes.cmd 使用，否则 cmd.exe 会重新解析多行消息并可能破坏 --quiet 等参数。
    const nativeExecutable = candidates.find((candidate) => candidate.toLowerCase().endsWith(".exe") && exists(candidate));
    if (nativeExecutable) {
      return nativeExecutable;
    }
  }

  const fromPath = options.resolveOnPath
    ? options.resolveOnPath()
    : resolveHermesBinOnPath(platform);
  if (fromPath) {
    return fromPath;
  }

  const local = candidates.find((candidate) => exists(candidate));
  if (local) {
    return local;
  }

  return "hermes";
}

function resolveHermesBinOnPath(platform: NodeJS.Platform): string | undefined {
  try {
    const resolved = platform === "win32"
      ? execFileSync("where.exe", ["hermes"], { stdio: "pipe", env: SUBPROCESS_ENV, timeout: 3000, windowsHide: true }).toString().trim()
      : execSync("command -v hermes", { stdio: "pipe", env: SUBPROCESS_ENV, timeout: 3000 }).toString().trim();
    return resolved.split(/\r?\n/)[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function hermesInvocation(args: string[]): ProcessInvocation {
  return buildExecutableInvocation(resolveHermesBin(), args);
}

export function runHermes(
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env: NodeJS.ProcessEnv = SUBPROCESS_ENV,
): string {
  const invocation = hermesInvocation(args);
  return execFileSync(invocation.command, invocation.args, {
    env,
    stdio: "pipe",
    timeout: timeoutMs,
  }).toString();
}

export async function runHermesAsync(
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env: NodeJS.ProcessEnv = SUBPROCESS_ENV,
): Promise<string> {
  const invocation = hermesInvocation(args);
  const { stdout } = await execFile(invocation.command, invocation.args, {
    encoding: "utf8",
    env,
    timeout: timeoutMs,
    maxBuffer: HERMES_EXEC_MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  return stdout;
}

export function runHermesWithInput(args: string[], input: string, timeoutMs = DEFAULT_TIMEOUT_MS): string {
  const invocation = hermesInvocation(args);
  return execFileSync(invocation.command, invocation.args, {
    env: SUBPROCESS_ENV,
    input,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
  }).toString();
}

export function stripHermesSessionResumeNotices(output: string): string {
  return output
    .split(/\r?\n|\r/)
    .filter((line) => {
      const clean = stripAnsi(line).trim();
      return !/^\s*↻?\s*Resumed session\b/i.test(clean)
        && !/^session_id:\s*\S+/i.test(clean)
        && !/^Error:\s*'NoneType'\s+object\s+is\s+not\s+iterable\s*$/i.test(clean);
    })
    .join("\n");
}

export function stripHermesSecurityReviewNotices(output: string): string {
  const lines = output.split(/\r?\n/);
  const kept: string[] = [];
  let inSecurityReview = false;

  for (const line of lines) {
    const clean = stripAnsi(line).trim();
    if (isHermesCommandDeniedTimeoutLine(clean)) {
      continue;
    }
    if (/DANGEROUS COMMAND:\s*Security scan/i.test(clean)) {
      inSecurityReview = true;
      continue;
    }
    if (inSecurityReview) {
      if (/Choice\s*\[[^\]]+\]:/i.test(clean) || /(?:^|\s)[✕x]\s*Denied\b/i.test(clean) || /\bDenied\b/i.test(clean)) {
        inSecurityReview = false;
      }
      continue;
    }
    kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function isHermesCommandDeniedTimeoutLine(line: string): boolean {
  const clean = stripAnsi(line).trim();
  return /\bTimeout\b\s*[–—-]\s*denying command\b/i.test(clean);
}

export function sanitizeHermesChatOutput(output: string): string {
  return stripHermesSecurityReviewNotices(stripHermesSessionResumeNotices(stripAnsi(output)));
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[\d;]*[A-Za-z@\[\]\\^_`{|}~-]/g, "");
}

export function errorMessageWithOutput(error: unknown): string {
  const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
  const stdout = boundedHermesErrorOutput(err.stdout);
  const stderr = boundedHermesErrorOutput(err.stderr);
  return [stdout, stderr, err.message].filter(Boolean).join("\n") || String(error);
}

function boundedHermesErrorOutput(value: Buffer | string | undefined): string {
  const output = value?.toString().trim() ?? "";
  if (Buffer.byteLength(output, "utf8") <= HERMES_ERROR_OUTPUT_LIMIT_BYTES) {
    return output;
  }
  const suffix = Buffer.from(output, "utf8").subarray(-HERMES_ERROR_OUTPUT_LIMIT_BYTES).toString("utf8");
  return `[Hermes output truncated to last ${HERMES_ERROR_OUTPUT_LIMIT_BYTES} bytes]\n${suffix}`;
}

export function isHermesMissingSessionError(error: unknown): boolean {
  const message = typeof error === "string" ? error : errorMessageWithOutput(error);
  return /Session not found:/i.test(message)
    || /Use a session ID from a previous CLI run/i.test(message);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function runHermesPython(script: string, extraEnv: NodeJS.ProcessEnv = {}): string {
  const cwd = resolveHermesAgentCwd();
  const python = resolveHermesPythonBin();
  return execFileSync(python, ["-c", script], {
    cwd,
    env: { ...SUBPROCESS_ENV, ...extraEnv },
    stdio: "pipe",
    timeout: DEFAULT_TIMEOUT_MS,
  }).toString();
}

export async function runHermesPythonAsync(
  script: string,
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const cwd = resolveHermesAgentCwd();
  const python = resolveHermesPythonBin();
  const { stdout } = await execFile(python, ["-c", script], {
    cwd,
    encoding: "utf8",
    env: { ...SUBPROCESS_ENV, ...extraEnv },
    timeout: timeoutMs,
  });
  return stdout;
}

function resolveHermesAgentCwd(): string {
  const agentDir = join(HERMES_HOME_DIR, "hermes-agent");
  return existsSync(agentDir) ? agentDir : homedir();
}
