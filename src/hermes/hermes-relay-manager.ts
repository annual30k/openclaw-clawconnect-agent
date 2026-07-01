import { statSync } from "fs";
import { WebSocket } from "ws";
import { uploadFileToRelay, type FileUploadRequest, type FileUploadResult } from "../core/relay/file-upload.js";
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
  buildMobileAssistantAbortedPayload,
  buildMobileAssistantErrorPayload,
  buildMobileAssistantFinalPayload,
  type MobileChatRun,
  resolveMobileChatRun,
} from "../core/relay/mobile-chat-run-bridge.js";
import { voiceInputSetupMessage } from "../core/relay/voice-input.js";
import {
  buildAttachmentStateChangedEvent,
  buildMessageCompletedEvent,
  deriveAttachmentId,
  derivePartId,
} from "../core/relay/timeline-event-builder.js";
import type { TimelineContentBlock } from "../core/relay/timeline-event-log.js";
import { gatewayCapabilitiesForType } from "../gateway-profiles.js";
import { prepareHermesVoiceInputCommand, resolveHermesVoiceInputSessionKey } from "./hermes-voice-input.js";
import {
  collectHermesUsageSnapshot,
  handleHermesCommand,
  readHermesStatusSnapshotAsync,
  runHermesChat,
} from "./hermes-runtime.js";
import {
  forgetActiveHermesChatRun,
  rememberActiveHermesChatRun,
  resolveHermesAbortRun,
  resolveHermesChatPreferredRunId,
  type ActiveHermesChatRun,
} from "./relay/active-hermes-chat-runs.js";
import {
  readHermesSlashCommandSearchParams,
  searchHermesSlashCommandCatalog,
} from "./relay/hermes-slash-command-catalog.js";

export {
  collectHermesSlashCommandCatalog,
  searchHermesSlashCommandCatalog,
  type HermesSlashCommandSearchResult,
} from "./relay/hermes-slash-command-catalog.js";
export {
  rememberActiveHermesChatRun,
  resolveHermesAbortRun,
  resolveHermesChatPreferredRunId,
  type ActiveHermesChatRun,
} from "./relay/active-hermes-chat-runs.js";

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

