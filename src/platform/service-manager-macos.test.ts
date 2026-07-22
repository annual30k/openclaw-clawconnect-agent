import assert from "node:assert/strict";
import test from "node:test";
import { macLaunchctlServiceTarget } from "./service-manager.js";

test("macOS service restart targets the loaded per-user launchd job atomically", () => {
  assert.equal(
    macLaunchctlServiceTarget("com.openclaw.clawconnect.agent.hermes", 501),
    "gui/501/com.openclaw.clawconnect.agent.hermes",
  );
});
