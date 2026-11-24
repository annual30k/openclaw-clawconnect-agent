import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildLinuxSystemdUnit,
  findLinuxProfileAgentPids,
  formatSystemdExecArg,
  getLinuxServicePaths,
  getLinuxServiceStatus,
  installLinuxService,
  isMatchingLinuxAgentRunArgv,
  restartLinuxService,
  stopLinuxService,
  type LinuxServicePaths,
} from "./service-manager-linux.js";

function withTempSandbox(runTest: (sandboxDir: string, paths: LinuxServicePaths) => void): void {
  const sandboxDir = mkdtempSync(join(tmpdir(), "clawconnect-linux-svc-"));
  const profileDir = join(sandboxDir, "profiles", "hermes");
  mkdirSync(profileDir, { recursive: true });
  const paths: LinuxServicePaths = {
    profile: "hermes",
    serviceName: "clawconnect-agent-hermes.service",
    servicePath: join(sandboxDir, "systemd", "user", "clawconnect-agent-hermes.service"),
    pidPath: join(profileDir, "clawconnect.pid"),
    startScriptPath: join(profileDir, "clawconnect-start.sh"),
    workingDirectory: profileDir,
    logPath: join(profileDir, "clawconnect.log"),
    errorLogPath: join(profileDir, "clawconnect-error.log"),
  };
  try {
    runTest(sandboxDir, paths);
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
}

function writeFakeProcEntry(procRoot: string, pid: number, argv: readonly string[]): void {
  const dir = join(procRoot, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cmdline"), `${argv.join("\0")}\0`, "utf8");
}

test("Linux OpenClaw and Hermes service definitions do not share mutable paths", () => {
  const openclaw = getLinuxServicePaths("openclaw");
  const hermes = getLinuxServicePaths("hermes");

  assert.equal(openclaw.serviceName, "clawconnect-agent-openclaw.service");
  assert.equal(hermes.serviceName, "clawconnect-agent-hermes.service");
  assert.notEqual(openclaw.servicePath, hermes.servicePath);
  assert.notEqual(openclaw.pidPath, hermes.pidPath);
  assert.notEqual(openclaw.startScriptPath, hermes.startScriptPath);
  assert.notEqual(openclaw.workingDirectory, hermes.workingDirectory);
  assert.notEqual(openclaw.logPath, hermes.logPath);
  assert.notEqual(openclaw.errorLogPath, hermes.errorLogPath);
});

test("systemd unit writes unquoted WorkingDirectory and escapes systemd specifiers and ExecStart args", () => {
  const unit = buildLinuxSystemdUnit({
    profile: "hermes",
    programArgs: [
      "/home/dick86114/.nvm/versions/node/v22.23.2/bin/node",
      "/home/dick86114/.nvm/versions/node/v22.23.2/lib/node_modules/clawconnect-agent/dist/index.js",
      "run",
      "--profile",
      "hermes",
    ],
    workingDirectory: "/home/dick86114/.clawconnect/profiles/hermes",
    stdoutLogPath: "/home/dick86114/.clawconnect/profiles/hermes/clawconnect.log",
    stderrLogPath: "/home/dick86114/.clawconnect/profiles/hermes/clawconnect-error.log",
  });

  assert.match(unit, /^WorkingDirectory=\/home\/dick86114\/\.clawconnect\/profiles\/hermes$/m);
  assert.doesNotMatch(unit, /^WorkingDirectory=['"]/m);
  assert.match(
    unit,
    /^ExecStart=\/home\/dick86114\/\.nvm\/versions\/node\/v22\.23\.2\/bin\/node \/home\/dick86114\/\.nvm\/versions\/node\/v22\.23\.2\/lib\/node_modules\/clawconnect-agent\/dist\/index\.js run --profile hermes$/m,
  );
  assert.equal(formatSystemdExecArg("/opt/a$b/100%"), "/opt/a$$b/100%%");
  assert.equal(
    formatSystemdExecArg('/home/Admin User/dir$1/100%/"q"\\x'),
    '"/home/Admin User/dir$$1/100%%/\\"q\\"\\\\x"',
  );
});

test("systemd unit rejects line breaks and empty ExecStart arguments", () => {
  assert.throws(
    () => buildLinuxSystemdUnit({
      programArgs: [],
      workingDirectory: "/tmp/work",
      stdoutLogPath: "/tmp/out.log",
      stderrLogPath: "/tmp/err.log",
    }),
    /at least one program argument/,
  );
  assert.throws(
    () => buildLinuxSystemdUnit({
      programArgs: ["/usr/bin/node", "/app/index.js"],
      workingDirectory: "/tmp/work\nExecStart=/bin/evil",
      stdoutLogPath: "/tmp/out.log",
      stderrLogPath: "/tmp/err.log",
    }),
    /must not contain line breaks/,
  );
});

test("Linux process matcher isolates profiles and ignores non-run commands or recycled PIDs", () => {
  const entry = "/opt/clawconnect-agent/dist/index.js";
  assert.equal(isMatchingLinuxAgentRunArgv(["node", entry, "run", "--profile", "hermes"], "hermes", entry), true);
  assert.equal(isMatchingLinuxAgentRunArgv(["node", entry, "run", "--profile=hermes"], "hermes", entry), true);
  assert.equal(isMatchingLinuxAgentRunArgv(["/usr/local/bin/clawconnect", "run", "-p", "hermes"], "hermes"), true);
  assert.equal(isMatchingLinuxAgentRunArgv(["node", entry, "run"], undefined, entry), true);

  assert.equal(isMatchingLinuxAgentRunArgv(["node", entry, "run", "--profile", "openclaw"], "hermes", entry), false);
  assert.equal(isMatchingLinuxAgentRunArgv(["node", entry, "run"], "hermes", entry), false);
  assert.equal(isMatchingLinuxAgentRunArgv(["node", entry, "pair-hermes"], "hermes", entry), false);
  assert.equal(isMatchingLinuxAgentRunArgv(["node", entry, "reset-hermes"], "hermes", entry), false);
  assert.equal(isMatchingLinuxAgentRunArgv(["node", entry, "send-file", "run", "--profile", "hermes"], "hermes", entry), false);

  withTempSandbox((sandboxDir, paths) => {
    const procRoot = join(sandboxDir, "proc");
    mkdirSync(procRoot, { recursive: true });
    // Recycled PID in clawconnect.pid belonging to tmux must NOT be targeted.
    writeFileSync(paths.pidPath, "1111\n", "utf8");
    writeFakeProcEntry(procRoot, 1111, ["/usr/bin/tmux", "new-session"]);
    // Orphan Hermes agent process without pid file MUST be discovered.
    writeFakeProcEntry(procRoot, 2222, ["/usr/bin/node", entry, "run", "--profile", "hermes"]);
    // OpenClaw profile process must NOT be touched.
    writeFakeProcEntry(procRoot, 3333, ["/usr/bin/node", entry, "run", "--profile", "openclaw"]);

    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const pids = findLinuxProfileAgentPids(paths, {
      procRoot,
      currentPid: 9999,
      currentUid: uid,
      entryScriptPath: entry,
      isPidRunning: () => true,
    });
    assert.deepEqual(pids, [2222]);
  });
});

test("systemd install stops leftover nohup agent before enabling service", () => {
  withTempSandbox((sandboxDir, paths) => {
    const procRoot = join(sandboxDir, "proc");
    const entry = "/opt/clawconnect-agent/dist/index.js";
    writeFileSync(paths.pidPath, "3432036\n", "utf8");
    writeFileSync(paths.startScriptPath, "#!/usr/bin/env bash\n", "utf8");
    writeFakeProcEntry(procRoot, 3432036, ["/usr/bin/node", entry, "run", "--profile", "hermes"]);

    const alive = new Set([3432036]);
    const commands: string[] = [];
    const signals: Array<{ pid: number; signal: string }> = [];
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;

    const ok = installLinuxService("hermes", {
      paths,
      procRoot,
      currentPid: 9999,
      currentUid: uid,
      entryScriptPath: entry,
      programArgs: ["/usr/bin/node", entry, "run", "--profile", "hermes"],
      canUseSystemd: true,
      isPidRunning: (pid) => alive.has(pid),
      killPid: (pid, signal) => {
        signals.push({ pid, signal });
        alive.delete(pid);
      },
      sleepSync: () => undefined,
      runCommand: (command) => {
        commands.push(command);
        return "";
      },
    });

    assert.equal(ok, true);
    assert.deepEqual(signals, [{ pid: 3432036, signal: "SIGTERM" }]);
    assert.equal(existsSync(paths.pidPath), false);
    assert.equal(existsSync(paths.startScriptPath), false);
    assert.equal(existsSync(paths.servicePath), true);
    assert.doesNotMatch(readFileSync(paths.servicePath, "utf8"), /^WorkingDirectory='/m);
    assert.ok(commands.includes("systemctl --user enable --now clawconnect-agent-hermes.service"));
  });
});

test("nohup fallback replaces an already-running stale process instead of reusing old credentials", () => {
  withTempSandbox((sandboxDir, paths) => {
    const procRoot = join(sandboxDir, "proc");
    const entry = "/opt/clawconnect-agent/dist/index.js";
    writeFileSync(paths.pidPath, "3432036\n", "utf8");
    writeFakeProcEntry(procRoot, 3432036, ["/usr/bin/node", entry, "run", "--profile", "hermes"]);

    const alive = new Set([3432036]);
    const signals: Array<{ pid: number; signal: string }> = [];
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;

    const ok = installLinuxService("hermes", {
      paths,
      procRoot,
      currentPid: 9999,
      currentUid: uid,
      entryScriptPath: entry,
      programArgs: ["/usr/bin/node", entry, "run", "--profile", "hermes"],
      canUseSystemd: true,
      isPidRunning: (pid) => alive.has(pid),
      killPid: (pid, signal) => {
        signals.push({ pid, signal });
        alive.delete(pid);
      },
      sleepSync: () => undefined,
      runCommand: (command) => {
        if (command.startsWith("systemctl --user enable")) {
          throw new Error("systemd user bus failed");
        }
        if (command.startsWith("systemctl --user is-active")) {
          throw new Error("inactive");
        }
        if (command.startsWith("sh -lc ")) {
          assert.equal(alive.has(3432036), false, "old PID must be stopped before starting nohup");
          assert.equal(existsSync(paths.pidPath), false, "old pid file must be cleared before starting nohup");
          writeFileSync(paths.pidPath, "3432999\n", "utf8");
          alive.add(3432999);
        }
        return "";
      },
    });

    assert.equal(ok, true);
    assert.deepEqual(signals, [{ pid: 3432036, signal: "SIGTERM" }]);
    assert.equal(existsSync(paths.servicePath), false, "failed systemd unit should not remain on disk");
    assert.equal(readFileSync(paths.pidPath, "utf8").trim(), "3432999");

    const status = getLinuxServiceStatus("hermes", {
      paths,
      canUseSystemd: true,
      isPidRunning: (pid) => alive.has(pid),
    });
    assert.equal(status.manager, "nohup");
    assert.equal(status.running, true);
  });
});

test("stopLinuxService waits for graceful exit and escalates to SIGKILL before outbox reset", () => {
  const testProfile = `unit-test-linux-${process.pid}-${Date.now()}`;
  withTempSandbox((sandboxDir, basePaths) => {
    const paths: LinuxServicePaths = { ...basePaths, profile: testProfile };
    const procRoot = join(sandboxDir, "proc");
    const entry = "/opt/clawconnect-agent/dist/index.js";
    // Simulate a stuck orphan process whose pid file was already missing.
    const fakePid = 2_147_483_640;
    writeFakeProcEntry(procRoot, fakePid, ["/usr/bin/node", entry, "run", "--profile", testProfile]);

    let running = true;
    let pollTicks = 0;
    const signals: string[] = [];
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;

    const stopped = stopLinuxService(testProfile, {
      paths,
      procRoot,
      currentPid: 9999,
      currentUid: uid,
      entryScriptPath: entry,
      canUseSystemd: false,
      sigtermTimeoutMs: 150,
      sigkillTimeoutMs: 100,
      pollIntervalMs: 50,
      isPidRunning: () => running,
      killPid: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") {
          running = false;
        }
      },
      sleepSync: () => {
        pollTicks += 1;
      },
    });

    assert.equal(stopped, true);
    assert.equal(running, false);
    assert.equal(pollTicks, 3);
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  });
});

test("stopLinuxService waits for delayed SIGTERM exit before removing pid file", () => {
  const testProfile = `unit-test-sigterm-${process.pid}-${Date.now()}`;
  withTempSandbox((sandboxDir, basePaths) => {
    const paths: LinuxServicePaths = { ...basePaths, profile: testProfile };
    const procRoot = join(sandboxDir, "proc");
    const entry = "/opt/clawconnect-agent/dist/index.js";
    writeFileSync(paths.pidPath, "3432036\n", "utf8");
    writeFakeProcEntry(procRoot, 3432036, ["/usr/bin/node", entry, "run", "--profile", testProfile]);

    let pollsRemaining = 2;
    const signals: string[] = [];
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;

    const stopped = stopLinuxService(testProfile, {
      paths,
      procRoot,
      currentPid: 9999,
      currentUid: uid,
      entryScriptPath: entry,
      canUseSystemd: false,
      sigtermTimeoutMs: 500,
      pollIntervalMs: 50,
      isPidRunning: () => pollsRemaining > 0,
      killPid: (_pid, signal) => {
        signals.push(signal);
        assert.equal(existsSync(paths.pidPath), true, "pid file must remain until process actually exits");
      },
      sleepSync: () => {
        pollsRemaining -= 1;
      },
    });

    assert.equal(stopped, true);
    assert.equal(pollsRemaining, 0);
    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(existsSync(paths.pidPath), false);
  });
});

test("restartLinuxService heals a legacy single-quoted systemd unit file", () => {
  withTempSandbox((_sandboxDir, paths) => {
    mkdirSync(join(paths.servicePath, ".."), { recursive: true });
    writeFileSync(paths.servicePath, "[Service]\nWorkingDirectory='/broken/legacy/path'\n", "utf8");
    const commands: string[] = [];

    const restarted = restartLinuxService("hermes", {
      paths,
      canUseSystemd: true,
      programArgs: ["/usr/bin/node", "/opt/clawconnect-agent/dist/index.js", "run", "--profile", "hermes"],
      isPidRunning: () => false,
      sleepSync: () => undefined,
      runCommand: (command) => {
        commands.push(command);
        return "";
      },
    });

    assert.equal(restarted, true);
    const healed = readFileSync(paths.servicePath, "utf8");
    assert.doesNotMatch(healed, /WorkingDirectory='/);
    assert.match(healed, new RegExp(`^WorkingDirectory=${paths.workingDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    assert.ok(commands.includes("systemctl --user start clawconnect-agent-hermes.service"));
  });
});
