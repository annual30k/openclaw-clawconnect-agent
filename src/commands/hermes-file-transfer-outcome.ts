import type { Writable } from "node:stream";

export type HermesFileTransferOutcomeKind = "ordinary" | "clarification" | "attempted" | "cancelled";

export type HermesFileTransferOutcome = {
  protocol: "clawconnect.hermes-file-transfer-outcome.v1";
  kind: HermesFileTransferOutcomeKind;
  sourceRunId: string;
  sourceRole: "assistant";
  status: "completed";
  /** User-visible text is a separate typed field; it is never delivery evidence. */
  assistantText?: string;
};

/**
 * Emit a machine-readable terminal result for Hermes' state.db. Hermes records
 * this command's stdout as a terminal tool row; ClawConnect then validates the
 * typed outcome instead of guessing from the assistant's prose.
 */
export function parseHermesFileTransferOutcome(value: unknown): HermesFileTransferOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("hermes_file_transfer_outcome_json_required");
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const sourceRunId = typeof record.sourceRunId === "string" ? record.sourceRunId.trim() : "";
  const assistantText = typeof record.assistantText === "string" ? record.assistantText.trim() : undefined;
  if (
    (kind !== "ordinary" && kind !== "clarification" && kind !== "attempted" && kind !== "cancelled")
    || !sourceRunId
    || (kind !== "attempted" && !assistantText)
  ) {
    throw new Error("hermes_file_transfer_outcome_invalid");
  }
  return {
    protocol: "clawconnect.hermes-file-transfer-outcome.v1",
    kind,
    sourceRunId,
    sourceRole: "assistant",
    status: "completed",
    ...(assistantText ? { assistantText } : {}),
  };
}

export function hermesFileTransferOutcomeCommand(
  rawJson: string,
  stdout: Writable = process.stdout,
): HermesFileTransferOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("hermes_file_transfer_outcome_json_invalid");
  }
  const outcome = parseHermesFileTransferOutcome(parsed);
  stdout.write(`${JSON.stringify(outcome)}\n`);
  return outcome;
}
