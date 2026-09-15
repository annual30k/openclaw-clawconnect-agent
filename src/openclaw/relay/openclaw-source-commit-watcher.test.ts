import assert from "node:assert/strict";
import { mkdtemp, rename, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSourceCommit } from "../../core/relay/source-commit.js";
import { watchOpenClawSourceCommit } from "./openclaw-source-commit-watcher.js";

test("OpenClaw source watcher rescans startup and survives database rename", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlink-source-watch-"));
  const databasePath = join(root, "openclaw-agent.sqlite");
  await writeFile(databasePath, "initial");
  let current = createSourceCommit({
    gatewayType: "openclaw", gatewayId: "gw", producerId: "main",
    sourceSessionId: "s", sourceOrderScope: "openclaw:main:s", sourceGeneration: "s",
    committedThroughSeq: 1, sourceRevision: "seq:1",
  });
  const seen: number[] = [];
  const watcher = watchOpenClawSourceCommit({
    databasePath,
    readCursor: () => current,
    onCommit: (commit) => { seen.push(commit.committedThroughSeq); },
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    current = { ...current, committedThroughSeq: 2, sourceRevision: "seq:2" };
    const replacement = join(root, "replacement.sqlite");
    await writeFile(replacement, "replacement");
    await rename(replacement, databasePath);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(seen.includes(1));
    assert.ok(seen.includes(2));
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

