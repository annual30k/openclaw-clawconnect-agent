import { readConfig, type ClawConnectConfig } from "../config/config.js";
import { uploadFileToRelay, type FileUploadResult } from "../core/relay/file-upload.js";
import {
  formatFileSize,
  normalizeSessionKey,
} from "../core/relay/file-upload-utils.js";

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

  const explicitSessionKey = opts.session?.trim() || resolveSessionKeyFromEnv(env);
  const explicitSourceRunId = resolveSourceRunId(opts.sourceRunId, env, config.gatewayType);
  const isOpenClaw = config.gatewayType === "openclaw" || !config.gatewayType;
  if (isOpenClaw && (!explicitSessionKey || !explicitSourceRunId)) {
    throw new Error("openclaw_send_file_requires_explicit_session_and_source_run_id");
  }
  if (isOpenClaw && explicitSessionKey && !isFullOpenClawSessionKey(explicitSessionKey)) {
    throw new Error("openclaw_send_file_requires_full_agent_session_key");
  }
  const hostSessionKey = await resolveTargetSessionKey(opts.session, config, deps.sessionStoreRoot, env);
  const sessionKey = relayUploadSessionKey(hostSessionKey, config);
  // OpenClaw child processes do not reliably inherit the Relay manager's
  // per-run environment. Never consult a "unique/latest" active-run record:
  // the caller must carry the exact session and sourceRunId (or use the native
  // message tool, whose structured tool result is handled by the Relay path).
  const sourceRunId = explicitSourceRunId;
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
      sourceRole: "assistant",
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

function relayUploadSessionKey(hostSessionKey: string, config: ClawConnectConfig): string {
  const normalized = normalizeSessionKey(hostSessionKey);
  if (config.gatewayType && config.gatewayType !== "openclaw") {
    return normalized;
  }
  // OpenClaw stores transcripts under agent:<agentId>:<session>, while Relay
  // and all mobile clients address the same chat as <session>. Persist the
  // file in the mobile session from the start so file and attachment timeline
  // share scope; sourceRunId is supplied separately by the typed contract.
  const match = /^agent:[^:]+:(.+)$/i.exec(normalized);
  return normalizeSessionKey(match?.[1] ?? normalized);
}

function resolveSourceRunId(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  gatewayType?: ClawConnectConfig["gatewayType"],
): string | undefined {
  const explicitValue = normalizeSourceRunId(explicit);
  if (explicitValue) return explicitValue;

  const keys = gatewayType === "openclaw" || !gatewayType
    ? ["CLAWCONNECT_SOURCE_RUN_ID"]
    : [
        "CLAWCONNECT_SOURCE_RUN_ID",
        "OPENCLAW_RUN_ID",
        "OPENCLAW_TRACE_RUN_ID",
        "OPENCLAW_REQUEST_ID",
        "CODEX_RUN_ID",
      ];
  for (const key of keys) {
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

/**
 * OpenClaw ownership is keyed by the complete transcript scope.  A Relay
 * display alias such as `main` is deliberately not sufficient here because
 * different OpenClaw agents may use that alias concurrently.
 */
function isFullOpenClawSessionKey(value: string): boolean {
  return /^agent:[^:]+:.+$/.test(value.trim());
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

  if (config.gatewayType === "openclaw" || !config.gatewayType) return "main";

  return "main";
}

function resolveSessionKeyFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  for (const key of [
    "CLAWCONNECT_SESSION_KEY",
    "CLAWCONNECT_CHAT_SESSION_KEY",
    "CLAWCONNECT_MOBILE_SESSION_KEY",
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
