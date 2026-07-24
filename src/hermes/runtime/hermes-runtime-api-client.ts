import { TextDecoder } from "util";
import type { LocalCommandContext } from "../../core/command-types.js";
import { buildMobileAssistantDeltaPayload } from "../../core/relay/mobile-chat-run-bridge.js";
import { buildToolInvocationUpdatedEvent } from "../../core/relay/timeline-event-builder.js";
import { rememberHermesSession } from "../hermes-session-store.js";
import { buildHermesPreloadedSkillsPrompt } from "./hermes-runtime-preloaded-skills.js";
import type { HermesChatResult, HermesToolLogEvent, HermesUsageSnapshot } from "./hermes-runtime-types.js";
import { resolveHermesApiSettings } from "./hermes-runtime-api-settings.js";
import { CHAT_TIMEOUT_MS, sanitizeHermesChatOutput } from "./hermes-runtime-process.js";
import { compactStringArray } from "./hermes-runtime-values.js";
import { hermesToolState } from "./hermes-runtime-tool-log-watcher.js";

const HERMES_API_HEALTH_TIMEOUT_MS = 1_500;
const HERMES_API_TOOLSETS_TIMEOUT_MS = 1_500;

type HermesApiConfig = {
  baseUrl: string;
  apiKey: string;
};

type HermesApiChatResult = HermesChatResult & {
  hermesSessionId: string;
};

type SseEvent = {
  event: string;
  data: unknown;
};

export type HermesApiResolvedToolEvent = {
  toolCallId: string;
  toolName: string;
  phase: HermesToolLogEvent["phase"];
  preview: string;
  isError: boolean;
};

export type HermesApiToolLifecycleTracker = {
  resolve: (eventName: string, record: Record<string, unknown>) => HermesApiResolvedToolEvent | undefined;
  finishActive: (phase: "completed" | "failed") => HermesApiResolvedToolEvent[];
  activeCount: () => number;
};

export async function tryRunHermesApiChat(params: {
  message: string;
  instructions?: string;
  sessionKey: string;
  resume?: string;
  preloadedSkillNames?: string[];
  requiredToolsets?: string[];
  context: LocalCommandContext;
}): Promise<HermesApiChatResult | undefined> {
  const config = readHermesApiConfig();
  if (!config) {
    return undefined;
  }
  const healthy = await isHermesApiHealthy(config);
  if (!healthy) {
    return undefined;
  }
  const requiredToolsetsAvailable = await hasRequiredHermesApiToolsets(config, params.requiredToolsets);
  if (!requiredToolsetsAvailable) {
    return undefined;
  }
  return await runHermesApiChat(config, params);
}

function readHermesApiConfig(): HermesApiConfig | undefined {
  if (isTruthyEnv(process.env.CLAWCONNECT_HERMES_API_DISABLED)) {
    return undefined;
  }
  const settings = resolveHermesApiSettings();
  const explicitUrl = firstNonEmpty(
    process.env.CLAWCONNECT_HERMES_API_URL,
    process.env.HERMES_API_SERVER_URL,
  );
  const explicitApiKey = firstNonEmpty(
    process.env.CLAWCONNECT_HERMES_API_KEY,
    process.env.API_SERVER_KEY,
  );
  if (process.env.HERMES_BIN?.trim() && (!explicitUrl || !explicitApiKey)) {
    // HERMES_BIN 是测试和诊断替换 Hermes CLI 的显式契约；不能让真实 ~/.hermes/.env API 配置绕过 fake binary。
    return undefined;
  }
  const apiKey = settings.apiKey;
  if (!apiKey) {
    return undefined;
  }
  return { baseUrl: settings.baseUrl, apiKey };
}

async function isHermesApiHealthy(config: HermesApiConfig): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(`${config.baseUrl}/health`, {
      headers: buildHermesApiHeaders(config),
    }, HERMES_API_HEALTH_TIMEOUT_MS);
    return response.ok;
  } catch {
    return false;
  }
}

