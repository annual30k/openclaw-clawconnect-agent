import { createHash } from "node:crypto";

/**
 * Version 3 source identity for transcript-backed timeline projections.
 *
 * `sourceOrderSeq` is an ordering coordinate only.  It is deliberately not
 * used to identify a message: replaying a snapshot or inserting a row must
 * never make two source messages share an identity.  `eventId` remains a
 * transport idempotency key and is not part of the projection identity.
 */
export const CANONICAL_TIMELINE_PROJECTION_VERSION = 3 as const;

export type TimelineProjectionGateway = "openclaw" | "hermes";
export type TimelineProjectionSourceRole = "user" | "assistant" | "tool" | "system";
export type TimelineProjectionDelivery = "embedded" | "independent";

function clean(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function requireIdentity(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Timeline projection identity is missing ${field}`);
  }
  return value.trim();
}

function keyPart(value: string): string {
  return encodeURIComponent(value);
}

export function openClawAgentIdFromSessionKey(
  sessionKey: string,
  defaultAgentId = "main",
): string {
  return sessionKey.match(/^agent:([^:]+):/)?.[1] ?? clean(defaultAgentId, "main");
}

export function openClawSourceOrderScope(input: {
  agentId?: string;
  sessionId: string;
}): string {
  return `openclaw:${keyPart(clean(input.agentId, "main"))}:${keyPart(requireIdentity(input.sessionId, "sourceSessionId"))}`;
}

export function hermesSourceOrderScope(input: {
  sessionId: string;
  profileId?: string;
}): string {
  return `hermes:${keyPart(clean(input.profileId, "default"))}:${keyPart(requireIdentity(input.sessionId, "sourceSessionId"))}`;
}

/**
 * Stable, bounded identity for one source row; source message id is never
 * optional here.
 *
 * The complete five-part source identity is retained in the projection
 * metadata fields. The database-facing id is intentionally an opaque digest:
 * concatenating arbitrary gateway/producer/session/message ids made the
 * legacy MySQL VARCHAR(191) message_id and sort_key columns overflow. Hashing
 * the canonical tuple preserves equality/distinctness without truncating any
 * identity component or making source order part of identity.
 */
export function canonicalProjectionMessageId(input: {
  gatewayType: TimelineProjectionGateway;
  gatewayId: string;
  producerId: string;
  sourceSessionId: string;
  sourceMessageId: string;
}): string {
  const gatewayId = requireIdentity(input.gatewayId, "gatewayId");
  const producerId = requireIdentity(input.producerId, "producerId");
  const sourceSessionId = requireIdentity(input.sourceSessionId, "sourceSessionId");
  const sourceMessageId = requireIdentity(input.sourceMessageId, "sourceMessageId");
  const identityTuple = JSON.stringify([
    input.gatewayType,
    gatewayId,
    producerId,
    sourceSessionId,
    sourceMessageId,
  ]);
  const digest = createHash("sha256").update(identityTuple).digest("hex");
  return `timeline:v3:${keyPart(input.gatewayType)}:${digest}`;
}

export function createProjectionMetadata(input: {
  gatewayType: TimelineProjectionGateway;
  gatewayId: string;
  producerId: string;
  sourceSessionId: string;
  sourceMessageId: string;
  sourceOrderScope: string;
  sourceOrderSeq: number;
  sourceRole: TimelineProjectionSourceRole;
  parentSourceMessageId?: string;
  timelineDelivery?: TimelineProjectionDelivery;
}): {
  projectionVersion: 3;
  canonicalMessageId: string;
  gatewayType: TimelineProjectionGateway;
  producerId: string;
  sourceSessionId: string;
  sourceMessageId: string;
  sourceOrderScope: string;
  sourceOrderSeq: number;
  sourceRole: TimelineProjectionSourceRole;
  parentSourceMessageId?: string;
  timelineDelivery?: TimelineProjectionDelivery;
} {
  if (!Number.isSafeInteger(input.sourceOrderSeq) || input.sourceOrderSeq <= 0) {
    throw new Error("Timeline projection sourceOrderSeq must be a positive integer");
  }
  const gatewayId = requireIdentity(input.gatewayId, "gatewayId");
  const producerId = requireIdentity(input.producerId, "producerId");
  const sourceSessionId = requireIdentity(input.sourceSessionId, "sourceSessionId");
  const sourceMessageId = requireIdentity(input.sourceMessageId, "sourceMessageId");
  const sourceOrderScope = requireIdentity(input.sourceOrderScope, "sourceOrderScope");
  return {
    projectionVersion: 3,
    canonicalMessageId: canonicalProjectionMessageId({
      ...input,
      gatewayId,
      producerId,
      sourceSessionId,
      sourceMessageId,
    }),
    gatewayType: input.gatewayType,
    producerId,
    sourceSessionId,
    sourceMessageId,
    sourceOrderScope,
    sourceOrderSeq: input.sourceOrderSeq,
    sourceRole: input.sourceRole,
    ...(input.parentSourceMessageId ? { parentSourceMessageId: input.parentSourceMessageId } : {}),
    ...(input.timelineDelivery ? { timelineDelivery: input.timelineDelivery } : {}),
  };
}
