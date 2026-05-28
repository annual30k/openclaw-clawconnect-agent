import { statSync } from "fs";
import { WebSocket } from "ws";
import { uploadFileToRelay, type FileUploadRequest } from "../core/relay/file-upload.js";
import {
  bindRelayAbortSignal,
  buildRelayUrl,
  parseRelayFrame,
  sendRelayJson,
  shouldRetryRelayClose,
} from "../core/relay/relay-server-connection.js";
import { buildOfficeEventPayload } from "../core/relay/office-payload.js";
import type { RelaySlashCommandDescriptor } from "../core/relay/slash-command-types.js";
import {
  buildMobileAssistantErrorPayload,
  buildMobileAssistantFinalPayload,
  resolveMobileChatRun,
} from "../core/relay/mobile-chat-run-bridge.js";
import { voiceInputSetupMessage } from "../core/relay/voice-input.js";
import { gatewayCapabilitiesForType } from "../gateway-profiles.js";
import { runHermesPython } from "./runtime/hermes-runtime-process.js";
import { prepareHermesVoiceInputCommand, resolveHermesVoiceInputSessionKey } from "./hermes-voice-input.js";
import {
  collectHermesUsageSnapshot,
  handleHermesCommand,
  readHermesStatusSnapshot,
  runHermesChat,
} from "./hermes-runtime.js";

type ToServer =
  | HermesRelayHelloMessage
  | { type: "heartbeat" }
  | { type: "gateway_connected" }
  | { type: "gateway_disconnected"; reason: string }
  | { type: "event"; event: string; payload: unknown }
  | { type: "res"; id: string; ok: boolean; payload?: unknown; error?: { message?: string } };

interface FromServer {
  type: "cmd" | "hello" | "heartbeat" | "event";
  id?: string;
  method?: string;
  params?: unknown;
  event?: string;
  payload?: unknown;
};

export type HermesRelayHelloMessage = {
  type: "hello";
  platform: string;
  agentVersion: string;
  capabilities?: string[];
  slashCommands?: readonly RelaySlashCommandDescriptor[];
};

