const OPENCLAW_ASSISTANT_MEDIA_IDEMPOTENCY_SUFFIX = ":assistant-media";
const OPENCLAW_MESSAGE_TOOL_IDEMPOTENCY_MARKER = ":message-tool:";

/**
 * OpenClaw persists automatic outgoing media as a second assistant record whose
 * idempotency key explicitly names its parent run. The desktop UI projects the
 * pair as one activity; mobile history must use the same stable relation.
 */
export function normalizeOpenClawAssistantMediaSidecars(
  messages: unknown[],
  fallbackSessionKey?: string,
): { messages: unknown[]; changed: boolean } {
  const candidatesByScopeAndRun = new Map<string, Array<{ index: number; message: Record<string, unknown> }>>();
  const messagesById = new Map<string, { index: number; message: Record<string, unknown> }>();
  const sidecars: Array<{ index: number; message: Record<string, unknown>; runId: string; scope: string; parentId?: string }> = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = asRecord(messages[index]);
    if (!message || message.role !== "assistant") continue;
    const scope = messageSessionScope(message, fallbackSessionKey);
    const messageId = firstString(message.id, message.messageId, message.message_id);
    if (messageId && !messagesById.has(messageId)) {
      messagesById.set(messageId, { index, message });
    }
    const idempotencyKey = firstString(message.idempotencyKey, message.idempotency_key);
    const sidecarRunId = assistantMediaSidecarRunId(idempotencyKey);
    if (scope && sidecarRunId) {
      sidecars.push({
        index,
        message,
        runId: sidecarRunId,
        scope,
        parentId: firstString(message.parentId, message.parent_id),
      });
      continue;
    }
    const runId = normalAssistantRunId(message);
    if (!scope || !runId) continue;
    const key = `${scope}\u0000${runId}`;
    const candidates = candidatesByScopeAndRun.get(key) ?? [];
    candidates.push({ index, message });
    candidatesByScopeAndRun.set(key, candidates);
  }

  if (sidecars.length === 0) return { messages, changed: false };

  const mergedByIndex = new Map<number, Record<string, unknown>>();
  const suppressedIndexes = new Set<number>();
  const processedSidecarKeys = new Set<string>();
  for (const sidecar of sidecars) {
    const explicitParent = sidecar.parentId ? messagesById.get(sidecar.parentId) : undefined;
    const candidates = explicitParent
      ? [explicitParent]
      : candidatesByScopeAndRun.get(`${sidecar.scope}\u0000${sidecar.runId}`);
    // An ambiguous or incomplete relation is deliberately preserved. We never
    // infer a parent by matching text, time, position, or a "latest" message.
    if (!candidates || candidates.length !== 1) continue;
    const parent = candidates[0]!;
    if (
      messageSessionScope(parent.message, fallbackSessionKey) !== sidecar.scope ||
      (normalAssistantRunId(parent.message) && normalAssistantRunId(parent.message) !== sidecar.runId)
    ) continue;
    const sidecarKey = `${sidecar.scope}\u0000${sidecar.runId}`;
    // Replayed records carry the same stable sidecar idempotency identity. Fold
    // its media once; still remove every replay from the visible transcript.
    if (processedSidecarKeys.has(sidecarKey)) {
      suppressedIndexes.add(sidecar.index);
      continue;
    }
    const currentParent = mergedByIndex.get(parent.index) ?? parent.message;
    mergedByIndex.set(parent.index, mergeAssistantMediaSidecar(currentParent, sidecar.message));
    suppressedIndexes.add(sidecar.index);
    processedSidecarKeys.add(sidecarKey);
  }

  if (suppressedIndexes.size === 0) return { messages, changed: false };
  return {
    messages: messages.flatMap((message, index) => {
      if (suppressedIndexes.has(index)) return [];
      return [mergedByIndex.get(index) ?? message];
    }),
    changed: true,
  };
}

/**
 * OpenClaw's message(media) tool persists each delivered file as a separate
 * assistant record. Its idempotency key names both the source run and exact
 * tool call. Concurrent calls may finish in any order, so restore the original
 * tool-call order before folding them into the turn's visible assistant reply.
 */
