import assert from "assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import test from "node:test";
import { tmpdir } from "os";
import { join } from "path";

const tempDir = await mkdtemp(join(tmpdir(), "clawconnect-remote-restart-"));
const runtimeFile = join(tempDir, "runtime-state.txt");
const logFile = join(tempDir, "openclaw.log");
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
exit 0
`,
);
await chmod(openclawBin, 0o755);

const originalOpenclawBin = process.env.OPENCLAW_BIN;
const originalRuntimeFile = process.env.OPENCLAW_RUNTIME_FILE;
const originalLogFile = process.env.OPENCLAW_LOG_FILE;
process.env.OPENCLAW_BIN = openclawBin;
process.env.OPENCLAW_RUNTIME_FILE = runtimeFile;
process.env.OPENCLAW_LOG_FILE = logFile;

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

  await rm(tempDir, { recursive: true, force: true });
});

async function setRuntimeState(state: "running" | "stopped" | "not running"): Promise<void> {
  await writeFile(runtimeFile, `${state}\n`);
}

async function clearLogFile(): Promise<void> {
  await writeFile(logFile, "");
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
