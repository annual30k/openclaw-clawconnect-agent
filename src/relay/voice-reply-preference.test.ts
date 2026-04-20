import assert from "assert/strict";
import test from "node:test";
import { VoiceReplyPreferenceStore } from "./voice-reply-preference.js";

test("voice reply preference store falls back from runId to sessionKey", () => {
  const store = new VoiceReplyPreferenceStore(false, {
    mainSessionKey: "agent:main:main",
    mainKey: "main",
    defaultAgentId: "main",
  });

  store.register({
    runId: "run-1",
    sessionKey: "main",
    enabled: true,
  });

  assert.equal(store.shouldUse("run-1", "agent:main:main"), true);
  assert.equal(store.shouldUse("other-run", "main"), true);

  store.clearRun("run-1");

  assert.equal(store.shouldUse("run-1", "main"), true);
});

test("voice reply preference store respects explicit session-level disable", () => {
  const store = new VoiceReplyPreferenceStore(true, {
    mainSessionKey: "agent:main:main",
    mainKey: "main",
    defaultAgentId: "main",
  });

  store.register({
    sessionKey: "main",
    enabled: false,
  });

  assert.equal(store.shouldUse(undefined, "agent:main:main"), false);
  assert.equal(store.shouldUse("missing-run", "main"), false);
});
