import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
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

test("logs command returns all log lines from the newest file by default", () => {
  const result = handleLocalCommand("clawpilot.logs");
  assert.ok(result);
  assert.equal(result?.ok, true);

  const payload = result?.payload as any;
  assert.equal(payload.logPath, latestLogPath);
  assert.equal(payload.totalLines, 120);
  assert.equal(payload.returnedLines, 120);
  assert.equal(payload.truncated, false);
});

test("logs command respects limit parameter", () => {
  const result = handleLocalCommand("clawpilot.logs", { limit: 10 });
  assert.ok(result);
  assert.equal(result?.ok, true);

  const payload = result?.payload as any;
  assert.equal(payload.returnedLines, 10);
  assert.equal(payload.truncated, true);
  assert.equal(payload.lines.length, 10);
  assert.equal(payload.lines[payload.lines.length - 1], "new-120");
});

test("logs command strips ANSI codes", async () => {
  const ansiLogPath = join(logsDir, "ansi.log");
  await writeFile(ansiLogPath, "\u001b[32mSUCCESS\u001b[39m\n");
  
  // Update mtime to make it newest (2 seconds ahead of current to bypass the "prefer main log" logic)
  const now = Date.now();
  await utimes(ansiLogPath, new Date(now + 2000), new Date(now + 2000));

  const result = handleLocalCommand("clawpilot.logs");
  const payload = result?.payload as any;
  
  assert.equal(payload.lines[0], "SUCCESS");
});
