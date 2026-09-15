import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectHermesFileTransferEvidence,
  collectHermesFileTransferOutcome,
  planHermesChatPreparation,
  verifyHermesFileTransferIfRequired,
} from "./hermes-runtime-chat.js";
import {
  getPendingHermesFileTransfer,
  recordPendingHermesFileTransfer,
} from "./hermes-file-transfer-state.js";
import { restoreEnv, writeHermesStateDb } from "../hermes-runtime-test-support.js";

type FixtureMessage = {
  role: string;
  content?: string;
  tool_name?: string;
  tool_calls?: string;
};

const STATE_DB_INSERT_SCRIPT = String.raw`
import json
import sqlite3
import sys

db_path, session_id, rows_json = sys.argv[1:4]
rows = json.loads(rows_json)
conn = sqlite3.connect(db_path)
conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
conn.execute(
    "INSERT INTO sessions (id, source, started_at, message_count) VALUES (?, 'cli', 1, ?)",
    (session_id, len(rows)),
)
for index, row in enumerate(rows, start=1):
    conn.execute(
        "INSERT INTO messages (session_id, role, content, tool_name, tool_calls, timestamp, active) VALUES (?, ?, ?, ?, ?, ?, 1)",
        (session_id, row.get("role", ""), row.get("content"), row.get("tool_name"), row.get("tool_calls"), index),
    )
conn.commit()
conn.close()
`;

function writeFixtureMessages(dbPath: string, sessionId: string, rows: FixtureMessage[]): void {
  execFileSync("python3", ["-c", STATE_DB_INSERT_SCRIPT, dbPath, sessionId, JSON.stringify(rows)], { stdio: "pipe" });
}

function mobileUser(text: string, sourceRunId: string): FixtureMessage {
  return {
    role: "user",
    content: `${text}\n\n[ClawConnect mobile turn]\nsourceRunId: ${sourceRunId}\nsessionKey: mobile-test`,
  };
}

function terminalSendFileResult(sourceRunId: string, fileId: string): FixtureMessage {
  const result = {
    filePath: `/Users/test/${fileId}.png`,
    absolutePath: `/Users/test/${fileId}.png`,
    gatewayId: "gw_test",
    sessionKey: "mobile-test",
    fileId,
    uploadId: `up_${fileId.slice(5)}`,
    fileName: `${fileId}.png`,
    mimeType: "image/png",
    sizeBytes: 1234,
    sha256: "a".repeat(64),
    sourceRunId,
    sourceRole: "assistant",
    status: "completed",
  };
  return {
    role: "tool",
    tool_name: "terminal",
    // Production state.db shape: exit_code belongs to the outer terminal
    // envelope while the typed send-file receipt is JSON in output.
    content: JSON.stringify({
      output: `[send-file] preparing ${result.filePath} for gateway gw_test session mobile-test\n${JSON.stringify(result, null, 2)}`,
      exit_code: 0,
      error: null,
    }),
  };
}

function assistantTerminalCommand(command: string): FixtureMessage {
  return {
    role: "assistant",
    tool_calls: JSON.stringify([{
      type: "function",
      function: {
        name: "terminal",
        arguments: JSON.stringify({ command }),
      },
    }]),
  };
}

function assistantTypedSendFile(path: string): FixtureMessage {
  return {
    role: "assistant",
    tool_calls: JSON.stringify([{
      type: "function",
      function: {
        name: "clawconnect_send_file",
        arguments: JSON.stringify({ path }),
      },
    }]),
  };
}

function typedSendFileResult(sourceRunId: string, fileId: string, ok = true): FixtureMessage {
  return {
    role: "tool",
    tool_name: "clawconnect_send_file",
    content: JSON.stringify(ok
      ? { ok: true, fileId, sourceRunId, status: "completed" }
      : { ok: false, error: "clawconnect_mobile_route_unavailable" }),
  };
}

