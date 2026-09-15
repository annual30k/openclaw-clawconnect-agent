import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  OPENCLAW_ACTIVE_RUN_TTL_MS,
  clearOpenClawActiveRun,
  markOpenClawActiveRunTerminal,
  recordOpenClawActiveRun,
  resolveOpenClawActiveRun,
} from "./openclaw-active-run-state.js";

test("OpenClaw active run state isolates concurrent sessions and consumes exact scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-active-run-state-"));
  const previous = process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE;
  process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE = join(root, "active-runs.json");
  try {
    await recordOpenClawActiveRun({ gatewayId: "gw", sessionKey: "agent:main:alpha", sourceRunId: "run-alpha" });
    await recordOpenClawActiveRun({ gatewayId: "gw", sessionKey: "agent:main:beta", sourceRunId: "run-beta" });
    await recordOpenClawActiveRun({ profile: "other", gatewayId: "gw", sessionKey: "agent:main:alpha", sourceRunId: "run-other-profile" });

    assert.equal(
      (await resolveOpenClawActiveRun({ gatewayId: "gw", sessionKey: "agent:main:alpha", sourceRunId: "run-alpha" }))?.sourceRunId,
      "run-alpha",
    );
    assert.equal(
      (await resolveOpenClawActiveRun({ gatewayId: "gw", sessionKey: "agent:main:beta", sourceRunId: "run-beta" }))?.sourceRunId,
      "run-beta",
    );
    assert.equal(await resolveOpenClawActiveRun({ gatewayId: "other", sessionKey: "agent:main:alpha", sourceRunId: "run-alpha" }), undefined);
    assert.equal(
      (await resolveOpenClawActiveRun({ profile: "other", gatewayId: "gw", sessionKey: "agent:main:alpha", sourceRunId: "run-other-profile" }))?.sourceRunId,
      "run-other-profile",
    );
  } finally {
    if (previous === undefined) delete process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE;
    else process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenClaw ownership keeps agent-qualified sessions distinct when Relay aliases match", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-active-run-state-"));
  const previous = process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE;
  process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE = join(root, "active-runs.json");
  try {
    await recordOpenClawActiveRun({ gatewayId: "gw", sessionKey: "agent:main:main", sourceRunId: "run-main" });
    await recordOpenClawActiveRun({ gatewayId: "gw", sessionKey: "agent:health-manager:main", sourceRunId: "run-health" });

    assert.equal(
      (await resolveOpenClawActiveRun({ gatewayId: "gw", sessionKey: "agent:main:main", sourceRunId: "run-main" }))?.sourceRunId,
      "run-main",
    );
    assert.equal(
      (await resolveOpenClawActiveRun({ gatewayId: "gw", sessionKey: "agent:health-manager:main", sourceRunId: "run-health" }))?.sourceRunId,
      "run-health",
    );
  } finally {
    if (previous === undefined) delete process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE;
    else process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenClaw active run state fails closed for ambiguous same-session runs and expired scopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-active-run-state-"));
  const previous = process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE;
  process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE = join(root, "active-runs.json");
  try {
    await recordOpenClawActiveRun({ gatewayId: "gw", sessionKey: "main", sourceRunId: "run-1" });
    await recordOpenClawActiveRun({ gatewayId: "gw", sessionKey: "main", sourceRunId: "run-2" });
    assert.equal(await resolveOpenClawActiveRun({ gatewayId: "gw", sessionKey: "main", sourceRunId: "run-unknown" }), undefined);
    assert.equal(
      (await resolveOpenClawActiveRun({ gatewayId: "gw", sessionKey: "main", sourceRunId: "run-2" }))?.sourceRunId,
      "run-2",
    );
    assert.equal(
      await resolveOpenClawActiveRun({ gatewayId: "gw", sessionKey: "main", sourceRunId: "run-2", nowMs: Date.now() + OPENCLAW_ACTIVE_RUN_TTL_MS + 1 }),
      undefined,
    );
  } finally {
    if (previous === undefined) delete process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE;
    else process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenClaw terminal state has bounded grace and explicit clear", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-active-run-state-"));
  const previous = process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE;
  process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE = join(root, "active-runs.json");
  try {
    await recordOpenClawActiveRun({ gatewayId: "gw", sessionKey: "main", sourceRunId: "run-terminal" });
    await markOpenClawActiveRunTerminal({ gatewayId: "gw", sessionKey: "main", sourceRunId: "run-terminal" });
    assert.equal((await resolveOpenClawActiveRun({ gatewayId: "gw", sessionKey: "main", sourceRunId: "run-terminal" }))?.state, "terminal");
    await clearOpenClawActiveRun({ gatewayId: "gw", sessionKey: "main", sourceRunId: "run-terminal" });
    assert.equal(await resolveOpenClawActiveRun({ gatewayId: "gw", sessionKey: "main", sourceRunId: "run-terminal" }), undefined);
  } finally {
    if (previous === undefined) delete process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE;
    else process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE = previous;
    await rm(root, { recursive: true, force: true });
  }
});