export async function runHermesRelayManager(opts: HermesRelayManagerOptions): Promise<boolean> {
  const wsUrl = buildRelayUrl(opts.relayServerUrl, opts.gatewayId, opts.relaySecret);
  const recentMobileFiles = new Map<string, Array<Record<string, unknown>>>();
  const sentArtifacts = new Map<string, number>();
  const activeChatRuns = new Map<string, ActiveHermesChatRun>();

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
      send(buildHermesRelayHelloMessage({
        platform: `${process.platform} (Hermes)`,
        agentVersion: "hermes",
        capabilities: opts.capabilities ?? [...gatewayCapabilitiesForType("hermes"), "models"],
      }));
      send({ type: "gateway_connected" });
      void readHermesStatusSnapshotAsync().then((statusSnapshot) => {
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

        if (msg.method === "chat.abort") {
          const abortRun = resolveHermesAbortRun(msg.params, activeChatRuns);
          abortRun?.controller.abort();
          if (requestId) {
            send({ type: "res", id: requestId, ok: true, payload: abortRun?.run });
          }
          if (abortRun) {
            send({
              type: "event",
              event: "chat",
              payload: {
                runId: abortRun.run.runId,
                sessionKey: abortRun.run.sessionKey,
                state: "aborted",
                role: "assistant",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "" }],
                },
              },
            });
          }
          return;
        }

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
          preferredRunId: resolveHermesChatPreferredRunId(msg.params, voiceInputRun),
          requestId,
          sessionKey: requestedSessionKey,
          fallbackPrefix: "hermes",
        });
        const runId = run.runId;
        const sessionKey = run.sessionKey;
        const abortController = new AbortController();
        rememberActiveHermesChatRun(activeChatRuns, run, msg.params, requestId, abortController);
        if (requestId) {
          acknowledgedChatRun = { runId, sessionKey };
          send({ type: "res", id: requestId, ok: true, payload: acknowledgedChatRun });
        }
        const paramsWithFiles = await attachRecentMobileFiles(msg.params, recentMobileFiles, opts);
        const chat = await runHermesChat(paramsWithFiles, {
          requestId: runId,
          gatewayId: opts.gatewayId,
          abortSignal: abortController.signal,
          publishEvent: (event) => {
            send(event);
            publishHermesOfficeSnapshot(send, event.event, event.payload);
          },
        });
        forgetActiveHermesChatRun(activeChatRuns, run);
        const artifactTimelineEvents: Array<{
          completed: ReturnType<typeof buildHermesArtifactCompletedEvent>;
          attachment: ReturnType<typeof buildAttachmentStateChangedEvent>;
        }> = [];

        for (const artifactPath of chat.artifactPaths) {
          const artifactKey = artifactDeliveryKey(chat.sessionKey, artifactPath);
          pruneSentArtifacts(sentArtifacts);
          if (artifactKey && sentArtifacts.has(artifactKey)) {
            continue;
          }
          try {
            const upload = await uploadFileToRelay(buildHermesArtifactUploadRequest({
              artifactPath,
              relayServerUrl: opts.relayServerUrl,
              relaySecret: opts.relaySecret,
              gatewayId: opts.gatewayId,
              sessionKey: chat.sessionKey,
              runId,
            }));
            const attachmentId = deriveAttachmentId({
              sessionKey: chat.sessionKey,
              name: upload.fileName,
              mimeType: upload.mimeType,
              size: upload.sizeBytes,
              contentHash: upload.sha256,
            });
            const block = buildHermesArtifactContentBlock(upload, attachmentId);
            const artifactIndex = artifactTimelineEvents.length;
            artifactTimelineEvents.push({
              ...buildHermesArtifactTimelineEvents({
                gatewayId: opts.gatewayId,
                sessionKey: chat.sessionKey,
                runId,
                upload,
                attachmentId,
                contentBlock: block,
                artifactIndex,
              }),
            });
            if (artifactKey) {
              sentArtifacts.set(artifactKey, Date.now());
            }
          } catch (error) {
            console.warn(`[hermes-relay] failed to upload artifact ${artifactPath}: ${String(error)}`);
          }
        }

        for (const artifactEvents of artifactTimelineEvents) {
          const attachmentPayload = {
            runId,
            sessionKey: chat.sessionKey,
            state: "attachment",
            role: "assistant",
            timelineEvents: [artifactEvents.completed, artifactEvents.attachment],
          };
          send({
            type: "event",
            event: "chat",
            payload: attachmentPayload,
          });
          publishHermesOfficeSnapshot(send, "chat", attachmentPayload);
        }

        const finalChatPayload = buildMobileAssistantFinalPayload({
          run: { runId, sessionKey: chat.sessionKey },
          text: chat.output,
          currentModel: chat.usage?.currentModel,
          provider: chat.usage?.provider,
          contextUsage: chat.usage?.contextUsage,
          contextLimit: chat.usage?.contextLimit,
          includeTimelineEvents: true,
        });
        send({
          type: "event",
          event: "chat",
          payload: finalChatPayload,
        });
        publishHermesOfficeSnapshot(send, "chat", finalChatPayload);

        if (requestId && !acknowledgedChatRun) {
          send({ type: "res", id: requestId, ok: true, payload: { runId, sessionKey: chat.sessionKey } });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "hermes_chat_aborted") {
          if (acknowledgedChatRun) {
            const abortedPayload = buildMobileAssistantAbortedPayload({
              run: acknowledgedChatRun,
              includeTimelineEvents: true,
            });
            send({
              type: "event",
              event: "chat",
              payload: abortedPayload,
            });
            publishHermesOfficeSnapshot(send, "chat", abortedPayload);
            forgetActiveHermesChatRun(activeChatRuns, acknowledgedChatRun);
          }
          return;
        }
        if (acknowledgedChatRun) {
          forgetActiveHermesChatRun(activeChatRuns, acknowledgedChatRun);
        }
        console.error(`[hermes-relay] cmd failed method=${methodForLog || "(unknown)"} id=${requestId ?? "(no-id)"}: ${message}`);
        const setupMessage = voiceInputSetupMessage(error);
        const chatRun = setupMessage ? (acknowledgedChatRun ?? voiceInputRun) : acknowledgedChatRun;
        if (chatRun) {
          const errorPayload = buildMobileAssistantErrorPayload({
            run: chatRun,
            errorMessage: setupMessage ?? message,
            includeTimelineEvents: true,
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
      activeChatRuns.forEach((entry) => entry.controller.abort());
      activeChatRuns.clear();
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

export function buildHermesArtifactContentBlock(
  upload: FileUploadResult,
  attachmentId?: string,
): TimelineContentBlock {
  const blockType = upload.mimeType.startsWith("image/")
    ? "image"
    : upload.mimeType.startsWith("audio/")
      ? "voice"
      : "file";
  return compactTimelineContentBlock({
    type: blockType,
    attachmentId,
    fileId: upload.fileId,
    fileName: upload.fileName,
    mimeType: upload.mimeType,
    sizeBytes: upload.sizeBytes,
    durationMs: upload.durationMs,
    imageWidth: upload.imageWidth,
    imageHeight: upload.imageHeight,
    downloadUrl: upload.downloadPath,
    downloadPath: upload.downloadPath,
    expiresAt: upload.expiresAt,
    sourceRunId: upload.sourceRunId,
    gatewayId: upload.gatewayId,
    sessionKey: upload.sessionKey,
    status: "available",
  });
}

export function buildHermesArtifactCompletedEvent(params: {
  gatewayId: string;
  sessionKey: string;
  runId: string;
  upload: FileUploadResult;
  attachmentId?: string;
  contentBlock?: TimelineContentBlock;
  artifactIndex?: number;
  now?: () => Date;
  idFactory?: (prefix: string) => string;
}) {
  const contentBlock = params.contentBlock ?? buildHermesArtifactContentBlock(params.upload, params.attachmentId);
  // Hermes 产物必须独立成附件消息，不能合进最终文字回答，否则客户端会把图片当作已完成 waiting 行的一部分吞掉。
  return buildMessageCompletedEvent({
    gatewayId: params.gatewayId,
    sessionKey: params.sessionKey,
    turnId: params.runId,
    runId: params.runId,
    role: "assistant",
    messageId: hermesArtifactMessageId(params.upload.fileId),
    partId: derivePartId({
      type: contentBlock.type,
      index: params.artifactIndex ?? 0,
    }),
    content: [contentBlock],
    timelineItemKind: "attachment",
    timelineResolvesWaiting: false,
    now: params.now,
    idFactory: params.idFactory,
  });
}

export function buildHermesArtifactTimelineEvents(params: {
  gatewayId: string;
  sessionKey: string;
  runId: string;
  upload: FileUploadResult;
  attachmentId: string;
  contentBlock?: TimelineContentBlock;
  artifactIndex?: number;
  now?: () => Date;
  idFactory?: (prefix: string) => string;
}) {
  const contentBlock = params.contentBlock ?? buildHermesArtifactContentBlock(params.upload, params.attachmentId);
  const completed = buildHermesArtifactCompletedEvent({
    ...params,
    contentBlock,
  });
  const partId = completed.partId;
  return {
    completed,
    attachment: buildAttachmentStateChangedEvent({
      gatewayId: params.gatewayId,
      sessionKey: params.sessionKey,
      turnId: params.runId,
      runId: params.runId,
      role: "assistant",
      messageId: completed.messageId,
      partId,
      seq: completed.seq + 1,
      now: params.now,
      idFactory: params.idFactory,
      timelineItemKind: "attachment",
      timelineResolvesWaiting: false,
      attachment: {
        attachmentId: params.attachmentId,
        state: "available",
        fileId: params.upload.fileId,
        name: params.upload.fileName,
        mimeType: params.upload.mimeType,
        sizeBytes: params.upload.sizeBytes,
        url: params.upload.downloadUrl,
        expiresAt: params.upload.expiresAt,
        sha256: params.upload.sha256,
      },
    }),
  };
}

function hermesArtifactMessageId(fileId: string): string {
  return `file-${fileId}`;
}

function compactTimelineContentBlock(
  block: Record<string, unknown> & { type: string },
): TimelineContentBlock {
  return Object.fromEntries(
    Object.entries(block).filter(([, value]) => value !== undefined),
  ) as TimelineContentBlock;
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