function terminalOutcome(
  sourceRunId: string,
  kind: "ordinary" | "clarification" | "attempted" | "cancelled",
  assistantText = kind === "ordinary" ? "普通回答" : kind === "clarification" ? "请指定文件" : "已取消文件发送。",
): FixtureMessage {
  const outcome = {
    protocol: "clawconnect.hermes-file-transfer-outcome.v1",
    kind,
    sourceRunId,
    sourceRole: "assistant",
    status: "completed",
    ...(kind !== "attempted" ? { assistantText } : {}),
  };
  return {
    role: "tool",
    tool_name: "terminal",
    content: JSON.stringify({
      output: JSON.stringify(outcome),
      exit_code: 0,
      error: null,
    }),
  };
}

test("pending state routes any continuation text and typed mobile capability is language-neutral", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-file-transfer-state-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_FILE_TRANSFER_STORE;
  try {
    process.env.CLAWCONNECT_HERMES_FILE_TRANSFER_STORE = join(root, "pending.json");
    await recordPendingHermesFileTransfer({
      gatewayId: "gw_test", sessionKey: "mobile-test", hermesSessionId: "hermes-1", sourceRunId: "run-previous",
    });

    for (const text of ["两张", "都要", "就这俩", "whatever", "both", "yes"]) {
      const plan = await planHermesChatPreparation({
        message: text, gatewayId: "gw_test", sessionKey: "mobile-test", sessionId: "hermes-1", sourceRunId: `run-${text}`,
      });
      assert.equal(plan.fileTransferMode, "continuation", text);
      assert.equal(plan.preloadFileTransferSkill, true, text);
    }

    const ordinary = await planHermesChatPreparation({
      message: "两张", gatewayId: "gw_test", sessionKey: "ordinary-chat", sessionId: "hermes-1", sourceRunId: "run-ordinary",
    });
    assert.equal(ordinary.fileTransferMode, undefined);
    assert.equal(ordinary.preloadFileTransferSkill, false);

    const differentSession = await planHermesChatPreparation({
      message: "whatever", gatewayId: "gw_test", sessionKey: "mobile-test", sessionId: "hermes-other", sourceRunId: "run-other-session",
    });
    assert.equal(differentSession.fileTransferMode, undefined);
    assert.equal(differentSession.preloadFileTransferSkill, false);

    const sameRun = await planHermesChatPreparation({
      message: "whatever", gatewayId: "gw_test", sessionKey: "mobile-test", sessionId: "hermes-1", sourceRunId: "run-previous",
    });
    assert.equal(sameRun.fileTransferMode, undefined);
    assert.equal(sameRun.preloadFileTransferSkill, false);

    const typedMobileScope = await planHermesChatPreparation({
      message: "manda isso para mim / ارسال هذا من فضلك / 请处理刚才那项",
      gatewayId: "gw_test", sessionKey: "mobile-chat", sessionId: "hermes-1", sourceRunId: "run-typed-mobile",
      fileTransferCapability: "cli",
    });
    assert.equal(typedMobileScope.preloadFileTransferSkill, true);
    assert.equal(typedMobileScope.fileTransferMode, undefined);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_FILE_TRANSFER_STORE", previousStore);
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending state expires after its bounded continuation turns and TTL", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-file-transfer-expiry-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_FILE_TRANSFER_STORE;
  try {
    process.env.CLAWCONNECT_HERMES_FILE_TRANSFER_STORE = join(root, "pending.json");
    await recordPendingHermesFileTransfer({ gatewayId: "gw_test", sessionKey: "mobile-test", hermesSessionId: "hermes-1", sourceRunId: "run-1", nowMs: 1_000 });
    assert.ok(await getPendingHermesFileTransfer({ gatewayId: "gw_test", sessionKey: "mobile-test", hermesSessionId: "hermes-1", sourceRunId: "run-2", nowMs: 1_001 }));
    await recordPendingHermesFileTransfer({ gatewayId: "gw_test", sessionKey: "mobile-test", hermesSessionId: "hermes-1", sourceRunId: "run-2", continuation: true, nowMs: 2_000 });
    await recordPendingHermesFileTransfer({ gatewayId: "gw_test", sessionKey: "mobile-test", hermesSessionId: "hermes-1", sourceRunId: "run-3", continuation: true, nowMs: 3_000 });
    assert.equal(await getPendingHermesFileTransfer({ gatewayId: "gw_test", sessionKey: "mobile-test", hermesSessionId: "hermes-1", sourceRunId: "run-4", nowMs: 3_001 }), undefined);

    await recordPendingHermesFileTransfer({ gatewayId: "gw_test", sessionKey: "mobile-test", hermesSessionId: "hermes-1", sourceRunId: "run-new", nowMs: 10_000 });
    assert.equal(await getPendingHermesFileTransfer({ gatewayId: "gw_test", sessionKey: "mobile-test", hermesSessionId: "hermes-1", sourceRunId: "run-late", nowMs: 610_001 }), undefined);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_FILE_TRANSFER_STORE", previousStore);
    rmSync(root, { recursive: true, force: true });
  }
});

