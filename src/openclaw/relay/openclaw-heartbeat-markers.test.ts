import assert from "node:assert/strict";
import test from "node:test";

import {
  isOpenClawHeartbeatAckText,
  isOpenClawHeartbeatPromptText,
  shouldSuppressOpenClawHeartbeatChatEvent,
} from "./openclaw-heartbeat-markers.js";

test("heartbeat markers match only the exact reserved prompt and acknowledgement texts", () => {
  assert.equal(isOpenClawHeartbeatPromptText("[OpenClaw heartbeat poll]"), true);
  assert.equal(isOpenClawHeartbeatPromptText("  OpenClaw heartbeat poll\r\n"), true);
  assert.equal(isOpenClawHeartbeatPromptText("[OpenClaw heartbeat poll] please explain"), false);
  assert.equal(isOpenClawHeartbeatPromptText("[openclaw heartbeat poll]"), false);
  assert.equal(isOpenClawHeartbeatPromptText(undefined), false);

  assert.equal(isOpenClawHeartbeatAckText("HEARTBEAT_OK"), true);
  assert.equal(isOpenClawHeartbeatAckText("HEARTBEAT OK\r"), true);
  assert.equal(isOpenClawHeartbeatAckText("HEARTBEAT_OK\n\nDisk space is low"), false);
  assert.equal(isOpenClawHeartbeatAckText("heartbeat_ok"), false);
  assert.equal(isOpenClawHeartbeatAckText(""), false);
});

test("heartbeat runs hide internal progress but publish a real alert final", () => {
  const heartbeatPrompt = "[OpenClaw heartbeat poll]";

  assert.equal(shouldSuppressOpenClawHeartbeatChatEvent({ promptText: heartbeatPrompt, assistantText: "HEART", chatState: "delta" }), true);
  assert.equal(shouldSuppressOpenClawHeartbeatChatEvent({ promptText: heartbeatPrompt, assistantText: "HEARTBEAT_OK", chatState: "final" }), true);
  assert.equal(shouldSuppressOpenClawHeartbeatChatEvent({ promptText: heartbeatPrompt, assistantText: "", chatState: "final" }), true);
  assert.equal(shouldSuppressOpenClawHeartbeatChatEvent({ promptText: heartbeatPrompt, assistantText: "provider error", chatState: "error" }), true);
  assert.equal(shouldSuppressOpenClawHeartbeatChatEvent({ promptText: heartbeatPrompt, assistantText: "", chatState: "aborted" }), true);

  // 历史保留真实告警的完整轮次，实时也必须发布这条 final。
  assert.equal(shouldSuppressOpenClawHeartbeatChatEvent({ promptText: heartbeatPrompt, assistantText: "Disk space is low", chatState: "final" }), false);
  assert.equal(shouldSuppressOpenClawHeartbeatChatEvent({ promptText: heartbeatPrompt, assistantText: "HEARTBEAT_OK\n\nDisk space is low", chatState: "final" }), false);
});

test("real user turns are never treated as heartbeat traffic", () => {
  assert.equal(shouldSuppressOpenClawHeartbeatChatEvent({ promptText: "[OpenClaw heartbeat poll] please explain", assistantText: "HEARTBEAT_OK", chatState: "final" }), false);
  assert.equal(shouldSuppressOpenClawHeartbeatChatEvent({ promptText: "say HEARTBEAT_OK", assistantText: "HEARTBEAT_OK", chatState: "final" }), false);
  assert.equal(shouldSuppressOpenClawHeartbeatChatEvent({ promptText: "hello", assistantText: "HEART", chatState: "delta" }), false);
});

test("runs without a known prompt hide only an exact acknowledgement", () => {
  assert.equal(shouldSuppressOpenClawHeartbeatChatEvent({ assistantText: "HEARTBEAT_OK", chatState: "final" }), true);
  assert.equal(shouldSuppressOpenClawHeartbeatChatEvent({ promptText: "   ", assistantText: "HEARTBEAT OK", chatState: "delta" }), true);
  assert.equal(shouldSuppressOpenClawHeartbeatChatEvent({ assistantText: "HEARTBEAT_OK\n\nDisk space is low", chatState: "final" }), false);
  assert.equal(shouldSuppressOpenClawHeartbeatChatEvent({ assistantText: "", chatState: "final" }), false);
  assert.equal(shouldSuppressOpenClawHeartbeatChatEvent({ assistantText: "Hello", chatState: "delta" }), false);
});
