
import { execFileSync } from "child_process";
import { readFile } from "fs/promises";
import type { LocalResult } from "../../commands/local-runtime.js";
import {
  DEFAULT_TIMEOUT_MS,
  HERMES_CRON_JOBS_FILE,
  errorMessageWithOutput,
  runHermes,
} from "./hermes-runtime-process.js";
import { numberParam, stringParam, toRecord } from "./hermes-runtime-values.js";

export async function runHermesCronList(params: unknown): Promise<LocalResult> {
  try {
    const includeDisabled = toRecord(params).includeDisabled !== false;
    const jobs = await readHermesCronJobs(includeDisabled);
    return { ok: true, payload: { jobs, items: jobs, hasMore: false, nextOffset: null } };
  } catch (error) {
    return { ok: false, error: errorMessageWithOutput(error) };
  }
}

export function runHermesCronCreate(params: unknown): LocalResult {
  const record = toRecord(params);
  const schedule = hermesScheduleFromParams(record);
  const prompt = promptFromCronParams(record);
  if (!schedule || !prompt) {
    return { ok: false, error: "schedule_and_prompt_required" };
  }
  const args = ["cron", "create", schedule, prompt];
  const name = stringParam(record, "name", "title");
  if (name) args.push("--name", name);
  const output = runHermes(args, DEFAULT_TIMEOUT_MS);
  const createdId = output.match(/Created job:\s*([A-Za-z0-9_-]+)/)?.[1];
  return { ok: true, payload: findHermesCronJobPayload(createdId) ?? { output } };
}

export function runHermesCronUpdate(params: unknown): LocalResult {
  const record = toRecord(params);
  const id = stringParam(record, "id", "jobId");
  const patch = toRecord(record.patch ?? record);
  if (!id) {
    return { ok: false, error: "job_id_required" };
  }
  const patchKeys = Object.keys(patch).filter((key) => key !== "id" && key !== "jobId");
  if (patchKeys.length === 1 && typeof patch.enabled === "boolean") {
    runHermes(["cron", patch.enabled ? "resume" : "pause", id]);
    return { ok: true, payload: findHermesCronJobPayload(id) ?? { id, enabled: patch.enabled } };
  }
  const args = ["cron", "edit", id];
  const schedule = hermesScheduleFromParams(patch);
  const prompt = promptFromCronParams(patch);
  const name = stringParam(patch, "name", "title");
  if (schedule) args.push("--schedule", schedule);
  if (prompt) args.push("--prompt", prompt);
  if (name) args.push("--name", name);
  if (typeof patch.enabled === "boolean") {
    runHermes(["cron", patch.enabled ? "resume" : "pause", id]);
  }
  if (args.length > 3) {
    runHermes(args);
  }
  return { ok: true, payload: findHermesCronJobPayload(id) ?? { id } };
}

export function runHermesCronRemove(params: unknown): LocalResult {
  const id = stringParam(toRecord(params), "id", "jobId");
  if (!id) {
    return { ok: false, error: "job_id_required" };
  }
  const output = runHermes(["cron", "remove", id]);
  return { ok: true, payload: { removed: !/not found/i.test(output), output } };
}

export function runHermesCronRun(params: unknown): LocalResult {
  const id = stringParam(toRecord(params), "id", "jobId");
  if (!id) {
    return { ok: false, error: "job_id_required" };
  }
  const output = runHermes(["cron", "run", id]);
  return { ok: true, payload: findHermesCronJobPayload(id) ?? { id, output } };
}

async function readHermesCronJobs(includeDisabled = true): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(HERMES_CRON_JOBS_FILE, "utf8");
    const parsed = JSON.parse(raw) as { jobs?: unknown } | unknown[];
    const jobs = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray(parsed.jobs)
        ? parsed.jobs
        : [];
    return jobs
      .filter((job): job is Record<string, unknown> => Boolean(job) && typeof job === "object" && !Array.isArray(job))
      .filter((job) => includeDisabled || job.enabled !== false)
      .map(normalizeHermesCronJob);
  } catch {
    return [];
  }
}

function findHermesCronJobPayload(id?: string): Record<string, unknown> | undefined {
  if (!id) return undefined;
  try {
    const raw = execFileSync(process.execPath, ["-e", `
      const fs = require("fs");
      const file = ${JSON.stringify(HERMES_CRON_JOBS_FILE)};
      const parsed = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { jobs: [] };
      const jobs = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.jobs) ? parsed.jobs : []);
      process.stdout.write(JSON.stringify(jobs.find((job) => job && job.id === ${JSON.stringify(id)}) || null));
    `], { stdio: "pipe", timeout: 3000 }).toString();
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? normalizeHermesCronJob(parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeHermesCronJob(job: Record<string, unknown>): Record<string, unknown> {
  const schedule = toRecord(job.schedule);
  const normalizedSchedule: Record<string, unknown> = {};
  if (schedule.kind === "once") {
    normalizedSchedule.kind = "at";
    const atMs = dateMs(schedule.run_at);
    if (atMs !== undefined) normalizedSchedule.atMs = atMs;
  } else if (schedule.kind === "interval") {
    normalizedSchedule.kind = "every";
    const minutes = numberParam(schedule, "minutes") ?? 0;
    normalizedSchedule.everyMs = Math.max(1, minutes) * 60_000;
    const anchorMs = dateMs(job.created_at);
    if (anchorMs !== undefined) normalizedSchedule.anchorMs = anchorMs;
  } else if (schedule.kind === "cron") {
    normalizedSchedule.kind = "cron";
    normalizedSchedule.expr = schedule.expr;
  }
  return {
    id: job.id,
    name: job.name,
    enabled: job.enabled !== false,
    state: {
      nextRunAtMs: dateMs(job.next_run_at),
      lastRunStatus: job.last_status,
      lastError: job.last_error,
      lastDeliveryError: job.last_delivery_error,
    },
    createdAtMs: dateMs(job.created_at),
    updatedAtMs: dateMs(job.updated_at) ?? dateMs(job.created_at),
    schedule: normalizedSchedule,
    payload: { message: typeof job.prompt === "string" ? job.prompt : "" },
    raw: job,
  };
}

function dateMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hermesScheduleFromParams(record: Record<string, unknown>): string | undefined {
  const explicit = stringParam(record, "schedule");
  if (explicit) return explicit;
  const schedule = toRecord(record.schedule);
  const kind = stringParam(schedule, "kind");
  if (kind === "at") {
    const at = stringParam(schedule, "at") ?? isoFromMs(schedule.atMs);
    return at;
  }
  if (kind === "every") {
    const everyMs = numberParam(schedule, "everyMs");
    return everyMs ? `every ${Math.max(1, Math.round(everyMs / 60_000))}m` : undefined;
  }
  if (kind === "cron") {
    return stringParam(schedule, "expr", "value");
  }
  return undefined;
}

function promptFromCronParams(record: Record<string, unknown>): string | undefined {
  const payload = toRecord(record.payload);
  return stringParam(record, "prompt", "message") ?? stringParam(payload, "message", "text");
}

function isoFromMs(value: unknown): string | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
