import { statSync } from "fs";
import { WebSocket } from "ws";
import { sendFileCommand } from "../commands/send-file.js";
import { buildOfficeEventPayload } from "../relay/office-payload.js";
import {
  collectHermesUsageSnapshot,
  handleHermesCommand,
  readHermesStatusSnapshot,
  runHermesChat,
} from "./hermes-runtime.js";

type ToServer =
  | { type: "hello"; platform: string; agentVersion: string; capabilities?: string[] }
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
}

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

    if (opts.signal) {
      if (opts.signal.aborted) {
        relayWs.close(1001, "shutdown");
      } else {
        opts.signal.addEventListener("abort", () => relayWs.close(1001, "shutdown"), { once: true });
      }
    }

    const send = (message: ToServer): void => {
      if (relayWs.readyState === WebSocket.OPEN) {
        relayWs.send(JSON.stringify(message));
      }
    };

    relayWs.on("open", () => {
      console.log(`Connected to relay server (hermes gatewayId=${opts.gatewayId})`);
      opts.onConnected?.();
      const statusSnapshot = readHermesStatusSnapshot();
      send({
        type: "hello",
        platform: `${process.platform} (Hermes)`,
        agentVersion: "hermes",
        capabilities: opts.capabilities ?? ["chat", "files", "logs", "restart", "sessions", "skills", "models", "gateway_service"],
      });
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
      try {
        let msg: FromServer;
        try {
          msg = JSON.parse(raw.toString()) as FromServer;
        } catch {
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

        if (msg.method !== "chat.send" && msg.method !== "agent" && msg.method !== "hermes.chat.send") {
          throw new Error(`Unsupported Hermes command: ${msg.method}`);
        }

        const runId = requestId ?? `hermes-${Date.now()}`;
        const paramsWithFiles = await attachRecentMobileFiles(msg.params, recentMobileFiles, opts);
        const chat = await runHermesChat(paramsWithFiles, {
          requestId,
          gatewayId: opts.gatewayId,
          publishEvent: (event) => {
            send(event);
            publishHermesOfficeSnapshot(send, event.event, event.payload);
          },
        });
        const finalChatPayload = {
          runId,
          sessionKey: chat.sessionKey,
          state: "final",
          role: "assistant",
          currentModel: chat.usage?.currentModel,
          provider: chat.usage?.provider,
          contextUsage: chat.usage?.contextUsage,
          contextLimit: chat.usage?.contextLimit,
          message: {
            role: "assistant",
            content: [{ type: "text", text: chat.output }],
          },
        };
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
          await sendFileCommand({
            filePath: artifactPath,
            gateway: opts.gatewayId,
            session: chat.sessionKey,
            json: true,
          }, {
            stdout: { write: () => true },
            stderr: { write: (chunk) => {
              const text = String(chunk).trim();
              if (text) console.log(text);
              return true;
            } },
          });
          if (artifactKey) {
            sentArtifacts.set(artifactKey, Date.now());
          }
        }

        if (requestId) {
          send({ type: "res", id: requestId, ok: true, payload: { runId, sessionKey: chat.sessionKey } });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[hermes-relay] cmd failed method=${methodForLog || "(unknown)"} id=${requestId ?? "(no-id)"}: ${message}`);
        if (requestId) {
          send({ type: "res", id: requestId, ok: false, error: { message } });
        }
      }
    });

    relayWs.on("close", (code, reason) => {
      console.log(`Hermes relay connection closed: ${code} ${reason.toString()}`);
      opts.onDisconnected?.();
      const intentional = opts.signal?.aborted || code === 4000;
      resolve(!intentional);
    });

    relayWs.on("error", (error) => {
      console.error("Hermes relay WebSocket error:", error.message);
    });
  });
}

function publishHermesOfficeSnapshot(send: (message: ToServer) => void, eventName: string | undefined, payload: unknown): void {
  if (eventName !== "chat" && eventName !== "agent" && eventName !== "context_usage") {
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

function buildRelayUrl(serverUrl: string, gatewayId: string, relaySecret: string): string {
  const base = serverUrl.replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}/relay/${gatewayId}?secret=${encodeURIComponent(relaySecret)}`;
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
