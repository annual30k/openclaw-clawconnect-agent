import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempHome = await mkdtemp(join(tmpdir(), "clawconnect-logs-"));
const openclawDir = join(tempHome, ".openclaw");
const logsDir = join(openclawDir, "logs");
const latestLogPath = join(logsDir, "clawconnect.log");
const olderLogPath = join(logsDir, "clawconnect-error.log");

const originalHome = process.env.HOME;
process.env.HOME = tempHome;

await mkdir(logsDir, { recursive: true });

const olderLogLines = Array.from({ length: 20 }, (_, index) => `old-${index + 1}`);
const latestLogLines = Array.from({ length: 120 }, (_, index) => `new-${index + 1}`);

await writeFile(olderLogPath, `${olderLogLines.join("\n")}\n`);
await new Promise((resolve) => setTimeout(resolve, 25));
await writeFile(latestLogPath, `${latestLogLines.join("\n")}\n`);

const { handleLocalCommand } = await import(`./local-handlers.js?logs-test=${encodeURIComponent(tempHome)}`);

test.after(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  await rm(tempHome, { recursive: true, force: true });
});

test("logs command returns all log lines from the newest file", () => {
  const result = handleLocalCommand("clawpilot.logs", { limit: 100 });
  assert.ok(result);
  assert.equal(result?.ok, true);

  const payload = result?.payload as {
    logPath?: string;
    lines?: string[];
    totalLines?: number;
    returnedLines?: number;
    truncated?: boolean;
    output?: string;
  };

  assert.equal(payload.logPath, latestLogPath);
  assert.equal(payload.totalLines, 120);
  assert.equal(payload.returnedLines, 120);
  assert.equal(payload.truncated, false);
  assert.deepEqual(payload.lines?.slice(0, 3), ["new-1", "new-2", "new-3"]);
  assert.deepEqual(payload.lines?.slice(-3), ["new-118", "new-119", "new-120"]);
  assert.match(payload.output ?? "", /^\[/);
});
