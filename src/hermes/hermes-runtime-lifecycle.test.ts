import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildClawConnectProfileRestartArgs } from "./runtime/hermes-runtime-lifecycle.js";
import { handleHermesCommand } from "./hermes-runtime.js";

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

test("ClawConnect profile restart helper targets the isolated Hermes profile", () => {
  assert.deepEqual(
    buildClawConnectProfileRestartArgs("hermes", "/opt/clawconnect/dist/index.js"),
    ["/opt/clawconnect/dist/index.js", "restart", "--profile", "hermes"],
  );
});

for (const method of ["hermes.agent.restart", "hermes.gateway.restart"]) {
  test(`${method} executes the Hermes gateway lifecycle command`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "clawconnect-hermes-restart-"));
    const argumentsPath = join(directory, "arguments.txt");
    const hermesBin = join(directory, "hermes");
    const previousHermesBin = process.env.HERMES_BIN;
    try {
      writeFileSync(hermesBin, [
        "#!/bin/sh",
        `printf '%s' \"$*\" > '${argumentsPath}'`,
        "echo 'Hermes gateway restarted'",
        "exit 0",
        "",
      ].join("\n"));
      chmodSync(hermesBin, 0o755);
      process.env.HERMES_BIN = hermesBin;

      const result = await handleHermesCommand(method, {}, {
        gatewayId: "gateway-hermes",
        requestId: `request-${method}`,
      });

      assert.equal(result?.ok, true);
      assert.equal(readFileSync(argumentsPath, "utf8"), "gateway restart");
    } finally {
      if (previousHermesBin === undefined) delete process.env.HERMES_BIN;
      else process.env.HERMES_BIN = previousHermesBin;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
