import assert from "node:assert/strict";
import test from "node:test";
import { isActiveMobileChatProcess } from "./install.js";

test("service restart is blocked inside an active mobile chat process", () => {
  assert.equal(isActiveMobileChatProcess({}), false);
  assert.equal(isActiveMobileChatProcess({ CLAWCONNECT_CHAT_SESSION_KEY: "main" }), true);
  assert.equal(isActiveMobileChatProcess({ CLAWCONNECT_SOURCE_RUN_ID: "run-1" }), true);
  assert.equal(isActiveMobileChatProcess({ CLAWCONNECT_CHAT_SESSION_KEY: "  " }), false);
});
