import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  formatShortTargetHint,
  parseGatewayTargetAlias,
  parsePairGatewayTarget,
  resolveImplicitSingleProfileTarget,
  resolveProfileCommandTarget,
} from "./cli-target.js";

const repoRoot = resolve(import.meta.dirname, "../..");

function runCliWithTempHome(home: string, args: string[]): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "src/index.ts", ...args],
    {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, USERPROFILE: home, LANG: "en_US.UTF-8" },
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
  return dir;
}

test("parseGatewayTargetAlias resolves oc/openclaw and hm/hermes case-insensitively", () => {
  assert.equal(parseGatewayTargetAlias("oc"), "openclaw");
  assert.equal(parseGatewayTargetAlias("OpenClaw"), "openclaw");
  assert.equal(parseGatewayTargetAlias("hm"), "hermes");
  assert.equal(parseGatewayTargetAlias("HERMES"), "hermes");
  assert.equal(parseGatewayTargetAlias("other"), undefined);
});

test("parsePairGatewayTarget resolves targets and rejects unknown or conflicting values", () => {
  assert.equal(parsePairGatewayTarget(undefined, undefined), undefined);
  assert.equal(parsePairGatewayTarget("oc", undefined), "openclaw");
  assert.equal(parsePairGatewayTarget("hm", undefined), "hermes");
  assert.equal(parsePairGatewayTarget("oc", "openclaw"), "openclaw");
  assert.throws(() => parsePairGatewayTarget("unknown"), /Unknown pair target/);
  assert.throws(() => parsePairGatewayTarget("oc", "hermes"), /Conflicting gateway target/);
});

test("resolveProfileCommandTarget resolves gateway aliases, --local, all, and rejects conflicts", () => {
  assert.deepEqual(resolveProfileCommandTarget({ target: "oc" }), {
    kind: "profile",
    profile: "openclaw",
    explicit: true,
  });
  assert.deepEqual(resolveProfileCommandTarget({ target: "oc", local: true }), {
    kind: "profile",
    profile: "openclaw-local",
    explicit: true,
  });
  assert.deepEqual(resolveProfileCommandTarget({ target: "hm", local: true }), {
    kind: "profile",
    profile: "hermes-local",
    explicit: true,
  });
  assert.deepEqual(resolveProfileCommandTarget({ target: "all", allowAll: true }), {
    kind: "all",
  });
  assert.deepEqual(resolveProfileCommandTarget({ target: "custom-box" }), {
    kind: "profile",
    profile: "custom-box",
    explicit: true,
  });
  assert.throws(() => resolveProfileCommandTarget({ target: "oc", profile: "hermes" }), /Do not pass both target/);
  assert.throws(() => resolveProfileCommandTarget({ local: true }), /--local requires a gateway target/);
  assert.throws(() => resolveProfileCommandTarget({ target: "all", allowAll: false }), /not supported/);
  assert.throws(() => resolveProfileCommandTarget({ target: "all", local: true, allowAll: true }), /--local/);
});

test("resolveImplicitSingleProfileTarget auto-selects only when unambiguous", () => {
  assert.deepEqual(
    resolveImplicitSingleProfileTarget({ defaultHasState: true, profiles: ["openclaw", "hermes"] }),
    { kind: "profile", profile: undefined },
  );
  assert.deepEqual(
    resolveImplicitSingleProfileTarget({ defaultHasState: false, profiles: ["openclaw"] }),
    { kind: "profile", profile: "openclaw" },
  );
  assert.deepEqual(
    resolveImplicitSingleProfileTarget({ defaultHasState: false, profiles: ["openclaw", "hermes"] }),
    { kind: "ambiguous", profiles: ["openclaw", "hermes"] },
  );
  assert.equal(formatShortTargetHint("restart", "openclaw"), "clawc rs oc");
  assert.equal(formatShortTargetHint("restart", "hermes-local"), "clawc rs hm --local");
});

test("package.json exposes clawc bin alias pointing at the same CLI entry as clawconnect", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
  };
  assert.equal(pkg.bin?.clawconnect, "dist/index.js");
  assert.equal(pkg.bin?.clawc, "dist/index.js");
});

test("CLI shorthand commands st, reset oc/all, and ambiguous rs guidance work deterministically", () => {
  const home = mkdtempSync(join(tmpdir(), "clawconnect-cli-shorthand-"));
  try {
    const ocDir = seedTempProfile(home, "openclaw", "openclaw");
    const ocLocalDir = seedTempProfile(home, "openclaw-local", "openclaw");
    const hmDir = seedTempProfile(home, "hermes", "hermes");

    const stAll = runCliWithTempHome(home, ["st"]);
    assert.match(stAll, /Profile:\s+openclaw/);
    assert.match(stAll, /Profile:\s+hermes/);

    const stOc = runCliWithTempHome(home, ["st", "oc"]);
    assert.match(stOc, /Profile:\s+openclaw/);
    assert.doesNotMatch(stOc, /Profile:\s+hermes/);

    const stOcLocal = runCliWithTempHome(home, ["st", "oc", "--local"]);
    assert.match(stOcLocal, /Profile:\s+openclaw-local/);

    const helpText = runCliWithTempHome(home, ["--help"]);
    assert.match(helpText, /clawc/);
    assert.match(helpText, /clawc st \[oc\|hm\|all\]/);
    assert.match(helpText, /clawc rs \[oc\|hm\|all\]/);

    // Multi-profile bare rs refuses to guess and prints concise target commands.
    assert.throws(
      () => runCliWithTempHome(home, ["rs"]),
      (err: unknown) => {
        const execErr = err as { status?: number; stderr?: string };
        assert.equal(execErr.status, 1);
        assert.match(execErr.stderr ?? "", /clawc rs oc/);
        assert.match(execErr.stderr ?? "", /clawc rs hm/);
        assert.match(execErr.stderr ?? "", /clawc rs all/);
        return true;
      },
    );

    // reset oc --local clears only openclaw-local.
    runCliWithTempHome(home, ["reset", "oc", "--local"]);
    assert.equal(existsSync(ocLocalDir), false);
    assert.equal(existsSync(ocDir), true);
    assert.equal(existsSync(hmDir), true);

    // reset all clears remaining profiles.
    runCliWithTempHome(home, ["reset", "all"]);
    assert.equal(existsSync(ocDir), false);
    assert.equal(existsSync(hmDir), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
