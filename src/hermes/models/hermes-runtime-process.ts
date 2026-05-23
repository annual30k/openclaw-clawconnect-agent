
import { execFileSync, execSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const IS_WINDOWS = process.platform === "win32";
export const HERMES_INBOX_DIR = join(homedir(), ".clawconnect", "hermes", "inbox");
export const HERMES_HOME_DIR = process.env.HERMES_HOME?.trim() || join(homedir(), ".hermes");
export const HERMES_CRON_JOBS_FILE = join(HERMES_HOME_DIR, "cron", "jobs.json");
export const HERMES_LOG_DIR = join(HERMES_HOME_DIR, "logs");
export const HERMES_AGENT_LOG_FILE = join(HERMES_LOG_DIR, "agent.log");
export const HERMES_MODELS_DEV_CACHE_FILE = join(HERMES_HOME_DIR, "models_dev_cache.json");
export const DEFAULT_TIMEOUT_MS = 120_000;
export const CHAT_TIMEOUT_MS = 30 * 60_000;
export const HERMES_TYPING_MARKER = "[[clawlink:typing]]";
export const CLAWCONNECT_MOBILE_BRIDGE_HINT = [
  "[ClawConnect mobile bridge]",
  "You are connected to a mobile chat client through ClawConnect.",
  "Only when the latest user request explicitly asks you to send, upload, attach, or share a local image or file, include its absolute local file path in your final answer.",
  "ClawConnect uploads supported file paths only for those explicit send requests.",
  "If the user is asking about capabilities, skills, file listings, or past work, do not repeat old file paths as sendable attachments.",
  "Do not say you cannot send attachments merely because you are running in a CLI environment.",
].join(" ");

export const SUBPROCESS_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: homedir(),
  PATH: [
    join(homedir(), ".local", "bin"),
    join(homedir(), ".hermes", "bin"),
    join(homedir(), ".npm-global", "bin"),
    process.env.PNPM_HOME,
    join(homedir(), ".local", "share", "pnpm"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    process.env.PATH ?? "",
  ].filter(Boolean).join(IS_WINDOWS ? ";" : ":"),
};

export function resolveHermesBin(): string {
  const explicit = process.env.HERMES_BIN?.trim();
  if (explicit && existsSync(explicit)) {
    return explicit;
  }

  try {
    const whichCmd = IS_WINDOWS ? "where hermes" : "command -v hermes";
    const resolved = execSync(whichCmd, { stdio: "pipe", env: SUBPROCESS_ENV, timeout: 3000 }).toString().trim();
    const first = resolved.split(/\r?\n/)[0]?.trim();
    if (first) {
      return first;
    }
  } catch {
    // fall through
  }

  const local = join(homedir(), ".local", "bin", IS_WINDOWS ? "hermes.cmd" : "hermes");
  if (existsSync(local)) {
    return local;
  }

  return "hermes";
}

export function runHermes(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): string {
  return execFileSync(resolveHermesBin(), args, {
    env: SUBPROCESS_ENV,
    stdio: "pipe",
    timeout: timeoutMs,
  }).toString();
}

export function runHermesWithInput(args: string[], input: string, timeoutMs = DEFAULT_TIMEOUT_MS): string {
  return execFileSync(resolveHermesBin(), args, {
    env: SUBPROCESS_ENV,
    input,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
  }).toString();
}

export function stripHermesSessionResumeNotices(output: string): string {
  return output
    .split(/\r?\n/)
    .filter((line) => !/^\s*↻?\s*Resumed session\b/i.test(stripAnsi(line).trim()))
    .join("\n");
}

export function stripHermesSecurityReviewNotices(output: string): string {
  const lines = output.split(/\r?\n/);
  const kept: string[] = [];
  let inSecurityReview = false;

  for (const line of lines) {
    const clean = stripAnsi(line).trim();
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

export function sanitizeHermesChatOutput(output: string): string {
  return stripHermesSecurityReviewNotices(stripHermesSessionResumeNotices(stripAnsi(output)));
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[\d;]*[A-Za-z@\[\]\\^_`{|}~-]/g, "");
}

export function errorMessageWithOutput(error: unknown): string {
  const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
  const stdout = err.stdout?.toString().trim() ?? "";
  const stderr = err.stderr?.toString().trim() ?? "";
  return [stdout, stderr, err.message].filter(Boolean).join("\n") || String(error);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function runHermesPython(script: string, extraEnv: NodeJS.ProcessEnv = {}): string {
  const venvPython = join(HERMES_HOME_DIR, "hermes-agent", "venv", "bin", "python");
  const python = process.env.HERMES_PYTHON?.trim()
    || (existsSync(venvPython) ? venvPython : join(homedir(), ".local", "bin", "python3.11"));
  return execFileSync(python, ["-c", script], {
    cwd: join(HERMES_HOME_DIR, "hermes-agent"),
    env: { ...SUBPROCESS_ENV, ...extraEnv },
    stdio: "pipe",
    timeout: DEFAULT_TIMEOUT_MS,
  }).toString();
}
