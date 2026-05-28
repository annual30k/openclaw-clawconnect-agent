import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareChatSendParams } from "./chat-send-attachments.js";

test("prepareChatSendParams stores attachments and appends media references", async () => {
  const outboundDir = await mkdtemp(join(tmpdir(), "clawconnect-outbound-"));
  try {
    const params = await prepareChatSendParams(
      {
        message: "hello",
        attachments: [
          {
            fileName: "note.txt",
            mimeType: "text/plain",
            content: Buffer.from("attachment body", "utf8").toString("base64"),
          },
        ],
      },
      {
        outboundDir,
        logger: {
          log() {},
          error() {},
        },
      },
    );

    const record = params as Record<string, unknown>;
    assert.equal(record.deliver, false);
    assert.match(String(record.message), /media attached:/);

    const [stagingDir] = await readdir(outboundDir);
    assert.ok(stagingDir);
    const [stagedFile] = await readdir(join(outboundDir, stagingDir));
    assert.ok(stagedFile);
    const body = await readFile(join(outboundDir, stagingDir, stagedFile), "utf8");
    assert.equal(body, "attachment body");
  } finally {
    await rm(outboundDir, { recursive: true, force: true });
  }
});

test("prepareChatSendParams removes client-only run identifiers before gateway forwarding", async () => {
  const params = await prepareChatSendParams({
    sessionKey: "main",
    message: "hello",
    runId: "client-run",
    run_id: "client-run-snake",
    requestId: "request-1",
    request_id: "request-1-snake",
    clientRunId: "client-run-2",
    client_run_id: "client-run-2-snake",
  });

  const record = params as Record<string, unknown>;
  assert.equal(record.sessionKey, "main");
  assert.equal(record.message, "hello");
  assert.equal(record.deliver, false);
  assert.equal("runId" in record, false);
  assert.equal("run_id" in record, false);
  assert.equal("requestId" in record, false);
  assert.equal("request_id" in record, false);
  assert.equal("clientRunId" in record, false);
  assert.equal("client_run_id" in record, false);
});
