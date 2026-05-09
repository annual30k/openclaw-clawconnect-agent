import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWindowsCommandLine,
  buildSelfUpdateArgs,
  CLAWCONNECT_PACKAGE_NAME,
  deriveWindowsNodeModuleCliEntry,
  isGlobalNpmInstall,
  parseResolvedCommandPath,
  parseVersionOutput,
} from "./update.js";

test("buildSelfUpdateArgs targets the latest published package by default", () => {
  assert.deepEqual(buildSelfUpdateArgs(), [
    "install",
    "-g",
    `${CLAWCONNECT_PACKAGE_NAME}@latest`,
  ]);
});

test("buildSelfUpdateArgs supports explicit version tags", () => {
  assert.deepEqual(buildSelfUpdateArgs("next"), [
    "install",
    "-g",
    `${CLAWCONNECT_PACKAGE_NAME}@next`,
  ]);
});

test("isGlobalNpmInstall detects node_modules-based global installs", () => {
  assert.equal(
    isGlobalNpmInstall("file:///usr/local/lib/node_modules/clawconnect-agent/dist/index.js"),
    true,
  );
  assert.equal(
    isGlobalNpmInstall("file:///Users/dev/workspace/clawconnect-agent/dist/index.js"),
    false,
  );
});

test("parseResolvedCommandPath returns the first resolved CLI location", () => {
  assert.equal(
    parseResolvedCommandPath("/usr/local/bin/clawconnect\n/opt/homebrew/bin/clawconnect\n"),
    "/usr/local/bin/clawconnect",
  );
  assert.equal(parseResolvedCommandPath("\n"), null);
});

test("parseVersionOutput reads the first non-empty line", () => {
  assert.equal(parseVersionOutput("\n0.1.4\n"), "0.1.4");
  assert.equal(parseVersionOutput(""), null);
});

test("buildWindowsCommandLine quotes args for cmd.exe execution", () => {
  assert.equal(
    buildWindowsCommandLine(["npm", "install", "-g", "clawconnect-agent@latest"]),
    "npm install -g clawconnect-agent@latest",
  );
  assert.equal(
    buildWindowsCommandLine(["npm", "config", "set", "prefix", "D:\\Program Files\\nodejs"]),
    'npm config set prefix "D:\\Program Files\\nodejs"',
  );
});

test("deriveWindowsNodeModuleCliEntry resolves the installed node module entry beside the shim", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clawconnect-update-"));
  const shimPath = path.join(tempRoot, "clawconnect.cmd");
  const cliPath = path.join(tempRoot, "node_modules", "clawconnect-agent", "dist", "index.js");
  await fs.mkdir(path.dirname(cliPath), { recursive: true });
  await fs.writeFile(shimPath, "@echo off\r\n", "utf-8");
  await fs.writeFile(cliPath, "// cli entry\n", "utf-8");

  assert.equal(
    deriveWindowsNodeModuleCliEntry(shimPath, "clawconnect-agent", path.join("dist", "index.js")),
    cliPath,
  );
});
