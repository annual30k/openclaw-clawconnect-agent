import assert from "node:assert/strict";
import test from "node:test";
import { parseLaunchctlPrintPlistPath, shouldManageMacLaunchdJob } from "./service-manager.js";

const plistPath = "/Users/real/Library/LaunchAgents/com.openclaw.clawconnect.agent.openclaw-local.plist";

test("launchd job is managed when this HOME owns the plist", () => {
  assert.equal(shouldManageMacLaunchdJob({ plistExists: true, plistPath }), true);
  assert.equal(
    shouldManageMacLaunchdJob({ plistExists: true, loadedPlistPath: "/elsewhere.plist", plistPath }),
    true,
  );
});

test("launchd job is managed when the loaded job points at this HOME's plist", () => {
  assert.equal(shouldManageMacLaunchdJob({ plistExists: false, loadedPlistPath: plistPath, plistPath }), true);
});

test("an isolated HOME never manages another HOME's loaded launchd job", () => {
  const isolatedPlist = "/var/folders/tmp/clawconnect-test/Library/LaunchAgents/com.openclaw.clawconnect.agent.openclaw-local.plist";
  assert.equal(
    shouldManageMacLaunchdJob({ plistExists: false, loadedPlistPath: plistPath, plistPath: isolatedPlist }),
    false,
  );
  assert.equal(shouldManageMacLaunchdJob({ plistExists: false, plistPath: isolatedPlist }), false);
});

test("launchctl print output yields the loaded plist path", () => {
  const output = [
    "gui/501/com.openclaw.clawconnect.agent.openclaw-local = {",
    "\tactive count = 1",
    `\tpath = ${plistPath}`,
    "\tstate = running",
    "}",
  ].join("\n");
  assert.equal(parseLaunchctlPrintPlistPath(output), plistPath);
  assert.equal(parseLaunchctlPrintPlistPath("no path here"), undefined);
});