async function hasRequiredHermesApiToolsets(
  config: HermesApiConfig,
  requiredToolsets: string[] | undefined,
): Promise<boolean> {
  const required = new Set(compactStringArray(requiredToolsets ?? []));
  if (required.size === 0) {
    return true;
  }
  try {
    const response = await fetchWithTimeout(`${config.baseUrl}/v1/toolsets`, {
      headers: buildHermesApiHeaders(config),
    }, HERMES_API_TOOLSETS_TIMEOUT_MS);
    if (!response.ok) {
      return false;
    }
    const payload = await readJsonResponse(response);
    const data = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).data
      : undefined;
    const enabledToolsets = new Set<string>();
    if (Array.isArray(data)) {
      for (const item of data) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          continue;
        }
        const record = item as Record<string, unknown>;
        const name = stringValue(record.name);
        if (name && record.enabled === true) {
          enabledToolsets.add(name);
        }
      }
    }
    for (const toolset of required) {
      if (!enabledToolsets.has(toolset)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function runHermesApiChat(
  config: HermesApiConfig,
  params: {
    message: string;
    instructions?: string;
    sessionKey: string;
    resume?: string;
    preloadedSkillNames?: string[];
    requiredToolsets?: string[];
    context: LocalCommandContext;
  },
): Promise<HermesApiChatResult | undefined> {
  const sessionId = params.resume ?? await createHermesApiSession(config, params.sessionKey);
  const preloadedSkillPrompt = await resolveHermesApiPreloadedSkillPrompt(params.preloadedSkillNames, sessionId);
  if ((params.preloadedSkillNames?.length ?? 0) > 0 && !preloadedSkillPrompt) {
    return undefined;
  }
  const instructions = combineHermesApiInstructions(params.instructions, preloadedSkillPrompt);
  const stream = await openHermesApiChatStream(config, {
    sessionId,
    sessionKey: params.sessionKey,
    message: params.message,
    instructions,
    abortSignal: params.context.abortSignal,
  });
  const parsed = await consumeHermesApiChatStream(stream, {
    sessionId,
    sessionKey: params.sessionKey,
    context: params.context,
  });
  await rememberHermesSession(params.sessionKey, {
    sessionKey: params.sessionKey,
    hermesSessionId: parsed.hermesSessionId,
    displayName: params.sessionKey,
    label: parsed.output,
    kind: "hermes",
  });
  return {
    output: parsed.output,
    sessionKey: params.sessionKey,
    artifactPaths: [],
    usage: parsed.usage,
    hermesSessionId: parsed.hermesSessionId,
  };
}

async function createHermesApiSession(config: HermesApiConfig, sessionKey: string): Promise<string> {
  const response = await fetchWithTimeout(`${config.baseUrl}/api/sessions`, {
    method: "POST",
    headers: buildHermesApiHeaders(config),
    body: JSON.stringify({ title: sessionKey }),
  }, HERMES_API_HEALTH_TIMEOUT_MS);
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const existingSessionId = response.status === 400
      ? await findExistingHermesApiSessionByTitle(config, sessionKey)
      : undefined;
    if (existingSessionId) {
      return existingSessionId;
    }
    throw new Error(`Hermes API session create failed: ${extractHermesApiError(payload, response.status)}`);
  }
  const sessionId = extractSessionId(payload);
  if (!sessionId) {
    throw new Error("Hermes API session create failed: missing session id");
  }
  return sessionId;
}

async function findExistingHermesApiSessionByTitle(
  config: HermesApiConfig,
  sessionKey: string,
): Promise<string | undefined> {
  try {
    const response = await fetchWithTimeout(`${config.baseUrl}/api/sessions`, {
      headers: buildHermesApiHeaders(config),
    }, HERMES_API_HEALTH_TIMEOUT_MS);
    if (!response.ok) return undefined;
    const payload = await readJsonResponse(response);
    const data = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).data
      : undefined;
    if (!Array.isArray(data)) return undefined;
    const matches = data.filter((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const record = item as Record<string, unknown>;
      return stringValue(record.title) === sessionKey && stringValue(record.source) === "api_server";
    });
    if (matches.length !== 1) return undefined;
    return stringValue((matches[0] as Record<string, unknown>).id) || undefined;
  } catch {
    return undefined;
  }
}

async function openHermesApiChatStream(
  config: HermesApiConfig,
  params: {
    sessionId: string;
    sessionKey: string;
    message: string;
    instructions?: string;
    abortSignal?: AbortSignal;
  },
): Promise<Response> {
  const response = await fetchWithTimeout(`${config.baseUrl}/api/sessions/${encodeURIComponent(params.sessionId)}/chat/stream`, {
    method: "POST",
    headers: {
      ...buildHermesApiHeaders(config),
      "X-Hermes-Session-Key": params.sessionKey,
    },
    body: JSON.stringify({
      message: params.message,
      ...(params.instructions ? { instructions: params.instructions } : {}),
    }),
  }, CHAT_TIMEOUT_MS, params.abortSignal);
  if (!response.ok) {
    const payload = await readJsonResponse(response);
    const message = extractHermesApiError(payload, response.status);
    if (response.status === 404 && /session/i.test(message)) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    throw new Error(`Hermes API chat stream failed: ${message}`);
  }
  if (!response.body) {
    throw new Error("Hermes API chat stream failed: missing response body");
  }
  return response;
}

