import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  invalidCredentialsRecoveryHint,
  pairCommandForProfile,
  relayCredentialsRejectedHint,
  resetCommandForProfile,
  restartCommandForProfile,
} from "./profile-hints.js";

test("profile hints point shortcut users at the isolated profile config", () => {
  assert.equal(resetCommandForProfile("hermes"), "clawconnect reset-hermes");
  assert.equal(resetCommandForProfile("hermes-local"), "clawconnect reset-hermes --local");
  assert.equal(resetCommandForProfile("openclaw"), "clawconnect reset-openclaw");
  assert.equal(resetCommandForProfile("openclaw-local"), "clawconnect reset-openclaw --local");
  assert.equal(pairCommandForProfile("hermes"), "clawconnect pair-hermes");
  assert.equal(pairCommandForProfile("hermes-local"), "clawconnect pair-hermes --local");
  assert.equal(pairCommandForProfile("openclaw-local"), "clawconnect pair-openclaw --local");
  assert.equal(restartCommandForProfile("openclaw"), "clawconnect restart-openclaw");
  assert.equal(restartCommandForProfile("openclaw-local"), "clawconnect restart-openclaw --local");
  assert.equal(restartCommandForProfile("hermes"), "clawconnect restart-hermes");
  assert.equal(restartCommandForProfile("hermes-local"), "clawconnect restart-hermes --local");
  assert.equal(
    invalidCredentialsRecoveryHint("hermes"),
    "Run `clawconnect reset-hermes` to clear this profile config, then run `clawconnect pair-hermes` to re-register."
  );
});

test("profile hints preserve generic commands for the default profile", () => {
  assert.equal(resetCommandForProfile(undefined), "clawconnect reset");
  assert.equal(pairCommandForProfile(undefined), "clawconnect pair");
  assert.equal(restartCommandForProfile(undefined), "clawconnect restart");
});

test("reset help documents profile-specific shortcut recovery", () => {
  const repoRoot = resolve(import.meta.dirname, "../..");
  const home = mkdtempSync(join(tmpdir(), "clawconnect-help-home-"));
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "reset", "--help"],
    {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, LANG: "en_US.UTF-8" },
      encoding: "utf8",
    }
  );

  assert.match(output, /pair-hermes uses profile 'hermes'/);
  assert.match(output, /clawconnect reset-hermes/);
  assert.match(output, /clawconnect reset-openclaw/);
  assert.match(output, /clawconnect reset-all/);
  assert.match(output, /clawconnect reset --profile <name>/);
});

test("pair-hermes help documents the matching reset profile and force flag", () => {
  const repoRoot = resolve(import.meta.dirname, "../..");
  const home = mkdtempSync(join(tmpdir(), "clawconnect-help-home-"));
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "pair-hermes", "--help"],
    {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, LANG: "en_US.UTF-8" },
      encoding: "utf8",
    }
  );

  assert.match(output, /'hermes'/);
  assert.match(output, /'hermes-local'/);
  assert.match(output, /clawconnect reset-hermes/);
  assert.match(output, /clawconnect reset-hermes --local/);
  assert.match(output, /-f, --force/);
});

test("top-level help includes the full command quick reference", () => {
  const repoRoot = resolve(import.meta.dirname, "../..");
  const home = mkdtempSync(join(tmpdir(), "clawconnect-help-home-"));
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "--help"],
    {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, LANG: "en_US.UTF-8" },
      encoding: "utf8",
    }
  );

  assert.match(output, /Command quick reference:/);
  assert.match(output, /pair-hermes\s+Pair Hermes Agent using profile 'hermes'/);
  assert.match(output, /run\s+Run one profile in the foreground/);
  assert.match(output, /reset-hermes\s+Uninstall Hermes Agent service and clear profile 'hermes'/);
  assert.match(output, /reset-all\s+Uninstall services and clear all paired profiles/);
  assert.match(output, /uninstall-openclaw\s+Remove OpenClaw background service/);
  assert.match(output, /uninstall-hermes\s+Remove Hermes background service/);
  assert.match(output, /send-file\s+Upload a local file/);
  assert.match(output, /help\s+Show detailed help for a command/);
});

test("relay credential rejection hint names 4401 and the profile-specific recovery commands", () => {
  const hint = relayCredentialsRejectedHint("openclaw");
  assert.match(hint, /\(4401\)/);
  assert.match(hint, /`clawconnect reset-openclaw`/);
  assert.match(hint, /`clawconnect pair-openclaw`/);
  assert.match(relayCredentialsRejectedHint(undefined), /`clawconnect reset`.*`clawconnect pair`/);
});
