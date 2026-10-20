import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runHermesChatHistory } from "../hermes-runtime.js";
import { restoreEnv, writeHermesStateDb } from "../hermes-runtime-test-support.js";
import {
  planHermesChatPreparation,
  resolveHermesTurnOutput,
  verifyHermesFileTransferIfRequired,
} from "./hermes-runtime-chat-file-transfer.js";
import {
  buildHermesTurnRowResolver,
  decideHermesAssistantRow,
} from "./hermes-runtime-history-turn-output.js";

type Row = {
  role: string;
  content?: string;
  tool_name?: string;
  tool_calls?: string;
  finish_reason?: string;
};

type HistoryMessage = { id: string; role: string; seq: number; content: Array<{ type: string; text?: string }> };

const INSERT_SCRIPT = String.raw`
import json
import sqlite3
import sys

db_path, session_id, rows_json = sys.argv[1:4]
rows = json.loads(rows_json)
conn = sqlite3.connect(db_path)
conn.execute("INSERT INTO sessions (id, source, started_at, message_count) VALUES (?, 'cli', 1, ?)", (session_id, len(rows)))
for index, row in enumerate(rows, start=1):
    conn.execute(
        "INSERT INTO messages (session_id, role, content, tool_name, tool_calls, finish_reason, timestamp, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
        (session_id, row["role"], row.get("content"), row.get("tool_name"), row.get("tool_calls"), row.get("finish_reason"), 1784808000 + index),
    )
conn.commit()
conn.close()
`;

function mobileUser(text: string, sourceRunId: string): Row {
  return { role: "user", content: `${text}\n\n[ClawConnect mobile turn]\nsourceRunId: ${sourceRunId}\nsessionKey: mobile-test` };
}

/** Hermes 在调用工具前写入的助手行：finish_reason=tool_calls，带 tool_calls，可能有正文。 */
function assistantCallingTool(content = ""): Row {
  return {
    role: "assistant",
    content,
    finish_reason: "tool_calls",
    tool_calls: JSON.stringify([{ type: "function", function: { name: "terminal", arguments: "{}" } }]),
  };
}

function finalAssistant(content: string): Row {
  return { role: "assistant", content, finish_reason: "stop" };
}

function outcomeResult(sourceRunId: string, kind: "ordinary" | "clarification" | "attempted" | "cancelled", assistantText?: string): Row {
  return {
    role: "tool",
    tool_name: "terminal",
    content: JSON.stringify({
      output: JSON.stringify({
        protocol: "clawconnect.hermes-file-transfer-outcome.v1",
        kind,
        sourceRunId,
        sourceRole: "assistant",
        status: "completed",
        ...(assistantText ? { assistantText } : {}),
      }),
      exit_code: 0,
      error: null,
    }),
  };
}

function sendFileReceipt(sourceRunId: string, fileId: string): Row {
  return {
    role: "tool",
    tool_name: "terminal",
    content: JSON.stringify({
      output: JSON.stringify({ fileId, sourceRunId, sourceRole: "assistant", status: "completed" }),
      exit_code: 0,
      error: null,
    }),
  };
}

function withStateDb<T>(rows: Row[], run: (sessionId: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "hermes-history-turn-output-"));
  const previousStateDb = process.env.CLAWCONNECT_HERMES_STATE_DB;
  const previousPending = process.env.CLAWCONNECT_HERMES_FILE_TRANSFER_STORE;
  const sessionId = "turn_output_session";
  const dbPath = writeHermesStateDb(root);
  execFileSync("python3", ["-c", INSERT_SCRIPT, dbPath, sessionId, JSON.stringify(rows)], { stdio: "pipe" });
  process.env.CLAWCONNECT_HERMES_STATE_DB = dbPath;
  process.env.CLAWCONNECT_HERMES_FILE_TRANSFER_STORE = join(root, "pending.json");
  return run(sessionId).finally(() => {
    restoreEnv("CLAWCONNECT_HERMES_STATE_DB", previousStateDb);
    restoreEnv("CLAWCONNECT_HERMES_FILE_TRANSFER_STORE", previousPending);
    rmSync(root, { recursive: true, force: true });
  });
}

