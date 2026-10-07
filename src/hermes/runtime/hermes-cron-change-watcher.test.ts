import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HERMES_CRON_JOBS_MISSING_DIGEST, watchHermesCronJobs } from "./hermes-cron-change-watcher.js";

const JOBS_V1 = JSON.stringify({ jobs: [{ id: "job-1", enabled: true }], updated_at: "2026-10-07T00:00:00Z" });
const JOBS_V2 = JSON.stringify({ jobs: [{ id: "job-1", enabled: false }], updated_at: "2026-10-07T00:01:00Z" });

async function createHermesHome(): Promise<{ root: string; cronDirectory: string; jobsFile: string }> {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-hermes-cron-watch-"));
  const cronDirectory = join(root, "cron");
  return { root, cronDirectory, jobsFile: join(cronDirectory, "jobs.json") };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for cron watcher condition");
}

/** Hermes 以临时文件 + rename 原子替换 jobs.json；测试同样避免读到截断中的半份内容。 */
async function writeJobsAtomically(jobsFile: string, content: string): Promise<void> {
  const temporaryFile = `${jobsFile}.writing`;
  await writeFile(temporaryFile, content);
  await rename(temporaryFile, jobsFile);
}

/** 让已排队的 fs.watch 通知与 setImmediate 检查全部执行完，用于断言“没有额外事件”。 */
async function drainWatcherNotifications(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  await new Promise((resolve) => setImmediate(resolve));
}

test("Hermes cron watcher baseline read emits nothing", async () => {
  const home = await createHermesHome();
  await mkdir(home.cronDirectory, { recursive: true });
  await writeFile(home.jobsFile, JOBS_V1);
  let changes = 0;
  const watcher = watchHermesCronJobs({ jobsFile: home.jobsFile, onChange: () => { changes += 1; }, logWarning: () => {} });
  try {
    watcher.checkNow();
    await drainWatcherNotifications();
    assert.equal(changes, 0);
    assert.notEqual(watcher.currentDigest(), HERMES_CRON_JOBS_MISSING_DIGEST);
  } finally {
    watcher.close();
    await rm(home.root, { recursive: true, force: true });
  }
});

test("Hermes cron watcher emits exactly once per content change and ignores identical rewrites", async () => {
  const home = await createHermesHome();
  await mkdir(home.cronDirectory, { recursive: true });
  await writeFile(home.jobsFile, JOBS_V1);
  let changes = 0;
  const watcher = watchHermesCronJobs({ jobsFile: home.jobsFile, onChange: () => { changes += 1; }, logWarning: () => {} });
  try {
    await writeJobsAtomically(home.jobsFile, JOBS_V2);
    await waitForCondition(() => changes === 1);
    // 重复通知与显式重新检查都不能对同一内容再次发事件。
    watcher.checkNow();
    watcher.checkNow();
    await drainWatcherNotifications();
    assert.equal(changes, 1);

    await writeJobsAtomically(home.jobsFile, JOBS_V2);
    watcher.checkNow();
    await drainWatcherNotifications();
    assert.equal(changes, 1);
  } finally {
    watcher.close();
    await rm(home.root, { recursive: true, force: true });
  }
});

test("Hermes cron watcher detects atomic rename replacement of jobs.json", async () => {
  const home = await createHermesHome();
  await mkdir(home.cronDirectory, { recursive: true });
  await writeFile(home.jobsFile, JOBS_V1);
  let changes = 0;
  const watcher = watchHermesCronJobs({ jobsFile: home.jobsFile, onChange: () => { changes += 1; }, logWarning: () => {} });
  try {
    const temporaryFile = join(home.cronDirectory, ".jobs.json.tmp");
    await writeFile(temporaryFile, JOBS_V2);
    await rename(temporaryFile, home.jobsFile);
    await waitForCondition(() => changes === 1);

    // 原子替换后目录监听仍然有效：第二次替换同样只触发一次。
    await writeFile(temporaryFile, JOBS_V1);
    await rename(temporaryFile, home.jobsFile);
    await waitForCondition(() => changes === 2);
    await drainWatcherNotifications();
    assert.equal(changes, 2);
  } finally {
    watcher.close();
    await rm(home.root, { recursive: true, force: true });
  }
});