export function normalizeOpenClawAutomaticMediaReplies(
  messages: unknown[],
  fallbackSessionKey?: string,
): { messages: unknown[]; changed: boolean } {
  const runs = new Map<string, {
    parents: Array<{ index: number; message: Record<string, unknown> }>;
    toolCallOrder: Map<string, number>;
    ambiguousToolCallIds: Set<string>;
    nextToolCallOrder: number;
  }>();
  const automaticReplies: Array<{
    index: number;
    message: Record<string, unknown>;
    sourceRunId: string;
    scope: string;
    identity: string;
    toolCallId?: string;
  }> = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = asRecord(messages[index]);
    if (!message || message.role !== "assistant") continue;
    const scope = messageSessionScope(message, fallbackSessionKey);
    if (!scope) continue;
    const relation = automaticMediaReplyRelation(message);
    const media = mediaContentBlocks(message.content);
    if (relation && media.length > 0) {
      const identity = firstString(message.idempotencyKey, message.idempotency_key, message.messageId, message.message_id, message.id);
      // A source-run relationship without the sidecar's own stable identity
      // cannot be deduplicated safely during transcript replay.
      if (identity) {
        automaticReplies.push({ index, message, ...relation, scope, identity });
      }
      continue;
    }

    const runId = normalAssistantRunId(message);
    if (!runId) continue;
    const key = `${scope}\u0000${runId}`;
    const run = runs.get(key) ?? {
      parents: [],
      toolCallOrder: new Map<string, number>(),
      ambiguousToolCallIds: new Set<string>(),
      nextToolCallOrder: 0,
    };
    run.parents.push({ index, message });
    for (const toolCallId of messageToolCallIds(message.content)) {
      if (run.toolCallOrder.has(toolCallId)) {
        run.ambiguousToolCallIds.add(toolCallId);
      } else {
        run.toolCallOrder.set(toolCallId, run.nextToolCallOrder);
        run.nextToolCallOrder += 1;
      }
    }
    runs.set(key, run);
  }

  if (automaticReplies.length === 0) return { messages, changed: false };

  const mergedByIndex = new Map<number, Record<string, unknown>>();
  const suppressedIndexes = new Set<number>();
  const processedReplies = new Set<string>();
  const repliesByRun = new Map<string, typeof automaticReplies>();
  for (const reply of automaticReplies) {
    const key = `${reply.scope}\u0000${reply.sourceRunId}`;
    const replies = repliesByRun.get(key) ?? [];
    replies.push(reply);
    repliesByRun.set(key, replies);
  }

  for (const [key, replies] of repliesByRun.entries()) {
    const run = runs.get(key);
    const parent = run ? selectAutomaticMediaParent(run.parents) : undefined;
    if (!run || !parent) continue;

    const uniqueReplies = replies.filter((reply) => {
      const replayKey = `${key}\u0000${reply.identity}`;
      if (processedReplies.has(replayKey)) {
        suppressedIndexes.add(reply.index);
        return false;
      }
      processedReplies.add(replayKey);
      return true;
    });
    const canRestoreToolCallOrder = uniqueReplies.length > 0 && uniqueReplies.every((reply) => (
      Boolean(reply.toolCallId)
      && !run.ambiguousToolCallIds.has(reply.toolCallId!)
      && run.toolCallOrder.has(reply.toolCallId!)
    ));
    const orderedReplies = canRestoreToolCallOrder
      ? [...uniqueReplies].sort((left, right) => (
          run.toolCallOrder.get(left.toolCallId!)! - run.toolCallOrder.get(right.toolCallId!)!
        ))
      : uniqueReplies;

    let currentParent = mergedByIndex.get(parent.index) ?? parent.message;
    for (const reply of orderedReplies) {
      currentParent = mergeAssistantMediaSidecar(currentParent, reply.message);
      suppressedIndexes.add(reply.index);
    }
    mergedByIndex.set(parent.index, currentParent);
  }

  if (suppressedIndexes.size === 0) return { messages, changed: false };
  return {
    messages: messages.flatMap((message, index) => {
      if (suppressedIndexes.has(index)) return [];
      return [mergedByIndex.get(index) ?? message];
    }),
    changed: true,
  };
}

/** Map an event-only sidecar to its documented parent run identity. */
export function canonicalizeOpenClawAssistantMediaSidecarPayload(payload: unknown): unknown {
  const record = asRecord(payload);
  const message = asRecord(record?.message);
  const source = message ?? record;
  if (source?.role !== "assistant") return payload;
  const sidecarRunId = assistantMediaSidecarRunId(firstString(
    source.idempotencyKey,
    source.idempotency_key,
  ));
  if (!sidecarRunId) return payload;
  const explicitRunId = firstString(
    record?.runId,
    record?.run_id,
    record?.turnId,
    record?.turn_id,
    message?.runId,
    message?.run_id,
    message?.turnId,
    message?.turn_id,
  );
  if (explicitRunId && explicitRunId !== sidecarRunId) return payload;
  if (explicitRunId) return payload;
  return { ...record, runId: sidecarRunId, turnId: sidecarRunId };
}

/** True only for the documented OpenClaw automatic-media sidecar identity. */
export function isOpenClawAssistantMediaSidecarPayload(payload: unknown): boolean {
  const record = asRecord(payload);
  const message = asRecord(record?.message);
  const source = message ?? record;
  return source?.role === "assistant" && Boolean(assistantMediaSidecarRunId(firstString(
    source.idempotencyKey,
    source.idempotency_key,
  )));
}

