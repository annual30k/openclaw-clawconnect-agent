import assert from "node:assert/strict";
import test from "node:test";
import { buildRelayHelloMessage } from "../relay-manager.js";
import { OPENCLAW_SLASH_COMMAND_CATALOG } from "./slash-command-catalog.js";

test("OpenClaw slash command catalog includes the upstream builtin surface", () => {
  const commands = OPENCLAW_SLASH_COMMAND_CATALOG.map(({ command }) => command.toLowerCase());

  assert.ok(commands.length >= 30);
  assert.equal(new Set(commands).size, commands.length);
  assert.equal(commands.includes("/tts"), false);

  for (const command of [
    "/help",
    "/commands",
    "/tools",
    "/skill",
    "/status",
    "/tasks",
    "/export-session",
    "/export",
    "/plugins",
    "/plugin",
    "/config",
    "/mcp",
    "/model",
    "/models",
    "/queue",
    "/bash",
    "/new",
    "/compact",
    "/think",
    "/verbose",
    "/usage",
    "/restart",
    "/activation",
  ]) {
    assert.ok(commands.includes(command));
  }
});

test("relay hello payload includes the shared slash command catalog", () => {
  const hello = buildRelayHelloMessage({
    platform: "darwin",
    agentVersion: "1.0.0",
    capabilities: ["chat", "skills"],
  });

  assert.equal(hello.type, "hello");
  assert.equal(hello.platform, "darwin");
  assert.equal(hello.agentVersion, "1.0.0");
  assert.deepEqual(hello.capabilities, ["chat", "skills"]);
  assert.deepEqual(hello.slashCommands, OPENCLAW_SLASH_COMMAND_CATALOG);
  assert.deepEqual(
    hello.slashCommands?.map(({ source, command, title, detail }) => ({ source, command, title, detail })),
    OPENCLAW_SLASH_COMMAND_CATALOG,
  );
});