export interface HermesRelayManagerOptions {
  relayServerUrl: string;
  gatewayId: string;
  relaySecret: string;
  displayName?: string;
  capabilities?: string[];
  signal?: AbortSignal;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

const HERMES_SLASH_COMMAND_CATALOG_SCRIPT = String.raw`
import json

items = []

def add(command, title=None, detail=None):
    if not command:
        return
    command = str(command).strip()
    if not command:
        return
    if not command.startswith("/"):
        command = "/" + command
    title = str(title or command.lstrip("/") or command).strip()
    detail = str(detail or title or command).strip()
    items.append({"command": command, "title": title, "detail": detail})

try:
    from hermes_cli.commands import COMMANDS
    for command, detail in COMMANDS.items():
        add(command, command.lstrip("/"), detail)
except Exception:
    pass

try:
    from agent.skill_commands import get_skill_commands
    for command, info in get_skill_commands().items():
        if not isinstance(info, dict):
            info = {}
        add(command, info.get("name") or str(command).lstrip("/"), info.get("description") or "Skill command")
except Exception:
    pass

try:
    from hermes_cli.plugins import get_plugin_commands
    for command, info in get_plugin_commands().items():
        if not isinstance(info, dict):
            info = {}
        add(command, command, info.get("description") or "Plugin command")
except Exception:
    pass

print(json.dumps(items, ensure_ascii=False))
`;

type HermesSlashCommandRunner = (script: string) => string;
type HermesSlashCommandCollector = () => readonly RelaySlashCommandDescriptor[];

const DEFAULT_HERMES_SLASH_COMMAND_SEARCH_LIMIT = 16;
const MAX_HERMES_SLASH_COMMAND_SEARCH_LIMIT = 50;
const MAX_HERMES_SLASH_COMMAND_SEARCH_OFFSET = 10_000;
let hermesSlashCommandCatalogCache: RelaySlashCommandDescriptor[] | undefined;

export interface HermesSlashCommandSearchResult {
  items: RelaySlashCommandDescriptor[];
  hasMore: boolean;
  nextOffset?: number;
  total: number;
}

export function collectHermesSlashCommandCatalog(
  runPython: HermesSlashCommandRunner = runHermesPython,
): RelaySlashCommandDescriptor[] {
  try {
    return parseHermesSlashCommandCatalog(runPython(HERMES_SLASH_COMMAND_CATALOG_SCRIPT));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[hermes-relay] failed to load Hermes slash command catalog: ${message}`);
    return [];
  }
}

export function searchHermesSlashCommandCatalog(opts: {
  query?: unknown;
  limit?: unknown;
  offset?: unknown;
  collect?: HermesSlashCommandCollector;
} = {}): HermesSlashCommandSearchResult {
  const query = normalizeHermesSlashCommandQuery(opts.query);
  const limit = normalizeHermesSlashCommandSearchLimit(opts.limit);
  const offset = normalizeHermesSlashCommandSearchOffset(opts.offset);
  const catalog = [...(opts.collect ?? getCachedHermesSlashCommandCatalog)()];

  const matches = catalog
    .map((command, index) => {
      const rank = hermesSlashCommandMatchRank(command, query);
      return rank === undefined ? undefined : { command, index, rank };
    })
    .filter((entry): entry is { command: RelaySlashCommandDescriptor; index: number; rank: number } => entry !== undefined)
    .sort((left, right) => {
      if (left.rank !== right.rank) return left.rank - right.rank;
      if (left.index !== right.index) return left.index - right.index;
      return left.command.title.localeCompare(right.command.title);
    });
  const items = matches.slice(offset, offset + limit).map((entry) => entry.command);
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < matches.length;

  return {
    items,
    hasMore,
    ...(hasMore ? { nextOffset } : {}),
    total: matches.length,
  };
}

export function buildHermesRelayHelloMessage(opts: {
  platform: string;
  agentVersion: string;
  capabilities?: string[];
  slashCommands?: readonly RelaySlashCommandDescriptor[];
}): HermesRelayHelloMessage {
  return {
    type: "hello",
    platform: opts.platform,
    agentVersion: opts.agentVersion,
    capabilities: opts.capabilities,
    ...(opts.slashCommands && opts.slashCommands.length > 0 ? { slashCommands: opts.slashCommands } : {}),
  };
}

function parseHermesSlashCommandCatalog(rawOutput: string): RelaySlashCommandDescriptor[] {
  const rawValue = JSON.parse(rawOutput) as unknown;
  if (!Array.isArray(rawValue)) {
    return [];
  }

  const commands: RelaySlashCommandDescriptor[] = [];
  const seen = new Set<string>();

  for (const entry of rawValue) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const command = normalizeHermesSlashCommandText(record.command ?? record.name ?? record.value ?? record.text);
    if (!command) {
      continue;
    }

    const key = command.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const title = readHermesSlashCommandLabel(record.title ?? record.label ?? record.name) ?? command.replace(/^\//, "");
    const detail = readHermesSlashCommandLabel(record.detail ?? record.description ?? record.summary) ?? title;
    commands.push({
      source: "Hermes",
      command,
      title,
      detail,
    });
  }

  return commands;
}

function normalizeHermesSlashCommandText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return undefined;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function readHermesSlashCommandLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed || undefined;
}

function getCachedHermesSlashCommandCatalog(): readonly RelaySlashCommandDescriptor[] {
  if (!hermesSlashCommandCatalogCache) {
    hermesSlashCommandCatalogCache = collectHermesSlashCommandCatalog();
  }
  return hermesSlashCommandCatalogCache;
}

function normalizeHermesSlashCommandQuery(value: unknown): string {
  if (typeof value !== "string") {
    return "/";
  }
  const trimmed = value.trim().replace(/\s+/g, " ").toLowerCase();
  if (!trimmed) {
    return "/";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeHermesSlashCommandSearchLimit(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(MAX_HERMES_SLASH_COMMAND_SEARCH_LIMIT, Math.trunc(value)));
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.min(MAX_HERMES_SLASH_COMMAND_SEARCH_LIMIT, Math.trunc(parsed)));
    }
  }
  return DEFAULT_HERMES_SLASH_COMMAND_SEARCH_LIMIT;
}

function normalizeHermesSlashCommandSearchOffset(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(MAX_HERMES_SLASH_COMMAND_SEARCH_OFFSET, Math.trunc(value)));
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(MAX_HERMES_SLASH_COMMAND_SEARCH_OFFSET, Math.trunc(parsed)));
    }
  }
  return 0;
}

function hermesSlashCommandMatchRank(command: RelaySlashCommandDescriptor, query: string): number | undefined {
  const normalizedCommand = command.command.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalizedCommand) {
    return undefined;
  }
  if (query === "/") return 0;
  if (normalizedCommand === query) {
    return 0;
  }
  if (normalizedCommand.startsWith(query)) {
    return 1;
  }
  if (query.startsWith(normalizedCommand)) {
    return 2;
  }

  const compactCommand = compactSlashSearchText(normalizedCommand);
  const compactQuery = compactSlashSearchText(query);
  if (!compactQuery) return 0;
  if (compactCommand.includes(compactQuery)) {
    return 3;
  }
  if (isSubsequence(compactQuery, compactCommand)) {
    return 4;
  }

  const searchableText = [command.title, command.detail]
    .map((value) => compactSlashSearchText(value))
    .filter(Boolean)
    .join(" ");
  if (searchableText.includes(compactQuery)) {
    return 5;
  }
  if (isSubsequence(compactQuery, searchableText)) {
    return 6;
  }
  return undefined;
}

function compactSlashSearchText(value: string): string {
  return value
    .trim()
    .replace(/^\//, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle) return true;
  let needleIndex = 0;
  for (const char of haystack) {
    if (char === needle[needleIndex]) {
      needleIndex += 1;
      if (needleIndex === needle.length) {
        return true;
      }
    }
  }
  return false;
}

function readHermesSlashCommandSearchParams(params: unknown): {
  query?: unknown;
  limit?: unknown;
  offset?: unknown;
} {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return {};
  }
  const record = params as Record<string, unknown>;
  return {
    query: record.query,
    limit: record.limit,
    offset: record.offset,
  };
}

export async function runHermesRelayManager(opts: HermesRelayManagerOptions): Promise<boolean> {
  const wsUrl = buildRelayUrl(opts.relayServerUrl, opts.gatewayId, opts.relaySecret);
  const recentMobileFiles = new Map<string, Array<Record<string, unknown>>>();
  const sentArtifacts = new Map<string, number>();

  return new Promise<boolean>((resolve) => {
    let relayWs: WebSocket;
    try {
      relayWs = new WebSocket(wsUrl);
    } catch (error) {
      console.error("Failed to create Hermes relay WebSocket:", error);
      resolve(true);
      return;
    }

    bindRelayAbortSignal(relayWs, opts.signal);

    const send = (message: ToServer): void => {
      sendRelayJson(relayWs, message);
    };

    relayWs.on("open", () => {
      console.log(`Connected to relay server (hermes gatewayId=${opts.gatewayId})`);
      opts.onConnected?.();
      const statusSnapshot = readHermesStatusSnapshot();
      send(buildHermesRelayHelloMessage({
        platform: `${process.platform} (Hermes)`,
        agentVersion: "hermes",
        capabilities: opts.capabilities ?? [...gatewayCapabilitiesForType("hermes"), "models"],
      }));
      send({ type: "gateway_connected" });
      send({
        type: "event",
        event: "office",
        payload: {
          currentModel: statusSnapshot.currentModel,
          provider: statusSnapshot.provider,
          office: {
            kind: "idle",
            title: "Hermes Agent",
            detail: opts.displayName ?? "Hermes gateway connected",
            phase: "connected",
            updatedAt: new Date().toISOString(),
          },
        },
      });
      void publishHermesUsageSnapshot(send);
    });

    relayWs.on("message", async (raw) => {
      let requestId: string | undefined;
      let methodForLog = "";
      let acknowledgedChatRun: { runId: string; sessionKey: string } | undefined;
      let voiceInputRun: { runId: string; sessionKey: string } | undefined;
      try {
        const msg = parseRelayFrame<FromServer>(raw);
        if (!msg) {
          return;
        }

        if (msg.type === "heartbeat") {
          send({ type: "heartbeat" });
          return;
        }
        if (msg.type === "hello") {
          return;
        }
        if (msg.type === "event") {
          if (msg.event === "file") {
            await rememberMobileFileEvent(msg.payload, recentMobileFiles, opts);
          }
          return;
        }
        if (msg.type !== "cmd" || !msg.method) {
          return;
        }

        requestId = msg.id;
        methodForLog = msg.method;

        if (msg.method === "slash_commands.search") {
          if (requestId) {
            send({
              type: "res",
              id: requestId,
              ok: true,
              payload: searchHermesSlashCommandCatalog(readHermesSlashCommandSearchParams(msg.params)),
            });
          }
          return;
        }

        const localResult = await handleHermesCommand(msg.method, msg.params, {
          requestId,
          gatewayId: opts.gatewayId,
          publishEvent: (event) => send(event),
        });
        if (localResult !== null) {
          if (requestId) {
            send(localResult.ok
              ? { type: "res", id: requestId, ok: true, payload: localResult.payload }
              : { type: "res", id: requestId, ok: false, error: { message: localResult.error } });
          }
          return;
        }

        if (msg.method === "chat.voice.send" || msg.method === "hermes.voice.send") {
          const voiceInput = await prepareHermesVoiceInputCommand(msg.params, { requestId });
          voiceInputRun = voiceInput.run;
          msg.params = voiceInput.params;
          msg.method = voiceInput.method;
        }

        if (msg.method !== "chat.send" && msg.method !== "agent" && msg.method !== "hermes.chat.send") {
          throw new Error(`Unsupported Hermes command: ${msg.method}`);
        }

        const requestedSessionKey = resolveHermesRelaySessionKey(msg.params);
        const run = resolveMobileChatRun({
          preferredRunId: voiceInputRun?.runId,
          requestId,
          sessionKey: requestedSessionKey,
          fallbackPrefix: "hermes",
        });
        const runId = run.runId;
        const sessionKey = run.sessionKey;
        if (requestId) {
          acknowledgedChatRun = { runId, sessionKey };
          send({ type: "res", id: requestId, ok: true, payload: acknowledgedChatRun });
        }
        const paramsWithFiles = await attachRecentMobileFiles(msg.params, recentMobileFiles, opts);
        const chat = await runHermesChat(paramsWithFiles, {
          requestId: runId,
          gatewayId: opts.gatewayId,
          publishEvent: (event) => {
            send(event);
            publishHermesOfficeSnapshot(send, event.event, event.payload);
          },
        });
        const finalChatPayload = buildMobileAssistantFinalPayload({
          run: { runId, sessionKey: chat.sessionKey },
          text: chat.output,
          currentModel: chat.usage?.currentModel,
          provider: chat.usage?.provider,
          contextUsage: chat.usage?.contextUsage,
          contextLimit: chat.usage?.contextLimit,
        });
        send({
          type: "event",
          event: "chat",
          payload: finalChatPayload,
        });
        publishHermesOfficeSnapshot(send, "chat", finalChatPayload);

        for (const artifactPath of chat.artifactPaths) {
          const artifactKey = artifactDeliveryKey(chat.sessionKey, artifactPath);
          pruneSentArtifacts(sentArtifacts);
          if (artifactKey && sentArtifacts.has(artifactKey)) {
            continue;
          }
          await uploadFileToRelay(buildHermesArtifactUploadRequest({
            artifactPath,
            relayServerUrl: opts.relayServerUrl,
            relaySecret: opts.relaySecret,
            gatewayId: opts.gatewayId,
            sessionKey: chat.sessionKey,
            runId,
          }));
          if (artifactKey) {
            sentArtifacts.set(artifactKey, Date.now());
          }
        }

        if (requestId && !acknowledgedChatRun) {
          send({ type: "res", id: requestId, ok: true, payload: { runId, sessionKey: chat.sessionKey } });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[hermes-relay] cmd failed method=${methodForLog || "(unknown)"} id=${requestId ?? "(no-id)"}: ${message}`);
        const setupMessage = voiceInputSetupMessage(error);
        const chatRun = setupMessage ? (acknowledgedChatRun ?? voiceInputRun) : acknowledgedChatRun;
        if (chatRun) {
          const errorPayload = buildMobileAssistantErrorPayload({
            run: chatRun,
            errorMessage: setupMessage ?? message,
          });
          send({
            type: "event",
            event: "chat",
            payload: errorPayload,
          });
          publishHermesOfficeSnapshot(send, "chat", errorPayload);
          if (setupMessage && requestId && !acknowledgedChatRun) {
            send({ type: "res", id: requestId, ok: true, payload: chatRun });
          }
        } else if (requestId) {
          send({ type: "res", id: requestId, ok: false, error: { message } });
        }
      }
    });

    relayWs.on("close", (code, reason) => {
      console.log(`Hermes relay connection closed: ${code} ${reason.toString()}`);
      opts.onDisconnected?.();
      resolve(shouldRetryRelayClose(code, opts.signal));
    });

    relayWs.on("error", (error) => {
      console.error("Hermes relay WebSocket error:", error.message);
    });
  });
}

