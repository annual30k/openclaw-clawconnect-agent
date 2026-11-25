import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { isActiveMobileChatProcess, resetCommand } from "./install.js";
import { getActiveProfile, setActiveProfile } from "../config/profile.js";

const repoRoot = resolve(import.meta.dirname, "../..");

function runCliWithTempHome(home: string, args: string[]): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "src/index.ts", ...args],
    {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, LANG: "en_US.UTF-8" },
      encoding: "utf8",
    },
  );
}

function seedTempProfile(home: string, profile: string, gatewayType: "openclaw" | "hermes"): string {
  const dir = join(home, ".clawconnect", "profiles", profile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      relayServerUrl: "https://clawlinks.cn",
      gatewayId: `gw_${profile}`,
      relaySecret: "sec_test",
      displayName: `Host ${profile}`,
      gatewayType,
    }),
  );
  writeFileSync(join(dir, "config.json.server-switch-20261125-100000.bak"), "{}");
  writeFileSync(join(dir, "clawconnect.log"), "Relay connected.\n");
  writeFileSync(join(dir, "clawconnect-error.log"), "err\n");
  return dir;
}

test("service restart is blocked inside an active mobile chat process", () => {
  assert.equal(isActiveMobileChatProcess({}), false);
  assert.equal(isActiveMobileChatProcess({ CLAWCONNECT_CHAT_SESSION_KEY: "main" }), true);
  assert.equal(isActiveMobileChatProcess({ CLAWCONNECT_SOURCE_RUN_ID: "run-1" }), true);
  assert.equal(isActiveMobileChatProcess({ CLAWCONNECT_CHAT_SESSION_KEY: "  " }), false);
});

test("reset removes config, registration backups, logs, and empty profile dir while preserving .env", () => {
  const home = mkdtempSync(join(tmpdir(), "clawconnect-reset-single-"));
  const clawHome = join(home, ".clawconnect");
  mkdirSync(clawHome, { recursive: true });
  writeFileSync(join(clawHome, ".env"), "CLAWCONNECT_RELAY_SERVER_URL=https://clawlinks.cn\n");
  const profileDir = seedTempProfile(home, "alpha-gw", "hermes");

  const output = runCliWithTempHome(home, ["reset", "--profile", "alpha-gw"]);

  assert.match(output, /Config removed:/);
  assert.match(output, /clawconnect pair --profile alpha-gw/);
  assert.equal(existsSync(profileDir), false);
  assert.equal(existsSync(join(clawHome, ".env")), true);
});

test("bare reset lists detected profiles instead of silently claiming no config when default is absent", () => {
  const home = mkdtempSync(join(tmpdir(), "clawconnect-reset-bare-"));
  const alphaDir = seedTempProfile(home, "alpha-gw", "openclaw");
  const betaDir = seedTempProfile(home, "beta-gw", "hermes");

  const output = runCliWithTempHome(home, ["reset"]);

  assert.match(output, /No default profile config found/);
  assert.match(output, /alpha-gw, beta-gw/);
  assert.match(output, /clawconnect reset --profile alpha-gw/);
  assert.match(output, /clawconnect reset-all/);
  assert.equal(existsSync(join(alphaDir, "config.json")), true);
  assert.equal(existsSync(join(betaDir, "config.json")), true);
});

test("reset-all clears every paired profile", () => {
  const home = mkdtempSync(join(tmpdir(), "clawconnect-reset-all-"));
  const alphaDir = seedTempProfile(home, "alpha-gw", "openclaw");
  const betaDir = seedTempProfile(home, "beta-gw", "hermes");

  const output = runCliWithTempHome(home, ["reset-all"]);

  assert.match(output, /Resetting profile: alpha-gw/);
  assert.match(output, /Resetting profile: beta-gw/);
  assert.equal(existsSync(alphaDir), false);
  assert.equal(existsSync(betaDir), false);
});

test("bare status lists all paired profiles instead of falsely reporting default not paired", () => {
  const home = mkdtempSync(join(tmpdir(), "clawconnect-status-all-default-"));
  seedTempProfile(home, "alpha-gw", "openclaw");
  seedTempProfile(home, "beta-gw", "hermes");

  const output = runCliWithTempHome(home, ["status"]);

  assert.match(output, /Profile:\s+alpha-gw/);
  assert.match(output, /Profile:\s+beta-gw/);
  assert.doesNotMatch(output, /Profile:\s+default/);

  const explicitDefault = runCliWithTempHome(home, ["status", "--profile", "default"]);
  assert.match(explicitDefault, /Profile:\s+default/);
  assert.match(explicitDefault, /Not paired/);
  assert.match(readFileSync(join(home, ".clawconnect", ".env"), "utf8"), /CLAWCONNECT_RELAY_SERVER_URL/);
});

test("reset preserves config and sets exitCode=1 if background service removal fails", () => {
  const home = mkdtempSync(join(tmpdir(), "clawconnect-reset-guard-"));
  const originalHome = process.env.HOME;
  const previousProfile = getActiveProfile();
  const previousExitCode = process.exitCode;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (message: unknown) => { errors.push(String(message)); };

  try {
    process.env.HOME = home;
    const profileDir = seedTempProfile(home, "alpha-gw", "hermes");
    setActiveProfile("alpha-gw");
    process.exitCode = undefined;

    resetCommand({
      uninstall: () => undefined,
      isServiceInstalled: () => true,
    });

    assert.equal(process.exitCode, 1);
    assert.equal(existsSync(join(profileDir, "config.json")), true);
    assert.match(errors.join("\n"), /clawconnect reset --profile alpha-gw/);
  } finally {
    process.env.HOME = originalHome;
    setActiveProfile(previousProfile);
    process.exitCode = previousExitCode;
    console.error = originalError;
  }
});

test("reset-openclaw --local clears openclaw-local without touching online openclaw profile", () => {
  const home = mkdtempSync(join(tmpdir(), "clawconnect-reset-local-"));
  const onlineDir = seedTempProfile(home, "openclaw", "openclaw");
  const localDir = seedTempProfile(home, "openclaw-local", "openclaw");

  const output = runCliWithTempHome(home, ["reset-openclaw", "--local"]);

  assert.match(output, /clawconnect pair-openclaw --local/);
  assert.equal(existsSync(localDir), false);
  assert.equal(existsSync(join(onlineDir, "config.json")), true);
});

test("install refuses to create an unpaired default or shortcut background service", () => {
  const home = mkdtempSync(join(tmpdir(), "clawconnect-install-unpaired-"));

  for (const args of [["install"], ["install-openclaw"], ["install-hermes", "--local"]]) {
    assert.throws(
      () => runCliWithTempHome(home, args),
      (err: unknown) => {
        const execError = err as { status?: number; stderr?: string };
        return execError.status === 1 && /pair-openclaw|pair-hermes/.test(execError.stderr ?? "");
      },
    );
  }
  assert.equal(existsSync(join(home, ".clawconnect", "config.json")), false);
  assert.equal(existsSync(join(home, ".clawconnect", "profiles")), false);
});

test("bare status on an unpaired profile does not instruct running clawconnect install", () => {
  const home = mkdtempSync(join(tmpdir(), "clawconnect-status-unpaired-"));

  const output = runCliWithTempHome(home, ["status"]);

  assert.match(output, /Not paired/);
  assert.doesNotMatch(output, /run 'clawconnect install'/);
});
