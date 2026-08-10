import assert from "node:assert/strict";
import test from "node:test";

import { getLinuxServicePaths } from "./service-manager-linux.js";

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
