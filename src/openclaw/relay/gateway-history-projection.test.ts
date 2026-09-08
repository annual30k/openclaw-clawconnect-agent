import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeOpenClawGatewayHistoryResponse } from "./chat-history.js";
import { restoreGatewayHistoryMessages } from "./gateway-history-projection.js";

test("v4 commentary projections share one archive row without losing subsequent errors, text, or media", () => {
  const meta = { id: "original", runId: "run", seq: 9, transcriptPosition: { source: "source", rawSeq: 11 } };
  const result = canonicalizeOpenClawGatewayHistoryResponse({ sessionId: "scope", messages: [
    { role: "assistant", content: [{ type: "text", text: "commentary" }], __openclaw: meta, openclawStreamFallback: { source: "segment", itemId: "commentary-1" } },
    { role: "assistant", content: [{ type: "toolCall", id: "tool1", name: "read" }], __openclaw: meta },
    { role: "assistant", errorMessage: "failed", content: [], __openclaw: { ...meta, id: "error", seq: 10 } },
    { role: "user", content: "", __openclaw: { id: "image-user", seq: 11, media: [{ url: "media://inbound/photo.png", kind: "image", contentType: "image/png" }] } },
    { role: "assistant", content: "recovered", __openclaw: { id: "recovery", seq: 12, runId: "new-run" } },
  ] }, { sessionKey: "agent:health:chat" });
  const messages = result.timelineSnapshot!.messages;
  assert.deepEqual(messages.map(m => m.seq), [9, 10, 11, 12]);
  assert.deepEqual(messages[0]!.content.map(c => c.type), ["text", "toolcall"]);
  assert.equal(messages[1]!.messageState, "failed");
  assert.equal(messages[2]!.content[0]!.url, "media://inbound/photo.png");
  assert.equal(messages[3]!.content[0]!.text, "recovered");
});

test("different archive identities with equal text remain separate", () => {
  const result = canonicalizeOpenClawGatewayHistoryResponse({ messages: [1, 2].map(seq => ({ role: "user", content: "same", __openclaw: { id: `user-${seq}`, seq } })) }, { sessionKey: "agent:health:chat" });
  assert.equal(result.timelineSnapshot!.messages.length, 2);
});

test("delivery-mirror images become canonical history content for mobile clients", () => {
  const runId = "run-display-mirror";
  const displayUrl = "/api/chat/media/outgoing/agent%3Amain%3Asession_1/att_display/full";
  const result = canonicalizeOpenClawGatewayHistoryResponse({
    sessionKey: "agent:main:session_1",
    messages: [
      {
        role: "assistant",
        id: "tool-call",
        __openclaw: { runId, seq: 10 },
        content: [{ type: "toolCall", id: "call_display", name: "message" }],
      },
      {
        role: "assistant",
        id: "delivery-mirror",
        idempotencyKey: `${runId}:message-tool:delivery-display:call_display`,
        __openclaw: { runId, seq: 11 },
        content: [],
        openclawDisplayContent: [{
          type: "image",
          artifactId: "artifact_managed_image_display",
          url: displayUrl,
          alt: "photo.png",
          mimeType: "image/png",
        }],
      },
    ],
  }, { sessionKey: "agent:main:session_1" });

  const messages = result.timelineSnapshot!.messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.content[1]!.type, "image");
  assert.equal(messages[0]!.content[1]!.url, displayUrl);
});

test("an early stream sidecar never moves its archive row ahead of intervening history", () => {
  const meta = { id: "original", seq: 9, transcriptPosition: { source: "source", rawSeq: 11 } };
  const restored = restoreGatewayHistoryMessages([
    { role: "assistant", content: "stream fragment", __openclaw: meta, openclawStreamFallback: { source: "segment", itemId: "fragment" } },
    { role: "assistant", content: "intervening archive row", __openclaw: { id: "next", seq: 10 } },
    { role: "assistant", content: "archive row", __openclaw: meta },
  ]);
  assert.deepEqual(restored.map(message => message.content), [
    "intervening archive row",
    [{ type: "text", text: "stream fragment" }, { type: "text", text: "archive row" }],
  ]);
});
