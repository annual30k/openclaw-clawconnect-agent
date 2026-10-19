import assert from "node:assert/strict";
import type { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildWindowsProcessQueryScript,
  buildWindowsServiceBinaryPath,
  buildWindowsServiceCreateScript,
  buildWindowsServiceHostCompileArgs,
  buildWindowsServiceStateScript,
  getWindowsServiceStatus,
  installWindowsService,
  isWindowsElevated,
  normalizeWindowsServiceLogEncoding,
  queryWindowsServiceState,
  resolveWindowsCscPath,
  restartWindowsService,
  uninstallWindowsService,
  windowsServiceAccount,
  windowsServiceName,
  WINDOWS_SERVICE_FAILURE_ACTIONS,
} from "./service-manager-windows.js";
import type { WindowsServiceDeps } from "./service-manager-windows.js";
import {
  buildWindowsServiceHostConfig,
  buildWindowsServiceHostSource,
  WINDOWS_HOST_GRANT_LOGON_RIGHT_FLAG,
} from "./windows-service-host-source.js";
import {
  LEGACY_WINDOWS_RUN_KEY,
  removeLegacyWindowsStartup,
} from "./windows-service-legacy-startup.js";

const TEST_PROFILE = "unit-test-profile";
const TEST_SERVICE = `ClawConnectAgent-${TEST_PROFILE}`;

type Call = { command: string; args: readonly string[] };

/** 按调用顺序记录所有外部命令；`respond` 可对特定命令返回结果或抛错。 */
function recordingExec(respond: (call: Call) => Buffer | undefined = () => undefined) {
  const calls: Call[] = [];
  const impl = ((command: string, args: readonly string[] = []) => {
    const call = { command, args };
    calls.push(call);
    return respond(call) ?? Buffer.from("");
  }) as unknown as typeof execFileSync;
  return { calls, impl };
}

function isStateQuery(call: Call): boolean {
  return call.command === "powershell" && call.args.some((arg) => arg.includes("Get-Service"));
}

function baseDeps(overrides: Partial<WindowsServiceDeps> = {}): WindowsServiceDeps & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    sleepSync: () => undefined,
    killProcess: () => false,
    account: "TESTPC\\tester",
    compileHost: () => { events.push("compile"); },
    writeConfig: () => { events.push("writeConfig"); },
    ...overrides,
  };
}

test("Windows host config uses key=value lines and quotes arguments with spaces", () => {
  const config = buildWindowsServiceHostConfig({
    executablePath: "C:\\Program Files\\nodejs\\node.exe",
    executableArgs: ["C:\\Users\\Admin User\\clawconnect\\index.js", "run", "--profile", "openclaw"],
    workingDirectory: "C:\\Users\\Admin User\\.clawconnect\\profiles\\openclaw",
    stdoutLogPath: "C:\\logs\\out.log",
    stderrLogPath: "C:\\logs\\err.log",
  });

  assert.equal(config, [
    "exe=C:\\Program Files\\nodejs\\node.exe",
    'args="C:\\Users\\Admin User\\clawconnect\\index.js" run --profile openclaw',
    "cwd=C:\\Users\\Admin User\\.clawconnect\\profiles\\openclaw",
    "out=C:\\logs\\out.log",
    "err=C:\\logs\\err.log",
    "",
  ].join("\r\n"));
});

test("Windows host config rejects values that would split into two keys", () => {
  assert.throws(
    () => buildWindowsServiceHostConfig({
      executablePath: "node.exe",
      executableArgs: [],
      workingDirectory: "C:\\a\nexe=evil.exe",
      stdoutLogPath: "o",
      stderrLogPath: "e",
    }),
    /must not contain line breaks/,
  );
});

