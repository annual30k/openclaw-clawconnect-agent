import assert from "node:assert/strict";
import { test } from "node:test";

import { buildClawConnectProfileRestartArgs } from "./runtime/hermes-runtime-lifecycle.js";

import {
  restoreEnv,
  writeMutableHistoryHermesBin,
  writePagedHistoryHermesBin,
  writeFakeHermesBin,
  writeTimeoutDeniedHermesBin,
  writeAbortPartialHermesBin,
  writeSlowPartialHermesBin,
  waitForHermesDelta,
  writeHistoryCompletingHermesBin,
  writeStaleHistoryHermesBin,
  writeRepeatedUserStaleHistoryHermesBin,
  writeConcurrentDetectingHermesBin,
  writeResumeMetadataHermesBin,
  writeHistoryHermesBin,
  writeUntimedHistoryHermesBin,
} from "./hermes-runtime-test-support.js";

test("Hermes agent restart targets the isolated ClawConnect Hermes profile", () => {
  assert.deepEqual(
    buildClawConnectProfileRestartArgs("hermes", "/opt/clawconnect/dist/index.js"),
    ["/opt/clawconnect/dist/index.js", "restart", "--profile", "hermes"],
  );
});
