import { WebSocket } from "ws";
import { OpenClawGatewayClient } from "./gateway-client.js";
import { handleLocalCommand } from "../commands/local-handlers.js";
import { handleProviderCommand } from "../commands/provider-handlers.js";
import { homedir } from "os";
import { join } from "path";
import { mkdir, writeFile } from "fs/promises";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OUTBOUND_DIR = join(homedir(), ".openclaw", "media", "outbound");

// ---------------------------------------------------------------------------
// Messages: relay client ↔ relay server
// ---------------------------------------------------------------------------

/** Messages the relay client sends to the relay server. */
type ToServer =
  | { type: "hello"; platform: string; agentVersion: string }
  | { type: "heartbeat" }
  | { type: "gateway_connected" }
  | { type: "gateway_disconnected"; reason: string }
  | { type: "event"; event: string; payload: unknown }
  | { type: "res"; id: string; ok: boolean; payload?: unknown; error?: { message?: string } };

/** Messages the relay server sends to the relay client. */
interface FromServer {
  type: "cmd" | "hello" | "heartbeat";
  id?: string;
  method: string;
  params: unknown;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RelayManagerOptions {
  relayServerUrl: string;
  gatewayId: string;
  relaySecret: string;
  gatewayUrl: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

type GatewaySessionDefaults = {
  mainSessionKey: string;
  mainKey: string;
  defaultAgentId?: string;
};

function normalizeChatEventPayload(rawPayload: unknown): unknown {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return rawPayload;
  }
  const payload = { ...(rawPayload as Record<string, unknown>) };
  const stateRaw = typeof payload.state === "string" ? payload.state.trim().toLowerCase() : "";
  const phaseRaw = typeof payload.phase === "string" ? payload.phase.trim().toLowerCase() : "";
  const hasState = stateRaw.length > 0;

  if (!hasState && phaseRaw) {
    if (phaseRaw.includes("delta") || phaseRaw.includes("stream")) {
      payload.state = "delta";
    } else if (phaseRaw.includes("final") || phaseRaw.includes("complete") || phaseRaw.includes("done")) {
      payload.state = "final";
    } else if (phaseRaw.includes("error") || phaseRaw.includes("fail")) {
      payload.state = "error";
    }
  }

  const hasMessage = payload.message && typeof payload.message === "object" && !Array.isArray(payload.message);
  const text = typeof payload.text === "string" ? payload.text : undefined;
  const delta = typeof payload.delta === "string" ? payload.delta : undefined;
  const streamText = text ?? delta;
  if (!hasMessage && streamText && streamText.length > 0) {
    payload.message = { content: [{ type: "text", text: streamText }] };
  }

  return payload;
}

function extractGatewaySessionDefaults(rawPayload: unknown): GatewaySessionDefaults | null {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return null;
  }
  const payload = rawPayload as Record<string, unknown>;
  const snapshot =
    payload.snapshot && typeof payload.snapshot === "object" && !Array.isArray(payload.snapshot)
      ? (payload.snapshot as Record<string, unknown>)
      : undefined;
  const sessionDefaultsRaw =
    snapshot?.sessionDefaults && typeof snapshot.sessionDefaults === "object" && !Array.isArray(snapshot.sessionDefaults)
      ? (snapshot.sessionDefaults as Record<string, unknown>)
      : snapshot?.sessiondefaults && typeof snapshot.sessiondefaults === "object" && !Array.isArray(snapshot.sessiondefaults)
        ? (snapshot.sessiondefaults as Record<string, unknown>)
        : undefined;

  const mainSessionKey =
    typeof sessionDefaultsRaw?.mainSessionKey === "string"
      ? sessionDefaultsRaw.mainSessionKey.trim()
      : "";
  const mainKey = typeof sessionDefaultsRaw?.mainKey === "string" ? sessionDefaultsRaw.mainKey.trim() : "";
  const defaultAgentId = typeof sessionDefaultsRaw?.defaultAgentId === "string"
    ? sessionDefaultsRaw.defaultAgentId.trim()
    : "";

  if (mainSessionKey) {
    return {
      mainSessionKey,
      mainKey: mainKey || "main",
      defaultAgentId: defaultAgentId || undefined,
    };
  }

