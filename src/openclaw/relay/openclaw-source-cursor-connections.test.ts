import assert from "node:assert/strict";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  closeOpenClawSourceCursorConnections,
  openClawSourceCursorStatements,
} from "./openclaw-source-cursor-connections.js";
import { isSourceCommitSignal } from "./openclaw-source-commit-watcher.js";

function createSourceDatabase(path: string, sessionId: string, seqs: number[]): void {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT)");
  database.exec("CREATE TABLE transcript_events (session_id TEXT, seq INTEGER)");
  database.prepare("INSERT INTO session_nodes VALUES (?, ?)").run("agent:main:main", sessionId);
  for (const seq of seqs) database.prepare("INSERT INTO transcript_events VALUES (?, ?)").run(sessionId, seq);
  database.close();
}

function maxSeq(path: string, sessionId: string): unknown {
  const statements = openClawSourceCursorStatements(path);
  return (statements?.committedThroughSeq.get(sessionId) as { committed_through_seq?: unknown } | undefined)
    ?.committed_through_seq;
}

test("the cursor connection is reused and still sees commits written after it was opened", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlink-cursor-conn-"));
  const path = join(root, "openclaw-agent.sqlite");
  try {
    createSourceDatabase(path, "s1", [1, 2]);
    const first = openClawSourceCursorStatements(path);
    assert.equal(maxSeq(path, "s1"), 2);
    assert.equal(openClawSourceCursorStatements(path), first);

    const writer = new DatabaseSync(path);
    writer.prepare("INSERT INTO transcript_events VALUES (?, ?)").run("s1", 3);
    writer.close();

    assert.equal(maxSeq(path, "s1"), 3);
    assert.equal(openClawSourceCursorStatements(path), first);
  } finally {
    closeOpenClawSourceCursorConnections();
    await rm(root, { recursive: true, force: true });
  }
});

test("an atomically replaced database is reopened instead of serving the old file's watermark", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlink-cursor-replace-"));
  const path = join(root, "openclaw-agent.sqlite");
  const replacement = join(root, "replacement.sqlite");
  try {
    createSourceDatabase(path, "s1", [1, 2, 3]);
    const first = openClawSourceCursorStatements(path);
    assert.equal(maxSeq(path, "s1"), 3);

    createSourceDatabase(replacement, "s1", [1, 2, 3, 4, 5]);
    await rename(replacement, path);

    assert.notEqual(openClawSourceCursorStatements(path), first);
    assert.equal(maxSeq(path, "s1"), 5);
  } finally {
    closeOpenClawSourceCursorConnections();
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing database yields no statements", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawlink-cursor-missing-"));
  try {
    assert.equal(openClawSourceCursorStatements(join(root, "absent.sqlite")), undefined);
  } finally {
    closeOpenClawSourceCursorConnections();
    await rm(root, { recursive: true, force: true });
  }
});

test("only main database and journal files signal new commits; reader-touched -shm does not", () => {
  const name = "openclaw-agent.sqlite";
  assert.equal(isSourceCommitSignal(name, name), true);
  assert.equal(isSourceCommitSignal(`${name}-wal`, name), true);
  assert.equal(isSourceCommitSignal(`${name}-journal`, name), true);
  assert.equal(isSourceCommitSignal(`${name}-shm`, name), false);
  assert.equal(isSourceCommitSignal(`${name}.reindex-lock.sqlite`, name), false);
  assert.equal(isSourceCommitSignal("other.sqlite", name), false);
  assert.equal(isSourceCommitSignal(null, name), true);
});
