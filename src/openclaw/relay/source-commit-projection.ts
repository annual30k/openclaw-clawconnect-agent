import { createHash } from "node:crypto";
import { parseCanonicalTimelineEvent, type CanonicalTimelineEvent } from "../../core/relay/timeline-event-log.js";
import type { HistoryResponse } from "./chat-history.js";
import type { SourceCommit } from "../../core/relay/source-commit.js";
import {
  sourceRowFingerprint,
  type SourceRowFingerprints,
  type SourceSnapshotMessage,
} from "./source-row-fingerprints.js";

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
  /** 宿主原地改写后重投的行：源 seq → 原始内容指纹，参与事件 ID。 */
  contentRevisions?: ReadonlyMap<number, string>,
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
    const role = message.sourceRole ?? message.role;
    // 与 Relay 历史快照及 Hermes 投影保持同一事件契约：user 行是 turn.user.created，
    // 失败/中止的行是 run.failed，其余为 message.completed。客户端按事件类型对账本地回显，
    // 若把 user 行发成 message.completed，会被只认 assistant 的解码器丢弃。
    const eventType: CanonicalTimelineEvent["eventType"] = role === "user"
      ? "turn.user.created"
      : message.messageState === "failed" || message.messageState === "aborted"
        ? "run.failed"
        : "message.completed";
    const contentRevision = contentRevisions?.get(sourceSeq);
    const eventIdParts: unknown[] = [sourceCommit.sourceOrderScope, sourceCommit.sourceGeneration, messageId, sourceSeq];
    if (contentRevision) eventIdParts.push(contentRevision);
    const eventId = `evt_source_commit_${createHash("sha256")
      .update(JSON.stringify(eventIdParts))
      .digest("hex")
      .slice(0, 32)}`;
    return [parseCanonicalTimelineEvent({
      protocolVersion: 2,
      eventId,
      eventType,
      gatewayId: sourceCommit.gatewayId,
      sessionKey: requireProjectionSessionKey(history.sessionKey),
      turnId: message.turnId,
      runId: message.runId ?? message.turnId,
      messageId,
      partId: message.partId ?? "part-text-1",
      attachmentId: null,
      seq: sourceSeq,
      turnSeq: message.turnSeq ?? sourceSeq,
      role,
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

export type SourceCommitPageReader = (cursorSeq: number) => Promise<HistoryResponse>;
export type SourceCommitMediaRelay = (page: HistoryResponse) => Promise<HistoryResponse>;

/** 只保留 (afterSeq, throughSeq] 内、且通过 include 的快照行。 */
function withSnapshotRows(
  history: HistoryResponse,
  afterSeq: number,
  throughSeq: number,
  include: (message: SourceSnapshotMessage) => boolean = () => true,
): HistoryResponse {
  if (!history.timelineSnapshot) return history;
  return {
    ...history,
    timelineSnapshot: {
      ...history.timelineSnapshot,
      messages: history.timelineSnapshot.messages.filter((message) => {
        const seq = message.sourceOrderSeq;
        return Number.isSafeInteger(seq)
          && (seq as number) > afterSeq
          && (seq as number) <= throughSeq
          && include(message);
      }),
    },
  };
}

type SourceCommitPageVisit = {
  /** 未经媒体处理的原始页。 */
  rawPage: HistoryResponse;
  pageSourceCommit: SourceCommit;
  afterSeq: number;
};

/**
 * Walk source-history pages without treating a page size as a source
 * watermark. The caller's page reader must report the raw SQLite sequence it
 * actually covered; visible heartbeat filtering is therefore safe, while a
 * missing page fails before the local observer cursor can advance.
 */
async function walkSourceCommitPages(options: {
  sourceCommit: SourceCommit;
  startSeq: number;
  readPage: SourceCommitPageReader;
  visit: (page: SourceCommitPageVisit) => Promise<void>;
}): Promise<number> {
  let readThroughSeq = options.startSeq;
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
    await options.visit({
      rawPage: history,
      afterSeq: readThroughSeq,
      pageSourceCommit: {
        ...options.sourceCommit,
        committedThroughSeq: pageCommittedThroughSeq,
        sourceRevision: pageCommittedThroughSeq === targetSeq
          ? options.sourceCommit.sourceRevision
          : `seq:${pageCommittedThroughSeq}`,
      },
    });
    readThroughSeq = sourceReadThroughSeq;
    if (readThroughSeq < targetSeq && history.sourceHasMore !== true) {
      throw new Error(`source commit ${options.sourceCommit.sourceRevision} history page ended before source watermark`);
    }
  }
  return readThroughSeq;
}

/**
 * 投影新提交的源行。宿主行在提交时可能已带投递媒体（openclawDelivery /
 * openclawDisplayContent 中的托管外发图片），必须先经 relayMedia 上传并改写为 Relay
 * 文件块，否则图片只能等下一次 history 刷新才出现。fingerprints 记录每行原始内容，
 * 供宿主原地改写后的重投比较。
 */
export async function projectSourceCommitHistoryPages(options: {
  sourceCommit: SourceCommit;
  previousCommittedThroughSeq?: number;
  readPage: SourceCommitPageReader;
  relayMedia?: SourceCommitMediaRelay;
  fingerprints?: SourceRowFingerprints;
  publish: (batch: SourceCommitProjectionBatch) => void | Promise<void>;
}): Promise<number> {
  const relayMedia = options.relayMedia ?? (async (page: HistoryResponse) => page);
  return walkSourceCommitPages({
    sourceCommit: options.sourceCommit,
    startSeq: options.previousCommittedThroughSeq ?? 0,
    readPage: options.readPage,
    visit: async ({ rawPage, pageSourceCommit, afterSeq }) => {
      const throughSeq = pageSourceCommit.committedThroughSeq;
      const rawRows = withSnapshotRows(rawPage, afterSeq, throughSeq).timelineSnapshot?.messages ?? [];
      const pageHistory = withSnapshotRows(await relayMedia(rawPage), afterSeq, throughSeq);
      const events = buildSourceCommitTimelineEvents(pageHistory, pageSourceCommit, afterSeq);
      if (events.length > 0) {
        await options.publish({ sourceCommit: pageSourceCommit, events });
      }
      options.fingerprints?.record(pageSourceCommit, rawRows);
    },
  });
}

/**
 * 宿主原地改写后的重投（OpenClaw 先提交最终回复，再把托管图片补写进同一行，seq 水位不变）。
 *
 * 只比较本进程投影过的范围：从记录了指纹的最小源 seq 起重读，原始内容指纹变化、或此前
 * 不可见而现在可见的行才重新发布。重投事件 ID 含内容指纹：同一内容永远得到同一 ID，
 * Relay 按 eventId 与内容哈希幂等；不同内容得到新 ID，作为同一 canonical 消息的新版本。
 * 返回重新发布的行数。
 */
export async function projectSourceCommitRewrite(options: {
  sourceCommit: SourceCommit;
  readPage: SourceCommitPageReader;
  relayMedia?: SourceCommitMediaRelay;
  fingerprints: SourceRowFingerprints;
  publish: (batch: SourceCommitProjectionBatch) => void | Promise<void>;
}): Promise<number> {
  const trackedFromSeq = options.fingerprints.trackedFromSeq(options.sourceCommit);
  if (trackedFromSeq === undefined) return 0;
  const relayMedia = options.relayMedia ?? (async (page: HistoryResponse) => page);
  let republished = 0;
  await walkSourceCommitPages({
    sourceCommit: options.sourceCommit,
    startSeq: trackedFromSeq - 1,
    readPage: options.readPage,
    visit: async ({ rawPage, pageSourceCommit, afterSeq }) => {
      const throughSeq = pageSourceCommit.committedThroughSeq;
      const revisions = new Map<number, string>();
      const rawRows = withSnapshotRows(rawPage, afterSeq, throughSeq, (message) => {
        const fingerprint = sourceRowFingerprint(message);
        if (options.fingerprints.matches(pageSourceCommit, message.sourceOrderSeq as number, fingerprint)) return false;
        revisions.set(message.sourceOrderSeq as number, fingerprint);
        return true;
      }).timelineSnapshot?.messages ?? [];
      if (rawRows.length === 0) return;
      // 媒体处理使用整页（侧车媒体行按源身份归并到父消息），之后只保留变化的行。
      const pageHistory = withSnapshotRows(
        await relayMedia(rawPage),
        afterSeq,
        throughSeq,
        (message) => revisions.has(message.sourceOrderSeq as number),
      );
      const events = buildSourceCommitTimelineEvents(pageHistory, pageSourceCommit, afterSeq, revisions);
      if (events.length > 0) {
        await options.publish({ sourceCommit: pageSourceCommit, events });
      }
      options.fingerprints.record(pageSourceCommit, rawRows);
      republished += events.length;
    },
  });
  return republished;
}

/** 源投影必须带会话归属；缺失时显式失败，绝不猜成 main 写错会话。 */
function requireProjectionSessionKey(value: unknown): string {
  const sessionKey = typeof value === "string" ? value.trim() : "";
  if (!sessionKey) {
    throw new Error("Source projection history page is missing sessionKey");
  }
  return sessionKey;
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
