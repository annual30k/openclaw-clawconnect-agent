import assert from "node:assert/strict";
import test from "node:test";
import { createHermesApiToolLifecycleTracker } from "./runtime/hermes-runtime-api-client.js";

test("Hermes API reasoning-only progress does not create an active tool invocation", () => {
  const tracker = createHermesApiToolLifecycleTracker("run-reasoning");

  const started = tracker.resolve("tool.started", {
    tool_call_id: "reasoning-call",
    tool_name: "_THINKING",
  });
  const progress = tracker.resolve("tool.progress", {
    message_id: "shared-assistant-message",
    tool_name: "_thinking",
    delta: "reasoning summary",
  });
  const completed = tracker.resolve("tool.completed", {
    tool_call_id: "reasoning-call",
    tool_name: "_thinking",
  });

  assert.equal(started, undefined);
  assert.equal(progress, undefined);
  assert.equal(completed, undefined);
  assert.equal(tracker.activeCount(), 0);
  assert.deepEqual(tracker.finishActive("completed"), []);
});

test("Hermes API explicit tool lifecycle preserves the upstream invocation id", () => {
  const tracker = createHermesApiToolLifecycleTracker("run-explicit");

  const started = tracker.resolve("tool.started", {
    tool_call_id: "call-weather-1",
    tool_name: "weather",
    preview: "Fuzhou",
  });
  const progress = tracker.resolve("tool.progress", {
    toolCallId: "call-weather-1",
    tool_name: "weather",
    delta: "fetching forecast",
  });
  const completed = tracker.resolve("tool.completed", {
    toolInvocationId: "call-weather-1",
    tool_name: "weather",
  });

  assert.deepEqual(
    [started, progress, completed].map((event) => [event?.toolCallId, event?.phase]),
    [
      ["call-weather-1", "streaming"],
      ["call-weather-1", "streaming"],
      ["call-weather-1", "completed"],
    ],
  );
  assert.equal(completed?.preview, "fetching forecast");
  assert.equal(tracker.activeCount(), 0);
});

test("Hermes API legacy same-name tools correlate terminal events in FIFO order", () => {
  const tracker = createHermesApiToolLifecycleTracker("run-legacy");

  const firstStarted = tracker.resolve("tool.started", { tool_name: "web_search", preview: "first" });
  const secondStarted = tracker.resolve("tool.started", { tool_name: "web_search", preview: "second" });
  const firstProgress = tracker.resolve("tool.progress", { tool_name: "web_search", delta: "first progress" });
  const firstCompleted = tracker.resolve("tool.completed", { tool_name: "web_search" });
  const secondCompleted = tracker.resolve("tool.completed", { tool_name: "web_search" });

  assert.equal(firstStarted?.toolCallId, "run-legacy:hermes-api-tool-1");
  assert.equal(secondStarted?.toolCallId, "run-legacy:hermes-api-tool-2");
  assert.equal(firstProgress?.toolCallId, firstStarted?.toolCallId);
  assert.equal(firstCompleted?.toolCallId, firstStarted?.toolCallId);
  assert.equal(secondCompleted?.toolCallId, secondStarted?.toolCallId);
  assert.equal(firstCompleted?.preview, "first progress");
  assert.equal(secondCompleted?.preview, "second");
  assert.equal(tracker.activeCount(), 0);
});

test("Hermes API run terminal closes every remaining active tool with its stable id", () => {
  const tracker = createHermesApiToolLifecycleTracker("run-terminal");
  const first = tracker.resolve("tool.started", { tool_name: "browser", preview: "one" });
  const second = tracker.resolve("tool.started", {
    tool_call_id: "call-browser-2",
    tool_name: "browser",
    preview: "two",
  });

  const terminal = tracker.finishActive("completed");

  assert.deepEqual(
    terminal.map((event) => [event.toolCallId, event.phase]),
    [
      [first?.toolCallId, "completed"],
      [second?.toolCallId, "completed"],
    ],
  );
  assert.equal(tracker.activeCount(), 0);
  assert.deepEqual(tracker.finishActive("completed"), []);
});
