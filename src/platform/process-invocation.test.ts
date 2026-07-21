import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExecutableInvocation,
  buildShellCommandInvocation,
  quoteShellArgument,
} from "./process-invocation.js";

test("Windows script entrypoints use Node or cmd without shell guessing", () => {
  assert.deepEqual(buildExecutableInvocation("C:\\OpenClaw\\openclaw.mjs", ["gateway", "status"], {
    platform: "win32",
    nodePath: "C:\\Node\\node.exe",
  }), {
    command: "C:\\Node\\node.exe",
    args: ["C:\\OpenClaw\\openclaw.mjs", "gateway", "status"],
  });

  const commandWrapper = buildExecutableInvocation("C:\\Users\\测试 User\\openclaw.cmd", ["--version"], {
    platform: "win32",
    commandShell: "cmd.exe",
  });
  assert.equal(commandWrapper.command, "cmd.exe");
  assert.deepEqual(commandWrapper.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(commandWrapper.args[3], /^"C:\\Users\\测试 User\\openclaw\.cmd" --version$/);

  assert.deepEqual(buildExecutableInvocation("C:\\OpenClaw Source\\openclaw.ps1", ["gateway", "status"], {
    platform: "win32",
    powershellPath: "pwsh.exe",
  }), {
    command: "pwsh.exe",
    args: ["-NoProfile", "-NonInteractive", "-File", "C:\\OpenClaw Source\\openclaw.ps1", "gateway", "status"],
  });
});

test("Windows configurable shell commands use PowerShell with UTF-8 and safe path quoting", () => {
  const quoted = quoteShellArgument("C:\\Users\\测试 User\\voice's.wav", "win32");
  assert.equal(quoted, "'C:\\Users\\测试 User\\voice''s.wav'");
  const invocation = buildShellCommandInvocation(`transcribe ${quoted}`, "win32");
  assert.equal(invocation.command, "powershell.exe");
  assert.match(invocation.args[3], /\[Console\]::OutputEncoding = \$utf8NoBom/);
  assert.ok(invocation.args[3].endsWith(`transcribe ${quoted}`));
});