test("Windows service host source supervises the agent and stays within C# 5 syntax", () => {
  const source = buildWindowsServiceHostSource();

  assert.match(source, /class AgentServiceHost : ServiceBase/);
  assert.match(source, /RestartDelayMs = 5000/);
  assert.match(source, /taskkill/);
  assert.match(source, /\/T \/F \/PID/);
  assert.match(source, /SeServiceLogonRight/);
  assert.ok(source.includes(`"${WINDOWS_HOST_GRANT_LOGON_RIGHT_FLAG}"`));
  // csc.exe（.NET Framework 4）只支持 C# 5：字符串插值、空条件、表达式体成员都会编译失败。
  assert.doesNotMatch(source, /\$"/);
  assert.doesNotMatch(source, /\?\./);
  assert.doesNotMatch(source, /=>/);
});

test("Windows service names and paths are isolated per profile", () => {
  assert.equal(windowsServiceName(), "ClawConnectAgent");
  assert.equal(windowsServiceName("Hermes Agent"), "ClawConnectAgent-hermes-agent");
  assert.equal(
    buildWindowsServiceBinaryPath("C:\\p\\host.exe", "ClawConnectAgent-openclaw", "C:\\p\\host.conf"),
    '"C:\\p\\host.exe" "ClawConnectAgent-openclaw" "C:\\p\\host.conf"',
  );
  assert.match(buildWindowsProcessQueryScript("openclaw"), /CLAW_PROFILE_NAME/);
  assert.match(buildWindowsProcessQueryScript("openclaw"), /OperationTimeoutSec 3/);
  assert.match(buildWindowsProcessQueryScript(), /-notmatch/);
  assert.match(buildWindowsServiceStateScript(), /CLAW_SERVICE_NAME/);
});

test("Windows service account is the current domain user and fails loudly without it", () => {
  assert.equal(windowsServiceAccount({ USERNAME: "Administrator", USERDOMAIN: "OS-2024" }), "OS-2024\\Administrator");
  assert.equal(windowsServiceAccount({ USERNAME: "dev", COMPUTERNAME: "PC1" }), "PC1\\dev");
  assert.throws(() => windowsServiceAccount({ USERDOMAIN: "PC1" }), /Cannot determine the current Windows account/);
});

test("Windows service creation never puts the password on a command line", () => {
  const script = buildWindowsServiceCreateScript();

  assert.match(script, /Read-Host .* -AsSecureString/);
  assert.match(script, /ValidateCredentials/);
  assert.match(script, /New-Service .* -Credential \$credential/);
  assert.match(script, /A Windows service cannot log on with an empty password/);
  assert.doesNotMatch(script, /-Password|password=|ConvertTo-SecureString/i);
});

test("Windows csc.exe resolution prefers the 64-bit Framework and reports a missing compiler", () => {
  const dir = "D:\\Windows";
  const both = new Set([
    join(dir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(dir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ]);
  assert.equal(
    resolveWindowsCscPath((path) => both.has(path), dir),
    join(dir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  );
  assert.equal(resolveWindowsCscPath(() => false, dir), undefined);
  assert.deepEqual(buildWindowsServiceHostCompileArgs("a.cs", "a.exe"), [
    "/nologo",
    "/target:exe",
    "/optimize+",
    "/out:a.exe",
    "/reference:System.ServiceProcess.dll",
    "a.cs",
  ]);
});

test("Windows elevation is detected through fltmc", () => {
  assert.equal(isWindowsElevated(recordingExec().impl), true);
  const denied = recordingExec(() => { throw new Error("access denied"); });
  assert.equal(isWindowsElevated(denied.impl), false);
  assert.deepEqual(denied.calls.map((call) => call.command), ["fltmc"]);
});

test("Windows service state maps Get-Service output and distinguishes missing from timed out", () => {
  const stateFor = (output: string | Error) => queryWindowsServiceState(TEST_SERVICE, {
    execFileSyncImpl: recordingExec(() => {
      if (output instanceof Error) throw output;
      return Buffer.from(`${output}\r\n`);
    }).impl,
  });

  assert.equal(stateFor("Running"), "running");
  assert.equal(stateFor("Stopped"), "stopped");
  assert.equal(stateFor("StartPending"), "pending");
  assert.equal(stateFor("StopPending"), "pending");
  assert.equal(stateFor(new Error("Cannot find any service")), "missing");

  const reported: string[] = [];
  const timedOut = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
  assert.equal(
    queryWindowsServiceState(TEST_SERVICE, {
      execFileSyncImpl: recordingExec(() => { throw timedOut; }).impl,
      onQueryTimeout: (probe) => reported.push(probe),
    }),
    "unknown",
  );
  assert.deepEqual(reported, ["service state"]);
});

test("Windows status reports installed and running from the service state", () => {
  const status = getWindowsServiceStatus(TEST_PROFILE, {
    execFileSyncImpl: recordingExec(() => Buffer.from("Running")).impl,
  });
  assert.equal(status.installed, true);
  assert.equal(status.running, true);
  assert.equal(status.manager, "Windows Service");
  assert.equal(status.serviceName, TEST_SERVICE);
  assert.equal(status.startHint, `sc.exe start "${TEST_SERVICE}"`);

  const missing = getWindowsServiceStatus(TEST_PROFILE, {
    execFileSyncImpl: recordingExec(() => { throw new Error("not found"); }).impl,
  });
  assert.equal(missing.installed, false);
  assert.equal(missing.running, false);
});

test("Windows install refuses to run without elevation and changes nothing", () => {
  const exec = recordingExec((call) => {
    if (call.command === "fltmc") throw new Error("access denied");
    return undefined;
  });
  const deps = baseDeps({ execFileSyncImpl: exec.impl });
  const originalError = console.error;
  const messages: string[] = [];
  console.error = (message: unknown) => { messages.push(String(message)); };
  try {
    assert.equal(installWindowsService(TEST_PROFILE, deps), false);
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(exec.calls.map((call) => call.command), ["fltmc"]);
  assert.deepEqual(deps.events, []);
  assert.match(messages.join("\n"), /requires an elevated terminal/);
  assert.match(messages.join("\n"), /clawconnect install --profile unit-test-profile/);
});

/** 模拟 SCM：missing → 创建后 stopped → start 后 running。 */
function scmSimulator(initial: "missing" | "stopped" | "running") {
  let state: string = initial;
  return recordingExec((call) => {
    if (call.command === "schtasks" && call.args[0] === "/query") throw new Error("task missing");
    if (call.command === "reg.exe" && call.args[0] === "query") throw new Error("entry missing");
    if (isStateQuery(call)) {
      if (state === "missing") throw new Error("Cannot find any service");
      return Buffer.from(state === "running" ? "Running" : "Stopped");
    }
    if (call.command === "powershell" && call.args.includes("-ExecutionPolicy")) state = "stopped";
    if (call.command === "sc.exe" && call.args[0] === "stop") state = "stopped";
    if (call.command === "sc.exe" && call.args[0] === "start") state = "running";
    return undefined;
  });
}

test("Windows first install creates the service, grants the logon right and configures auto-restart", () => {
  const exec = scmSimulator("missing");
  const deps = baseDeps({ execFileSyncImpl: exec.impl });

  assert.equal(installWindowsService(TEST_PROFILE, deps), true);

  const sc = exec.calls.filter((call) => call.command === "sc.exe").map((call) => [...call.args]);
  assert.deepEqual(sc, [
    ["failure", TEST_SERVICE, "reset=", "86400", "actions=", WINDOWS_SERVICE_FAILURE_ACTIONS],
    ["failureflag", TEST_SERVICE, "1"],
    ["start", TEST_SERVICE],
  ]);
  const creation = exec.calls.findIndex((call) => call.command === "powershell" && call.args.includes("-ExecutionPolicy"));
  const grant = exec.calls.findIndex((call) => call.args[0] === WINDOWS_HOST_GRANT_LOGON_RIGHT_FLAG);
  const start = exec.calls.findIndex((call) => call.command === "sc.exe" && call.args[0] === "start");
  assert.ok(creation >= 0 && grant > creation && start > grant, "create → grant right → start");
  assert.deepEqual(deps.events, ["compile", "writeConfig"]);
});

test("Windows reinstall keeps the existing service credentials and does not prompt for a password", () => {
  const exec = scmSimulator("running");
  const deps = baseDeps({ execFileSyncImpl: exec.impl });

  assert.equal(installWindowsService(TEST_PROFILE, deps), true);

  assert.ok(exec.calls.every((call) => !call.args.includes("-ExecutionPolicy")), "no password prompt");
  const sc = exec.calls.filter((call) => call.command === "sc.exe").map((call) => call.args[0]);
  assert.deepEqual(sc, ["stop", "start"]);
  assert.deepEqual(deps.events, ["compile", "writeConfig"]);
});

test("Windows install removes the legacy scheduled task before the service starts", () => {
  const exec = recordingExec((call) => {
    if (call.command === "reg.exe" && call.args[0] === "query") throw new Error("entry missing");
    if (isStateQuery(call)) throw new Error("Cannot find any service");
    return undefined;
  });
  const deps = baseDeps({ execFileSyncImpl: exec.impl });
  const stopped: Array<string | undefined> = [];
  deps.killProcess = (profile) => { stopped.push(profile); return false; };

  installWindowsService(TEST_PROFILE, deps);

  const flat = exec.calls.map((call) => [call.command, ...call.args].join(" "));
  const deleteIndex = flat.indexOf(`schtasks /delete /tn ${TEST_SERVICE} /f`);
  const createIndex = flat.findIndex((line) => line.includes("-ExecutionPolicy"));
  assert.ok(deleteIndex >= 0, "legacy task is deleted");
  assert.ok(deleteIndex < createIndex, "legacy task is removed before the service is created");
  assert.ok(stopped.includes(TEST_PROFILE), "legacy agent process is stopped");
});

test("Windows install aborts without touching the service when the legacy task cannot be removed", () => {
  const exec = recordingExec((call) => {
    if (call.command === "reg.exe" && call.args[0] === "query") throw new Error("entry missing");
    if (call.command === "schtasks" && call.args[0] === "/delete") throw new Error("access denied");
    return undefined;
  });
  const deps = baseDeps({ execFileSyncImpl: exec.impl });
  const originalError = console.error;
  console.error = () => undefined;
  try {
    assert.equal(installWindowsService(TEST_PROFILE, deps), false);
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(deps.events, []);
  assert.ok(exec.calls.every((call) => call.command !== "sc.exe"));
});

test("Windows install reports a service that never reaches the running state", () => {
  const exec = recordingExec((call) => {
    if (call.command === "schtasks" && call.args[0] === "/query") throw new Error("task missing");
    if (call.command === "reg.exe" && call.args[0] === "query") throw new Error("entry missing");
    if (isStateQuery(call)) return Buffer.from("Stopped");
    return undefined;
  });
  const deps = baseDeps({ execFileSyncImpl: exec.impl });
  const originalError = console.error;
  const messages: string[] = [];
  console.error = (message: unknown) => { messages.push(String(message)); };
  try {
    assert.equal(installWindowsService(TEST_PROFILE, deps), false);
  } finally {
    console.error = originalError;
  }

  assert.match(messages.join("\n"), /did not reach the running state/);
});

test("Windows restart refreshes the host config between stop and start", () => {
  const exec = scmSimulator("running");
  const deps = baseDeps({ execFileSyncImpl: exec.impl });

  assert.equal(restartWindowsService(TEST_PROFILE, deps), true);

  assert.deepEqual(
    exec.calls.filter((call) => call.command === "sc.exe").map((call) => call.args[0]),
    ["stop", "start"],
  );
  assert.deepEqual(deps.events, ["writeConfig"]);
});

test("Windows restart of a missing service falls back to a full install", () => {
  const exec = scmSimulator("missing");
  const deps = baseDeps({ execFileSyncImpl: exec.impl });

  assert.equal(restartWindowsService(TEST_PROFILE, deps), true);

  assert.deepEqual(deps.events, ["compile", "writeConfig"]);
});

test("Windows uninstall stops and deletes the service", () => {
  const exec = scmSimulator("running");
  const deps = baseDeps({ execFileSyncImpl: exec.impl });

  assert.equal(uninstallWindowsService(TEST_PROFILE, deps), true);

  assert.deepEqual(
    exec.calls.filter((call) => call.command === "sc.exe").map((call) => call.args[0]),
    ["stop", "delete"],
  );
});

test("Windows legacy cleanup leaves a clean machine untouched", () => {
  const exec = recordingExec((call) => {
    if (call.args[0] === "query" || call.args[0] === "/query") throw new Error("missing");
    return undefined;
  });
  const stopped: Array<string | undefined> = [];

  assert.equal(removeLegacyWindowsStartup("openclaw", {
    execFileSyncImpl: exec.impl,
    defaultProfileConfigured: false,
    stopLegacyProcess: (profile) => { stopped.push(profile); },
  }), true);

  assert.ok(exec.calls.every((call) => call.args[0] === "/query" || call.args[0] === "query"));
  assert.deepEqual(stopped, []);
});

test("Windows legacy cleanup removes the profile's own task and Run entry", () => {
  const exec = recordingExec((call) => {
    if (call.args.includes("ClawConnectAgent")) throw new Error("legacy default missing");
    return undefined;
  });
  const stopped: Array<string | undefined> = [];

  assert.equal(removeLegacyWindowsStartup("openclaw", {
    execFileSyncImpl: exec.impl,
    defaultProfileConfigured: false,
    stopLegacyProcess: (profile) => { stopped.push(profile); },
  }), true);

  const flat = exec.calls.map((call) => [call.command, ...call.args].join(" "));
  assert.ok(flat.includes("schtasks /delete /tn ClawConnectAgent-openclaw /f"));
  assert.ok(flat.includes(`reg.exe delete ${LEGACY_WINDOWS_RUN_KEY} /v ClawConnectAgent-openclaw /f`));
  assert.deepEqual(stopped, ["openclaw"]);
});

test("Windows legacy cleanup removes the orphaned unsuffixed entry only without a default profile", () => {
  const present = (call: Call) => !(call.args.includes("ClawConnectAgent-openclaw") && call.args[0].endsWith("uery"));
  const without = recordingExec((call) => (present(call) ? undefined : (() => { throw new Error("missing"); })()));
  removeLegacyWindowsStartup("openclaw", {
    execFileSyncImpl: without.impl,
    defaultProfileConfigured: false,
    stopLegacyProcess: () => undefined,
  });
  assert.ok(without.calls.some((call) => call.args[0] === "/delete" && call.args.includes("ClawConnectAgent")));

  const withDefault = recordingExec((call) => (present(call) ? undefined : (() => { throw new Error("missing"); })()));
  removeLegacyWindowsStartup("openclaw", {
    execFileSyncImpl: withDefault.impl,
    defaultProfileConfigured: true,
    stopLegacyProcess: () => undefined,
  });
  assert.ok(withDefault.calls.every((call) => !call.args.includes("ClawConnectAgent")));
});

test("Windows legacy cleanup fails closed on a delete failure or a timed-out probe", () => {
  const denied = recordingExec((call) => {
    if (call.args[0] === "/delete") throw new Error("access denied");
    return undefined;
  });
  assert.equal(removeLegacyWindowsStartup("hermes", {
    execFileSyncImpl: denied.impl,
    defaultProfileConfigured: true,
    stopLegacyProcess: () => undefined,
  }), false);

  const timedOut = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
  const slow = recordingExec(() => { throw timedOut; });
  assert.equal(removeLegacyWindowsStartup("hermes", {
    execFileSyncImpl: slow.impl,
    defaultProfileConfigured: true,
    onQueryTimeout: () => undefined,
    stopLegacyProcess: () => undefined,
  }), false);
  assert.ok(slow.calls.every((call) => call.args[0] === "/query" || call.args[0] === "query"));
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
