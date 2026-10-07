import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  buildHermesCronChangedEvent,
  clearHermesCronChangeRelayStateForTests,
  startHermesCronChangeRelay,
  type HermesCronChangedEvent,
} from "./hermes-cron-change-relay.js";

afterEach(() => clearHermesCronChangeRelayStateForTests());

async function writeJobsAtomically(jobsFile: string, content: string): Promise<void> {
  const temporaryFile = `${jobsFile}.writing`;
  await writeFile(temporaryFile, content);
  await rename(temporaryFile, jobsFile);
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for cron relay condition");
}

test("Hermes cron changed frame matches the OpenClaw cron event frame shape", () => {
  assert.deepEqual(buildHermesCronChangedEvent(), {
    type: "event",
    event: "cron",
    payload: { action: "changed", source: "hermes" },
  });
});

test("Hermes cron change relay sends one cron frame per change and replays a change made while disconnected", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-hermes-cron-relay-"));
  const jobsFile = join(root, "cron", "jobs.json");
  await mkdir(join(root, "cron"), { recursive: true });
  await writeFile(jobsFile, JSON.stringify({ jobs: [] }));
  const sent: HermesCronChangedEvent[] = [];
  try {
    const firstConnection = startHermesCronChangeRelay({ gatewayId: "gw-hermes", jobsFile, send: (frame) => sent.push(frame) });
    assert.equal(sent.length, 0);
    await writeJobsAtomically(jobsFile, JSON.stringify({ jobs: [{ id: "job-1" }] }));
    await waitForCondition(() => sent.length === 1);
    firstConnection.stop();

    // 同一内容重连不补发；断线期间发生变化则重连时补发恰好一次。
    startHermesCronChangeRelay({ gatewayId: "gw-hermes", jobsFile, send: (frame) => sent.push(frame) }).stop();
    assert.equal(sent.length, 1);
    await writeJobsAtomically(jobsFile, JSON.stringify({ jobs: [{ id: "job-1" }, { id: "job-2" }] }));
    startHermesCronChangeRelay({ gatewayId: "gw-hermes", jobsFile, send: (frame) => sent.push(frame) }).stop();
    assert.equal(sent.length, 2);
    assert.deepEqual(sent, [buildHermesCronChangedEvent(), buildHermesCronChangedEvent()]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
