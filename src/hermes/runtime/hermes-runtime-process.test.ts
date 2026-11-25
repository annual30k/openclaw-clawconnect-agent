import assert from "node:assert/strict";
import test from "node:test";
import { buildExecutableInvocation } from "../../platform/process-invocation.js";
import {
  isHermesMissingSessionError,
  isHermesReadOnlySessionError,
  isHermesUnknownSkillError,
  isHermesUnresumableMappedSessionError,
  resolveHermesBin,
} from "./hermes-runtime-process.js";

test("Windows Hermes resolution bypasses a legacy PATH shim when native hermes.exe exists", () => {
  const nativeHome = "C:\\Users\\tester\\AppData\\Local/hermes";
  const nativeExecutable = `${nativeHome}/hermes-agent/venv/Scripts/hermes.exe`;
  const legacyShim = `${nativeHome}/bin/hermes.cmd`;
  let pathResolutionCalls = 0;

  const resolved = resolveHermesBin({
    env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    platform: "win32",
    systemHome: "C:\\Users\\tester",
    exists: (path) => path === nativeHome || path === nativeExecutable || path === legacyShim,
    resolveOnPath: () => {
      pathResolutionCalls += 1;
      return legacyShim;
    },
  });

  assert.equal(resolved, nativeExecutable);
  assert.equal(pathResolutionCalls, 0);
});

test("Windows Hermes resolution still uses PATH when only a local legacy shim exists", () => {
  const nativeHome = "C:\\Users\\tester\\AppData\\Local/hermes";
  const localLegacyShim = `${nativeHome}/bin/hermes.cmd`;
  const pathExecutable = "C:\\Tools\\Hermes\\hermes.exe";

  assert.equal(resolveHermesBin({
    env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    platform: "win32",
    systemHome: "C:\\Users\\tester",
    exists: (path) => path === nativeHome || path === localLegacyShim,
    resolveOnPath: () => pathExecutable,
  }), pathExecutable);
});

test("native Windows Hermes invocation preserves a multiline Chinese query as one argv value", () => {
  const executable = "C:\\Users\\tester\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe";
  const query = "现在桌面有哪些文件\n请按名称列出，并保留 & 和 \"引号\"";
  const args = ["chat", "--query", query, "--quiet", "--source", "pocketclaw"];

  assert.deepEqual(buildExecutableInvocation(executable, args, { platform: "win32" }), {
    command: executable,
    args,
  });
});

test("Hermes error classifiers distinguish missing, read-only, and unknown-skill refusals", () => {
  const missingError = new Error("Session not found: 20261124_180000_missing");
  const readOnlyError = new Error([
    "Session api_1795512609_b66068f8 found but has no messages. Starting fresh.",
    "Error: session_read_only",
    "session_id: api_1795512609_b66068f8",
  ].join("\n"));
  const readOnlyDetailError = new Error("this stored conversation can be read but not continued; start a new chat");
  const unknownSkillGatewayError = new Error(
    "Hermes couldn't start the model connection: unknown_skill. Your message was not sent.",
  );
  const unknownSkillCliError = new Error("Unknown skill(s): file-transfer");
  const unrelatedError = new Error("provider rate limit");

  assert.equal(isHermesMissingSessionError(missingError), true);
  assert.equal(isHermesReadOnlySessionError(readOnlyError), true);
  assert.equal(isHermesReadOnlySessionError(readOnlyDetailError), true);
  assert.equal(isHermesUnresumableMappedSessionError(missingError), true);
  assert.equal(isHermesUnresumableMappedSessionError(readOnlyError), true);
  assert.equal(isHermesUnresumableMappedSessionError(unrelatedError), false);
  assert.equal(isHermesUnknownSkillError(unknownSkillGatewayError), true);
  assert.equal(isHermesUnknownSkillError(unknownSkillCliError), true);
  assert.equal(isHermesUnknownSkillError(unrelatedError), false);
});
