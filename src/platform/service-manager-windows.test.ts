import assert from "node:assert/strict";
import test from "node:test";
import { buildWindowsPowerShellBootstrap } from "./service-manager-windows.js";

test("buildWindowsPowerShellBootstrap configures UTF-8 for native process logs", () => {
  const command = "& 'node.exe' 'dist/index.js' 'run' >> 'log.txt' 2>> 'error.txt'";
  const script = buildWindowsPowerShellBootstrap(command);

  assert.match(script, /\[Console\]::InputEncoding = \$utf8NoBom/);
  assert.match(script, /\[Console\]::OutputEncoding = \$utf8NoBom/);
  assert.match(script, /\$OutputEncoding = \$utf8NoBom/);
  assert.match(script, /\$PSDefaultParameterValues\['Out-File:Encoding'\] = 'utf8'/);
  assert.ok(script.endsWith(command));
});