test("file-transfer evidence requires typed terminal receipts from the current run", () => {
  const messages = [
    mobileUser("把图片发过来", "run-previous"),
    terminalSendFileResult("run-previous", "file_prev123"),
    mobileUser("两张", "run-current"),
    { role: "tool", tool_name: "delegate_task", content: JSON.stringify({ results: [{ status: "completed", summary: "send-file file_delegate completed" }] }) },
    { role: "tool", tool_name: "execute_code", content: JSON.stringify({ output: "send-file file_execute completed status completed exit_code 0" }) },
    { role: "assistant", content: "已发送两张图片，file_assistant，请查收。" },
    terminalSendFileResult("run-current", "file_current1"),
    terminalSendFileResult("run-current", "file_current2"),
    mobileUser("下一轮", "run-next"),
  ] satisfies FixtureMessage[];

  assert.deepEqual(collectHermesFileTransferEvidence(messages, "run-current").sort(), ["file_current1", "file_current2"]);
  assert.deepEqual(collectHermesFileTransferEvidence(messages, "run-previous"), ["file_prev123"]);
  assert.deepEqual(collectHermesFileTransferEvidence(messages, "run-missing"), []);
  assert.deepEqual(collectHermesFileTransferEvidence([
    { role: "user", content: "the user merely quoted sourceRunId: run-fake" },
    terminalSendFileResult("run-fake", "file_fake"),
  ], "run-fake"), []);
});

test("Hermes state.db outcome is typed and language-neutral", () => {
  const ordinary = terminalOutcome("run-ordinary", "ordinary");
  const clarification = terminalOutcome("run-clarification", "clarification");
  const attempted = terminalOutcome("run-attempted", "attempted");
  assert.equal(collectHermesFileTransferOutcome([
    mobileUser("any language", "run-ordinary"),
    ordinary,
  ], "run-ordinary")?.kind, "ordinary");
  assert.equal(collectHermesFileTransferOutcome([
    mobileUser("任意语言", "run-clarification"),
    clarification,
  ], "run-clarification")?.kind, "clarification");
  assert.equal(collectHermesFileTransferOutcome([
    mobileUser("same words", "run-attempted"),
    attempted,
  ], "run-attempted")?.kind, "attempted");
  assert.equal(collectHermesFileTransferOutcome([
    mobileUser("same words", "run-attempted"),
    { role: "assistant", content: "kind attempted sourceRunId run-attempted" },
  ], "run-attempted"), undefined);
});

