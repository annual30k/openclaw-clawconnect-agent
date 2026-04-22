import assert from "assert/strict";
import { chmod, mkdtemp, readFile, rename, rm, unlink, writeFile } from "fs/promises";
import test from "node:test";
import { tmpdir } from "os";
import { dirname, join } from "path";

const tempDir = await mkdtemp(join(tmpdir(), "clawconnect-doctor-fix-"));
const logFile = join(tempDir, "openclaw.log");

const nodeBinDir = dirname(process.execPath);
const openclawBin = join(nodeBinDir, "openclaw");
const backupBin = join(nodeBinDir, `openclaw.bak-${process.pid}-${Date.now()}`);
let hadOriginal = false;

try {
  await rename(openclawBin, backupBin);
  hadOriginal = true;
} catch {
  hadOriginal = false;
}

await writeFile(
  openclawBin,
  `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$OPENCLAW_LOG_FILE"
printf 'fixed\\n'
exit 0
`,
);
await chmod(openclawBin, 0o755);

const originalLogFile = process.env.OPENCLAW_LOG_FILE;
process.env.OPENCLAW_LOG_FILE = logFile;

const { handleLocalCommand } = await import(`./local-handlers.js?doctor-fix-test=${encodeURIComponent(tempDir)}`);

test.after(async () => {
  if (originalLogFile === undefined) {
    delete process.env.OPENCLAW_LOG_FILE;
  } else {
    process.env.OPENCLAW_LOG_FILE = originalLogFile;
  }

  await rm(tempDir, { recursive: true, force: true });
  await unlink(openclawBin).catch(() => {});
  if (hadOriginal) {
    await rename(backupBin, openclawBin);
  }
});

test("doctor fix command runs openclaw doctor --fix", async () => {
  const events: Array<{ event: string; payload: unknown }> = [];
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

  const logContent = await readFile(logFile, "utf8");
  assert.match(logContent, /doctor --fix/);
  assert.ok(events.some((item) => item.event === "doctor_fix_log"));
});
