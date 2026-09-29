import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backupConfigBeforeRegistration, pruneRegistrationBackups } from "./config-backups.js";

test("registration backup copies the config and keeps only the newest backups", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawconnect-backups-"));
  try {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, "{\"gatewayId\":\"gw_current\"}");
    for (const stamp of ["20260101-000000", "20260102-000000", "20260103-000000"]) {
      writeFileSync(join(dir, `config.json.server-switch-${stamp}.bak`), stamp);
    }
    writeFileSync(join(dir, "config.json.bak-1778460627385"), "manual");
    writeFileSync(join(dir, "config.json.migrated-20260519103405"), "migrated");

    const backupPath = backupConfigBeforeRegistration(configPath, new Date(2026, 8, 29, 13, 5, 9), 2);

    assert.equal(backupPath, join(dir, "config.json.server-switch-20260929-130509.bak"));
    assert.equal(readFileSync(backupPath, "utf8"), "{\"gatewayId\":\"gw_current\"}");
    assert.deepEqual(readdirSync(dir).sort(), [
      "config.json",
      "config.json.bak-1778460627385",
      "config.json.migrated-20260519103405",
      "config.json.server-switch-20260103-000000.bak",
      "config.json.server-switch-20260929-130509.bak",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registration backup is skipped when there is no config to preserve", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawconnect-backups-empty-"));
  try {
    assert.equal(backupConfigBeforeRegistration(join(dir, "config.json")), undefined);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruning orders backups by embedded timestamp, not by creation order", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawconnect-backups-order-"));
  try {
    for (const stamp of ["20260903-000818", "20260602-004000", "20260929-111839", "20260729-103151"]) {
      writeFileSync(join(dir, `config.json.server-switch-${stamp}.bak`), stamp);
    }

    const removed = pruneRegistrationBackups(dir, 2);

    assert.deepEqual(removed, [
      "config.json.server-switch-20260602-004000.bak",
      "config.json.server-switch-20260729-103151.bak",
    ]);
    assert.deepEqual(readdirSync(dir).sort(), [
      "config.json.server-switch-20260903-000818.bak",
      "config.json.server-switch-20260929-111839.bak",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
