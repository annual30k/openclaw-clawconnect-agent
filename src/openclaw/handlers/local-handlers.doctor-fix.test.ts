import assert from "assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import test from "node:test";
import { tmpdir } from "os";
import { join } from "path";

const tempDir = await mkdtemp(join(tmpdir(), "clawconnect-doctor-fix-"));
const logFile = join(tempDir, "openclaw.log");
const controlFile = join(tempDir, "openclaw.control");
const openclawBin = join(tempDir, "openclaw");

await writeFile(
  openclawBin,
  `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$OPENCLAW_LOG_FILE"
if [ "\${1:-}" = "doctor" ]; then
  mode="$(cat "$OPENCLAW_CONTROL_FILE")"
  if [ "$mode" = "signal" ]; then
    kill -TERM "$$"
  fi
  if [ "$mode" = "failure" ]; then
    exit 7
  fi
fi
printf 'fixed\\n'
exit 0
`,
);
await chmod(openclawBin, 0o755);
await writeFile(controlFile, "success");

const originalOpenclawBin = process.env.OPENCLAW_BIN;
const originalLogFile = process.env.OPENCLAW_LOG_FILE;
const originalControlFile = process.env.OPENCLAW_CONTROL_FILE;
process.env.OPENCLAW_BIN = openclawBin;
process.env.OPENCLAW_LOG_FILE = logFile;
process.env.OPENCLAW_CONTROL_FILE = controlFile;

const { handleLocalCommand } = await import(`./local-handlers.js?doctor-fix-test=${encodeURIComponent(tempDir)}`);

test.after(async () => {
  if (originalOpenclawBin === undefined) {
    delete process.env.OPENCLAW_BIN;
  } else {
    process.env.OPENCLAW_BIN = originalOpenclawBin;
  }
  if (originalLogFile === undefined) {
    delete process.env.OPENCLAW_LOG_FILE;
  } else {
    process.env.OPENCLAW_LOG_FILE = originalLogFile;
  }
  if (originalControlFile === undefined) {
    delete process.env.OPENCLAW_CONTROL_FILE;
  } else {
    process.env.OPENCLAW_CONTROL_FILE = originalControlFile;
  }

  await rm(tempDir, { recursive: true, force: true });
});

test("doctor fix command runs the configured OpenClaw binary as a child process", async () => {
  const events: Array<{
    event: string;
    payload: {
      gatewayId?: string;
      requestId?: string;
      runId?: string;
      stream?: string;
      seq?: number;
      text?: string;
      status?: "completed" | "failed";
      exitCode?: number | null;
    };
  }> = [];
  const result = await handleLocalCommand("clawpilot.doctor.fix", undefined, {
    requestId: "req-1",
    gatewayId: "gw-1",
    publishEvent: ({ event, payload }) => {
      events.push({ event, payload });
    },
  });
  assert.ok(result);
  assert.equal(result?.ok, true);

  const payload = result?.payload as { output?: string };
  assert.equal(payload.output, "fixed");

  const logLines = (await readFile(logFile, "utf8")).trim().split("\n");
  assert.equal(logLines.length, 2);
  assert.equal(logLines[0], "--version");
  assert.equal(logLines[1], "doctor --fix --non-interactive --yes");

  assert.deepEqual(
    events.map(({ event, payload }) => ({
      event,
      gatewayId: payload.gatewayId,
      requestId: payload.requestId,
      runId: payload.runId,
      stream: payload.stream,
      seq: payload.seq,
      text: payload.text,
      status: payload.status,
      exitCode: payload.exitCode,
    })),
    [
      {
        event: "doctor_fix_log",
        gatewayId: "gw-1",
        requestId: "req-1",
        runId: "req-1",
        stream: "stdout",
        seq: 1,
        text: "fixed",
        status: undefined,
        exitCode: undefined,
      },
      {
        event: "doctor_fix_log",
        gatewayId: "gw-1",
        requestId: "req-1",
        runId: "req-1",
        stream: "status",
        seq: 2,
        text: "openclaw doctor --fix exited with code 0",
        status: "completed",
        exitCode: 0,
      },
    ],
  );
});

test("doctor fix reports a failed terminal event when the child is terminated by a signal", async () => {
  await writeFile(controlFile, "signal");
  const events: Array<{
    event: string;
    payload: {
      stream?: string;
      status?: "completed" | "failed";
      exitCode?: number | null;
      text?: string;
    };
  }> = [];

  const result = await handleLocalCommand("clawpilot.doctor.fix", undefined, {
    requestId: "req-signal",
    gatewayId: "gw-1",
    publishEvent: ({ event, payload }) => {
      events.push({ event, payload });
    },
  });

  assert.ok(result);
  assert.equal(result?.ok, false);
  assert.match(result?.error ?? "", /exited with signal SIGTERM/);
  const finalEvent = events.at(-1);
  assert.equal(finalEvent?.event, "doctor_fix_log");
  assert.equal(finalEvent?.payload.stream, "status");
  assert.equal(finalEvent?.payload.status, "failed");
  assert.equal(finalEvent?.payload.exitCode, null);
  assert.equal(finalEvent?.payload.text, "openclaw doctor --fix exited with signal SIGTERM");
});

test("doctor fix reports a failed terminal event when the child cannot be started", async () => {
  await chmod(openclawBin, 0o644);
  const events: Array<{
    event: string;
    payload: {
      stream?: string;
      status?: "completed" | "failed";
      exitCode?: number | null;
      text?: string;
    };
  }> = [];

  const result = await handleLocalCommand("clawpilot.doctor.fix", undefined, {
    requestId: "req-spawn-error",
    gatewayId: "gw-1",
    publishEvent: ({ event, payload }) => {
      events.push({ event, payload });
    },
  });

  assert.ok(result);
  assert.equal(result?.ok, false);
  assert.match(result?.error ?? "", /EACCES/);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event, "doctor_fix_log");
  assert.equal(events[0]?.payload.stream, "stderr");
  assert.equal(events[0]?.payload.status, "failed");
  assert.equal(events[0]?.payload.exitCode, null);
  assert.match(events[0]?.payload.text ?? "", /failed to start:.*EACCES/);
});