test("Hermes cron watcher emits once when cron directory and jobs file appear later", async () => {
  const home = await createHermesHome();
  let changes = 0;
  const watcher = watchHermesCronJobs({ jobsFile: home.jobsFile, onChange: () => { changes += 1; }, logWarning: () => {} });
  try {
    assert.equal(watcher.currentDigest(), HERMES_CRON_JOBS_MISSING_DIGEST);
    await mkdir(home.cronDirectory, { recursive: true });
    // 目录创建本身不改变“文件不存在”的内容状态，不得发事件。
    await drainWatcherNotifications();
    assert.equal(changes, 0);

    await writeJobsAtomically(home.jobsFile, JOBS_V1);
    await waitForCondition(() => changes === 1);
    await drainWatcherNotifications();
    assert.equal(changes, 1);
  } finally {
    watcher.close();
    await rm(home.root, { recursive: true, force: true });
  }
});

test("Hermes cron watcher compares the first read against a carried baseline digest", async () => {
  const home = await createHermesHome();
  await mkdir(home.cronDirectory, { recursive: true });
  await writeFile(home.jobsFile, JOBS_V1);
  let firstChanges = 0;
  const first = watchHermesCronJobs({ jobsFile: home.jobsFile, onChange: () => { firstChanges += 1; }, logWarning: () => {} });
  const carriedDigest = first.currentDigest();
  first.close();
  try {
    let unchangedChanges = 0;
    const unchanged = watchHermesCronJobs({
      jobsFile: home.jobsFile,
      baselineDigest: carriedDigest,
      onChange: () => { unchangedChanges += 1; },
      logWarning: () => {},
    });
    unchanged.close();
    assert.equal(unchangedChanges, 0);

    await writeFile(home.jobsFile, JOBS_V2);
    let changedChanges = 0;
    const changed = watchHermesCronJobs({
      jobsFile: home.jobsFile,
      baselineDigest: carriedDigest,
      onChange: () => { changedChanges += 1; },
      logWarning: () => {},
    });
    changed.close();
    assert.equal(changedChanges, 1);
    assert.equal(firstChanges, 0);
  } finally {
    await rm(home.root, { recursive: true, force: true });
  }
});

test("Hermes cron watcher stops emitting after close", async () => {
  const home = await createHermesHome();
  await mkdir(home.cronDirectory, { recursive: true });
  await writeFile(home.jobsFile, JOBS_V1);
  let changes = 0;
  const watcher = watchHermesCronJobs({ jobsFile: home.jobsFile, onChange: () => { changes += 1; }, logWarning: () => {} });
  try {
    watcher.close();
    await writeFile(home.jobsFile, JOBS_V2);
    watcher.checkNow();
    await drainWatcherNotifications();
    assert.equal(changes, 0);
  } finally {
    await rm(home.root, { recursive: true, force: true });
  }
});

test("Hermes cron watcher survives a throwing listener and a missing Hermes home", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-hermes-cron-watch-"));
  const warnings: string[] = [];
  const missingHomeWatcher = watchHermesCronJobs({
    jobsFile: join(root, "absent-home", "cron", "jobs.json"),
    onChange: () => { throw new Error("listener failed"); },
    logWarning: (message) => warnings.push(message),
  });
  missingHomeWatcher.close();
  assert.ok(warnings.some((message) => message.includes("cannot watch Hermes home")));

  const cronDirectory = join(root, "cron");
  const jobsFile = join(cronDirectory, "jobs.json");
  await mkdir(cronDirectory, { recursive: true });
  await writeFile(jobsFile, JOBS_V1);
  const watcher = watchHermesCronJobs({
    jobsFile,
    onChange: () => { throw new Error("listener failed"); },
    logWarning: (message) => warnings.push(message),
  });
  try {
    await writeFile(jobsFile, JOBS_V2);
    assert.doesNotThrow(() => watcher.checkNow());
    assert.ok(warnings.some((message) => message.includes("change listener failed")));
  } finally {
    watcher.close();
    await rm(root, { recursive: true, force: true });
  }
});
