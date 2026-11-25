import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getHermesBinCandidates,
  resolveHermesHomeDir,
  resolveHermesPythonBin,
  resolveHermesStateDbPath,
} from "./hermes-runtime-paths.js";

test("Hermes native Windows paths prefer LOCALAPPDATA and Scripts/python.exe", () => {
  const existing = new Set([
    "C:\\Users\\tester\\AppData\\Local/hermes",
    "C:\\Users\\tester/.hermes",
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

test("Hermes native Windows home remains authoritative when a legacy home also exists", () => {
  const existing = new Set([
    "C:\\Users\\tester\\AppData\\Local/hermes",
    "C:\\Users\\tester/.hermes",
  ]);

  assert.equal(resolveHermesHomeDir({
    env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    platform: "win32",
    systemHome: "C:\\Users\\tester",
    exists: (path: string) => existing.has(path),
  }), "C:\\Users\\tester\\AppData\\Local/hermes");
});

test("Hermes native Windows executable candidates prefer hermes.exe over command shims", () => {
  const options = {
    env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    platform: "win32" as const,
    systemHome: "C:\\Users\\tester",
    exists: (path: string) => path === "C:\\Users\\tester\\AppData\\Local/hermes",
  };

  assert.deepEqual(getHermesBinCandidates(options).slice(0, 4), [
    "C:\\Users\\tester\\AppData\\Local/hermes/hermes-agent/venv/Scripts/hermes.exe",
    "C:\\Users\\tester\\AppData\\Local/hermes/hermes-agent/venv/Scripts/hermes.cmd",
    "C:\\Users\\tester\\AppData\\Local/hermes/hermes-agent/venv/Scripts/hermes.ps1",
    "C:\\Users\\tester\\AppData\\Local/hermes/bin/hermes.cmd",
  ]);
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

test("resolveHermesPythonBin finds uv tool, pipx, and python shebang interpreters while ignoring non-python interpreters", () => {
  const uvPython = "/home/tester/.local/share/uv/tools/hermes-agent/bin/python";
  assert.equal(resolveHermesPythonBin({
    env: {},
    platform: "linux",
    systemHome: "/home/tester",
    exists: (path) => path === uvPython,
  }), uvPython);

  const pipxPython3 = "/home/tester/.local/pipx/venvs/hermes-agent/bin/python3";
  assert.equal(resolveHermesPythonBin({
    env: {},
    platform: "linux",
    systemHome: "/home/tester",
    exists: (path) => path === pipxPython3,
  }), pipxPython3);

  const root = mkdtempSync(join(tmpdir(), "hermes-python-shebang-"));
  try {
    const customPython = join(root, "opt-venv", "bin", "python3");
    const hermesWrapper = join(root, "bin", "hermes");
    mkdirSync(join(root, "opt-venv", "bin"), { recursive: true });
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(customPython, "", "utf8");
    writeFileSync(hermesWrapper, `#!${customPython}\nprint('hermes')\n`, "utf8");
    chmodSync(customPython, 0o755);
    chmodSync(hermesWrapper, 0o755);

    assert.equal(resolveHermesPythonBin({
      env: { HERMES_BIN: hermesWrapper, HERMES_HOME: join(root, "empty-hermes") },
      platform: "linux",
      systemHome: join(root, "empty-home"),
    }), customPython);

    writeFileSync(hermesWrapper, "#!/usr/bin/env node\nconsole.log('hermes')\n", "utf8");
    assert.equal(resolveHermesPythonBin({
      env: { HERMES_BIN: hermesWrapper, HERMES_HOME: join(root, "empty-hermes") },
      platform: "linux",
      systemHome: join(root, "empty-home"),
    }), "python3");

    writeFileSync(hermesWrapper, "#!/bin/sh\necho hermes\n", "utf8");
    assert.equal(resolveHermesPythonBin({
      env: { HERMES_BIN: hermesWrapper, HERMES_HOME: join(root, "empty-hermes") },
      platform: "linux",
      systemHome: join(root, "empty-home"),
    }), "python3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