async function resolveHermesApiPreloadedSkillPrompt(
  preloadedSkillNames: string[] | undefined,
  sessionId: string,
): Promise<string | undefined> {
  if (!preloadedSkillNames || preloadedSkillNames.length === 0) {
    return undefined;
  }
  return await buildHermesPreloadedSkillsPrompt(preloadedSkillNames, sessionId);
}

function combineHermesApiInstructions(...sections: Array<string | undefined>): string | undefined {
  const instructions = compactStringArray(sections).join("\n\n").trim();
  return instructions || undefined;
}

async function consumeHermesApiChatStream(
  response: Response,
  params: {
    sessionId: string;
    sessionKey: string;
    context: LocalCommandContext;
  },
): Promise<{ output: string; hermesSessionId: string; usage?: HermesUsageSnapshot }> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Hermes API chat stream failed: missing stream reader");
  }

  const decoder = new TextDecoder();
  const runId = params.context.requestId ?? `hermes-api-${Date.now()}`;
  let buffer = "";
  let seq = 0;
  let deltaOutput = "";
  let finalOutput = "";
  let usage: HermesUsageSnapshot | undefined;
  let hermesSessionId = params.sessionId;
  const toolLifecycle = createHermesApiToolLifecycleTracker(runId);

  const publishToolEvent = (event: HermesApiResolvedToolEvent): void => {
    publishHermesApiToolEvent(params.context, {
      gatewayId: params.context.gatewayId,
      sessionKey: params.sessionKey,
      runId,
      seq: seq += 1,
      event,
    });
  };

  const finishActiveTools = (phase: "completed" | "failed"): void => {
    for (const event of toolLifecycle.finishActive(phase)) {
      publishToolEvent(event);
    }
  };

  const handleEvent = (event: SseEvent): void => {
    const record = event.data && typeof event.data === "object" && !Array.isArray(event.data)
      ? event.data as Record<string, unknown>
      : {};
    const eventSessionId = stringValue(record.session_id);
    if (eventSessionId) {
      hermesSessionId = eventSessionId;
    }
    switch (event.event) {
      case "assistant.delta": {
        const delta = stringValue(record.delta);
        if (!delta) {
          return;
        }
        deltaOutput += delta;
        params.context.publishEvent?.({
          type: "event",
          event: "chat",
          payload: buildMobileAssistantDeltaPayload({
            run: { runId, sessionKey: params.sessionKey },
            seq: seq += 1,
            timestampMs: Date.now(),
            // canonical message.part.delta 是同一 part 的绝对状态；Hermes API 的 assistant.delta 是增量片段。
            delta: deltaOutput,
            includeTimelineEvents: true,
          }),
        });
        return;
      }
      case "assistant.completed": {
        const content = sanitizeHermesChatOutput(stringValue(record.content) ?? stringValue(record.text) ?? "").trim();
        if (content) {
          finalOutput = content;
        }
        return;
      }
      case "run.completed": {
        finishActiveTools("completed");
        const content = sanitizeHermesChatOutput(stringValue(record.output) ?? "").trim();
        if (content) {
          finalOutput = content;
        }
        usage = normalizeHermesApiUsage(record.usage, hermesSessionId);
        return;
      }
      case "tool.started":
      case "tool.completed":
      case "tool.failed":
      case "tool.progress": {
        const toolEvent = toolLifecycle.resolve(event.event, record);
        if (toolEvent) {
          publishToolEvent(toolEvent);
        }
        return;
      }
      case "error": {
        finishActiveTools("failed");
        throw new Error(stringValue(record.message) ?? "Hermes API stream error");
      }
      case "done": {
        finishActiveTools("completed");
        return;
      }
    }
  };

  try {
    while (true) {
      if (params.context.abortSignal?.aborted) {
        throw new Error("hermes_chat_aborted");
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const frames = splitCompleteSseFrames(buffer);
      buffer = frames.remainder;
      for (const frame of frames.completeFrames) {
        const parsed = parseSseEvent(frame);
        if (parsed) {
          handleEvent(parsed);
        }
      }
    }
    const tail = buffer.trim();
    if (tail) {
      const parsed = parseSseEvent(tail);
      if (parsed) {
        handleEvent(parsed);
      }
    }
  } catch (error) {
    finishActiveTools("failed");
    if (params.context.abortSignal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new Error("hermes_chat_aborted");
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be closed after a network abort.
    }
  }

  finishActiveTools("completed");
  const output = sanitizeHermesChatOutput(finalOutput || deltaOutput).trim();
  return {
    output,
    hermesSessionId,
    usage: usage ?? { hermesSessionId },
  };
}