function mergeAssistantMediaSidecar(
  parent: Record<string, unknown>,
  sidecar: Record<string, unknown>,
): Record<string, unknown> {
  const parentContent = normalizeContentBlocks(parent.content);
  const sidecarMedia = mediaContentBlocks(sidecar.content);
  return sidecarMedia.length === 0
    ? parent
    : { ...parent, content: [...parentContent, ...sidecarMedia] };
}

function mediaContentBlocks(content: unknown): unknown[] {
  return normalizeContentBlocks(content).filter((block) => !isTextContentBlock(block));
}

function normalizeContentBlocks(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  return typeof content === "string" && content.trim() ? [{ type: "text", text: content }] : [];
}

function isTextContentBlock(block: unknown): boolean {
  const record = asRecord(block);
  const type = typeof record?.type === "string" ? record.type.trim().toLowerCase() : "";
  return type === "text" || type === "input_text" || type === "output_text";
}

function messageSessionScope(message: Record<string, unknown>, fallbackSessionKey?: string): string | undefined {
  return firstString(message.sessionKey, message.sessionId, fallbackSessionKey);
}

function normalAssistantRunId(message: Record<string, unknown>): string | undefined {
  const idempotencyKey = firstString(message.idempotencyKey, message.idempotency_key);
  const metadata = asRecord(message.__openclaw);
  return firstString(
    message.runId,
    message.run_id,
    message.turnId,
    message.turn_id,
    metadata?.runId,
    metadata?.run_id,
    idempotencyKey && !assistantMediaSidecarRunId(idempotencyKey)
      ? normalizeOpenClawRunId(idempotencyKey)
      : undefined,
  );
}

function automaticMediaReplySourceRunId(message: Record<string, unknown>): string | undefined {
  const metadata = asRecord(message.__openclaw);
  return firstString(
    message.sourceRunId,
    message.source_run_id,
    metadata?.sourceRunId,
    metadata?.source_run_id,
  );
}

function automaticMediaReplyRelation(
  message: Record<string, unknown>,
): { sourceRunId: string; toolCallId?: string } | undefined {
  const explicitSourceRunId = automaticMediaReplySourceRunId(message);
  const idempotencyKey = firstString(
    message.idempotencyKey,
    message.idempotency_key,
    asRecord(message.__openclaw)?.idempotencyKey,
    asRecord(message.__openclaw)?.idempotency_key,
  );
  const markerIndex = idempotencyKey?.indexOf(OPENCLAW_MESSAGE_TOOL_IDEMPOTENCY_MARKER) ?? -1;
  if (!idempotencyKey || markerIndex <= 0) {
    return explicitSourceRunId ? { sourceRunId: explicitSourceRunId } : undefined;
  }

  const sourceRunId = idempotencyKey.slice(0, markerIndex).trim();
  const suffix = idempotencyKey.slice(markerIndex + OPENCLAW_MESSAGE_TOOL_IDEMPOTENCY_MARKER.length);
  const toolCallId = suffix.slice(suffix.lastIndexOf(":") + 1).trim();
  if (!sourceRunId || !toolCallId || (explicitSourceRunId && explicitSourceRunId !== sourceRunId)) {
    return undefined;
  }
  return { sourceRunId, toolCallId };
}

function messageToolCallIds(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const calls: string[] = [];
  for (const contentBlock of content) {
    const block = asRecord(contentBlock);
    const type = firstString(block?.type)?.toLowerCase();
    const name = firstString(block?.name, block?.toolName, block?.tool_name)?.toLowerCase();
    const id = firstString(block?.id, block?.toolCallId, block?.tool_call_id);
    if (id && name === "message" && ["toolcall", "tool_call", "tool-use", "tooluse"].includes(type ?? "")) {
      calls.push(id);
    }
  }
  return calls;
}

function selectAutomaticMediaParent(
  parents: Array<{ index: number; message: Record<string, unknown> }>,
): { index: number; message: Record<string, unknown> } | undefined {
  const textParents = parents.filter(({ message }) => normalizeContentBlocks(message.content).some(isTextContentBlock));
  if (textParents.length === 1) return textParents[0];
  return parents.length === 1 ? parents[0] : undefined;
}

function assistantMediaSidecarRunId(idempotencyKey: string | undefined): string | undefined {
  if (!idempotencyKey?.endsWith(OPENCLAW_ASSISTANT_MEDIA_IDEMPOTENCY_SUFFIX)) return undefined;
  const runId = idempotencyKey.slice(0, -OPENCLAW_ASSISTANT_MEDIA_IDEMPOTENCY_SUFFIX.length).trim();
  return runId || undefined;
}

function normalizeOpenClawRunId(value: string): string {
  return value.replace(/:(?:user|assistant|tool|system)$/i, "").trim();
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
