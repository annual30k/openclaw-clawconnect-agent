import { readConfig, type ClawConnectConfig } from "../config/config.js";
import { uploadFileToRelay, type FileUploadResult } from "../core/relay/file-upload.js";
import {
  formatFileSize,
  normalizeSessionKey,
} from "../core/relay/file-upload-utils.js";
import { inferLatestOpenClawSessionKey } from "../openclaw/session-store.js";

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

  if (!relayServerUrl) {
    throw new Error("relay_server_url_required");
  }
  if (!relaySecret) {
    throw new Error("relay_secret_required");
  }
  if (!gatewayId) {
    throw new Error("gateway_id_required");
  }

  const sessionKey = await resolveTargetSessionKey(opts.session, config, deps.sessionStoreRoot);
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
      sourceRunId: opts.sourceRunId,
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

async function resolveTargetSessionKey(
  explicitSessionKey: string | undefined,
  config: ClawConnectConfig,
  sessionStoreRoot?: string,
): Promise<string> {
  const trimmedExplicit = explicitSessionKey?.trim() ?? "";
  if (trimmedExplicit) {
    return normalizeSessionKey(trimmedExplicit);
  }

  if (config.gatewayType === "openclaw" || !config.gatewayType) {
    const inferredSessionKey = await inferLatestOpenClawSessionKey(sessionStoreRoot);
    return normalizeSessionKey(inferredSessionKey ?? "main");
  }

  return "main";
}

function writeLog(stream: Pick<NodeJS.WritableStream, "write">, message: string): void {
  stream.write(`${message}\n`);
}
