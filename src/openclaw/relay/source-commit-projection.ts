import { createHash } from "node:crypto";
import { parseCanonicalTimelineEvent, type CanonicalTimelineEvent } from "../../core/relay/timeline-event-log.js";
import type { HistoryResponse } from "./chat-history.js";
import type { SourceCommit } from "../../core/relay/source-commit.js";

export type SourceCommitProjectionBatch = {
  sourceCommit: SourceCommit;
  events: CanonicalTimelineEvent[];
};

/**
 * Turn the authoritative source snapshot into a deterministic append stream.
 * The cursor only gates visibility; each source row keeps its own canonical
 * identity and source order coordinate.
 */
export function buildSourceCommitTimelineEvents(
  history: HistoryResponse,
  sourceCommit: SourceCommit,
  previousCommittedThroughSeq?: number,
): CanonicalTimelineEvent[] {
  const messages = history.timelineSnapshot?.messages ?? [];
  return messages.flatMap((message, index): CanonicalTimelineEvent[] => {
    if (message.projectionVersion !== 3) {
      throw new Error(`OpenClaw source commit projection requires v3 at row ${index}`);
    }
    const sourceMessageId = requireSourceProjectionString(message.sourceMessageId, "sourceMessageId", index);
    const sourceSeq = requireSourceProjectionSequence(message.sourceOrderSeq, index);
    const canonicalMessageId = requireSourceProjectionString(message.canonicalMessageId, "canonicalMessageId", index);
    if (sourceSeq > sourceCommit.committedThroughSeq) {
      throw new Error(`OpenClaw source commit row ${index} exceeds committedThroughSeq`);
    }
    if (previousCommittedThroughSeq !== undefined && sourceSeq <= previousCommittedThroughSeq) {
      return [];
    }
    const messageId = canonicalMessageId;
    const eventId = `evt_source_commit_${createHash("sha256")
      .update(JSON.stringify([sourceCommit.sourceOrderScope, sourceCommit.sourceGeneration, messageId, sourceSeq]))
      .digest("hex")
      .slice(0, 32)}`;
    return [parseCanonicalTimelineEvent({
      protocolVersion: 2,
      eventId,
      eventType: "message.completed",
      gatewayId: sourceCommit.gatewayId,
      sessionKey: history.sessionKey ?? "main",
      turnId: message.turnId,
      runId: message.runId ?? message.turnId,
      messageId,
      partId: message.partId ?? "part-text-1",
      attachmentId: null,
      seq: sourceSeq,
      turnSeq: message.turnSeq ?? sourceSeq,
      role: message.sourceRole ?? message.role,
      messageState: message.messageState,
      runState: "completed",
      createdAt: message.createdAt,
      source: "history",
      content: message.content,
      attachment: null,
      error: null,
      ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
      ...(message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : {}),
      ...(message.projectionVersion === 3 ? {
        projectionVersion: 3,
        canonicalMessageId,
        gatewayType: message.gatewayType ?? sourceCommit.gatewayType,
        producerId: message.producerId ?? sourceCommit.producerId,
        sourceSessionId: message.sourceSessionId ?? sourceCommit.sourceSessionId,
        sourceMessageId,
        sourceOrderScope: message.sourceOrderScope ?? sourceCommit.sourceOrderScope,
        sourceOrderSeq: sourceSeq,
        ...(message.parentSourceMessageId ? { parentSourceMessageId: message.parentSourceMessageId } : {}),
        ...(message.sourceRole ? { sourceRole: message.sourceRole } : {}),
        ...(message.timelineDelivery ? { timelineDelivery: message.timelineDelivery } : {}),
      } : {}),
      sourceCommit,
      extensions: {
        sourceCommitRevision: sourceCommit.sourceRevision,
      },
    })];
  });
}

/**
 * Walk source-history pages without treating a page size as a source
 * watermark. The caller's page reader must report the raw SQLite sequence it
 * actually covered; visible heartbeat filtering is therefore safe, while a
 * missing page fails before the local observer cursor can advance.
 */
export async function projectSourceCommitHistoryPages(options: {
  sourceCommit: SourceCommit;
  previousCommittedThroughSeq?: number;
  readPage: (cursorSeq: number) => Promise<HistoryResponse>;
  publish: (batch: SourceCommitProjectionBatch) => void | Promise<void>;
}): Promise<number> {
  let readThroughSeq = options.previousCommittedThroughSeq ?? 0;
  const targetSeq = options.sourceCommit.committedThroughSeq;
  while (readThroughSeq < targetSeq) {
    const history = await options.readPage(readThroughSeq);
    const rawSourceReadThroughSeq: unknown = history.sourceReadThroughSeq;
    if (
      typeof rawSourceReadThroughSeq !== "number"
      || !Number.isSafeInteger(rawSourceReadThroughSeq)
      || rawSourceReadThroughSeq <= readThroughSeq
    ) {
      throw new Error(`source commit ${options.sourceCommit.sourceRevision} history page made no source progress`);
    }
    const sourceReadThroughSeq = rawSourceReadThroughSeq as number;
    if (
      history.sourceRangeHasGap === true
      || (
        history.sourceRangeStartSeq !== undefined
        && history.sourceRangeStartSeq > readThroughSeq + 1
      )
    ) {
      throw new Error(`source commit ${options.sourceCommit.sourceRevision} history page has a source gap`);
    }
    const pageCommittedThroughSeq = Math.min(sourceReadThroughSeq, targetSeq);
    const pageSourceCommit: SourceCommit = {
      ...options.sourceCommit,
      committedThroughSeq: pageCommittedThroughSeq,
      sourceRevision: pageCommittedThroughSeq === targetSeq
        ? options.sourceCommit.sourceRevision
        : `seq:${pageCommittedThroughSeq}`,
    };
    const pageMessages = history.timelineSnapshot?.messages.filter((message) => {
      const seq = message.sourceOrderSeq;
      return Number.isSafeInteger(seq)
        && (seq as number) > readThroughSeq
        && (seq as number) <= pageCommittedThroughSeq;
    }) ?? [];
    const pageHistory: HistoryResponse = history.timelineSnapshot
      ? {
          ...history,
          timelineSnapshot: {
            ...history.timelineSnapshot,
            messages: pageMessages,
          },
        }
      : history;
    const events = buildSourceCommitTimelineEvents(pageHistory, pageSourceCommit, readThroughSeq);
    if (events.length > 0) {
      await options.publish({ sourceCommit: pageSourceCommit, events });
    }
    readThroughSeq = sourceReadThroughSeq;
    if (readThroughSeq < targetSeq && history.sourceHasMore !== true) {
      throw new Error(`source commit ${options.sourceCommit.sourceRevision} history page ended before source watermark`);
    }
  }
  return readThroughSeq;
}

function requireSourceProjectionString(value: unknown, field: string, index: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`OpenClaw source commit projection ${field} is missing at row ${index}`);
  }
  return value.trim();
}

function requireSourceProjectionSequence(value: unknown, index: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`OpenClaw source commit projection sourceOrderSeq is missing or invalid at row ${index}`);
  }
  return value as number;
}