function publishHermesApiToolEvent(
  context: LocalCommandContext,
  params: {
    gatewayId?: string;
    sessionKey: string;
    runId: string;
    seq: number;
    event: HermesApiResolvedToolEvent;
  },
): void {
  const event: HermesToolLogEvent = {
    toolName: params.event.toolName,
    phase: params.event.phase,
    text: params.event.preview,
    isError: params.event.isError,
  };
  context.publishEvent?.({
    type: "event",
    event: "chat",
    payload: {
      runId: params.runId,
      sessionKey: params.sessionKey,
      stream: "tool",
      state: event.phase,
      phase: event.phase,
      role: "tool",
      seq: params.seq,
      ts: Date.now(),
      data: {
        phase: event.phase,
        tool_call_id: params.event.toolCallId,
        tool_name: event.toolName,
        text: event.text,
        is_error: event.isError === true,
      },
      timelineEvents: [
        buildToolInvocationUpdatedEvent({
          gatewayId: params.gatewayId ?? "clawconnect",
          sessionKey: params.sessionKey,
          turnId: params.runId,
          runId: params.runId,
          toolInvocationId: params.event.toolCallId,
          toolState: hermesToolState(event),
          seq: params.seq,
          turnSeq: params.seq,
          content: [{
            type: event.phase === "completed" || event.phase === "failed" ? "tool_result" : "tool_call",
            toolName: event.toolName,
            text: event.text,
            isError: event.isError === true,
          }],
        }),
      ],
    },
  });
}

export function createHermesApiToolLifecycleTracker(runId: string): HermesApiToolLifecycleTracker {
  type ActiveTool = { toolCallId: string; toolName: string; preview: string };
  const activeById = new Map<string, ActiveTool>();
  const activeIdsByName = new Map<string, string[]>();
  let invocationCounter = 0;

  const register = (tool: ActiveTool): void => {
    const existing = activeById.get(tool.toolCallId);
    activeById.set(tool.toolCallId, tool);
    if (existing) {
      return;
    }
    const queue = activeIdsByName.get(tool.toolName) ?? [];
    queue.push(tool.toolCallId);
    activeIdsByName.set(tool.toolName, queue);
  };

  const remove = (toolCallId: string): ActiveTool | undefined => {
    const active = activeById.get(toolCallId);
    if (!active) {
      return undefined;
    }
    activeById.delete(toolCallId);
    const queue = activeIdsByName.get(active.toolName)?.filter((id) => id !== toolCallId) ?? [];
    if (queue.length > 0) {
      activeIdsByName.set(active.toolName, queue);
    } else {
      activeIdsByName.delete(active.toolName);
    }
    return active;
  };

  const firstActiveId = (toolName: string): string | undefined => activeIdsByName.get(toolName)?.[0];

  const resolve = (
    eventName: string,
    record: Record<string, unknown>,
  ): HermesApiResolvedToolEvent | undefined => {
    const toolName = hermesApiToolName(record);
    const explicitToolCallId = hermesApiExplicitToolCallId(record);
    const phase = hermesApiToolPhase(eventName);
    const recordPreview = hermesApiToolPreview(record);

    // The legacy session API represents `reasoning.available` as `_thinking`.
    // It is private reasoning metadata, not a user-visible tool lifecycle. Ignore
    // every phase defensively so a future started/completed pair cannot surface it.
    if (toolName.trim().toLowerCase() === "_thinking") {
      return undefined;
    }

    if (eventName === "tool.started") {
      const toolCallId = explicitToolCallId ?? `${runId}:hermes-api-tool-${invocationCounter += 1}`;
      const active = activeById.get(toolCallId);
      const tool: ActiveTool = {
        toolCallId,
        toolName,
        preview: recordPreview || active?.preview || "",
      };
      register(tool);
      return resolvedHermesApiToolEvent(tool, phase);
    }

    if (eventName === "tool.progress") {
      const toolCallId = explicitToolCallId ?? firstActiveId(toolName);
      if (!toolCallId) {
        // A progress fragment without explicit identity or a preceding start cannot
        // be correlated safely. Do not invent a permanently active invocation.
        return undefined;
      }
      const active = activeById.get(toolCallId);
      const tool: ActiveTool = {
        toolCallId,
        toolName: active?.toolName ?? toolName,
        preview: recordPreview || active?.preview || "",
      };
      register(tool);
      return resolvedHermesApiToolEvent(tool, phase);
    }

    if (eventName === "tool.completed" || eventName === "tool.failed") {
      const toolCallId = explicitToolCallId ?? firstActiveId(toolName);
      if (!toolCallId) {
        return undefined;
      }
      const active = remove(toolCallId);
      const tool: ActiveTool = {
        toolCallId,
        toolName: active?.toolName ?? toolName,
        preview: recordPreview || active?.preview || "",
      };
      return resolvedHermesApiToolEvent(tool, phase);
    }

    return undefined;
  };

  return {
    resolve,
    finishActive: (phase) => {
      const terminalPhase: HermesToolLogEvent["phase"] = phase;
      const active = [...activeById.values()];
      activeById.clear();
      activeIdsByName.clear();
      return active.map((tool) => resolvedHermesApiToolEvent(tool, terminalPhase));
    },
    activeCount: () => activeById.size,
  };
}