async function assistantTexts(sessionId: string, params: { limit?: number; cursor?: string; direction?: "older" | "newer" } = {}): Promise<Array<[number, string]>> {
  const result = await runHermesChatHistory({ sessionKey: `hermes:${sessionId}`, limit: params.limit ?? 50, ...params });
  assert.equal(result.ok, true);
  const messages = (result.payload as { messages: HistoryMessage[] }).messages;
  return messages
    .filter((message) => message.role === "assistant")
    .map((message) => [message.seq, message.content.map((block) => block.text ?? "").join("")]);
}

test("turn output precedence is file receipt, then typed outcome, then an unverified send, otherwise none", () => {
  const user = mobileUser("q", "run-1");
  assert.deepEqual(resolveHermesTurnOutput([user, finalAssistant("raw")], "run-1"), { kind: "none" });
  assert.deepEqual(
    resolveHermesTurnOutput([user, outcomeResult("run-1", "ordinary", "typed answer")], "run-1"),
    { kind: "ordinary", text: "typed answer" },
  );
  assert.equal(resolveHermesTurnOutput([user, outcomeResult("run-1", "clarification", "which file?")], "run-1").kind, "clarification");
  assert.equal(resolveHermesTurnOutput([user, outcomeResult("run-1", "cancelled", "cancelled it")], "run-1").kind, "cancelled");
  assert.equal(resolveHermesTurnOutput([user, outcomeResult("run-1", "attempted")], "run-1").kind, "attempted-unverified");
  // 回执优先于 outcome：文件已真实送达时，即使模型声明 ordinary 也以回执为准。
  assert.deepEqual(
    resolveHermesTurnOutput([user, sendFileReceipt("run-1", "file_abc1"), outcomeResult("run-1", "ordinary", "typed")], "run-1"),
    { kind: "file-evidence", text: "已发送 1 个文件，请查收。", fileCount: 1 },
  );
  // 其他 run 的 typed 结论不能串到当前轮。
  assert.deepEqual(resolveHermesTurnOutput([user, outcomeResult("run-other", "ordinary", "x")], "run-1"), { kind: "none" });
});

test("assistant row decision keeps raw text outside mobile turns and carries typed text on the last terminal row", () => {
  const user = mobileUser("q", "run-1");
  const first = { ...finalAssistant("first"), id: "11" };
  const last = { ...finalAssistant("last"), id: "12" };
  const typed = outcomeResult("run-1", "ordinary", "typed answer");
  const turn = [user, assistantCallingTool(), typed, first, last] as Array<Record<string, unknown>>;

  assert.deepEqual(decideHermesAssistantRow(first, turn), { kind: "drop" });
  assert.deepEqual(decideHermesAssistantRow(last, turn), { kind: "typed", text: "typed answer" });
  // 没有 [ClawConnect mobile turn] 元数据的用户行不是移动端轮次，不应用 typed 规则。
  assert.deepEqual(
    decideHermesAssistantRow(last, [{ role: "user", content: "plain" }, typed, first, last] as Array<Record<string, unknown>>),
    { kind: "raw" },
  );
  assert.deepEqual(decideHermesAssistantRow(last, [user, last] as Array<Record<string, unknown>>), { kind: "raw" });
});

test("turn row resolver slices each user turn from the full row sequence", () => {
  const rows = [
    { role: "user", id: "1" },
    { role: "assistant", id: "2" },
    { role: "user", id: "3" },
    { role: "tool", id: "4" },
    { role: "assistant", id: "5" },
  ] as Array<Record<string, unknown>>;
  const resolve = buildHermesTurnRowResolver(rows);

  assert.deepEqual(resolve(1).map((row) => row.id), ["1", "2"]);
  assert.deepEqual(resolve(3).map((row) => row.id), ["3", "4", "5"]);
  assert.deepEqual(resolve(4).map((row) => row.id), ["3", "4", "5"]);
});

test("history shows the typed answer instead of the model's post-tool closing sentence", async () => {
  const rows = [
    mobileUser("你可以做什么", "run-1"),
    assistantCallingTool("工具调用前的草稿，不是最终回答"),
    outcomeResult("run-1", "ordinary", "我可以帮你发文件、查资料、写代码。"),
    finalAssistant("已发送 ✅ 上面就是完整的能力清单。"),
  ];
  await withStateDb(rows, async (sessionId) => {
    // 回归：此前刷新后历史只剩 "已发送 ✅ ……" 这句收尾话。
    assert.deepEqual(await assistantTexts(sessionId), [[4, "我可以帮你发文件、查资料、写代码。"]]);
  });
});