  const config =
    payload.config && typeof payload.config === "object" && !Array.isArray(payload.config)
      ? (payload.config as Record<string, unknown>)
      : undefined;
  const session =
    config?.session && typeof config.session === "object" && !Array.isArray(config.session)
      ? (config.session as Record<string, unknown>)
      : undefined;
  const scope = typeof session?.scope === "string" ? session.scope.trim() : "";
  if (scope === "global") {
    return {
      mainSessionKey: "global",
      mainKey: "global",
    };
  }

  return null;
}

function canonicalizeSessionKey(rawValue: unknown, defaults: GatewaySessionDefaults): string | unknown {
  if (typeof rawValue !== "string") {
    return rawValue;
  }
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return trimmed;
  }

  const mainKey = defaults.mainKey || "main";
  const isMainAlias =
    trimmed === "main" ||
    trimmed === mainKey ||
    trimmed === defaults.mainSessionKey ||
    (defaults.defaultAgentId
      ? trimmed === `agent:${defaults.defaultAgentId}:main` || trimmed === `agent:${defaults.defaultAgentId}:${mainKey}`
      : false);

  return isMainAlias ? defaults.mainSessionKey : trimmed;
}

function shouldCanonicalizeSessionKey(method: string): boolean {
  return method === "chat.send" || method === "chat.history" || method === "chat.abort" || method === "agent";
}

function canonicalizeRelayParams(
  method: string,
  rawParams: unknown,
  defaults: GatewaySessionDefaults,
): unknown {
  if (!shouldCanonicalizeSessionKey(method)) {
    return rawParams;
  }
  if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
    return rawParams;
  }
  const params = rawParams as Record<string, unknown>;
  if (!("sessionKey" in params)) {
    return rawParams;
  }
  return {
    ...params,
    sessionKey: canonicalizeSessionKey(params.sessionKey, defaults),
  };
}

function appendUniqueSuffix(base: string, suffix: string): string {
  if (!suffix) {
    return base;
  }
  if (!base) {
    return suffix;
  }
  if (base.endsWith(suffix)) {
    return base;
  }
  const maxOverlap = Math.min(base.length, suffix.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (base.slice(-overlap) === suffix.slice(0, overlap)) {
      return base + suffix.slice(overlap);
    }
  }
  return base + suffix;
}

function extractChatText(rawPayload: unknown): string {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return "";
  }
  const payload = rawPayload as Record<string, unknown>;
  const message =
    payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)
      ? (payload.message as Record<string, unknown>)
      : undefined;
  const content = Array.isArray(message?.content) ? message?.content : [];
  const blockText = content.find((block) => {
    return Boolean(block) && typeof block === "object" && !Array.isArray(block) && (block as Record<string, unknown>).type === "text";
  }) as Record<string, unknown> | undefined;
  if (typeof blockText?.text === "string" && blockText.text.trim().length > 0) {
    return blockText.text;
  }
  if (typeof payload.text === "string" && payload.text.trim().length > 0) {
    return payload.text;
  }
  if (typeof payload.delta === "string" && payload.delta.trim().length > 0) {
    return payload.delta;
  }
  const data =
    payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : undefined;
  if (typeof data?.text === "string" && data.text.trim().length > 0) {
    return data.text;
  }
  if (typeof data?.delta === "string" && data.delta.trim().length > 0) {
    return data.delta;
  }
  return "";
}

function normalizeChatState(rawPayload: unknown): string {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return "";
  }
  const payload = rawPayload as Record<string, unknown>;
  const data =
    payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : undefined;
  const rawState =
    typeof payload.state === "string" ? payload.state
      : typeof payload.phase === "string" ? payload.phase
        : typeof data?.phase === "string" ? data.phase
          : "";
  return rawState.trim().toLowerCase();
}

function extractChatRole(rawPayload: unknown): string {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return "";
  }
  const payload = rawPayload as Record<string, unknown>;
  if (typeof payload.role === "string" && payload.role.trim()) {
    return payload.role.trim().toLowerCase();
  }
  const message =
    payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)
      ? (payload.message as Record<string, unknown>)
      : undefined;
  if (typeof message?.role === "string" && message.role.trim()) {
    return message.role.trim().toLowerCase();
  }
  return "";
}

