import assert from "assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import test from "node:test";
import { tmpdir } from "os";
import { join } from "path";

const tempDir = await mkdtemp(join(tmpdir(), "clawconnect-remote-restart-"));
const runtimeFile = join(tempDir, "runtime-state.txt");
const logFile = join(tempDir, "openclaw.log");
const failureActionFile = join(tempDir, "failure-action.txt");
const openclawBin = join(tempDir, "openclaw");

await writeFile(
  openclawBin,
  `#!/bin/sh
set -eu
if [ "\${1:-}" = "gateway" ] && [ "\${2:-}" = "status" ]; then
  runtime_state="$(cat "$OPENCLAW_RUNTIME_FILE" 2>/dev/null || true)"
  if [ -z "$runtime_state" ]; then
    runtime_state="stopped"
  fi
  printf 'Runtime: %s\\n' "$runtime_state"
fi
printf '%s\\n' "$*" >> "$OPENCLAW_LOG_FILE"
failure_action="$(cat "$OPENCLAW_FAILURE_ACTION_FILE" 2>/dev/null || true)"
if [ -n "$failure_action" ] && [ "$failure_action" = "\${2:-}" ]; then
  printf 'gateway %s failed\\n' "$failure_action" >&2
  exit 7
fi
exit 0
`,
);
await chmod(openclawBin, 0o755);

const originalOpenclawBin = process.env.OPENCLAW_BIN;
const originalRuntimeFile = process.env.OPENCLAW_RUNTIME_FILE;
const originalLogFile = process.env.OPENCLAW_LOG_FILE;
const originalFailureActionFile = process.env.OPENCLAW_FAILURE_ACTION_FILE;
process.env.OPENCLAW_BIN = openclawBin;
process.env.OPENCLAW_RUNTIME_FILE = runtimeFile;
process.env.OPENCLAW_LOG_FILE = logFile;
process.env.OPENCLAW_FAILURE_ACTION_FILE = failureActionFile;

const { handleLocalCommand } = await import(`./local-handlers.js?remote-restart-test=${encodeURIComponent(tempDir)}`);

test.after(async () => {
  if (originalOpenclawBin === undefined) {
    delete process.env.OPENCLAW_BIN;
  } else {
    process.env.OPENCLAW_BIN = originalOpenclawBin;
  }
  if (originalRuntimeFile === undefined) {
    delete process.env.OPENCLAW_RUNTIME_FILE;
  } else {
    process.env.OPENCLAW_RUNTIME_FILE = originalRuntimeFile;
  }
  if (originalLogFile === undefined) {
    delete process.env.OPENCLAW_LOG_FILE;
  } else {
    process.env.OPENCLAW_LOG_FILE = originalLogFile;
  }
  if (originalFailureActionFile === undefined) {
    delete process.env.OPENCLAW_FAILURE_ACTION_FILE;
  } else {
    process.env.OPENCLAW_FAILURE_ACTION_FILE = originalFailureActionFile;
  }

  await rm(tempDir, { recursive: true, force: true });
});

async function setRuntimeState(state: "running" | "stopped" | "not running"): Promise<void> {
  await writeFile(runtimeFile, `${state}\n`);
}

async function clearLogFile(): Promise<void> {
  await writeFile(logFile, "");
  await writeFile(failureActionFile, "");
}

async function waitForLogEntry(expected: string): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const content = await readFile(logFile, "utf8").catch(() => "");
    if (content.includes(expected)) {
      return content;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${expected} in ${logFile}`);
}

test("remote restart starts the gateway when runtime is stopped", async () => {
  await clearLogFile();
  await setRuntimeState("stopped");

  const result = handleLocalCommand("clawpilot.gateway.remoteRestart");
  assert.ok(result);
  assert.equal(result?.ok, true);
  assert.deepEqual(result?.payload, { output: "Gateway start requested." });

  const logContent = await waitForLogEntry("gateway start");
  assert.match(logContent, /gateway status --no-probe/);
  assert.match(logContent, /gateway start/);
});

test("remote restart restarts the gateway when runtime is running", async () => {
  await clearLogFile();
  await setRuntimeState("running");

  const result = handleLocalCommand("clawpilot.gateway.remoteRestart");
  assert.ok(result);
  assert.equal(result?.ok, true);
  assert.deepEqual(result?.payload, { output: "Gateway restart requested." });

  const logContent = await waitForLogEntry("gateway restart");
  assert.match(logContent, /gateway status --no-probe/);
  assert.match(logContent, /gateway restart/);
});

test("online restart streams a dedicated maintenance lifecycle with a completed exit code", async () => {
  await clearLogFile();
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];

  const result = await handleLocalCommand("clawpilot.gateway.restart", undefined, {
    gatewayId: "gateway-openclaw",
    requestId: "request-online-restart",
    publishEvent: (event) => events.push(event as { event: string; payload: Record<string, unknown> }),
  });

  assert.equal(result?.ok, true);
  assert.equal(events.every((event) => event.event === "maintenance_log"), true);
  assert.equal(events[0]?.payload.stream, "status");
  assert.equal(events[0]?.payload.text, "Running: openclaw gateway restart");
  const finalPayload = events.at(-1)?.payload;
  assert.equal(finalPayload?.requestId, "request-online-restart");
  assert.equal(finalPayload?.runId, "request-online-restart");
  assert.equal(finalPayload?.stream, "status");
  assert.equal(finalPayload?.action, "restart");
  assert.equal(finalPayload?.status, "completed");
  assert.equal(finalPayload?.exitCode, 0);
  assert.equal(finalPayload?.text, "openclaw gateway restart exited with code 0");
});

test("remote restart streams start when the OpenClaw gateway service is stopped", async () => {
  await clearLogFile();
  await setRuntimeState("stopped");
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];

  const result = await handleLocalCommand("clawpilot.gateway.remoteRestart", undefined, {
    gatewayId: "gateway-openclaw",
    requestId: "request-remote-restart",
    publishEvent: (event) => events.push(event as { event: string; payload: Record<string, unknown> }),
  });

  assert.equal(result?.ok, true);
  assert.equal(events.every((event) => event.event === "maintenance_log"), true);
  assert.equal(events[0]?.payload.text, "Running: openclaw gateway start");
  const finalPayload = events.at(-1)?.payload;
  assert.equal(finalPayload?.requestId, "request-remote-restart");
  assert.equal(finalPayload?.stream, "status");
  assert.equal(finalPayload?.action, "start");
  assert.equal(finalPayload?.status, "completed");
  assert.equal(finalPayload?.exitCode, 0);
  assert.equal(finalPayload?.text, "openclaw gateway start exited with code 0");
});

test("gateway restart streams a failed terminal state for a non-zero exit code", async () => {
  await clearLogFile();
  await writeFile(failureActionFile, "restart\n");
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];

  const result = await handleLocalCommand("clawpilot.gateway.restart", undefined, {
    gatewayId: "gateway-openclaw",
    requestId: "request-failed-restart",
    publishEvent: (event) => events.push(event as { event: string; payload: Record<string, unknown> }),
  });

  assert.equal(result?.ok, false);
  assert.match(result?.error ?? "", /exited with code 7/);
  const finalPayload = events.at(-1)?.payload;
  assert.equal(finalPayload?.stream, "status");
  assert.equal(finalPayload?.action, "restart");
  assert.equal(finalPayload?.status, "failed");
  assert.equal(finalPayload?.exitCode, 7);
  assert.equal(finalPayload?.text, "openclaw gateway restart exited with code 7");
});
