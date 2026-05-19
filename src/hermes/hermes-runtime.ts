import { randomUUID } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { basename, extname, join, resolve } from "path";
import { execFileSync, execSync, spawn } from "child_process";
import type { LocalCommandContext, LocalResult } from "../commands/local-runtime.js";
import {
  forgetHermesSession,
  getMappedHermesSessionId,
  listStoredHermesSessions,
  mergeLiveHermesSessionsWithStoredAliases,
  parseHermesSessionsList,
  rememberHermesSession,
} from "./hermes-session-store.js";

const IS_WINDOWS = process.platform === "win32";
const HERMES_INBOX_DIR = join(homedir(), ".clawconnect", "hermes", "inbox");
const HERMES_HOME_DIR = process.env.HERMES_HOME?.trim() || join(homedir(), ".hermes");
const HERMES_CRON_JOBS_FILE = join(HERMES_HOME_DIR, "cron", "jobs.json");
const HERMES_LOG_DIR = join(HERMES_HOME_DIR, "logs");
const HERMES_MODELS_DEV_CACHE_FILE = join(HERMES_HOME_DIR, "models_dev_cache.json");
const DEFAULT_TIMEOUT_MS = 120_000;
const CHAT_TIMEOUT_MS = 30 * 60_000;
const CLAWCONNECT_MOBILE_BRIDGE_HINT = [
  "[ClawConnect mobile bridge]",
  "You are connected to a mobile chat client through ClawConnect.",
  "Only when the latest user request explicitly asks you to send, upload, attach, or share a local image or file, include its absolute local file path in your final answer.",
  "ClawConnect uploads supported file paths only for those explicit send requests.",
  "If the user is asking about capabilities, skills, file listings, or past work, do not repeat old file paths as sendable attachments.",
  "Do not say you cannot send attachments merely because you are running in a CLI environment.",
].join(" ");