function withMessageText(rawPayload: unknown, text: string): unknown {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload) || !text.trim()) {
    return rawPayload;
  }
  const payload = { ...(rawPayload as Record<string, unknown>) };
  payload.message = {
    content: [{ type: "text", text }],
  };
  return payload;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Connects to the cloud relay server and the local OpenClaw Gateway,
 * then bridges messages between them indefinitely.
 *
 * The gateway client runs for as long as this relay connection is alive.
 * Returns a Promise that resolves `true` (retry) when the relay server
 * connection closes.
 */
export async function runRelayManager(opts: RelayManagerOptions): Promise<boolean> {
  const wsUrl = buildRelayUrl(opts.relayServerUrl, opts.gatewayId, opts.relaySecret);

  return new Promise<boolean>((resolve) => {
    let relayWs: WebSocket;
    try {
      relayWs = new WebSocket(wsUrl);
    } catch (err) {
      console.error("Failed to create relay WebSocket:", err);
      resolve(true);
      return;
    }

    let gatewayClient: OpenClawGatewayClient | null = null;
    let sessionDefaults: GatewaySessionDefaults = { mainSessionKey: "main", mainKey: "main" };
    const chatBuffers = new Map<string, string>();
    const chatFallbacks = new Map<string, ReturnType<typeof setTimeout>>();

    type HistoryResponse = { messages?: Array<{ role: string; content?: Array<{ type: string; text?: string }> }> };

    const clearChatFallback = (runId: string): void => {
      const timer = chatFallbacks.get(runId);
      if (timer) {
        clearTimeout(timer);
        chatFallbacks.delete(runId);
      }
    };

    const extractHistoryAssistantText = (history: HistoryResponse | undefined): string => {
      const msgs = history?.messages ?? [];
      const last = [...msgs].reverse().find((m) => m.role === "assistant");
      return last?.content?.find((b) => b.type === "text")?.text ?? "";
    };

    const scheduleChatHistoryFallback = (runId: string, sessionKey: string, attempt = 0): void => {
      if (!runId || !sessionKey) {
        return;
      }
      clearChatFallback(runId);
      const timer = setTimeout(() => {
        if (!gatewayClient) {
          chatFallbacks.delete(runId);
          return;
        }
        const fetchHistory = () =>
          gatewayClient!.request<HistoryResponse>("chat.history", { sessionKey, limit: 10 });
        withTimeout(fetchHistory(), 800, "chat.history fallback")
          .then(async (history) => {
            let text = extractHistoryAssistantText(history);
            if (!text && attempt < 4) {
              scheduleChatHistoryFallback(runId, sessionKey, attempt + 1);
              return;
            }
            if (!text) {
              chatFallbacks.delete(runId);
              return;
            }
            console.log(
              `[relay] synthesized chat final from history: runId=${runId} sessionKey=${sessionKey} textLength=${text.length} attempt=${attempt}`,
            );
            clearChatFallback(runId);
            send({
              type: "event",
              event: "chat",
              payload: {
                runId,
                sessionKey,
                state: "final",
                role: "assistant",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text }],
                },
              },
            });
          })
          .catch((err) => {
            if (attempt < 4) {
              scheduleChatHistoryFallback(runId, sessionKey, attempt + 1);
              return;
            }
            console.warn(`[relay] chat history fallback failed runId=${runId}: ${String(err)}`);
            chatFallbacks.delete(runId);
          });
      }, attempt === 0 ? 1500 : 2000);
      timer.unref?.();
      chatFallbacks.set(runId, timer);
    };

    const refreshSessionDefaults = async (): Promise<void> => {
      if (!gatewayClient) {
        return;
      }
      try {
        const payload = await gatewayClient.request("config.get", {});
        const nextDefaults = extractGatewaySessionDefaults(payload);
        if (nextDefaults) {
          sessionDefaults = nextDefaults;
          console.log(
            `[relay] session defaults updated mainSessionKey=${sessionDefaults.mainSessionKey} mainKey=${sessionDefaults.mainKey}`,
          );
        }
      } catch (err) {
        console.warn(`[relay] failed to load session defaults: ${String(err)}`);
      }
    };

    function send(msg: ToServer): void {
      if (relayWs.readyState === WebSocket.OPEN) {
        relayWs.send(JSON.stringify(msg));
      }
    }

    relayWs.on("open", () => {
      console.log(`Connected to relay server (gatewayId=${opts.gatewayId})`);
      opts.onConnected?.();
      send({
        type: "hello",
        platform: process.platform,
        agentVersion: "1.0.0",
      });

      // Start the persistent gateway connection as soon as we're connected
      // to the relay server. Its lifetime is tied to this relay session.
      gatewayClient = new OpenClawGatewayClient({
        url: opts.gatewayUrl,
        token: opts.gatewayToken,
        password: opts.gatewayPassword,

        onConnected: () => {
          console.log("Gateway connected.");
          send({ type: "gateway_connected" });
          void refreshSessionDefaults();
        },

        onDisconnected: (reason) => {
          console.log(`Gateway disconnected: ${reason}`);
          send({ type: "gateway_disconnected", reason });
        },

        onEvent: (event, payload) => {
          const normalizedPayload = event === "chat" ? normalizeChatEventPayload(payload) : payload;
          if (event === "chat") {
            const p = normalizedPayload as { sessionKey?: string; runId?: string };
            const state = normalizeChatState(normalizedPayload);
            const runId = typeof p?.runId === "string" ? p.runId : "";
            const currentText = extractChatText(normalizedPayload);
            const role = extractChatRole(normalizedPayload);

            if (runId) {
              if (role === "assistant" && (state === "delta" || state === "final" || state === "error" || state === "failed" || state === "fail")) {
                clearChatFallback(runId);
              }
              if (state === "delta" || state === "streaming" || state === "in_progress") {
                const previousText = chatBuffers.get(runId) ?? "";
                chatBuffers.set(runId, appendUniqueSuffix(previousText, currentText));
              } else if (state === "error" || state === "failed" || state === "fail" || state === "aborted") {
                chatBuffers.delete(runId);
              }
            }

            if (state === "final" && p?.sessionKey) {
              const bufferedText = runId ? chatBuffers.get(runId) ?? "" : "";
              const resolvedText = currentText || bufferedText;
              if (runId) {
                chatBuffers.delete(runId);
              }
              if (resolvedText.trim()) {
                send({ type: "event", event, payload: withMessageText(normalizedPayload, resolvedText) });
                return;
              }

              const sessionKey = p.sessionKey;
              const fetchHistory = () =>
                gatewayClient!.request<HistoryResponse>("chat.history", { sessionKey, limit: 10 });
              withTimeout(fetchHistory(), 500, "chat.history")
                .then(async (history) => {
                  let text = extractHistoryAssistantText(history);
                  // Retry once after a short delay if OpenClaw hasn't committed the message yet.
                  if (!text) {
                    await new Promise((resolve) => setTimeout(resolve, 150));
                    const retryHistory = await withTimeout(fetchHistory(), 500, "chat.history retry");
                    text = extractHistoryAssistantText(retryHistory);
                  }
                  console.log(
                    `[relay] chat final enriched from history: runId=${runId || "(unknown)"} textLength=${text?.length ?? 0}`,
                  );
                  send({ type: "event", event, payload: text ? withMessageText(normalizedPayload, text) : normalizedPayload });
                })
                .catch((err) => {
                  console.error(`[relay] chat.history fetch failed: ${err}`);
                  send({ type: "event", event, payload: normalizedPayload });
                });
              return;
            }
          }
          send({ type: "event", event, payload: normalizedPayload });
        },
      });

      gatewayClient.start();
    });

    relayWs.on("message", async (raw) => {
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

      if (msg.type !== "cmd" || !msg.method) return;

      const requestId = msg.id;
      console.log(`[relay] cmd received method=${msg.method} id=${requestId ?? "(no-id)"}`);

      // Handle clawpilot.provider.* commands locally (async)
      const providerPromise = handleProviderCommand(msg.method, msg.params);
      if (providerPromise !== null) {
        const result = await providerPromise;
        if (requestId) {
          send({
            type: "res",
            id: requestId,
            ok: result.ok,
            ...(result.ok
              ? { payload: result.payload }
              : { error: { message: result.error } }),
          });
        }
        return;
      }

      // Handle clawpilot.* commands locally without forwarding to the gateway
      const localResult = handleLocalCommand(msg.method);
      if (localResult !== null) {
        if (requestId) {
          if (localResult.ok) {
            send({ type: "res", id: requestId, ok: true, payload: localResult.payload });
          } else {
            send({ type: "res", id: requestId, ok: false, error: { message: localResult.error } });
          }
        }
        return;
      }

      // Handle chat.send with attachments - save to disk and add path reference
      if (msg.method === "chat.send") {
        const params = msg.params as any;
        // Always set deliver:false so OpenClaw responds via WebSocket (not external channel)
        params.deliver = false;
        if (params.attachments && params.attachments.length > 0) {
          const fileReferences: string[] = [];

          // Ensure outbound directory exists
          await mkdir(OUTBOUND_DIR, { recursive: true });

          // Save each attachment to disk and create path reference
          for (const att of params.attachments) {
            try {
              // Decode base64 to buffer
              const buffer = Buffer.from(att.content, "base64");
              const ext = att.mimeType === "image/png" ? ".png" : ".jpg";
              const stagedFileName = `${randomUUID()}${ext}`;
              const stagedPath = join(OUTBOUND_DIR, stagedFileName);

              // Write to disk
              await writeFile(stagedPath, buffer);
              console.log(`[relay] Saved attachment to: ${stagedPath}`);

              // Create path reference (same format as ClawX)
              fileReferences.push(
                `[media attached: ${stagedPath} (${att.mimeType}) | ${stagedPath}]`
              );
            } catch (err) {
              console.error(`[relay] Failed to save attachment: ${err}`);
            }
          }

          // Append file references to message
          if (fileReferences.length > 0) {
            const refs = fileReferences.join("\n");
            params.message = params.message ? `${params.message}\n\n${refs}` : refs;
            console.log(`[relay] Added file references to message`);
          }
        }
      }

      const params = canonicalizeRelayParams(msg.method, msg.params, sessionDefaults);

      gatewayClient
        ?.request(msg.method, params)
        .then((result) => {
          console.log(`[relay] cmd ok method=${msg.method} id=${requestId ?? "(no-id)"}`);
          if ((msg.method === "chat.send" || msg.method === "agent") && params && typeof params === "object" && !Array.isArray(params)) {
            const paramsRecord = params as Record<string, unknown>;
            const sessionKey =
              typeof paramsRecord.sessionKey === "string" && paramsRecord.sessionKey.trim().length > 0
                ? paramsRecord.sessionKey.trim()
                : sessionDefaults.mainSessionKey;
            const resultRecord = result && typeof result === "object" && !Array.isArray(result)
              ? (result as Record<string, unknown>)
              : undefined;
            const runId =
              typeof resultRecord?.runId === "string" && resultRecord.runId.trim().length > 0
                ? resultRecord.runId.trim()
                : requestId;
            if (runId) {
              scheduleChatHistoryFallback(runId, sessionKey);
            }
          }
          if (requestId) {
            send({ type: "res", id: requestId, ok: true, payload: result });
          }
        })
        .catch((err: unknown) => {
          console.error(`[relay] cmd failed method=${msg.method} id=${requestId ?? "(no-id)"}: ${String(err)}`);
          if (requestId) {
            send({ type: "res", id: requestId, ok: false, error: { message: String(err) } });
          }
        });
    });

    relayWs.on("close", (code, reason) => {
      console.log(`Relay connection closed: ${code} ${reason.toString()}`);
      opts.onDisconnected?.();
      gatewayClient?.stop();
      gatewayClient = null;
      // Code 4000 = server kicked us because another relay client took over.
      // Stop retrying so the two instances don't bounce each other forever.
      resolve(code !== 4000);
    });

    relayWs.on("error", (err) => {
      console.error("Relay WebSocket error:", err.message);
      // close event will follow
    });
  });
}

function buildRelayUrl(serverUrl: string, gatewayId: string, relaySecret: string): string {
  const base = serverUrl.replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}/relay/${gatewayId}?secret=${encodeURIComponent(relaySecret)}`;
}
