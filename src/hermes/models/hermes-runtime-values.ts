
import { randomUUID } from "crypto";
import { basename } from "path";
import type { HermesUsageSnapshot } from "./hermes-runtime-types.js";
import { stripAnsi } from "./hermes-runtime-process.js";

export function sanitizeFileName(fileName: string): string {
  const base = basename(fileName).replace(/[^\w.\- ()[\]]/g, "_").slice(0, 160);
  return base || `attachment-${randomUUID()}`;
}

export function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function stringParam(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function numberParam(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function booleanValue(value: unknown): boolean {
  return value === true;
}

export function compactStringArray(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

export function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

export function firstNonNegativeInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = nonNegativeInteger(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

export function firstPositiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = nonNegativeInteger(value);
    if (parsed !== undefined && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

export function mergeHermesUsageSnapshots(...snapshots: HermesUsageSnapshot[]): HermesUsageSnapshot {
  const merged: HermesUsageSnapshot = {};
  for (const snapshot of snapshots) {
    if (snapshot.currentModel !== undefined) merged.currentModel = snapshot.currentModel;
    if (snapshot.provider !== undefined) merged.provider = snapshot.provider;
    if (snapshot.contextUsage !== undefined) merged.contextUsage = snapshot.contextUsage;
    if (snapshot.contextLimit !== undefined) merged.contextLimit = snapshot.contextLimit;
    if (snapshot.hermesSessionId !== undefined) merged.hermesSessionId = snapshot.hermesSessionId;
  }
  return merged;
}

export function parseJsonObject(output: string): Record<string, unknown> | undefined {
  const clean = stripAnsi(output).trim();
  const candidates = [clean];
  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(clean.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

export function parseMaybeJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim().startsWith("{")) {
    return parseJsonObject(value);
  }
  return undefined;
}
