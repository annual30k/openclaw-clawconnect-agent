import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildHermesArtifactUploadRequest,
  buildHermesRelayHelloMessage,
  collectHermesSlashCommandCatalog,
  searchHermesSlashCommandCatalog,
  shouldPublishHermesOfficeSnapshot,
} from "./hermes-relay-manager.js";

test("Hermes artifact uploads are linked to the assistant source run", () => {
  const request = buildHermesArtifactUploadRequest({
      artifactPath: "/tmp/reply.jpg",
      relayServerUrl: "https://relay.example",
      relaySecret: "secret-1",
      gatewayId: "gw-1",
      sessionKey: "main",
      runId: "run-voice-1",
    });
  assert.deepEqual(request, {
    relayServerUrl: "https://relay.example",
    relaySecret: "secret-1",
    gatewayId: "gw-1",
    sessionKey: "main",
    filePath: "/tmp/reply.jpg",
    sourceRunId: "run-voice-1",
  });
  assert.equal("json" in request, false);
  assert.equal("gateway" in request, false);
  assert.equal("session" in request, false);
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