test("history text is identical to the live final output for the same rows", async () => {
  const rows = [
    mobileUser("hello", "run-live"),
    assistantCallingTool(),
    outcomeResult("run-live", "ordinary", "typed live answer"),
    finalAssistant("消息已通过 ClawConnect 送达 ✅"),
  ];
  await withStateDb(rows, async (sessionId) => {
    const plan = await planHermesChatPreparation({
      message: "hello",
      gatewayId: "gw_test",
      sessionKey: "mobile-test",
      sessionId,
      sourceRunId: "run-live",
      fileTransferCapability: "cli",
    });
    const live = await verifyHermesFileTransferIfRequired({
      plan,
      gatewayId: "gw_test",
      sessionKey: "mobile-test",
      sessionId,
      sourceRunId: "run-live",
    });
    const history = await assistantTexts(sessionId);

    assert.equal(live.output, "typed live answer");
    assert.deepEqual(history.map(([, text]) => text), [live.output]);
  });
});

test("a turn split across history pages resolves the same typed answer from either page", async () => {
  const rows = [
    mobileUser("one", "run-1"),
    assistantCallingTool(),
    outcomeResult("run-1", "ordinary", "typed one"),
    finalAssistant("closing one"),
    mobileUser("two", "run-2"),
    assistantCallingTool(),
    outcomeResult("run-2", "ordinary", "typed two"),
    finalAssistant("closing two"),
  ];
  await withStateDb(rows, async (sessionId) => {
    // limit=1 时页内只有最后一行，不含本轮的用户行和 outcome 行；仍必须得到 typed 文本。
    assert.deepEqual(await assistantTexts(sessionId, { limit: 1 }), [[8, "typed two"]]);
    assert.deepEqual(await assistantTexts(sessionId, { limit: 1, cursor: "seq:8", direction: "older" }), []);
    assert.deepEqual(await assistantTexts(sessionId, { limit: 3, cursor: "seq:5", direction: "older" }), [[4, "typed one"]]);
  });
});

test("only the last terminal assistant row of a typed turn is shown", async () => {
  const rows = [
    mobileUser("q", "run-1"),
    assistantCallingTool(),
    outcomeResult("run-1", "ordinary", "typed answer"),
    finalAssistant("closing sentence A"),
    finalAssistant("closing sentence B"),
  ];
  await withStateDb(rows, async (sessionId) => {
    assert.deepEqual(await assistantTexts(sessionId), [[5, "typed answer"]]);
  });
});

test("a delivered file and an unverified send attempt both use host-generated history text", async () => {
  const delivered = [
    mobileUser("send it", "run-file"),
    assistantCallingTool(),
    sendFileReceipt("run-file", "file_abc123"),
    finalAssistant("模型自称发了 3 张"),
  ];
  await withStateDb(delivered, async (sessionId) => {
    assert.deepEqual(await assistantTexts(sessionId), [[4, "已发送 1 个文件，请查收。"]]);
  });

  const unverified = [
    mobileUser("send it", "run-fail"),
    assistantCallingTool(),
    outcomeResult("run-fail", "attempted"),
    finalAssistant("已经发送成功啦"),
  ];
  await withStateDb(unverified, async (sessionId) => {
    const [[, text]] = await assistantTexts(sessionId);
    assert.match(text, /文件尚未发送/);
  });
});

test("turns without a typed conclusion keep the host's raw answer", async () => {
  const rows = [
    mobileUser("old protocol turn", "run-legacy"),
    finalAssistant("legacy answer written before the outcome protocol"),
    { role: "user", content: "typed in a desktop Hermes CLI" },
    outcomeResult("run-desktop", "ordinary", "must not apply"),
    finalAssistant("desktop answer"),
  ];
  await withStateDb(rows, async (sessionId) => {
    assert.deepEqual(await assistantTexts(sessionId), [
      [2, "legacy answer written before the outcome protocol"],
      [5, "desktop answer"],
    ]);
  });
});
