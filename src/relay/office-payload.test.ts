import assert from "node:assert/strict";
import test from "node:test";
import { buildOfficeEventPayload } from "./office-payload.js";

test("buildOfficeEventPayload derives writing and executing states from streaming payloads", () => {
  const writing = buildOfficeEventPayload(
    "chat",
    {
      sessionKey: "agent:main:main",
      role: "assistant",
      state: "streaming",
      text: "正在整理回复",
      currentModel: "gpt-4o",
    },
    () => "2026-04-14T08:00:00.000Z",
  );

  assert.deepEqual(writing?.office.kind, "writing");
  assert.equal(writing?.office.title, "写作中");
  assert.equal(writing?.office.detail, "正在整理回复");
  assert.equal(writing?.office.progress, 0.42);

  const executing = buildOfficeEventPayload(
    "agent",
    {
      sessionKey: "agent:main:main",
      role: "assistant",
      state: "streaming",
      text: "正在运行 shell",
      data: {
        toolName: "shell",
        toolCallId: "tool-1",
      },
    },
    () => "2026-04-14T08:00:00.000Z",
  );

  assert.deepEqual(executing?.office.kind, "executing");
  assert.equal(executing?.office.title, "执行中");
  assert.equal(executing?.office.toolName, "shell");
  assert.equal(executing?.office.toolCallId, "tool-1");
  assert.equal(executing?.office.progress, 0.72);
});

test("buildOfficeEventPayload derives syncing and offline states for lifecycle events", () => {
  const syncing = buildOfficeEventPayload(
    "context_usage",
    {
      sessionKey: "agent:main:main",
      currentModel: "gpt-4o",
      contextUsage: 512,
      contextLimit: 4096,
    },
    () => "2026-04-14T08:00:00.000Z",
  );

  assert.deepEqual(syncing?.office.kind, "syncing");
  assert.equal(syncing?.office.detail, "512 / 4.1k");

  const offline = buildOfficeEventPayload(
    "gateway_disconnected",
    {
      reason: "network",
    },
    () => "2026-04-14T08:00:00.000Z",
  );

  assert.deepEqual(offline?.office.kind, "offline");
  assert.equal(offline?.office.detail, "主机暂时离线");
});

test("buildOfficeEventPayload accepts Hermes final chat payloads", () => {
  const payload = buildOfficeEventPayload(
    "chat",
    {
      sessionKey: "main",
      role: "assistant",
      state: "final",
      currentModel: "gpt-5.5",
      contextUsage: 54000,
      contextLimit: 272000,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "天气表格已生成" }],
      },
    },
    () => "2026-05-19T07:10:00.000Z",
  );

  assert.equal(payload?.sessionKey, "main");
  assert.equal(payload?.currentModel, "gpt-5.5");
  assert.equal(payload?.contextUsage, 54000);
  assert.equal(payload?.contextLimit, 272000);
  assert.equal(payload?.office.kind, "idle");
  assert.equal(payload?.office.updatedAt, "2026-05-19T07:10:00.000Z");
});