const SUBPROCESS_ENV: NodeJS.ProcessEnv = {
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

export type HermesChatResult = {
  output: string;
  sessionKey: string;
  artifactPaths: string[];
  usage?: HermesUsageSnapshot;
};

export type HermesUsageSnapshot = {
  currentModel?: string;
  provider?: string;
  contextUsage?: number;
  contextLimit?: number;
  hermesSessionId?: string;
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

function sanitizeHermesChatOutput(output: string): string {
  return stripHermesSecurityReviewNotices(stripHermesSessionResumeNotices(stripAnsi(output)));
}

export function handleHermesCommand(
  method: string,
  params: unknown,
  context: LocalCommandContext = {},
): LocalResult | Promise<LocalResult> | null {
  switch (method) {
    case "hermes.status":
      return runHermesOutput(["status"]);
    case "hermes.logs":
      return runHermesLogs(params);
    case "hermes.sessions.list":
      return runHermesSessionsList();
    case "hermes.sessions.rename":
      return runHermesSessionRename(params);
    case "hermes.sessions.delete":
      return runHermesSessionDelete(params);
    case "hermes.sessions.export":
      return runHermesSessionExport(params);
    case "cron.list":
    case "hermes.cron.list":
      return runHermesCronList(params);
    case "cron.add":
    case "hermes.cron.add":
      return runHermesCronCreate(params);
    case "cron.update":
    case "hermes.cron.update":
      return runHermesCronUpdate(params);
    case "cron.remove":
    case "hermes.cron.remove":
      return runHermesCronRemove(params);
    case "cron.status":
    case "hermes.cron.status":
      return runHermesOutput(["cron", "status"]);
    case "hermes.cron.run":
      return runHermesCronRun(params);
    case "hermes.skills.list":
    case "skills.status":
      return runHermesSkillsList();
    case "hermes.skills.update":
      return runHermesSkillsUpdate(params);
    case "hermes.skills.search":
      return runHermesSkillsSearch(params);
    case "hermes.skills.inspect":
      return runHermesSkillsInspect(params);
    case "hermes.skills.install":
      return runHermesSkillsInstall(params);
    case "hermes.skills.uninstall":
      return runHermesSkillsUninstall(params);
    case "hermes.mcp.list":
      return runHermesMcpList();
    case "hermes.mcp.test":
      return runHermesMcpTest(params);
    case "hermes.mcp.add":
      return runHermesMcpAdd(params);
    case "hermes.mcp.remove":
      return runHermesMcpRemove(params);
    case "hermes.dashboard.status":
      return runHermesOutput(["dashboard", "--status"]);
    case "hermes.dashboard.start":
      return runHermesDashboardStart(params);
    case "hermes.dashboard.stop":
      return runHermesOutput(["dashboard", "--stop"]);
    case "hermes.gateway.start":
      return runHermesLifecycle("start", context);
    case "hermes.gateway.stop":
      return runHermesLifecycle("stop", context);
    case "hermes.gateway.restart":
    case "hermes.agent.restart":
      return runHermesLifecycle("restart", context);
    case "hermes.backup.create":
      return runHermesBackupCreate(params);
    case "hermes.backup.list":
      return runHermesBackupList();
    case "hermes.backup.delete":
      return runHermesBackupDelete(params);
    case "hermes.backup.restore":
      return runHermesBackupRestore(params);
    case "hermes.update":
      return runHermesOutput(["update"], 10 * 60_000);
    default:
      return null;
  }
}

export async function runHermesChat(
  params: unknown,
  context: LocalCommandContext = {},
): Promise<HermesChatResult> {
  const record = params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
  const rawMessage = typeof record.message === "string" ? record.message : "";
  const sessionKey = typeof record.sessionKey === "string" && record.sessionKey.trim().length > 0
    ? record.sessionKey.trim()
    : "main";
  const message = await prepareHermesMessage(rawMessage, record.attachments, sessionKey);
  if (!message.trim()) {
    throw new Error("message_required");
  }

  const args = ["chat", "--query", message, "--quiet", "--source", "pocketclaw"];
  const resume = typeof record.hermesSessionId === "string" && record.hermesSessionId.trim().length > 0
    ? record.hermesSessionId.trim()
    : await getMappedHermesSessionId(sessionKey);
  if (resume) {
    args.push("--resume", resume);
  }

  const rawOutput = context.publishEvent
    ? await runHermesChatStreaming(args, sessionKey, context)
    : runHermes(args, CHAT_TIMEOUT_MS);
  const output = sanitizeHermesChatOutput(rawOutput).trim();
  const sessions = await listHermesSessions();
  const mappedSession = sessions[0];
  if (mappedSession) {
    await rememberHermesSession(sessionKey, mappedSession);
  }
  const usage = await collectHermesUsageSnapshot(mappedSession?.hermesSessionId);
  return {
    output,
    sessionKey,
    artifactPaths: extractDeliverablePaths(output, { userMessage: rawMessage }),
    usage,
  };
}

async function runHermesChatStreaming(
  args: string[],
  sessionKey: string,
  context: LocalCommandContext,
): Promise<string> {
  const child = spawn(resolveHermesBin(), args, {
    env: SUBPROCESS_ENV,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const runId = context.requestId ?? `hermes-${Date.now()}`;
  let output = "";
  let stderr = "";
  let seq = 0;
  let stdoutLineBuffer = "";
  let inSecurityReview = false;

  const filterChatLine = (line: string): string | null => {
    const clean = stripAnsi(line).trim();
    if (/DANGEROUS COMMAND:\s*Security scan/i.test(clean)) {
      inSecurityReview = true;
      return null;
    }
    if (inSecurityReview) {
      if (/Choice\s*\[[^\]]+\]:/i.test(clean) || /(?:^|\s)[✕x]\s*Denied\b/i.test(clean) || /\bDenied\b/i.test(clean)) {
        inSecurityReview = false;
      }
      return null;
    }
    return line;
  };

  const publishText = (text: string): void => {
    stdoutLineBuffer += text;
    const lines = stdoutLineBuffer.split(/\r?\n/);
    stdoutLineBuffer = lines.pop() ?? "";
    const clean = stripHermesSessionResumeNotices(
      lines
        .map(filterChatLine)
        .filter((line): line is string => line !== null)
        .join("\n"),
    );
    if (!clean.trim()) {
      return;
    }
    const chunk = `${clean}\n`;
    output += chunk;
    context.publishEvent?.({
      type: "event",
      event: "chat",
      payload: {
        runId,
        sessionKey,
        state: "streaming",
        role: "assistant",
        seq: seq += 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: chunk }],
        },
      },
    });
  };

  const flushStdoutLineBuffer = (): void => {
    if (!stdoutLineBuffer) {
      return;
    }
    const clean = stripHermesSessionResumeNotices(filterChatLine(stdoutLineBuffer) ?? "");
    stdoutLineBuffer = "";
    if (!clean.trim()) {
      return;
    }
    output += clean;
    context.publishEvent?.({
      type: "event",
      event: "chat",
      payload: {
        runId,
        sessionKey,
        state: "streaming",
        role: "assistant",
        seq: seq += 1,
        message: {
          role: "assistant",
          content: [{ type: "text", text: clean }],
        },
      },
    });
  };

  const publishStderr = (text: string): void => {
    const clean = stripAnsi(text).trimEnd();
    if (!clean) {
      return;
    }
    stderr += `${clean}\n`;
    context.publishEvent?.({
      type: "event",
      event: "maintenance_log",
      payload: {
        gatewayId: context.gatewayId,
        requestId: context.requestId,
        runId,
        stream: "stderr",
        seq: seq += 1,
        ts: Date.now(),
        text: clean,
      },
    });
  };

  child.stdout?.on("data", (chunk) => publishText(chunk.toString()));
  child.stderr?.on("data", (chunk) => publishStderr(chunk.toString()));

  return await new Promise<string>((resolveOutput, rejectOutput) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectOutput(new Error("hermes_chat_timeout"));
    }, CHAT_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectOutput(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      flushStdoutLineBuffer();
      if (code && code !== 0) {
        const reason = stderr.trim() || output.trim() || `hermes chat exited with code ${code}`;
        rejectOutput(new Error(signal ? `${reason} (${signal})` : reason));
        return;
      }
      resolveOutput(output);
    });
  });
}

export async function listHermesSessions(): Promise<ReturnType<typeof parseHermesSessionsList>> {
  const output = runHermes(["sessions", "list"]);
  const parsed = parseHermesSessionsList(output);
  const stored = await listStoredHermesSessions();
  return mergeLiveHermesSessionsWithStoredAliases(parsed, stored);
}

export function readHermesStatusSnapshot(): HermesUsageSnapshot {
  try {
    return enrichHermesUsageSnapshot(parseHermesStatusSnapshot(runHermes(["status"], 10_000)));
  } catch {
    return {};
  }
}

export async function collectHermesUsageSnapshot(hermesSessionId?: string): Promise<HermesUsageSnapshot> {
  const status = readHermesStatusSnapshot();
  const sessionId = hermesSessionId ?? (await latestHermesSessionId());
  if (!sessionId) {
    return status;
  }
  try {
    const output = runHermes(["sessions", "export", "-", "--session-id", sessionId], 10 * 60_000);
    return enrichHermesUsageSnapshot(mergeHermesUsageSnapshots(
      status,
      parseHermesSessionUsageSnapshot(output),
      { hermesSessionId: sessionId },
    ));
  } catch {
    return {
      ...status,
      hermesSessionId: sessionId,
    };
  }
}

export function parseHermesStatusSnapshot(output: string): HermesUsageSnapshot {
  const snapshot: HermesUsageSnapshot = {};
  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    const model = line.match(/^Model:\s*(.+)$/i)?.[1]?.trim();
    if (model && model !== "--") {
      snapshot.currentModel = model;
      continue;
    }
    const provider = line.match(/^Provider:\s*(.+)$/i)?.[1]?.trim();
    if (provider && provider !== "--") {
      snapshot.provider = provider;
    }
  }
  return snapshot;
}

