import assert from "node:assert/strict";
import test from "node:test";

import { dedupeChatSendUserMirrorTranscriptText } from "./transcript-dedupe.js";

test("dedupeChatSendUserMirrorTranscriptText removes OpenClaw prompt mirror for the same mobile chat.send", () => {
  const transcript = [
    JSON.stringify({
      type: "session",
      id: "session-1",
      timestamp: "2026-06-01T01:43:00.000Z",
    }),
    JSON.stringify({
      type: "message",
      id: "original-user",
      parentId: "previous-assistant",
      timestamp: "2026-06-01T01:43:55.270Z",
      message: {
        role: "user",
        content: "后天福州的天气怎么样返回表格",
        timestamp: 1780278235251,
        idempotencyKey: "BE8F866D-DE1B-4BF5-ACDC-738F4064B7FF:user",
      },
    }),
    JSON.stringify({
      type: "message",
      id: "prompt-mirror",
      parentId: "original-user",
      timestamp: "2026-06-01T01:44:11.853Z",
      message: {
        role: "user",
        content: "[Mon 2026-06-01 09:43 GMT+8] 后天福州的天气怎么样返回表格",
        timestamp: 1780278251848,
        sourceChannel: "webchat",
        senderId: "openclaw-macos",
        senderName: "ClawConnect Agent",
        senderUsername: "ClawConnect Agent",
        senderLabel: "ClawConnect Agent (openclaw-macos)",
        __openclaw: { mirrorIdentity: "019e80da-1f19-7ff2-b2ab-38ee28551745:prompt" },
        idempotencyKey: "codex-app-server:thread-1:019e80da-1f19-7ff2-b2ab-38ee28551745:prompt",
      },
    }),
    JSON.stringify({
      type: "message",
      id: "tool-call",
      parentId: "prompt-mirror",
      timestamp: "2026-06-01T01:44:11.856Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool-1", name: "web_search" }],
      },
    }),
  ].join("\n") + "\n";

  const result = dedupeChatSendUserMirrorTranscriptText(transcript, {
    clientRunId: "BE8F866D-DE1B-4BF5-ACDC-738F4064B7FF",
    message: "后天福州的天气怎么样返回表格",
    senderId: "openclaw-macos",
    senderName: "ClawConnect Agent",
  });

  assert.equal(result.removedCount, 1);
  assert.equal(result.changed, true);
  assert.equal(result.text.includes("prompt-mirror"), false);
  const rewrittenToolCall = result.text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id?: string; parentId?: string })
    .find((entry) => entry.id === "tool-call");
  assert.equal(rewrittenToolCall?.parentId, "original-user");
});

test("dedupeChatSendUserMirrorTranscriptText keeps a real repeated same-text user turn", () => {
  const transcript = [
    JSON.stringify({
      type: "message",
      id: "original-user",
      parentId: "previous-assistant",
      message: {
        role: "user",
        content: "你好啊",
        idempotencyKey: "run-1:user",
      },
    }),
    JSON.stringify({
      type: "message",
      id: "real-repeat",
      parentId: "original-user",
      message: {
        role: "user",
        content: "你好啊",
        idempotencyKey: "run-2:user",
      },
    }),
  ].join("\n") + "\n";

  const result = dedupeChatSendUserMirrorTranscriptText(transcript, {
    clientRunId: "run-1",
    message: "你好啊",
    senderId: "openclaw-macos",
    senderName: "ClawConnect Agent",
  });

  assert.equal(result.changed, false);
  assert.equal(result.removedCount, 0);
  assert.equal(result.text, transcript);
});
