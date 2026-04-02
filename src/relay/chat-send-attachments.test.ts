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