export function buildHermesArtifactUploadRequest(params: {
  artifactPath: string;
  relayServerUrl: string;
  relaySecret: string;
  gatewayId: string;
  sessionKey: string;
  runId: string;
}): FileUploadRequest {
  return {
    relayServerUrl: params.relayServerUrl,
    relaySecret: params.relaySecret,
    gatewayId: params.gatewayId,
    sessionKey: params.sessionKey,
    filePath: params.artifactPath,
    sourceRunId: params.runId,
  };
}

export function shouldPublishHermesOfficeSnapshot(eventName: string | undefined, payload: unknown): boolean {
  if (eventName !== "chat" && eventName !== "agent" && eventName !== "context_usage") {
    return false;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const state = typeof (payload as Record<string, unknown>).state === "string"
    ? ((payload as Record<string, unknown>).state as string).trim().toLowerCase()
    : "";
  return state !== "delta";
}

function publishHermesOfficeSnapshot(send: (message: ToServer) => void, eventName: string | undefined, payload: unknown): void {
  if (!shouldPublishHermesOfficeSnapshot(eventName, payload)) {
    return;
  }
  if (!eventName) {
    return;
  }
  const officePayload = buildOfficeEventPayload(eventName, payload, () => new Date().toISOString());
  if (!officePayload) {
    return;
  }
  send({ type: "event", event: "office", payload: officePayload });
}

function artifactDeliveryKey(sessionKey: string, filePath: string): string | undefined {
  try {
    const stat = statSync(filePath);
    return [
      sessionKey,
      filePath,
      stat.size,
      Math.floor(stat.mtimeMs),
    ].join("\0");
  } catch {
    return undefined;
  }
}

function pruneSentArtifacts(sentArtifacts: Map<string, number>): void {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [key, timestamp] of sentArtifacts) {
    if (timestamp < cutoff) {
      sentArtifacts.delete(key);
    }
  }
}

