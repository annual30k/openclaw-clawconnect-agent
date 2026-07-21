import assert from "node:assert/strict";
import test from "node:test";
import { resolveHermesHomeDir, resolveHermesPythonBin, resolveHermesStateDbPath } from "./hermes-runtime-paths.js";

test("Hermes native Windows paths prefer LOCALAPPDATA and Scripts/python.exe", () => {
  const existing = new Set([
    "C:\\Users\\tester\\AppData\\Local/hermes",
    "C:\\Users\\tester\\AppData\\Local/hermes/hermes-agent/venv/Scripts/python.exe",
  ]);
  const options = {
    env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    platform: "win32" as const,
    systemHome: "C:\\Users\\tester",
    exists: (path: string) => existing.has(path),
  };

  assert.equal(resolveHermesHomeDir(options), "C:\\Users\\tester\\AppData\\Local/hermes");
  assert.equal(
    resolveHermesPythonBin(options),
    "C:\\Users\\tester\\AppData\\Local/hermes/hermes-agent/venv/Scripts/python.exe",
  );
});

test("Hermes explicit home works for non-default and source installations", () => {
  assert.equal(resolveHermesHomeDir({
    env: { HERMES_HOME: "~/custom-hermes" },
    platform: "linux",
    systemHome: "/home/tester",
  }), "/home/tester/custom-hermes");
  assert.equal(resolveHermesPythonBin({
    env: { HERMES_HOME: "~/custom-hermes", HERMES_PYTHON: "~/python/bin/python3" },
    platform: "linux",
    systemHome: "/home/tester",
  }), "/home/tester/python/bin/python3");
  assert.equal(resolveHermesStateDbPath({
    env: { HERMES_HOME: "~/custom-hermes" },
    platform: "linux",
    systemHome: "/home/tester",
  }), "/home/tester/custom-hermes/state.db");
  assert.equal(resolveHermesStateDbPath({
    env: { CLAWCONNECT_HERMES_STATE_DB: "~/databases/hermes.db" },
    platform: "linux",
    systemHome: "/home/tester",
  }), "/home/tester/databases/hermes.db");
});
