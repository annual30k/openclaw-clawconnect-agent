import assert from "node:assert/strict";
import type { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildWindowsPowerShellBootstrap,
  buildWindowsDetachedRunnerStartScript,
  buildWindowsProcessQueryScript,
  buildWindowsScheduledTaskStateScript,
  buildWindowsServiceProcessCommand,
  buildWindowsStartupRegistryArgs,
  buildWindowsServiceTaskCommand,
  getWindowsServiceStatus,
  migrateLegacyWindowsStartup,
  normalizeWindowsServiceLogEncoding,
  WINDOWS_READ_ONLY_QUERY_TIMEOUT_MS,
  WINDOWS_RUN_KEY,
  windowsTaskName,
} from "./service-manager-windows.js";

test("buildWindowsPowerShellBootstrap configures UTF-8 for native process logs", () => {
  const command = "& 'node.exe' 'dist/index.js' 'run' >> 'log.txt' 2>> 'error.txt'";
  const script = buildWindowsPowerShellBootstrap(command);

  assert.match(script, /\[Console\]::InputEncoding = \$utf8NoBom/);
  assert.match(script, /\[Console\]::OutputEncoding = \$utf8NoBom/);
  assert.match(script, /\$OutputEncoding = \$utf8NoBom/);
  assert.match(script, /\$PSDefaultParameterValues\['Out-File:Encoding'\] = 'utf8'/);
  assert.ok(script.endsWith(command));
});

test("Windows service commands safely invoke paths containing spaces, quotes, and shell characters", () => {
  const script = buildWindowsServiceProcessCommand(
    ["C:\\Program Files\\Node & Tools\\node.exe", "C:\\Users\\O'Brien\\Claw Connect\\index.js", "run", "--profile", "Hermes Agent"],
    "C:\\Users\\O'Brien\\Logs\\claw & connect.log",
    "C:\\Users\\O'Brien\\Logs\\claw-error.log",
  );

  assert.match(script, /& 'C:\\Program Files\\Node & Tools\\node\.exe'/);
  assert.match(script, /'C:\\Users\\O''Brien\\Claw Connect\\index\.js'/);
  assert.match(script, /'--profile' 'Hermes Agent'/);
  assert.match(script, />> 'C:\\Users\\O''Brien\\Logs\\claw & connect\.log'/);
});

test("Windows scheduled task uses a short runner command instead of inline service paths", () => {
  const runnerPath = "C:\\Users\\Administrator\\.clawconnect\\profiles\\openclaw\\clawconnect-service.ps1";
  const command = buildWindowsServiceTaskCommand(runnerPath);

  assert.equal(
    command,
    `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${runnerPath}"`,
  );
  assert.ok(command.length <= 261);
  assert.doesNotMatch(command, /node_modules|clawconnect-error\.log/);
});

test("Windows standard-user fallback installs a profile-specific HKCU startup entry", () => {
  const command = 'powershell.exe -NoProfile -File "C:\\Users\\Dev User\\.clawconnect\\clawconnect-service.ps1"';

  assert.deepEqual(
    buildWindowsStartupRegistryArgs("ClawConnectAgent-openclaw", command),
    [
      "add",
      WINDOWS_RUN_KEY,
      "/v",
      "ClawConnectAgent-openclaw",
      "/t",
      "REG_SZ",
      "/d",
      command,
      "/f",
    ],
  );
});

test("Windows Startup launches the runner through a detached hidden PowerShell process", () => {
  const script = buildWindowsDetachedRunnerStartScript();

  assert.match(script, /Start-Process -FilePath 'powershell\.exe'/);
  assert.match(script, /-WindowStyle Hidden/);
  assert.match(script, /'-ExecutionPolicy', 'Bypass'/);
  assert.match(script, /\$env:CLAW_RUNNER_PATH/);
  assert.match(script, /-PassThru/);
  assert.match(script, /\[string\]\$process\.Id/);
});

