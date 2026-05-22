import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildHermesArtifactSendOptions,
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