export function parseHermesSessionUsageSnapshot(output: string): HermesUsageSnapshot {
  const record = parseJsonObject(output);
  if (!record) {
    return {};
  }
  const modelConfig = parseMaybeJsonObject(record.model_config);
  return mergeHermesUsageSnapshots({
    currentModel: stringValue(record.model) ?? stringValue(record.currentModel) ?? stringValue(record.current_model),
    contextUsage: firstNonNegativeInteger(
      record.input_tokens,
      record.prompt_tokens,
      record.contextUsage,
      record.context_usage,
    ),
    contextLimit: firstPositiveInteger(
      record.contextLimit,
      record.context_limit,
      record.maxInputTokens,
      record.max_input_tokens,
      record.contextWindow,
      record.context_window,
      record.contextTokens,
      record.context_tokens,
      modelConfig?.contextLimit,
      modelConfig?.context_limit,
      modelConfig?.maxInputTokens,
      modelConfig?.max_input_tokens,
      modelConfig?.contextWindow,
      modelConfig?.context_window,
      modelConfig?.contextTokens,
      modelConfig?.context_tokens,
      modelConfig?.maxContextTokens,
      modelConfig?.max_context_tokens,
    ),
  });
}

async function latestHermesSessionId(): Promise<string | undefined> {
  const sessions = await listHermesSessions();
  return sessions[0]?.hermesSessionId;
}

function enrichHermesUsageSnapshot(snapshot: HermesUsageSnapshot): HermesUsageSnapshot {
  if (!snapshot.currentModel || snapshot.contextLimit !== undefined) {
    return snapshot;
  }
  const contextLimit = readHermesContextLimit(snapshot.currentModel, snapshot.provider);
  return contextLimit !== undefined ? { ...snapshot, contextLimit } : snapshot;
}

function readHermesContextLimit(model: string, provider?: string): number | undefined {
  return readHermesContextLimitFromLogs(model)
    ?? readHermesContextLimitFromModelsDevCache(model, provider);
}

function readHermesContextLimitFromLogs(model: string): number | undefined {
  const normalizedModel = normalizeModelId(model);
  try {
    const logFiles = readdirSync(HERMES_LOG_DIR)
      .filter((name) => name.endsWith(".log"))
      .map((name) => join(HERMES_LOG_DIR, name))
      .sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs);
    let latest: number | undefined;
    for (const filePath of logFiles) {
      const content = readFileSync(filePath, "utf8");
      const pattern = /Cached context length\s+([^\s@]+)@[^\n]*?->\s*([\d,]+)\s*tokens/gi;
      for (const match of content.matchAll(pattern)) {
        if (normalizeModelId(match[1]) !== normalizedModel) {
          continue;
        }
        const parsed = nonNegativeInteger(match[2]?.replace(/,/g, ""));
        if (parsed !== undefined && parsed > 0) {
          latest = parsed;
        }
      }
    }
    return latest;
  } catch {
    return undefined;
  }
}