function resolvedHermesApiToolEvent(
  tool: { toolCallId: string; toolName: string; preview: string },
  phase: HermesToolLogEvent["phase"],
): HermesApiResolvedToolEvent {
  return {
    ...tool,
    phase,
    isError: phase === "failed",
  };
}

function hermesApiExplicitToolCallId(record: Record<string, unknown>): string | undefined {
  const nested = record.tool_call && typeof record.tool_call === "object" && !Array.isArray(record.tool_call)
    ? record.tool_call as Record<string, unknown>
    : undefined;
  return firstNonEmpty(
    stringValue(record.toolCallId),
    stringValue(record.tool_call_id),
    stringValue(record.toolInvocationId),
    stringValue(record.tool_invocation_id),
    stringValue(record.callId),
    stringValue(record.call_id),
    stringValue(nested?.id),
  );
}

function hermesApiToolName(record: Record<string, unknown>): string {
  return firstNonEmpty(stringValue(record.tool_name), stringValue(record.tool)) ?? "hermes";
}

function hermesApiToolPreview(record: Record<string, unknown>): string {
  return compactStringArray([
    stringValue(record.preview),
    stringValue(record.delta),
    stringValue(record.text),
  ]).join("\n");
}

function hermesApiToolPhase(eventName: string): HermesToolLogEvent["phase"] {
  if (eventName === "tool.completed") {
    return "completed";
  }
  if (eventName === "tool.failed") {
    return "failed";
  }
  return "streaming";
}

function splitCompleteSseFrames(buffer: string): { completeFrames: string[]; remainder: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const remainder = parts.pop() ?? "";
  return { completeFrames: parts, remainder };
}

function parseSseEvent(frame: string): SseEvent | undefined {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split(/\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim() || "message";
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  if (dataLines.length === 0) {
    return undefined;
  }
  const rawData = dataLines.join("\n");
  try {
    return { event, data: JSON.parse(rawData) as unknown };
  } catch {
    return { event, data: { text: rawData } };
  }
}

function normalizeHermesApiUsage(value: unknown, hermesSessionId: string): HermesUsageSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { hermesSessionId };
  }
  const record = value as Record<string, unknown>;
  const inputTokens = numberValue(record.input_tokens);
  return {
    hermesSessionId,
    contextUsage: inputTokens,
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text };
  }
}

function extractSessionId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const session = record.session && typeof record.session === "object" && !Array.isArray(record.session)
    ? record.session as Record<string, unknown>
    : {};
  return stringValue(record.session_id) ?? stringValue(record.id) ?? stringValue(session.id);
}

function extractHermesApiError(payload: unknown, status: number): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return `HTTP ${status}`;
  }
  const record = payload as Record<string, unknown>;
  const error = record.error && typeof record.error === "object" && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : undefined;
  return stringValue(error?.message)
    ?? stringValue(record.message)
    ?? stringValue(record.error)
    ?? `HTTP ${status}`;
}

function buildHermesApiHeaders(config: HermesApiConfig): Record<string, string> {
  return {
    "Authorization": `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let abortHandler: (() => void) | undefined;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  if (abortSignal) {
    abortHandler = () => controller.abort();
    abortSignal.addEventListener("abort", abortHandler, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    if (abortSignal && abortHandler) {
      abortSignal.removeEventListener("abort", abortHandler);
    }
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isTruthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}