test("Windows service install migrates old UTF-16LE logs before UTF-8 appends", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawconnect-win-log-"));
  const path = join(dir, "clawconnect.log");
  const content = "启动成功\r\nRelay connected.\r\n";
  writeFileSync(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]));

  normalizeWindowsServiceLogEncoding(path);

  assert.equal(readFileSync(path, "utf8"), content);
  rmSync(dir, { recursive: true, force: true });
});

test("Windows services and process queries are isolated by ClawConnect profile", () => {
  assert.equal(windowsTaskName(), "ClawConnectAgent");
  assert.equal(windowsTaskName("Hermes Agent"), "ClawConnectAgent-hermes-agent");
  assert.match(buildWindowsProcessQueryScript("openclaw"), /CLAW_PROFILE_NAME/);
  assert.match(buildWindowsProcessQueryScript("openclaw"), /OperationTimeoutSec 3/);
  assert.match(buildWindowsScheduledTaskStateScript(), /CLAW_TASK_NAME/);
  assert.match(buildWindowsProcessQueryScript(), /-notmatch/);
});

test("Windows named profiles remove only the exact legacy scheduled task", () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const execFileSyncImpl = ((command: string, args: readonly string[]) => {
    calls.push({ command, args });
    if (command === "reg.exe" && args[0] === "query") {
      throw new Error("startup entry missing");
    }
    return Buffer.from("success");
  }) as typeof execFileSync;
  let stoppedLegacyProcesses = 0;

  assert.equal(migrateLegacyWindowsStartup("openclaw", {
    execFileSyncImpl,
    defaultProfileConfigured: false,
    stopLegacyProcess: () => { stoppedLegacyProcesses += 1; },
  }), true);
  assert.deepEqual(
    calls.map((call) => [call.command, ...call.args]),
    [
      ["schtasks", "/query", "/tn", "ClawConnectAgent"],
      ["reg.exe", "query", WINDOWS_RUN_KEY, "/v", "ClawConnectAgent"],
      ["schtasks", "/end", "/tn", "ClawConnectAgent"],
      ["schtasks", "/delete", "/tn", "ClawConnectAgent", "/f"],
    ],
  );
  assert.equal(stoppedLegacyProcesses, 1);
  assert.ok(calls.every((call) => !call.args.includes("ClawConnectAgent-openclaw")));
});

test("Windows default profile preserves its current unsuffixed scheduled task", () => {
  const calls: string[] = [];
  const execFileSyncImpl = ((command: string) => {
    calls.push(command);
    return Buffer.from("success");
  }) as typeof execFileSync;

  assert.equal(migrateLegacyWindowsStartup(undefined, { execFileSyncImpl }), true);
  assert.deepEqual(calls, []);
});

test("Windows named profiles preserve the unsuffixed startup owned by a configured default profile", () => {
  const calls: string[] = [];
  const execFileSyncImpl = ((command: string) => {
    calls.push(command);
    return Buffer.from("success");
  }) as typeof execFileSync;

  assert.equal(migrateLegacyWindowsStartup("openclaw", {
    execFileSyncImpl,
    defaultProfileConfigured: true,
  }), true);
  assert.deepEqual(calls, []);
});

test("Windows named profiles remove an orphaned exact legacy Run entry without a scheduled task", () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const execFileSyncImpl = ((command: string, args: readonly string[]) => {
    calls.push({ command, args });
    if (command === "schtasks" && args[0] === "/query") {
      throw new Error("scheduled task missing");
    }
    return Buffer.from("success");
  }) as typeof execFileSync;

  assert.equal(migrateLegacyWindowsStartup("hermes", {
    execFileSyncImpl,
    defaultProfileConfigured: false,
    stopLegacyProcess: () => undefined,
  }), true);
  assert.deepEqual(
    calls.map((call) => [call.command, ...call.args]),
    [
      ["schtasks", "/query", "/tn", "ClawConnectAgent"],
      ["reg.exe", "query", WINDOWS_RUN_KEY, "/v", "ClawConnectAgent"],
      ["reg.exe", "delete", WINDOWS_RUN_KEY, "/v", "ClawConnectAgent", "/f"],
    ],
  );
  assert.ok(calls.every((call) => !call.args.includes("ClawConnectAgent-hermes")));
});