function readHermesContextLimitFromModelsDevCache(model: string, provider?: string): number | undefined {
  try {
    const raw = readFileSync(HERMES_MODELS_DEV_CACHE_FILE, "utf8");
    const cache = JSON.parse(raw) as unknown;
    if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
      return undefined;
    }
    const providerId = hermesModelsDevProviderId(provider);
    const providerRecord = toRecord((cache as Record<string, unknown>)[providerId]);
    const models = toRecord(providerRecord.models);
    const normalizedModel = normalizeModelId(model);
    for (const [candidate, entry] of Object.entries(models)) {
      if (normalizeModelId(candidate) !== normalizedModel) {
        continue;
      }
      const limit = toRecord(toRecord(entry).limit);
      const parsed = firstPositiveInteger(
        limit.context,
        limit.input,
        toRecord(entry).context_window,
        toRecord(entry).contextWindow,
      );
      if (parsed !== undefined) {
        return parsed;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function hermesModelsDevProviderId(provider?: string): string {
  const normalized = provider?.toLowerCase() ?? "";
  if (normalized.includes("openai")) {
    return "openai";
  }
  if (normalized.includes("minimax")) {
    return "minimax";
  }
  if (normalized.includes("anthropic")) {
    return "anthropic";
  }
  if (normalized.includes("google") || normalized.includes("gemini")) {
    return "google";
  }
  if (normalized.includes("deepseek")) {
    return "deepseek";
  }
  if (normalized.includes("openrouter")) {
    return "openrouter";
  }
  return "openai";
}

function normalizeModelId(model: string | undefined): string {
  const normalized = model?.trim().toLowerCase() ?? "";
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

function runHermesOutput(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): LocalResult {
  try {
    const output = runHermes(args, timeoutMs);
    return { ok: true, payload: { output } };
  } catch (error) {
    return { ok: false, error: errorMessageWithOutput(error) };
  }
}

function runHermesLogs(params: unknown): LocalResult {
  const record = params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
  const logName = typeof record.logName === "string" && record.logName.trim().length > 0 ? record.logName.trim() : "gateway";
  const limit = typeof record.limit === "number" && Number.isFinite(record.limit) ? Math.max(1, Math.min(2000, Math.floor(record.limit))) : 100;
  return runHermesOutput(["logs", logName, "-n", String(limit)]);
}

async function runHermesSessionsList(): Promise<LocalResult> {
  try {
    const sessions = await listHermesSessions();
    return { ok: true, payload: { sessions, items: sessions } };
  } catch (error) {
    return { ok: false, error: errorMessageWithOutput(error) };
  }
}

function runHermesSessionRename(params: unknown): LocalResult {
  const record = toRecord(params);
  const sessionId = stringParam(record, "sessionId", "hermesSessionId", "id");
  const title = stringParam(record, "title", "name");
  if (!sessionId || !title) {
    return { ok: false, error: "session_id_and_title_required" };
  }
  return runHermesOutput(["sessions", "rename", sessionId, title]);
}

async function runHermesSessionDelete(params: unknown): Promise<LocalResult> {
  const record = toRecord(params);
  const sessionKey = stringParam(record, "sessionKey", "key", "session");
  const sessionId = stringParam(record, "sessionId", "hermesSessionId", "id")
    ?? await resolveHermesSessionIdFromParams(record);
  if (!sessionId) {
    return { ok: false, error: "session_id_required" };
  }
  const result = runHermesOutput(["sessions", "delete", "--yes", sessionId]);
  if (!result.ok) {
    return result;
  }
  await forgetHermesSession(sessionKey ?? sessionId, sessionId);
  return {
    ok: true,
    payload: {
      ...(toRecord(result.payload)),
      deleted: true,
      sessionId,
      sessionKey,
    },
  };
}

async function runHermesSessionExport(params: unknown): Promise<LocalResult> {
  const record = toRecord(params);
  const sessionId = stringParam(record, "sessionId", "hermesSessionId", "id")
    ?? await resolveHermesSessionIdFromParams(record);
  const output = stringParam(record, "output", "outputPath");
  const args = ["sessions", "export", output ?? "-"];
  if (sessionId) args.push("--session-id", sessionId);
  return runHermesOutput(args, 10 * 60_000);
}

async function runHermesCronList(params: unknown): Promise<LocalResult> {
  try {
    const includeDisabled = toRecord(params).includeDisabled !== false;
    const jobs = await readHermesCronJobs(includeDisabled);
    return { ok: true, payload: { jobs, items: jobs, hasMore: false, nextOffset: null } };
  } catch (error) {
    return { ok: false, error: errorMessageWithOutput(error) };
  }
}

function runHermesCronCreate(params: unknown): LocalResult {
  const record = toRecord(params);
  const schedule = hermesScheduleFromParams(record);
  const prompt = promptFromCronParams(record);
  if (!schedule || !prompt) {
    return { ok: false, error: "schedule_and_prompt_required" };
  }
  const args = ["cron", "create", schedule, prompt];
  const name = stringParam(record, "name", "title");
  if (name) args.push("--name", name);
  const output = runHermes(args, DEFAULT_TIMEOUT_MS);
  const createdId = output.match(/Created job:\s*([A-Za-z0-9_-]+)/)?.[1];
  return { ok: true, payload: findHermesCronJobPayload(createdId) ?? { output } };
}

function runHermesCronUpdate(params: unknown): LocalResult {
  const record = toRecord(params);
  const id = stringParam(record, "id", "jobId");
  const patch = toRecord(record.patch ?? record);
  if (!id) {
    return { ok: false, error: "job_id_required" };
  }
  const patchKeys = Object.keys(patch).filter((key) => key !== "id" && key !== "jobId");
  if (patchKeys.length === 1 && typeof patch.enabled === "boolean") {
    runHermes(["cron", patch.enabled ? "resume" : "pause", id]);
    return { ok: true, payload: findHermesCronJobPayload(id) ?? { id, enabled: patch.enabled } };
  }
  const args = ["cron", "edit", id];
  const schedule = hermesScheduleFromParams(patch);
  const prompt = promptFromCronParams(patch);
  const name = stringParam(patch, "name", "title");
  if (schedule) args.push("--schedule", schedule);
  if (prompt) args.push("--prompt", prompt);
  if (name) args.push("--name", name);
  if (typeof patch.enabled === "boolean") {
    runHermes(["cron", patch.enabled ? "resume" : "pause", id]);
  }
  if (args.length > 3) {
    runHermes(args);
  }
  return { ok: true, payload: findHermesCronJobPayload(id) ?? { id } };
}

function runHermesCronRemove(params: unknown): LocalResult {
  const id = stringParam(toRecord(params), "id", "jobId");
  if (!id) {
    return { ok: false, error: "job_id_required" };
  }
  const output = runHermes(["cron", "remove", id]);
  return { ok: true, payload: { removed: !/not found/i.test(output), output } };
}

function runHermesCronRun(params: unknown): LocalResult {
  const id = stringParam(toRecord(params), "id", "jobId");
  if (!id) {
    return { ok: false, error: "job_id_required" };
  }
  const output = runHermes(["cron", "run", id]);
  return { ok: true, payload: findHermesCronJobPayload(id) ?? { id, output } };
}

function runHermesSkillsList(): LocalResult {
  const output = runHermes(["skills", "list"]);
  return { ok: true, payload: { skills: parseHermesSkillsList(output), output } };
}

function runHermesSkillsUpdate(params: unknown): LocalResult {
  const record = toRecord(params);
  const skillKey = stringParam(record, "skillKey", "name", "id");
  if (!skillKey || typeof record.enabled !== "boolean") {
    return { ok: false, error: "skill_key_and_enabled_required" };
  }
  const script = [
    "from hermes_cli.config import load_config",
    "from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills",
    `skill=${JSON.stringify(skillKey)}`,
    `enabled=${record.enabled ? "True" : "False"}`,
    "config=load_config()",
    "disabled=get_disabled_skills(config)",
    "disabled.discard(skill) if enabled else disabled.add(skill)",
    "save_disabled_skills(config, disabled)",
    "print('ok')",
  ].join("\n");
  runHermesPython(script);
  return { ok: true, payload: { ok: true, skillKey, enabled: record.enabled } };
}

function runHermesSkillsSearch(params: unknown): LocalResult {
  const query = stringParam(toRecord(params), "query", "q") ?? "";
  return runHermesOutput(["skills", "search", query]);
}

function runHermesSkillsInspect(params: unknown): LocalResult {
  const id = stringParam(toRecord(params), "identifier", "skillKey", "name", "id");
  if (!id) return { ok: false, error: "skill_identifier_required" };
  return runHermesOutput(["skills", "inspect", id]);
}

function runHermesSkillsInstall(params: unknown): LocalResult {
  const record = toRecord(params);
  const id = stringParam(record, "identifier", "skillKey", "name", "id");
  if (!id) return { ok: false, error: "skill_identifier_required" };
  const args = ["skills", "install", id, "--yes"];
  const category = stringParam(record, "category");
  const name = stringParam(record, "nameOverride");
  if (category) args.push("--category", category);
  if (name) args.push("--name", name);
  if (record.force === true) args.push("--force");
  return runHermesOutput(args, 10 * 60_000);
}

function runHermesSkillsUninstall(params: unknown): LocalResult {
  const id = stringParam(toRecord(params), "skillKey", "name", "id");
  if (!id) return { ok: false, error: "skill_name_required" };
  return runHermesOutput(["skills", "uninstall", id], 10 * 60_000);
}

function runHermesMcpList(): LocalResult {
  const output = runHermes(["mcp", "list"]);
  return { ok: true, payload: { servers: parseHermesMcpList(output), output } };
}

function runHermesMcpTest(params: unknown): LocalResult {
  const name = stringParam(toRecord(params), "name", "serverName");
  if (!name) return { ok: false, error: "mcp_server_name_required" };
  return runHermesOutput(["mcp", "test", name]);
}

function runHermesMcpAdd(params: unknown): LocalResult {
  const record = toRecord(params);
  const name = stringParam(record, "name", "serverName");
  if (!name) return { ok: false, error: "mcp_server_name_required" };
  const args = ["mcp", "add", name];
  const url = stringParam(record, "url");
  const command = stringParam(record, "command");
  const preset = stringParam(record, "preset");
  if (url) args.push("--url", url);
  if (command) args.push("--command", command);
  const argValues = Array.isArray(record.args) ? record.args.filter((item): item is string => typeof item === "string") : [];
  if (argValues.length > 0) args.push("--args", ...argValues);
  if (preset) args.push("--preset", preset);
  const envValues = Array.isArray(record.env) ? record.env.filter((item): item is string => typeof item === "string") : [];
  if (envValues.length > 0) args.push("--env", ...envValues);
  const output = runHermesWithInput(args, "y\n", 10 * 60_000);
  return { ok: true, payload: { output } };
}

function runHermesMcpRemove(params: unknown): LocalResult {
  const name = stringParam(toRecord(params), "name", "serverName");
  if (!name) return { ok: false, error: "mcp_server_name_required" };
  return { ok: true, payload: { output: runHermesWithInput(["mcp", "remove", name], "y\n", DEFAULT_TIMEOUT_MS) } };
}

function runHermesDashboardStart(params: unknown): LocalResult {
  const record = toRecord(params);
  const args = ["dashboard", "--no-open"];
  const port = numberParam(record, "port");
  const host = stringParam(record, "host");
  if (port) args.push("--port", String(port));
  if (host) args.push("--host", host);
  if (record.tui === true) args.push("--tui");
  if (record.skipBuild === true) args.push("--skip-build");
  return runHermesOutput(args, 10 * 60_000);
}

function runHermesBackupCreate(params: unknown): LocalResult {
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

function runHermesBackupList(): LocalResult {
  return { ok: true, payload: { backups: listHermesBackups(), maxBackups: 0 } };
}

function runHermesBackupDelete(params: unknown): LocalResult {
  const id = stringParam(toRecord(params), "backupId", "id", "path");
  if (!id) return { ok: false, error: "backup_id_required" };
  const backup = findHermesBackup(id);
  if (!backup) return { ok: false, error: "backup_not_found" };
  const backupPath = stringParam(backup, "path");
  if (!backupPath) return { ok: false, error: "backup_path_missing" };
  unlinkSync(backupPath);
  return { ok: true, payload: { backup, backups: listHermesBackups(), maxBackups: 0 } };
}

function runHermesBackupRestore(params: unknown): LocalResult {
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

async function runHermesLifecycle(
  action: "start" | "stop" | "restart",
  context: LocalCommandContext,
): Promise<LocalResult> {
  const args = ["gateway", action];
  const publishEvent = context.publishEvent;
  const requestId = context.requestId;
  const gatewayId = context.gatewayId;
  const child = spawn(resolveHermesBin(), args, {
    env: SUBPROCESS_ENV,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  let seq = 0;

  const emit = (stream: "stdout" | "stderr" | "status", text: string): void => {
    const clean = stripAnsi(text).trimEnd();
    if (!clean) {
      return;
    }
    output += `${clean}\n`;
    publishEvent?.({
      type: "event",
      event: "maintenance_log",
      payload: {
        gatewayId,
        requestId,
        runId: requestId,
        stream,
        seq: seq += 1,
        ts: Date.now(),
        text: clean,
      },
    });
  };

  child.stdout?.on("data", (chunk) => emit("stdout", chunk.toString()));
  child.stderr?.on("data", (chunk) => emit("stderr", chunk.toString()));
  emit("status", `Running: hermes gateway ${action}`);

  return await new Promise<LocalResult>((resolveResult) => {
    child.once("error", (error) => resolveResult({ ok: false, error: String(error) }));
    child.once("close", (code, signal) => {
      const summary = typeof code === "number"
        ? `hermes gateway ${action} exited with code ${code}`
        : `hermes gateway ${action} exited${signal ? ` with signal ${signal}` : ""}`;
      emit("status", summary);
      if (code && code !== 0) {
        resolveResult({ ok: false, error: output.trim() || summary });
        return;
      }
      resolveResult({ ok: true, payload: { output: output.trim() || summary } });
    });
  });
}

async function prepareHermesMessage(message: string, attachments: unknown, sessionKey: string): Promise<string> {
  const refs: string[] = [];
  if (Array.isArray(attachments)) {
    const safeSession = sessionKey.replace(/[^\w.-]/g, "_") || "main";
    for (const attachment of attachments) {
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
        continue;
      }
      const record = attachment as Record<string, unknown>;
      if (typeof record.content !== "string" || record.content.length === 0) {
        continue;
      }
      const fileName = sanitizeFileName(
        typeof record.fileName === "string" ? record.fileName
          : typeof record.name === "string" ? record.name
            : `attachment-${randomUUID()}`,
      );
      const dir = join(HERMES_INBOX_DIR, safeSession, randomUUID());
      await mkdir(dir, { recursive: true });
      const filePath = join(dir, fileName);
      await writeFile(filePath, Buffer.from(record.content, "base64"));
      const mimeType = typeof record.mimeType === "string" ? record.mimeType : "application/octet-stream";
      refs.push(`[file attached: ${filePath} (${mimeType})]`);
    }
  }
  const sections = [message.trim()];
  if (refs.length > 0) {
    sections.push(refs.join("\n"));
  }
  sections.push(CLAWCONNECT_MOBILE_BRIDGE_HINT);
  return sections.filter(Boolean).join("\n\n").trim();
}

async function resolveHermesSessionIdFromParams(record: Record<string, unknown>): Promise<string | undefined> {
  const sessionKey = stringParam(record, "sessionKey", "key", "session");
  if (!sessionKey) {
    return undefined;
  }
  if (sessionKey.toLowerCase().startsWith("hermes:")) {
    const hermesId = sessionKey.slice("hermes:".length).trim();
    return hermesId || undefined;
  }
  if (/^[0-9]{8}_[0-9]{6}_[A-Za-z0-9_-]+$/.test(sessionKey)) {
    return sessionKey;
  }
  return await getMappedHermesSessionId(sessionKey);
}

function sanitizeFileName(fileName: string): string {
  const base = basename(fileName).replace(/[^\w.\- ()[\]]/g, "_").slice(0, 160);
  return base || `attachment-${randomUUID()}`;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringParam(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function numberParam(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

function firstNonNegativeInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = nonNegativeInteger(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function firstPositiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = nonNegativeInteger(value);
    if (parsed !== undefined && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function mergeHermesUsageSnapshots(...snapshots: HermesUsageSnapshot[]): HermesUsageSnapshot {
  const merged: HermesUsageSnapshot = {};
  for (const snapshot of snapshots) {
    if (snapshot.currentModel !== undefined) merged.currentModel = snapshot.currentModel;
    if (snapshot.provider !== undefined) merged.provider = snapshot.provider;
    if (snapshot.contextUsage !== undefined) merged.contextUsage = snapshot.contextUsage;
    if (snapshot.contextLimit !== undefined) merged.contextLimit = snapshot.contextLimit;
    if (snapshot.hermesSessionId !== undefined) merged.hermesSessionId = snapshot.hermesSessionId;
  }
  return merged;
}

function parseJsonObject(output: string): Record<string, unknown> | undefined {
  const clean = stripAnsi(output).trim();
  const candidates = [clean];
  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(clean.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

function parseMaybeJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim().startsWith("{")) {
    return parseJsonObject(value);
  }
  return undefined;
}

function runHermesPython(script: string): string {
  const venvPython = join(HERMES_HOME_DIR, "hermes-agent", "venv", "bin", "python");
  const python = process.env.HERMES_PYTHON?.trim()
    || (existsSync(venvPython) ? venvPython : join(homedir(), ".local", "bin", "python3.11"));
  return execFileSync(python, ["-c", script], {
    cwd: join(HERMES_HOME_DIR, "hermes-agent"),
    env: SUBPROCESS_ENV,
    stdio: "pipe",
    timeout: DEFAULT_TIMEOUT_MS,
  }).toString();
}

async function readHermesCronJobs(includeDisabled = true): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(HERMES_CRON_JOBS_FILE, "utf8");
    const parsed = JSON.parse(raw) as { jobs?: unknown } | unknown[];
    const jobs = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray(parsed.jobs)
        ? parsed.jobs
        : [];
    return jobs
      .filter((job): job is Record<string, unknown> => Boolean(job) && typeof job === "object" && !Array.isArray(job))
      .filter((job) => includeDisabled || job.enabled !== false)
      .map(normalizeHermesCronJob);
  } catch {
    return [];
  }
}

function findHermesCronJobPayload(id?: string): Record<string, unknown> | undefined {
  if (!id) return undefined;
  try {
    const raw = execFileSync(process.execPath, ["-e", `
      const fs = require("fs");
      const file = ${JSON.stringify(HERMES_CRON_JOBS_FILE)};
      const parsed = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { jobs: [] };
      const jobs = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.jobs) ? parsed.jobs : []);
      process.stdout.write(JSON.stringify(jobs.find((job) => job && job.id === ${JSON.stringify(id)}) || null));
    `], { stdio: "pipe", timeout: 3000 }).toString();
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? normalizeHermesCronJob(parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeHermesCronJob(job: Record<string, unknown>): Record<string, unknown> {
  const schedule = toRecord(job.schedule);
  const normalizedSchedule: Record<string, unknown> = {};
  if (schedule.kind === "once") {
    normalizedSchedule.kind = "at";
    const atMs = dateMs(schedule.run_at);
    if (atMs !== undefined) normalizedSchedule.atMs = atMs;
  } else if (schedule.kind === "interval") {
    normalizedSchedule.kind = "every";
    const minutes = numberParam(schedule, "minutes") ?? 0;
    normalizedSchedule.everyMs = Math.max(1, minutes) * 60_000;
    const anchorMs = dateMs(job.created_at);
    if (anchorMs !== undefined) normalizedSchedule.anchorMs = anchorMs;
  } else if (schedule.kind === "cron") {
    normalizedSchedule.kind = "cron";
    normalizedSchedule.expr = schedule.expr;
  }
  return {
    id: job.id,
    name: job.name,
    enabled: job.enabled !== false,
    state: {
      nextRunAtMs: dateMs(job.next_run_at),
      lastRunStatus: job.last_status,
      lastError: job.last_error,
      lastDeliveryError: job.last_delivery_error,
    },
    createdAtMs: dateMs(job.created_at),
    updatedAtMs: dateMs(job.updated_at) ?? dateMs(job.created_at),
    schedule: normalizedSchedule,
    payload: { message: typeof job.prompt === "string" ? job.prompt : "" },
    raw: job,
  };
}

function dateMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hermesScheduleFromParams(record: Record<string, unknown>): string | undefined {
  const explicit = stringParam(record, "schedule");
  if (explicit) return explicit;
  const schedule = toRecord(record.schedule);
  const kind = stringParam(schedule, "kind");
  if (kind === "at") {
    const at = stringParam(schedule, "at") ?? isoFromMs(schedule.atMs);
    return at;
  }
  if (kind === "every") {
    const everyMs = numberParam(schedule, "everyMs");
    return everyMs ? `every ${Math.max(1, Math.round(everyMs / 60_000))}m` : undefined;
  }
  if (kind === "cron") {
    return stringParam(schedule, "expr", "value");
  }
  return undefined;
}

function promptFromCronParams(record: Record<string, unknown>): string | undefined {
  const payload = toRecord(record.payload);
  return stringParam(record, "prompt", "message") ?? stringParam(payload, "message", "text");
}

function isoFromMs(value: unknown): string | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

export function parseHermesSkillsList(output: string): Array<Record<string, unknown>> {
  const skills: Array<Record<string, unknown>> = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes("│")) continue;
    const cells = line.split("│").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 5 || cells[0] === "Name" || cells.some((cell) => cell.includes("━"))) continue;
    const skillKey = cells[0];
    const metadata = readHermesSkillMetadata(skillKey, cells[1]);
    skills.push({
      skillKey: metadata?.skillKey ?? skillKey,
      name: metadata?.name ?? skillKey,
      description: metadata?.description ?? cells[1],
      category: metadata?.category ?? cells[1],
      source: cells[2],
      trust: cells[3],
      status: cells[4],
      enabled: cells[4].toLowerCase() === "enabled",
      ...(metadata?.filePath ? { filePath: metadata.filePath } : {}),
      ...(metadata?.baseDir ? { baseDir: metadata.baseDir } : {}),
      ...(metadata?.homepage ? { homepage: metadata.homepage } : {}),
      ...(metadata?.requirements ? { requirements: metadata.requirements } : {}),
      ...(metadata?.platforms ? { platforms: metadata.platforms } : {}),
      ...(metadata?.version ? { version: metadata.version } : {}),
      ...(metadata?.author ? { author: metadata.author } : {}),
    });
  }
  return skills;
}

type HermesSkillMetadata = {
  skillKey: string;
  name: string;
  description?: string;
  category?: string;
  filePath?: string;
  baseDir?: string;
  homepage?: string;
  requirements?: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  platforms?: string[];
  version?: string;
  author?: string;
};

function readHermesSkillMetadata(skillKey: string, category: string): HermesSkillMetadata | undefined {
  const skillFile = resolveHermesSkillFile(skillKey, category);
  if (!skillFile) {
    return undefined;
  }
  try {
    const frontmatter = parseYamlFrontmatter(readFileSync(skillFile, "utf8"));
    const metadata = toRecord(frontmatter.metadata);
    const hermes = toRecord(metadata.hermes);
    return {
      skillKey: stringValue(frontmatter.name) ?? basename(dirnameForFile(skillFile)),
      name: stringValue(frontmatter.name) ?? basename(dirnameForFile(skillFile)),
      description: stringValue(frontmatter.description),
      category: normalizeSkillCategoryFromPath(skillFile),
      filePath: skillFile,
      baseDir: dirnameForFile(skillFile),
      homepage: stringValue(hermes.homepage) ?? stringValue(frontmatter.homepage),
      requirements: {
        bins: stringArrayValue(toRecord(frontmatter.prerequisites).commands),
        anyBins: [],
        env: [
          ...stringArrayValue(toRecord(frontmatter.prerequisites).env_vars),
          ...stringArrayValue(toRecord(frontmatter.prerequisites).env),
        ],
        config: stringArrayValue(toRecord(frontmatter.prerequisites).config),
        os: stringArrayValue(frontmatter.platforms),
      },
      platforms: stringArrayValue(frontmatter.platforms),
      version: stringValue(frontmatter.version),
      author: stringValue(frontmatter.author),
    };
  } catch {
    return undefined;
  }
}

function resolveHermesSkillFile(skillKey: string, category: string): string | undefined {
  const skillsDir = hermesSkillsDir();
  const candidates: string[] = [];
  if (category.trim()) {
    candidates.push(join(skillsDir, category.trim(), skillKey, "SKILL.md"));
  }
  candidates.push(join(skillsDir, skillKey, "SKILL.md"));
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const normalizedPrefix = skillKey.replace(/…+$/u, "").trim();
  if (!normalizedPrefix) {
    return undefined;
  }
  const categoryDirs = category.trim()
    ? [join(skillsDir, category.trim())]
    : [skillsDir, ...listDirectoryPaths(skillsDir)];
  for (const categoryDir of categoryDirs) {
    for (const skillDir of listDirectoryPaths(categoryDir)) {
      const name = basename(skillDir);
      if (name.startsWith(normalizedPrefix)) {
        const skillFile = join(skillDir, "SKILL.md");
        if (existsSync(skillFile)) {
          return skillFile;
        }
      }
    }
  }
  return undefined;
}

function parseYamlFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {};
  }
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; record: Record<string, unknown> }> = [{ indent: -1, record: root }];
  for (const rawLine of match[1].split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
      continue;
    }
    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    const pair = rawLine.trim().match(/^([^:#][^:]*):(?:\s*(.*))?$/);
    if (!pair) {
      continue;
    }
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].record;
    const key = pair[1].trim();
    const rawValue = pair[2]?.trim() ?? "";
    if (!rawValue) {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, record: child });
    } else {
      parent[key] = parseYamlScalar(rawValue);
    }
  }
  return root;
}

function parseYamlScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => stripYamlQuotes(item.trim())).filter(Boolean);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return stripYamlQuotes(trimmed);
}

function stripYamlQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function stringArrayValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function listDirectoryPaths(dir: string): string[] {
  try {
    return readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function dirnameForFile(filePath: string): string {
  return filePath.slice(0, -"/SKILL.md".length);
}

function normalizeSkillCategoryFromPath(filePath: string): string | undefined {
  const skillsDir = hermesSkillsDir();
  const relative = filePath.startsWith(`${skillsDir}/`) ? filePath.slice(skillsDir.length + 1) : "";
  const parts = relative.split("/");
  const category = parts.length >= 3 ? parts[0]?.trim() : "";
  return category ? category : undefined;
}

function hermesSkillsDir(): string {
  return process.env.HERMES_SKILLS_DIR?.trim() || join(HERMES_HOME_DIR, "hermes-agent", "skills");
}

function parseHermesMcpList(output: string): Array<Record<string, unknown>> {
  if (/No MCP servers configured/i.test(output)) return [];
  const servers: Array<Record<string, unknown>> = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Name") || trimmed.startsWith("─") || trimmed.startsWith("MCP ")) continue;
    const match = trimmed.match(/^(\S+)\s+(.{1,30}?)\s{2,}(.{1,12}?)\s{2,}(.+)$/);
    if (match) {
      servers.push({ name: match[1], transport: match[2].trim(), tools: match[3].trim(), status: match[4].trim() });
    }
  }
  return servers;
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

export function extractDeliverablePaths(
  text: string,
  options: { userMessage?: string } = {},
): string[] {
  if (options.userMessage !== undefined && !hasDeliverableSendIntent(options.userMessage)) {
    return [];
  }

  const allowed = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".svg",
    ".mp4", ".mov", ".avi", ".mkv", ".webm",
    ".mp3", ".wav", ".ogg", ".m4a", ".flac",
    ".pdf", ".docx", ".doc", ".odt", ".rtf", ".txt", ".md",
    ".xlsx", ".xls", ".csv", ".tsv", ".json", ".xml", ".yaml", ".yml",
    ".pptx", ".ppt", ".odp", ".zip", ".tar", ".gz", ".tgz", ".bz2", ".7z",
    ".html", ".htm",
  ]);
  const paths = new Set<string>();
  const pattern = /(?:^|[\s("'`:：])((?:~|\/)[^\s"'`<>|]+?\.[A-Za-z0-9]{1,8})(?=$|[\s).,"'`])/g;
  for (const match of text.matchAll(pattern)) {
    const rawPath = match[1];
    const absolutePath = rawPath.startsWith("~/") ? join(homedir(), rawPath.slice(2)) : rawPath;
    if (allowed.has(extname(absolutePath).toLowerCase()) && existsSync(resolve(absolutePath))) {
      paths.add(resolve(absolutePath));
    }
  }
  return [...paths];
}

function hasDeliverableSendIntent(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (!text) {
    return false;
  }

  if (/(不要|不用|别|无需|不需要).{0,20}(发|发送|传|上传|转发|分享|附件|attach|send|upload|share|deliver)/.test(text)
    || /(只要|仅要).{0,20}(路径|文件名|名字|文本|文字)/.test(text)
    || /\b(do not|don't|dont|no need to|without|not need to)\b.{0,30}\b(send|upload|attach|share|deliver)\b/.test(text)
    || /\bonly\b.{0,30}\b(path|filename|file name|text)\b/.test(text)) {
    return false;
  }

  const deliverableWords = [
    "文件", "图片", "照片", "图", "附件", "文档", "报告", "表格", "截图", "压缩包", "备份", "录音", "音频", "视频",
    "file", "image", "photo", "picture", "attachment", "document", "report", "spreadsheet", "screenshot", "archive",
    "zip", "pdf", "doc", "docx", "xlsx", "ppt", "pptx",
  ].join("|");
  const sendVerbs = [
    "发", "发送", "传", "上传", "转发", "分享", "发给", "传给", "send", "upload", "attach", "share", "deliver",
  ].join("|");

  const directChinesePatterns = [
    new RegExp(`(把|将).{0,50}(${deliverableWords}).{0,30}(${sendVerbs})(给我|到手机|到移动端|过来|回来|一下|给这边)?`),
    new RegExp(`(${sendVerbs})(给我|到手机|到移动端|过来|回来).{0,50}(${deliverableWords})?`),
    new RegExp(`(给我|帮我).{0,20}(${sendVerbs}).{0,50}(${deliverableWords})`),
  ];
  if (directChinesePatterns.some((pattern) => pattern.test(text))) {
    return true;
  }

  const englishPatterns = [
    new RegExp(`\\b(send|upload|attach|share|deliver)\\b.{0,50}\\b(${deliverableWords})\\b`),
    new RegExp(`\\b(${deliverableWords})\\b.{0,50}\\b(send|upload|attach|share|deliver)\\b`),
  ];
  return englishPatterns.some((pattern) => pattern.test(text));
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[\d;]*[A-Za-z@\[\]\\^_`{|}~-]/g, "");
}

function errorMessageWithOutput(error: unknown): string {
  const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
  const stdout = err.stdout?.toString().trim() ?? "";
  const stderr = err.stderr?.toString().trim() ?? "";
  return [stdout, stderr, err.message].filter(Boolean).join("\n") || String(error);
}
