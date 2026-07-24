import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  openClawInstallDirCandidates,
  parseGatewayRuntimeState,
  resolveGatewayRemoteRestartAction,
  selectOpenclawBinCandidate,
} from "../runtime/local-runtime.js";

test("parseGatewayRuntimeState handles running/stopped/unknown", () => {
  assert.equal(parseGatewayRuntimeState("Runtime: running\n"), "running");
  assert.equal(parseGatewayRuntimeState("Runtime: stopped\n"), "stopped");
  assert.equal(parseGatewayRuntimeState("Runtime: not running\n"), "stopped");
  assert.equal(parseGatewayRuntimeState("Runtime: UNKNOWN\n"), "unknown");
  assert.equal(parseGatewayRuntimeState("no runtime here"), "unknown");
});

test("parseGatewayRuntimeState ignores ANSI escapes", () => {
  const output = "\u001b[31mRuntime:\u001b[0m running\n";
  assert.equal(parseGatewayRuntimeState(output), "running");
});

test("resolveGatewayRemoteRestartAction maps runtime to action", () => {
  assert.equal(resolveGatewayRemoteRestartAction("running"), "restart");
  assert.equal(resolveGatewayRemoteRestartAction("stopped"), "start");
  assert.equal(resolveGatewayRemoteRestartAction("unknown"), "start");
});

test("selectOpenclawBinCandidate falls back to package entry when PATH shim is broken", () => {
  const exists = (candidate: string) => ["/bad/openclaw", "/pkg/openclaw.mjs"].includes(candidate);
  const canRun = (candidate: string) => candidate === "/pkg/openclaw.mjs";

  assert.equal(
    selectOpenclawBinCandidate({
      pathBin: "/bad/openclaw",
      packageBin: "/pkg/openclaw.mjs",
      exists,
      canRun,
    }),
    "/pkg/openclaw.mjs",
  );
});

test("selectOpenclawBinCandidate supports official installer wrapper paths", () => {
  const exists = (candidate: string) => ["/home/me/.openclaw/bin/openclaw"].includes(candidate);
  const canRun = (candidate: string) => candidate === "/home/me/.openclaw/bin/openclaw";

  assert.equal(
    selectOpenclawBinCandidate({
      pathBin: "/bad/openclaw",
      extraBins: [
        "/home/me/.openclaw/bin/openclaw",
        "/home/me/.local/bin/openclaw",
      ],
      packageBin: "/pkg/openclaw.mjs",
      exists,
      canRun,
    }),
    "/home/me/.openclaw/bin/openclaw",
  );
});

test("selectOpenclawBinCandidate prefers a working explicit binary", () => {
  const exists = (candidate: string) => ["/explicit/openclaw", "/pkg/openclaw.mjs"].includes(candidate);
  const canRun = (candidate: string) => candidate === "/explicit/openclaw" || candidate === "/pkg/openclaw.mjs";

  assert.equal(
    selectOpenclawBinCandidate({
      explicitBin: "/explicit/openclaw",
      pathBin: "/bad/openclaw",
      packageBin: "/pkg/openclaw.mjs",
      exists,
      canRun,
    }),
    "/explicit/openclaw",
  );
});

test("selectOpenclawBinCandidate keeps an existing explicit binary when its probe is temporarily unavailable", () => {
  const exists = (candidate: string) => ["/explicit/openclaw", "/pkg/openclaw.mjs"].includes(candidate);
  const canRun = (candidate: string) => candidate === "/pkg/openclaw.mjs";

  assert.equal(
    selectOpenclawBinCandidate({
      explicitBin: "/explicit/openclaw",
      packageBin: "/pkg/openclaw.mjs",
      exists,
      canRun,
    }),
    "/explicit/openclaw",
  );
});

test("OpenClaw install directory overrides expand tilde paths", () => {
  const root = join(homedir(), "custom-openclaw");
  assert.deepEqual(openClawInstallDirCandidates("~/custom-openclaw"), [
    join(root, "openclaw.mjs"),
    join(root, "dist", "index.js"),
    join(root, "bin", process.platform === "win32" ? "openclaw.cmd" : "openclaw"),
    join(root, process.platform === "win32" ? "openclaw.cmd" : "openclaw"),
    join(root, "node_modules", "openclaw", "openclaw.mjs"),
  ]);
});
