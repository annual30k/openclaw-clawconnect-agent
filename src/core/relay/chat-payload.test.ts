import assert from "node:assert/strict";
import test from "node:test";
import { extractChatRole, normalizeChatEventPayload } from "./chat-payload.js";

test("chat phase normalization accepts only controlled protocol values", () => {
  const unchanged = normalizeChatEventPayload({ phase: "streaming but already final", text: "hello" }) as Record<string, unknown>;
  assert.equal(unchanged.state, undefined);

  const final = normalizeChatEventPayload({ phase: "completed", text: "hello" }) as Record<string, unknown>;
  assert.equal(final.state, "final");
  // Normal OpenClaw visible deltas/finals carry provenance in message.role;
  // terminal lifecycle errors are allowed to omit it and are handled only
  // through the relay's previously registered provider run context.
  assert.equal(extractChatRole(final), "");
  assert.equal(extractChatRole({ state: "final", message: { role: "assistant" } }), "assistant");
  assert.equal(extractChatRole({ state: "error", error: { message: "failed" } }), "");
});
