import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildWindowsPowerShellBootstrap,
  buildWindowsProcessQueryScript,
  buildWindowsServiceProcessCommand,
  buildWindowsServiceTaskCommand,
  normalizeWindowsServiceLogEncoding,
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
  assert.match(buildWindowsProcessQueryScript(), /-notmatch/);
});
