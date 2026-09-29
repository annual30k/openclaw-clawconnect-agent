import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isolateHomeDirectory } from "./isolated-home.js";

test("isolateHomeDirectory redirects os.homedir on every platform and restores both variables", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = join(tmpdir(), "clawconnect-isolated-home-probe");

  const restore = isolateHomeDirectory(tempHome);
  try {
    assert.equal(process.env.HOME, tempHome);
    assert.equal(process.env.USERPROFILE, tempHome);
    assert.equal(homedir(), tempHome);
  } finally {
    restore();
  }

  assert.equal(process.env.HOME, originalHome);
  assert.equal(process.env.USERPROFILE, originalUserProfile);
});

test("test runner never exposes the developer's real home directory", () => {
  assert.ok(homedir().startsWith(tmpdir()), `homedir ${homedir()} must be inside ${tmpdir()}`);
});
