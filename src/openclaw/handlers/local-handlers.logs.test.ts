import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempHome = await mkdtemp(join(tmpdir(), "clawconnect-logs-"));
const openclawDir = join(tempHome, ".openclaw");
const logsDir = join(openclawDir, "logs");
const clawconnectDir = join(tempHome, ".clawconnect");
const defaultErrorLogPath = join(clawconnectDir, "clawconnect-error.log");
const profileOpenClawDir = join(clawconnectDir, "profiles", "openclaw");
const profileOpenClawConfigPath = join(profileOpenClawDir, "config.json");
const profileOpenClawLogPath = join(profileOpenClawDir, "clawconnect.log");
const latestLogPath = join(logsDir, "clawconnect.log");
const olderLogPath = join(logsDir, "clawconnect-error.log");

const originalHome = process.env.HOME;
const originalProfile = process.env.CLAWCONNECT_PROFILE;
process.env.HOME = tempHome;

await mkdir(logsDir, { recursive: true });
await mkdir(profileOpenClawDir, { recursive: true });

const olderLogLines = Array.from({ length: 20 }, (_, index) => `old-${index + 1}`);
const latestLogLines = Array.from({ length: 120 }, (_, index) => `new-${index + 1}`);

await writeFile(olderLogPath, `${olderLogLines.join("\n")}\n`);
await new Promise((resolve) => setTimeout(resolve, 25));
await writeFile(latestLogPath, `${latestLogLines.join("\n")}\n`);
await writeFile(profileOpenClawConfigPath, JSON.stringify({
  relayServerUrl: "http://127.0.0.1:8080",
  gatewayId: "gw_current",
  relaySecret: "secret",
  displayName: "Mac OpenClaw",
  gatewayType: "openclaw",
}));
await writeFile(profileOpenClawLogPath, "profile-openclaw\n");

const { handleLocalCommand } = await import(`./local-handlers.js?logs-test=${encodeURIComponent(tempHome)}`);

test.after(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalProfile === undefined) {
    delete process.env.CLAWCONNECT_PROFILE;
  } else {
    process.env.CLAWCONNECT_PROFILE = originalProfile;
  }
  await rm(tempHome, { recursive: true, force: true });
});

test("logs command returns all log lines from the newest file by default", () => {
  const result = handleLocalCommand("clawpilot.logs");
  assert.ok(result);
  assert.equal(result?.ok, true);

  const payload = result?.payload as any;
  assert.equal(payload.source, "connection");
  assert.equal(payload.logPath, latestLogPath);
  assert.equal(payload.totalLines, 120);
  assert.equal(payload.returnedLines, 120);
  assert.equal(payload.truncated, false);
});

test("logs command respects limit parameter", () => {
  const result = handleLocalCommand("clawpilot.logs", { limit: 10 });
  assert.ok(result);
  assert.equal(result?.ok, true);

  const payload = result?.payload as any;
  assert.equal(payload.returnedLines, 10);
  assert.equal(payload.truncated, true);
  assert.equal(payload.lines.length, 10);
  assert.equal(payload.lines[payload.lines.length - 1], "new-120");
});

test("logs command strips ANSI codes", async () => {
  const ansiLogPath = join(logsDir, "ansi.log");
  await writeFile(ansiLogPath, "\u001b[32mSUCCESS\u001b[39m\n");
  
  // Update mtime to make it newest (2 seconds ahead of current to bypass the "prefer main log" logic)
  const now = Date.now();
  await utimes(ansiLogPath, new Date(now + 2000), new Date(now + 2000));

  const result = handleLocalCommand("clawpilot.logs");
  const payload = result?.payload as any;
  
  assert.equal(payload.lines[0], "SUCCESS");
});

test("logs command reads OpenClaw gateway and error sources explicitly", async () => {
  const gatewayLogPath = join(logsDir, "gateway.log");
  const gatewayErrorLogPath = join(logsDir, "gateway.err.log");
  await writeFile(gatewayLogPath, "gateway-started\ngateway-ready\n");
  await writeFile(gatewayErrorLogPath, "gateway-failed\n");

  const gatewayPayload = handleLocalCommand("clawpilot.logs", { source: "gateway" })?.payload as any;
  const errorPayload = handleLocalCommand("clawpilot.logs", { source: "gateway-error" })?.payload as any;

  assert.equal(gatewayPayload.source, "gateway");
  assert.equal(gatewayPayload.logPath, gatewayLogPath);
  assert.deepEqual(gatewayPayload.lines, ["gateway-started", "gateway-ready"]);
  assert.equal(errorPayload.source, "gateway-error");
  assert.equal(errorPayload.logPath, gatewayErrorLogPath);
  assert.deepEqual(errorPayload.lines, ["gateway-failed"]);
});

test("logs command rejects unknown sources", () => {
  const result = handleLocalCommand("clawpilot.logs", { source: "../../secrets" });
  assert.equal(result?.ok, false);
  assert.equal(result?.error, "invalid_log_source");
});

test("logs command reads the active profile log before newer default logs", async () => {
  await writeFile(defaultErrorLogPath, "default-error\n");
  const now = Date.now();
  await utimes(defaultErrorLogPath, new Date(now + 3000), new Date(now + 3000));
  await utimes(profileOpenClawLogPath, new Date(now + 1000), new Date(now + 1000));

  process.env.CLAWCONNECT_PROFILE = "openclaw";
  const result = handleLocalCommand("clawpilot.logs");
  const payload = result?.payload as any;

  assert.equal(payload.logPath, profileOpenClawLogPath);
  assert.deepEqual(payload.lines, ["profile-openclaw"]);
  delete process.env.CLAWCONNECT_PROFILE;
});

test("logs command scopes active profile logs to the current gateway run", async () => {
  await writeFile(profileOpenClawLogPath, [
    "Starting ClawConnect host agent…",
    "  Gateway ID:   gw_old",
    "old-gateway-line",
    "Starting ClawConnect host agent…",
    "  Gateway ID:   gw_current",
    "current-gateway-line",
  ].join("\n"));

  process.env.CLAWCONNECT_PROFILE = "openclaw";
  const result = handleLocalCommand("clawpilot.logs");
  const payload = result?.payload as any;

  assert.equal(payload.logPath, profileOpenClawLogPath);
  assert.deepEqual(payload.lines, [
    "Starting ClawConnect host agent…",
    "  Gateway ID:   gw_current",
    "current-gateway-line",
  ]);
  delete process.env.CLAWCONNECT_PROFILE;
});
