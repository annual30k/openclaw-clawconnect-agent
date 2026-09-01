import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_TIMELINE_DELTA_CAPABILITY,
  CHAT_TOOL_LIFECYCLE_CAPABILITY,
  CLAWCONNECT_AGENT_VERSION,
  buildHermesHostRuntimeMetadata,
  buildOpenClawHostRuntimeMetadata,
} from "./runtime-metadata.js";

test("OpenClaw hello metadata reports the installed Agent version and live event contract", () => {
  const metadata = buildOpenClawHostRuntimeMetadata("win32");

  assert.equal(metadata.platform, "win32");
  assert.match(CLAWCONNECT_AGENT_VERSION, /^\d+\.\d+\.\d+(?:[-+].+)?$/);
  assert.equal(metadata.agentVersion, CLAWCONNECT_AGENT_VERSION);
  assert.ok(metadata.capabilities.includes(CHAT_TIMELINE_DELTA_CAPABILITY));
  assert.ok(metadata.capabilities.includes(CHAT_TOOL_LIFECYCLE_CAPABILITY));
});

test("Hermes API metadata advertises typed text and tool lifecycle events", () => {
  const metadata = buildHermesHostRuntimeMetadata("api", ["chat"], "win32");

  assert.equal(metadata.platform, "win32 (Hermes API)");
  assert.equal(metadata.agentVersion, CLAWCONNECT_AGENT_VERSION);
  assert.deepEqual(metadata.capabilities, [
    "chat",
    CHAT_TIMELINE_DELTA_CAPABILITY,
    CHAT_TOOL_LIFECYCLE_CAPABILITY,
  ]);
});

test("Hermes CLI metadata does not claim semantic assistant text deltas", () => {
  const metadata = buildHermesHostRuntimeMetadata("local", ["chat", "chat"], "win32");

  assert.equal(metadata.platform, "win32 (Hermes CLI)");
  assert.deepEqual(metadata.capabilities, ["chat", CHAT_TOOL_LIFECYCLE_CAPABILITY]);
  assert.equal(metadata.capabilities.includes(CHAT_TIMELINE_DELTA_CAPABILITY), false);
});
