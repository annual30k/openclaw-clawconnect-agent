import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HermesToolLogEvent } from "./hermes-runtime-types.js";
import { createHermesToolLogWatcher } from "./hermes-runtime-tool-log-watcher.js";

test("Hermes tool events remain available from agent.log when CLI stdout is quiet", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-tool-log-watcher-"));
  const logFile = join(root, "agent.log");
  const events: HermesToolLogEvent[] = [];
  writeFileSync(logFile, "existing log line\n", "utf8");
  const watcher = createHermesToolLogWatcher((event) => events.push(event), {
    logFile,
    pollIntervalMs: 5,
  });

  try {
    watcher.start();
    appendFileSync(logFile, [
      "2026-07-23 00:10:00,000 INFO [session] agent.tool_executor: tool web_search running",
      "2026-07-23 00:10:01,000 INFO [session] agent.tool_executor: tool web_search completed (1.00s, 42 chars)",
      "",
    ].join("\n"), "utf8");

    await waitFor(() => events.length === 2);
    assert.deepEqual(events, [
      {
        toolName: "web_search",
        phase: "streaming",
        text: "web_search running",
        isError: false,
      },
      {
        toolName: "web_search",
        phase: "completed",
        text: "web_search completed (1.00s, 42 chars)",
        isError: false,
      },
    ]);
  } finally {
    watcher.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for Hermes tool log events");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