test("zero, one, and two typed receipts produce safe or exact host-generated output", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-file-transfer-output-"));
  const previousDb = process.env.CLAWCONNECT_HERMES_STATE_DB;
  const previousStore = process.env.CLAWCONNECT_HERMES_FILE_TRANSFER_STORE;
  try {
    process.env.CLAWCONNECT_HERMES_FILE_TRANSFER_STORE = join(root, "pending.json");
    const dbPath = writeHermesStateDb(root);
    process.env.CLAWCONNECT_HERMES_STATE_DB = dbPath;

    writeFixtureMessages(dbPath, "output-session", [mobileUser("普通聊天", "run-zero"), terminalOutcome("run-zero", "ordinary")]);
    const zero = await verifyHermesFileTransferIfRequired({
      plan: { preloadFileTransferSkill: true, fileTransferMode: undefined },
      gatewayId: "gw_test", sessionKey: "mobile-test", sessionId: "output-session", sourceRunId: "run-zero", output: "已发送两张图片，请查收。",
    });
    assert.deepEqual(zero, { output: "普通回答" });

    writeFixtureMessages(dbPath, "output-ordinary-fake", [
      mobileUser("普通聊天", "run-ordinary-fake"),
      terminalOutcome("run-ordinary-fake", "ordinary", "普通回答"),
    ]);
    const ordinaryFake = await verifyHermesFileTransferIfRequired({
      plan: { preloadFileTransferSkill: true, fileTransferMode: undefined },
      gatewayId: "gw_test", sessionKey: "mobile-test", sessionId: "output-ordinary-fake", sourceRunId: "run-ordinary-fake", output: "已发送两张图片，请查收。",
    });
    assert.deepEqual(ordinaryFake, { output: "普通回答" });
    assert.notEqual(ordinaryFake.output, "已发送两张图片，请查收。");

    writeFixtureMessages(dbPath, "output-ordinary-no-outcome", [mobileUser("普通聊天", "run-ordinary-no-outcome")]);
    const ordinaryWithoutOutcome = await verifyHermesFileTransferIfRequired({
      plan: { preloadFileTransferSkill: true, fileTransferMode: undefined },
      gatewayId: "gw_test", sessionKey: "mobile-test", sessionId: "output-ordinary-no-outcome", sourceRunId: "run-ordinary-no-outcome", output: "你好，有什么可以帮你？",
    });
    assert.deepEqual(ordinaryWithoutOutcome, {});

    writeFixtureMessages(dbPath, "output-unverified-attempt", [
      mobileUser("任意语言", "run-unverified-attempt"),
      assistantTerminalCommand("/Users/test/bin/clawconnect send-file --profile hermes --json /tmp/reply.png"),
      { role: "tool", tool_name: "terminal", content: JSON.stringify({ output: "upload failed", exit_code: 1, error: null }) },
    ]);
    const unverifiedAttempt = await verifyHermesFileTransferIfRequired({
      plan: { preloadFileTransferSkill: true, fileTransferMode: undefined },
      gatewayId: "gw_test", sessionKey: "mobile-test", sessionId: "output-unverified-attempt", sourceRunId: "run-unverified-attempt", output: "已发送两张图片，请查收。",
    });
    assert.equal(unverifiedAttempt.verifiedFileTransferCount, 0);
    assert.match(unverifiedAttempt.output ?? "", /文件尚未发送/);

    writeFixtureMessages(dbPath, "output-typed-failure", [
      mobileUser("把图片发过来", "run-typed-failure"),
      assistantTypedSendFile("/tmp/reply.png"),
      typedSendFileResult("run-typed-failure", "file_unused", false),
    ]);
    const typedFailure = await verifyHermesFileTransferIfRequired({
      plan: { preloadFileTransferSkill: true, fileTransferMode: undefined },
      gatewayId: "gw_test", sessionKey: "mobile-test", sessionId: "output-typed-failure", sourceRunId: "run-typed-failure", output: "发送失败。",
    });
    assert.equal(typedFailure.verifiedFileTransferCount, 0);
    assert.match(typedFailure.output ?? "", /文件尚未发送/);

    writeFixtureMessages(dbPath, "output-attempted", [mobileUser("任意语言", "run-attempted"), terminalOutcome("run-attempted", "attempted")]);
    const attempted = await verifyHermesFileTransferIfRequired({
      plan: { preloadFileTransferSkill: true, fileTransferMode: undefined },
      gatewayId: "gw_test", sessionKey: "mobile-test", sessionId: "output-attempted", sourceRunId: "run-attempted", output: "已发送两张图片。",
    });
    assert.equal(attempted.verifiedFileTransferCount, 0);
    assert.match(attempted.output ?? "", /文件尚未发送/);

    writeFixtureMessages(dbPath, "output-one", [mobileUser("把图片发过来", "run-one"), terminalSendFileResult("run-one", "file_one")]);
    const one = await verifyHermesFileTransferIfRequired({
      plan: { preloadFileTransferSkill: true, fileTransferMode: "continuation" },
      gatewayId: "gw_test", sessionKey: "mobile-test", sessionId: "output-one", sourceRunId: "run-one", output: "模型声称已发送两张。",
    });
    assert.equal(one.verifiedFileTransferCount, 1);
    assert.equal(one.output, "已发送 1 个文件，请查收。");

    writeFixtureMessages(dbPath, "output-typed-one", [
      mobileUser("把图片发过来", "run-typed-one"),
      assistantTypedSendFile("/tmp/reply.png"),
      typedSendFileResult("run-typed-one", "file_typedone"),
    ]);
    const typedOne = await verifyHermesFileTransferIfRequired({
      plan: { preloadFileTransferSkill: true, fileTransferMode: undefined },
      gatewayId: "gw_test", sessionKey: "mobile-test", sessionId: "output-typed-one", sourceRunId: "run-typed-one", output: "图片已经发送。",
    });
    assert.deepEqual(typedOne, { verifiedFileTransferCount: 1, output: "已发送 1 个文件，请查收。" });

    writeFixtureMessages(dbPath, "output-two", [mobileUser("把图片发过来", "run-two"), terminalSendFileResult("run-two", "file_twoa"), terminalSendFileResult("run-two", "file_twob")]);
    const two = await verifyHermesFileTransferIfRequired({
      plan: { preloadFileTransferSkill: true, fileTransferMode: "continuation" },
      gatewayId: "gw_test", sessionKey: "mobile-test", sessionId: "output-two", sourceRunId: "run-two", output: "没有可靠的数量文本。",
    });
    assert.equal(two.verifiedFileTransferCount, 2);
    assert.equal(two.output, "已发送 2 个文件，请查收。");
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_STATE_DB", previousDb);
    restoreEnv("CLAWCONNECT_HERMES_FILE_TRANSFER_STORE", previousStore);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes clarification creates scoped pending state and arbitrary continuation remains eligible", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-file-transfer-clarification-"));
  const previousDb = process.env.CLAWCONNECT_HERMES_STATE_DB;
  const previousStore = process.env.CLAWCONNECT_HERMES_FILE_TRANSFER_STORE;
  try {
    process.env.CLAWCONNECT_HERMES_FILE_TRANSFER_STORE = join(root, "pending.json");
    const dbPath = writeHermesStateDb(root);
    process.env.CLAWCONNECT_HERMES_STATE_DB = dbPath;
    writeFixtureMessages(dbPath, "clarification-session", [
      mobileUser("任意语言请求", "run-clarification"),
      { role: "assistant", content: "你要哪一个文件？" },
      terminalOutcome("run-clarification", "clarification"),
    ]);
    assert.deepEqual(await verifyHermesFileTransferIfRequired({
      plan: { preloadFileTransferSkill: true, fileTransferMode: undefined },
      gatewayId: "gw_test", sessionKey: "mobile-test", sessionId: "clarification-session", sourceRunId: "run-clarification", output: "你要哪一个文件？",
    }), { output: "请指定文件" });
    const pending = await getPendingHermesFileTransfer({
      gatewayId: "gw_test", sessionKey: "mobile-test", hermesSessionId: "clarification-session", sourceRunId: "run-next",
    });
    assert.equal(pending?.sourceRunId, "run-clarification");
    const continuation = await planHermesChatPreparation({
      message: "whatever", gatewayId: "gw_test", sessionKey: "mobile-test", sessionId: "clarification-session", sourceRunId: "run-next",
    });
    assert.equal(continuation.fileTransferMode, "continuation");
    writeFixtureMessages(dbPath, "clarification-session", [
      mobileUser("whatever", "run-next"),
      terminalSendFileResult("run-next", "file_nexta"),
      terminalSendFileResult("run-next", "file_nextb"),
    ]);
    assert.deepEqual(await verifyHermesFileTransferIfRequired({
      plan: continuation,
      gatewayId: "gw_test",
      sessionKey: "mobile-test",
      sessionId: "clarification-session",
      sourceRunId: "run-next",
      output: "模型声称发送了两张图片。",
    }), { verifiedFileTransferCount: 2, output: "已发送 2 个文件，请查收。" });
    assert.equal(await getPendingHermesFileTransfer({
      gatewayId: "gw_test", sessionKey: "mobile-test", hermesSessionId: "clarification-session", sourceRunId: "run-after",
    }), undefined);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_STATE_DB", previousDb);
    restoreEnv("CLAWCONNECT_HERMES_FILE_TRANSFER_STORE", previousStore);
    rmSync(root, { recursive: true, force: true });
  }
});