test("Windows named profile migration fails closed when the legacy task cannot be deleted", () => {
  const calls: Array<readonly string[]> = [];
  const execFileSyncImpl = ((command: string, args: readonly string[]) => {
    calls.push(args);
    if (command === "reg.exe" && args[0] === "query") {
      throw new Error("startup entry missing");
    }
    if (args[0] === "/delete") {
      throw new Error("access denied");
    }
    return Buffer.from("success");
  }) as typeof execFileSync;

  assert.equal(migrateLegacyWindowsStartup("hermes", {
    execFileSyncImpl,
    defaultProfileConfigured: false,
    stopLegacyProcess: () => undefined,
  }), false);
  assert.deepEqual(calls.at(-1), ["/delete", "/tn", "ClawConnectAgent", "/f"]);
  assert.ok(calls.every((args) => !args.includes("ClawConnectAgent-hermes")));
});

test("Windows status trusts a running scheduled task when process command lines are hidden", () => {
  const calls: string[] = [];
  const execFileSyncImpl = ((command: string, args: readonly string[]) => {
    calls.push(command);
    if (command === "schtasks") {
      return Buffer.from("task exists");
    }
    if (command === "reg.exe") {
      throw new Error("startup entry missing");
    }
    assert.equal(command, "powershell");
    assert.match(args.join(" "), /Get-ScheduledTask/);
    return Buffer.from("Running\r\n");
  }) as typeof execFileSync;

  const status = getWindowsServiceStatus("hermes", {
    execFileSyncImpl,
    scriptPath: "C:\\Program Files\\clawconnect-agent\\dist\\index.js",
  });

  assert.equal(status.installed, true);
  assert.equal(status.running, true);
  assert.equal(status.manager, "Windows Task Scheduler");
  assert.deepEqual(calls, ["schtasks", "reg.exe", "powershell"]);
});

test("Windows status bounds every system probe and degrades a timed-out process query", () => {
  const calls: Array<{ command: string; timeout: number | undefined }> = [];
  const timedOutProbes: string[] = [];
  const execFileSyncImpl = ((command: string, args: readonly string[], options: { timeout?: number }) => {
    calls.push({ command, timeout: options.timeout });
    if (command === "schtasks") {
      return Buffer.from("task exists");
    }
    if (command === "reg.exe") {
      throw new Error("startup entry missing");
    }
    assert.equal(command, "powershell");
    if (args.join(" ").includes("Get-ScheduledTask")) {
      return Buffer.from("Ready\r\n");
    }
    assert.match(args.join(" "), /Get-CimInstance Win32_Process/);
    const timeout = new Error("process query timed out");
    Object.assign(timeout, { code: "ETIMEDOUT" });
    throw timeout;
  }) as typeof execFileSync;

  const status = getWindowsServiceStatus("hermes", {
    execFileSyncImpl,
    onQueryTimeout: (probe) => timedOutProbes.push(probe),
    scriptPath: "C:\\Program Files\\clawconnect-agent\\dist\\index.js",
  });

  assert.equal(status.installed, true);
  assert.equal(status.running, false);
  assert.equal(status.manager, "Windows Task Scheduler");
  assert.deepEqual(
    calls.map((call) => call.command),
    ["schtasks", "reg.exe", "powershell", "powershell"],
  );
  assert.ok(calls.every((call) => call.timeout === WINDOWS_READ_ONLY_QUERY_TIMEOUT_MS));
  assert.deepEqual(timedOutProbes, ["running process"]);
});