async function publishHermesUsageSnapshot(send: (message: ToServer) => void): Promise<void> {
  try {
    const snapshot = await collectHermesUsageSnapshot();
    if (!snapshot.currentModel && snapshot.contextUsage === undefined && snapshot.contextLimit === undefined) {
      return;
    }
    send({
      type: "event",
      event: "context_usage",
      payload: {
        currentModel: snapshot.currentModel,
        provider: snapshot.provider,
        contextUsage: snapshot.contextUsage,
        contextLimit: snapshot.contextLimit,
        hermesSessionId: snapshot.hermesSessionId,
        updatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[hermes-relay] usage snapshot failed: ${message}`);
  }
}

async function rememberMobileFileEvent(
  payload: unknown,
  recentMobileFiles: Map<string, Array<Record<string, unknown>>>,
  opts: HermesRelayManagerOptions,
): Promise<void> {
  const block = extractFileBlock(payload);
  if (!block || block.origin !== "mobile") {
    return;
  }
  const sessionKey = typeof block.sessionKey === "string" && block.sessionKey.trim() ? block.sessionKey.trim() : "main";
  const downloadUrl = typeof block.downloadUrl === "string" ? block.downloadUrl : "";
  const fileName = typeof block.fileName === "string" ? block.fileName : typeof block.name === "string" ? block.name : "attachment";
  if (!downloadUrl) {
    return;
  }
  const content = await downloadFileAsBase64(downloadUrl, opts);
  const attachments = recentMobileFiles.get(sessionKey) ?? [];
  attachments.push({
    fileName,
    mimeType: typeof block.mimeType === "string" ? block.mimeType : "application/octet-stream",
    content,
  });
  recentMobileFiles.set(sessionKey, attachments.slice(-12));
}

async function attachRecentMobileFiles(
  params: unknown,
  recentMobileFiles: Map<string, Array<Record<string, unknown>>>,
  opts: HermesRelayManagerOptions,
): Promise<unknown> {
  const record = params && typeof params === "object" && !Array.isArray(params)
    ? { ...(params as Record<string, unknown>) }
    : {};
  const sessionKey = typeof record.sessionKey === "string" && record.sessionKey.trim() ? record.sessionKey.trim() : "main";
  const pending = recentMobileFiles.get(sessionKey) ?? [];
  if (pending.length === 0) {
    return params;
  }
  const existing = Array.isArray(record.attachments) ? record.attachments : [];
  recentMobileFiles.delete(sessionKey);
  if (existing.length > 0) {
    return record;
  }
  return {
    ...record,
    attachments: pending,
  };
}

function resolveHermesRelaySessionKey(params: unknown): string {
  return resolveHermesVoiceInputSessionKey(params);
}

function extractFileBlock(payload: unknown): Record<string, unknown> | undefined {
  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
  const content = record?.message && typeof record.message === "object" && !Array.isArray(record.message)
    ? (record.message as Record<string, unknown>).content
    : undefined;
  const blocks = Array.isArray(content) ? content : [];
  return blocks.find((block): block is Record<string, unknown> => {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      return false;
    }
    const type = (block as Record<string, unknown>).type;
    return type === "file" || type === "voice";
  });
}

async function downloadFileAsBase64(downloadUrl: string, opts: HermesRelayManagerOptions): Promise<string> {
  const url = new URL(downloadUrl, opts.relayServerUrl);
  url.searchParams.set("secret", opts.relaySecret);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`file_download_failed:${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString("base64");
}
