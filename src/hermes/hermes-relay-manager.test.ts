import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildHermesArtifactSendOptions,
  buildHermesNewSessionResetPayload,
  buildHermesRelayHelloMessage,
  collectHermesSlashCommandCatalog,
  isHermesNewSessionResetParams,
  searchHermesSlashCommandCatalog,
  shouldPublishHermesOfficeSnapshot,
} from "./hermes-relay-manager.js";

test("Hermes artifact uploads are linked to the assistant source run", () => {
  assert.deepEqual(
    buildHermesArtifactSendOptions({
      artifactPath: "/tmp/reply.jpg",
      gatewayId: "gw-1",
      sessionKey: "main",
      runId: "run-voice-1",
    }),
    {
      filePath: "/tmp/reply.jpg",
      gateway: "gw-1",
      session: "main",
      json: true,
      sourceRunId: "run-voice-1",
    },
  );
});

test("Hermes office snapshots skip high-frequency assistant deltas", () => {
  assert.equal(
    shouldPublishHermesOfficeSnapshot("chat", {
      state: "delta",
      role: "assistant",
      delta: "hello",
    }),
    false,
  );

  assert.equal(
    shouldPublishHermesOfficeSnapshot("chat", {
      state: "final",
      role: "assistant",
      message: { content: [{ type: "text", text: "done" }] },
    }),
    true,
  );
});

test("Hermes /new reset payload does not carry stale context usage", () => {
  assert.equal(isHermesNewSessionResetParams({ message: " /NEW ", sessionKey: "ios-1" }), true);
  assert.equal(isHermesNewSessionResetParams({ message: "/new keep this text", sessionKey: "ios-1" }), false);
  assert.equal(isHermesNewSessionResetParams({ message: "/model", sessionKey: "ios-1" }), false);

  assert.deepEqual(
    buildHermesNewSessionResetPayload({ runId: "run-1", sessionKey: "ios-1" }),
    {
      runId: "run-1",
      sessionKey: "ios-1",
      state: "final",
      role: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "新会话已开始。有什么需要我帮你处理的？" }],
      },
    },
  );
});

test("Hermes slash command catalog is loaded from Hermes terminal metadata", () => {
  const catalog = collectHermesSlashCommandCatalog(() => JSON.stringify([
    {
      command: "/new",
      title: "new",
      detail: "Start a new session",
    },
    {
      command: "model",
      title: "model",
      description: "Switch model",
    },
    {
      command: "/new",
      title: "duplicate",
      detail: "Duplicate command",
    },
    {
      command: "",
      title: "ignored",
      detail: "Ignored command",
    },
  ]));

  assert.deepEqual(catalog, [
    {
      source: "Hermes",
      command: "/new",
      title: "new",
      detail: "Start a new session",
    },
    {
      source: "Hermes",
      command: "/model",
      title: "model",
      detail: "Switch model",
    },
  ]);
});

test("Hermes relay hello does not eagerly include Hermes slash commands", () => {
  const hello = buildHermesRelayHelloMessage({
    platform: "darwin (Hermes)",
    agentVersion: "hermes",
    capabilities: ["chat"],
  });

  assert.deepEqual(hello, {
    type: "hello",
    platform: "darwin (Hermes)",
    agentVersion: "hermes",
    capabilities: ["chat"],
  });
});

test("Hermes relay hello can still include explicit slash commands for compatibility", () => {
  const slashCommands = [
    {
      source: "Hermes" as const,
      command: "/retry",
      title: "retry",
      detail: "Retry the last message",
    },
  ];

  assert.deepEqual(
    buildHermesRelayHelloMessage({
      platform: "darwin (Hermes)",
      agentVersion: "hermes",
      capabilities: ["chat"],
      slashCommands,
    }),
    {
      type: "hello",
      platform: "darwin (Hermes)",
      agentVersion: "hermes",
      capabilities: ["chat"],
      slashCommands,
    },
  );
});

test("Hermes slash command search filters, paginates, and fuzzy matches the terminal catalog lazily", () => {
  const result = searchHermesSlashCommandCatalog({
    query: "/mdl",
    limit: 1,
    offset: 1,
    collect: () => [
      {
        source: "Hermes",
        command: "/new",
        title: "new",
        detail: "Start a new session",
      },
      {
        source: "Hermes",
        command: "/model",
        title: "model",
        detail: "Switch model",
      },
      {
        source: "Hermes",
        command: "/model provider",
        title: "model provider",
        detail: "Switch provider",
      },
      {
        source: "Hermes",
        command: "/history",
        title: "history",
        detail: "Show history",
      },
    ],
  });

  assert.deepEqual(result, {
    items: [
      {
        source: "Hermes",
        command: "/model provider",
        title: "model provider",
        detail: "Switch provider",
      },
    ],
    hasMore: false,
    total: 2,
  });
});
