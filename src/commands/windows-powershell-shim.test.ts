import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  COMMAND_NAMES,
  isClawConnectPowerShellShim,
  removeWindowsPowerShellShim,
  resolveAllWindowsShimPaths,
  resolveWindowsShimPaths,
} from "../../scripts/fix-windows-powershell-shim.mjs";

test("Windows global install removes only the blocked ClawConnect and clawc PowerShell shims", () => {
  const prefix = mkdtempSync(join(tmpdir(), "clawconnect-global-prefix-"));
  const packageRoot = join(prefix, "node_modules", "clawconnect-agent");
  const allPaths = resolveAllWindowsShimPaths(packageRoot);
  assert.ok(allPaths);
  assert.deepEqual(COMMAND_NAMES, ["clawconnect", "clawc"]);
  assert.equal(allPaths.length, 2);

  for (const paths of allPaths) {
    writeFileSync(paths.cmdPath, "@echo off\r\nnode node_modules\\clawconnect-agent\\dist\\index.js %*\r\n");
    writeFileSync(
      paths.ps1Path,
      "& $basedir/node.exe $basedir/node_modules/clawconnect-agent/dist/index.js $args\r\n",
    );
  }

  assert.equal(removeWindowsPowerShellShim({
    platform: "win32",
    env: { npm_config_global: "true" },
    packageRoot,
  }), true);
  for (const paths of allPaths) {
    assert.equal(readFileSync(paths.cmdPath, "utf8").startsWith("@echo off"), true);
    assert.throws(() => readFileSync(paths.ps1Path, "utf8"), { code: "ENOENT" });
  }
  assert.deepEqual(resolveWindowsShimPaths(packageRoot), allPaths[0]);

  rmSync(prefix, { recursive: true, force: true });
});

test("PowerShell shim cleanup is disabled for local installs and non-Windows platforms", () => {
  const packageRoot = "C:\\project\\node_modules\\clawconnect-agent";
  let removeCalls = 0;
  const commonOptions = {
    packageRoot,
    fileExists: () => true,
    readFile: () => "node_modules/clawconnect-agent/dist/index.js",
    removeFile: () => { removeCalls += 1; },
  };

  assert.equal(removeWindowsPowerShellShim({
    ...commonOptions,
    platform: "win32",
    env: { npm_config_global: "false" },
  }), false);
  assert.equal(removeWindowsPowerShellShim({
    ...commonOptions,
    platform: "darwin",
    env: { npm_config_global: "true" },
  }), false);
  assert.equal(removeCalls, 0);
});

test("PowerShell shim cleanup preserves files that do not target ClawConnect", () => {
  let removeCalls = 0;
  assert.equal(removeWindowsPowerShellShim({
    platform: "win32",
    env: { npm_config_location: "global" },
    packageRoot: "C:\\npm\\node_modules\\clawconnect-agent",
    fileExists: () => true,
    readFile: () => "Write-Host 'user-owned script'",
    removeFile: () => { removeCalls += 1; },
  }), false);
  assert.equal(removeCalls, 0);
  assert.equal(isClawConnectPowerShellShim("node_modules\\clawconnect-agent\\dist\\index.js"), true);
});
