import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isClawConnectPowerShellShim,
  removeWindowsPowerShellShim,
  resolveWindowsShimPaths,
} from "../../scripts/fix-windows-powershell-shim.mjs";

test("Windows global install removes only the blocked ClawConnect PowerShell shim", () => {
  const prefix = mkdtempSync(join(tmpdir(), "clawconnect-global-prefix-"));
  const packageRoot = join(prefix, "node_modules", "clawconnect-agent");
  const paths = resolveWindowsShimPaths(packageRoot);
  assert.ok(paths);

  writeFileSync(paths.cmdPath, "@echo off\r\nnode node_modules\\clawconnect-agent\\dist\\index.js %*\r\n");
  writeFileSync(
    paths.ps1Path,
    "& $basedir/node.exe $basedir/node_modules/clawconnect-agent/dist/index.js $args\r\n",
  );

  assert.equal(removeWindowsPowerShellShim({
    platform: "win32",
    env: { npm_config_global: "true" },
    packageRoot,
  }), true);
  assert.equal(readFileSync(paths.cmdPath, "utf8").startsWith("@echo off"), true);
  assert.throws(() => readFileSync(paths.ps1Path, "utf8"), { code: "ENOENT" });

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
