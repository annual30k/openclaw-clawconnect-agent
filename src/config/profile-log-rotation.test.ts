import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateLogFileIfOversized, rotateProfileLogsIfOversized } from "./profile-log-rotation.js";

test("oversized profile logs are copied to a single backup generation and truncated in place", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clawconnect-log-rotation-"));
  try {
    const logPath = join(dir, "clawconnect.log");
    const errorLogPath = join(dir, "clawconnect-error.log");
    await writeFile(logPath, "x".repeat(2_048));
    await writeFile(errorLogPath, "small");

    const results = rotateProfileLogsIfOversized(undefined, { maxBytes: 1_024, paths: [logPath, errorLogPath] });

    assert.deepEqual(results.map((result) => [result.rotated, result.bytesBefore]), [[true, 2_048], [false, 5]]);
    assert.equal((await stat(logPath)).size, 0);
    assert.equal((await readFile(`${logPath}.1`, "utf8")).length, 2_048);
    assert.equal(await readFile(errorLogPath, "utf8"), "small");

    // 第二代备份覆盖第一代：只保留一份。
    await writeFile(logPath, "y".repeat(1_500));
    rotateLogFileIfOversized(logPath, 1_024);
    assert.equal((await readFile(`${logPath}.1`, "utf8")).at(0), "y");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing log files are reported without rotation", () => {
  const result = rotateLogFileIfOversized("/nonexistent/clawconnect.log", 1);
  assert.deepEqual(result, { path: "/nonexistent/clawconnect.log", rotated: false, bytesBefore: 0 });
});
