import assert from "node:assert/strict";
import test from "node:test";
import { isOpenClawConfigBackupName } from "./local-handlers.js";

test("OpenClaw restore fallback follows a custom config filename", () => {
  const configPath = "/srv/openclaw/config/custom-openclaw.json5";
  assert.equal(isOpenClawConfigBackupName("custom-openclaw.json5.bak", configPath), true);
  assert.equal(isOpenClawConfigBackupName("custom-openclaw.json5.bak.2", configPath), true);
  assert.equal(isOpenClawConfigBackupName("openclaw.json.bak", configPath), false);
});
