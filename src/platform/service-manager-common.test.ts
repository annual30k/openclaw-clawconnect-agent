import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildWindowsDirAclGrants,
  buildWindowsFileAclGrant,
  getProgramArgs,
  resolveServiceEntryPath,
} from "./service-manager-common.js";

test("resolveServiceEntryPath prefers dist/index.js when it exists", () => {
  const root = mkdtempSync(join(tmpdir(), "clawconnect-service-"));
  const srcDir = join(root, "src");
  const distDir = join(root, "dist");
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
  const srcPath = join(srcDir, "index.ts");
  const distPath = join(distDir, "index.js");
  writeFileSync(srcPath, "// src placeholder", "utf-8");
  writeFileSync(distPath, "// dist placeholder", "utf-8");

  assert.equal(resolveServiceEntryPath(srcPath), distPath);
});

test("resolveServiceEntryPath falls back when dist entry is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "clawconnect-service-"));
  const srcDir = join(root, "src");
  mkdirSync(srcDir, { recursive: true });
  const srcPath = join(srcDir, "index.ts");
  writeFileSync(srcPath, "// src placeholder", "utf-8");

  assert.equal(resolveServiceEntryPath(srcPath), srcPath);
});

test("Windows file ACL grant keeps delete permission available", () => {
  assert.equal(buildWindowsFileAclGrant("Administrator"), "Administrator:(M)");
});

test("Windows directory ACL grants apply modify access to the directory and children", () => {
  assert.deepEqual(buildWindowsDirAclGrants("Administrator"), [
    "Administrator:(M)",
    "Administrator:(OI)(CI)(M)",
  ]);
});

test("getProgramArgs includes profile for multi-instance services", () => {
  const args = getProgramArgs("hermes");
  assert.deepEqual(args.slice(-3), ["run", "--profile", "hermes"]);
});
