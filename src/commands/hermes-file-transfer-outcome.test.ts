import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import {
  hermesFileTransferOutcomeCommand,
  parseHermesFileTransferOutcome,
} from "./hermes-file-transfer-outcome.js";

test("Hermes file-transfer outcome bridge emits a typed terminal record", () => {
  let output = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const result = hermesFileTransferOutcomeCommand(
    JSON.stringify({ kind: "clarification", sourceRunId: "run-clarify", assistantText: "请指定文件" }),
    stdout,
  );
  assert.deepEqual(result, {
    protocol: "clawconnect.hermes-file-transfer-outcome.v1",
    kind: "clarification",
    sourceRunId: "run-clarify",
    sourceRole: "assistant",
    status: "completed",
    assistantText: "请指定文件",
  });
  assert.deepEqual(JSON.parse(output), result);
});

test("Hermes file-transfer outcome bridge rejects missing stable source identity", () => {
  assert.throws(
    () => parseHermesFileTransferOutcome({ kind: "attempted" }),
    /hermes_file_transfer_outcome_invalid/,
  );
});

test("Hermes file-transfer outcome bridge requires typed visible text for non-delivery outcomes", () => {
  assert.throws(
    () => parseHermesFileTransferOutcome({ kind: "ordinary", sourceRunId: "run-ordinary" }),
    /hermes_file_transfer_outcome_invalid/,
  );
});
