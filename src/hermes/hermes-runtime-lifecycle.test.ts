import assert from "node:assert/strict";
import { test } from "node:test";

import { buildClawConnectProfileRestartArgs } from "./models/hermes-runtime-lifecycle.js";

test("Hermes agent restart targets the isolated ClawConnect Hermes profile", () => {
  assert.deepEqual(
    buildClawConnectProfileRestartArgs("hermes", "/opt/clawconnect/dist/index.js"),
    ["/opt/clawconnect/dist/index.js", "restart", "--profile", "hermes"],
  );
});

