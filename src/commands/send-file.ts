import { readConfig, type ClawConnectConfig } from "../config/config.js";
import { uploadFileToRelay, type FileUploadResult } from "../core/relay/file-upload.js";
import {
  formatFileSize,
  normalizeSessionKey,
} from "../core/relay/file-upload-utils.js";
import {
  inferLatestOpenClawSendFileSourceRunId,
  inferLatestOpenClawSessionKey,
} from "../openclaw/session-store.js";

export interface SendFileCommandOptions {
  filePath: string;
  gateway?: string;
  session?: string;
  json?: boolean;
  durationMs?: number;
  transcript?: string;
  sourceRunId?: string;
}

export interface SendFileCommandDependencies {
  loadConfig?: () => ClawConnectConfig;
  fetchImpl?: typeof fetch;
  stdout?: Pick<NodeJS.WritableStream, "write">;
  stderr?: Pick<NodeJS.WritableStream, "write">;
  sessionStoreRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export type SendFileResult = FileUploadResult;

export async function sendFileCommand(
  opts: SendFileCommandOptions,
  deps: SendFileCommandDependencies = {},
): Promise<SendFileResult> {
  const loadConfig = deps.loadConfig ?? readConfig;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  const config = loadConfig();
  const relayServerUrl = config.relayServerUrl?.trim();
  const relaySecret = config.relaySecret?.trim();
  const gatewayId = (opts.gateway?.trim() || config.gatewayId?.trim() || "").trim();
  const env = deps.env ?? process.env;

  if (!relayServerUrl) {
    throw new Error("relay_server_url_required");
  }
  if (!relaySecret) {
    throw new Error("relay_secret_required");
  }
  if (!gatewayId) {
    throw new Error("gateway_id_required");
  }

  const sessionKey = await resolveTargetSessionKey(opts.session, config, deps.sessionStoreRoot, env);
  const sourceRunId =
    resolveSourceRunId(opts.sourceRunId, env)
    ?? await resolveOpenClawTranscriptSourceRunId(opts, config, sessionKey, deps.sessionStoreRoot);
  writeLog(stderr, `[send-file] preparing ${opts.filePath} for gateway ${gatewayId} session ${sessionKey}`);

  const result = await uploadFileToRelay(
    {
      relayServerUrl,
      relaySecret,
      gatewayId,
      sessionKey,
      filePath: opts.filePath,
      senderDisplayName: config.displayName,
      durationMs: opts.durationMs,
      transcript: opts.transcript,
      sourceRunId,
    },
    {
      fetchImpl: deps.fetchImpl,
    },
  );

  if (opts.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    writeLog(stdout, `[send-file] uploaded ${result.fileName}`);
    writeLog(stdout, `  gateway: ${result.gatewayId}`);
    writeLog(stdout, `  session: ${result.sessionKey}`);
    writeLog(stdout, `  file id: ${result.fileId}`);
    writeLog(stdout, `  size: ${formatFileSize(result.sizeBytes)}`);
    writeLog(stdout, `  download: ${result.downloadUrl}`);
    writeLog(stdout, `  expires: ${result.expiresAt}`);
  }

  return result;
}

async function resolveOpenClawTranscriptSourceRunId(
  opts: SendFileCommandOptions,
  config: ClawConnectConfig,
  sessionKey: string,
  sessionStoreRoot?: string,
): Promise<string | undefined> {
  if (config.gatewayType && config.gatewayType !== "openclaw") {
    return undefined;
  }
  // OpenClaw exec tools do not always inject the relay run id into subprocess
  // env. Use the target transcript's current send-file tool call as a stable
  // source id, so returned files attach to the assistant turn instead of time.
  return inferLatestOpenClawSendFileSourceRunId({
    sessionKey,
    filePath: opts.filePath,
    sessionStoreRoot,
  });
}

function resolveSourceRunId(explicit: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const explicitValue = normalizeSourceRunId(explicit);
  if (explicitValue) return explicitValue;

  for (const key of [
    "CLAWCONNECT_SOURCE_RUN_ID",
    "OPENCLAW_RUN_ID",
    "OPENCLAW_TRACE_RUN_ID",
    "OPENCLAW_REQUEST_ID",
    "CODEX_RUN_ID",
  ]) {
    const value = normalizeSourceRunId(env[key]);
    if (value) return value;
  }
  return undefined;
}

function normalizeSourceRunId(value: string | undefined): string | undefined {
  let trimmed = value?.trim();
  if (!trimmed) return undefined;
  for (const suffix of [":user", ":assistant", ":tool", ":system"]) {
    if (trimmed.endsWith(suffix)) {
      trimmed = trimmed.slice(0, -suffix.length);
      break;
    }
  }
  return trimmed || undefined;
}

async function resolveTargetSessionKey(
  explicitSessionKey: string | undefined,
  config: ClawConnectConfig,
  sessionStoreRoot?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const trimmedExplicit = explicitSessionKey?.trim() ?? "";
  if (trimmedExplicit) {
    return normalizeSessionKey(trimmedExplicit);
  }

  const envSessionKey = resolveSessionKeyFromEnv(env);
  if (envSessionKey) {
    return envSessionKey;
  }

  if (config.gatewayType === "openclaw" || !config.gatewayType) {
    const inferredSessionKey = await inferLatestOpenClawSessionKey(sessionStoreRoot);
    return normalizeSessionKey(inferredSessionKey ?? "main");
  }

  return "main";
}

function resolveSessionKeyFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  for (const key of [
    "CLAWCONNECT_SESSION_KEY",
    "CLAWCONNECT_CHAT_SESSION_KEY",
    "CLAWCONNECT_MOBILE_SESSION_KEY",
    "OPENCLAW_SESSION_KEY",
    "OPENCLAW_CHAT_SESSION_KEY",
  ]) {
    const value = env[key]?.trim();
    if (value) {
      return normalizeSessionKey(value);
    }
  }
  return undefined;
}

function writeLog(stream: Pick<NodeJS.WritableStream, "write">, message: string): void {
  stream.write(`${message}\n`);
}
