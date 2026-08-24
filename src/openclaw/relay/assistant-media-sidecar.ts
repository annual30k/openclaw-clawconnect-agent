const OPENCLAW_ASSISTANT_MEDIA_IDEMPOTENCY_SUFFIX = ":assistant-media";

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
  const sidecarMedia = normalizeContentBlocks(sidecar.content).filter((block) => !isTextContentBlock(block));
  return sidecarMedia.length === 0
    ? parent
    : { ...parent, content: [...parentContent, ...sidecarMedia] };
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
  return firstString(
    message.runId,
    message.run_id,
    message.turnId,
    message.turn_id,
    idempotencyKey && !assistantMediaSidecarRunId(idempotencyKey)
      ? normalizeOpenClawRunId(idempotencyKey)
      : undefined,
  );
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
