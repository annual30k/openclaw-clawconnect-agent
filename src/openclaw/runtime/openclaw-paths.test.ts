import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveOpenClawConfigPath,
  resolveOpenClawStateDir,
} from "./openclaw-paths.js";

test("OpenClaw paths follow the official state and config override precedence", () => {
  const systemHome = "/Users/tester";

  assert.equal(resolveOpenClawStateDir({ env: {}, systemHome }), "/Users/tester/.openclaw");
  assert.equal(resolveOpenClawStateDir({
    env: { OPENCLAW_HOME: "/srv/openclaw-user" },
    systemHome,
  }), "/srv/openclaw-user/.openclaw");
  assert.equal(resolveOpenClawStateDir({
    env: {
      OPENCLAW_HOME: "/ignored",
      CLAWCONNECT_OPENCLAW_HOME: "/legacy-state",
      OPENCLAW_STATE_DIR: "~/custom-state",
    },
    systemHome,
  }), "/Users/tester/custom-state");
  assert.equal(resolveOpenClawConfigPath({
    env: {
      OPENCLAW_STATE_DIR: "/state",
      OPENCLAW_CONFIG_PATH: "/config/custom.json5",
    },
    systemHome,
  }), "/config/custom.json5");
});
