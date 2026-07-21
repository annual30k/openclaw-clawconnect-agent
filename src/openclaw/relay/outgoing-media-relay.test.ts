import assert from "assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  extractDeliverablePathCandidates,
  relayOutgoingMediaInHistoryResponse,
  relayOutgoingMediaInPayload,
} from "./outgoing-media-relay.js";

test("outgoing artifact detection recognizes Windows drive and UNC paths", () => {
  assert.deepEqual(extractDeliverablePathCandidates([
    "已生成 C:\\Users\\测试 User\\Desktop\\report.xlsx。",
    "备用文件 \\\\fileserver\\shared\\image.png",
  ].join("\n")), [
    "C:\\Users\\测试 User\\Desktop\\report.xlsx",
    "\\\\fileserver\\shared\\image.png",
  ]);
});

test("relayOutgoingMediaInPayload uploads OpenClaw outgoing media and rewrites the image block", async () => {
  const fixture = await createOutgoingMediaFixture();
  const server = await createFileUploadRelayServer("file_outgoing_payload");
  try {
    const payload = {
      message: {
        runId: "assistant-run-outgoing",
        role: "assistant",
        content: [
          { type: "text", text: "sent image" },
          {
            type: "image",
            url: `/api/chat/media/outgoing/agent%3Amain%3Asession_1/${fixture.attachmentId}/full`,
            alt: "photo.jpg",
            mimeType: "image/jpeg",
          },
        ],
      },
    };

    const result = await relayOutgoingMediaInPayload(payload, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      recordsDir: fixture.recordsDir,
      cache: new Map(),
    }) as typeof payload;

    const image = result.message.content[1] as Record<string, unknown>;
    assert.equal(image.fileId, "file_outgoing_payload");
    assert.equal(image.downloadUrl, "/api/mobile/files/file_outgoing_payload");
    assert.equal(image.fileName, "photo.jpg");
    assert.equal(image.sourceRunId, "assistant-run-outgoing");
    assert.equal(image.gatewayId, "gw_test");
    assert.equal(image.sessionKey, "agent:main:session_1");
  } finally {
    await server.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("relayOutgoingMediaInPayload shares one upload while identical blocks resolve concurrently", async () => {
  const fixture = await createOutgoingMediaFixture();
  const server = await createFileUploadRelayServer("file_outgoing_shared");
  try {
    const outgoingUrl = `/api/chat/media/outgoing/agent%3Amain%3Asession_1/${fixture.attachmentId}/full`;
    const payload = {
      message: {
        runId: "assistant-run-shared",
        role: "assistant",
        content: [
          { type: "image", url: outgoingUrl, mimeType: "image/jpeg" },
          { type: "image", url: outgoingUrl, mimeType: "image/jpeg" },
        ],
      },
    };

    const result = await relayOutgoingMediaInPayload(payload, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      recordsDir: fixture.recordsDir,
      cache: new Map(),
    }) as typeof payload;

    assert.equal(server.initRequestCount(), 1);
    assert.deepEqual(
      result.message.content.map((block) => (block as Record<string, unknown>).fileId),
      ["file_outgoing_shared", "file_outgoing_shared"],
    );
    assert.equal(typeof server.initBody()?.idempotencyKey, "string");
    assert.notEqual(server.initBody()?.idempotencyKey, "");
  } finally {
    await server.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("relayOutgoingMediaInHistoryResponse rewrites outgoing media inside chat history", async () => {
  const fixture = await createOutgoingMediaFixture();
  const server = await createFileUploadRelayServer("file_outgoing_history");
  try {
    const history = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "image",
              url: `/api/chat/media/outgoing/agent%3Amain%3Asession_1/${fixture.attachmentId}/full`,
              mimeType: "image/jpeg",
            },
          ],
        },
      ],
    };

    const result = await relayOutgoingMediaInHistoryResponse(history, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      recordsDir: fixture.recordsDir,
      cache: new Map(),
    }) as typeof history;

    const image = result.messages[0].content[0] as Record<string, unknown>;
    assert.equal(image.fileId, "file_outgoing_history");
    assert.equal(image.downloadPath, "/api/mobile/files/file_outgoing_history");
  } finally {
    await server.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("relayOutgoingMediaInHistoryResponse strips staged user media without reuploading host paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-openclaw-input-media-history-"));
  const imagePath = join(root, "22.JPG");
  await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const server = await createFileUploadRelayServer("file_input_history");
  try {
    const history = {
      sessionKey: "agent:main:session_1",
      messages: [{
        id: "user-message-1",
        runId: "client-run-1:user",
        role: "user",
        content: [{ type: "text", text: `分析一下这个图片\n\n[media attached: ${imagePath} (image/jpeg) | ${imagePath}]` }],
      }],
    };

    const result = await relayOutgoingMediaInHistoryResponse(history, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      cache: new Map(),
    }) as typeof history;

    assert.equal(result.messages[0].content[0]?.text, "分析一下这个图片");
    assert.equal(result.messages[0].content.length, 1);
    assert.equal(server.initRequestCount(), 0);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("relayOutgoingMediaInHistoryResponse strips OpenClaw MEDIA control markers without local artifact uploads", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-openclaw-media-marker-history-"));
  const imagePath = join(root, "codex-shot.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const server = await createFileUploadRelayServer("file_should_not_upload");
  try {
    const history = {
      sessionKey: "agent:main:session_1",
      messages: [
        {
          id: "assistant-message-1",
          role: "assistant",
          content: [
            { type: "text", text: `桌面截图已发送到你手机上了\nMEDIA:${imagePath}` },
          ],
        },
      ],
      timelineSnapshot: {
        messages: [
          {
            messageId: "assistant-message-1",
            role: "assistant",
            content: [
              { type: "text", text: `桌面截图已发送到你手机上了\nMEDIA:${imagePath}` },
            ],
          },
        ],
      },
    };

    const result = await relayOutgoingMediaInHistoryResponse(history, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      cache: new Map(),
    }) as typeof history;

    assert.equal((result.messages[0].content[0] as Record<string, unknown>).text, "桌面截图已发送到你手机上了");
    assert.equal(result.messages[0].content.length, 1);
    assert.equal((result.timelineSnapshot.messages[0].content[0] as Record<string, unknown>).text, "桌面截图已发送到你手机上了");
    assert.equal(result.timelineSnapshot.messages[0].content.length, 1);
    assert.equal(server.initRequestCount(), 0);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("relayOutgoingMediaInPayload does not treat OpenClaw MEDIA markers as sendable local paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-openclaw-media-marker-payload-"));
  const imagePath = join(root, "codex-shot.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const server = await createFileUploadRelayServer("file_should_not_upload");
  try {
    const payload = {
      runId: "assistant-run-1",
      sessionKey: "agent:main:session_1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: `截图已经发过去了\nMEDIA:${imagePath}` },
        ],
      },
    };

    const result = await relayOutgoingMediaInPayload(payload, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      cache: new Map(),
      userMessage: "把截图发过来",
    }) as typeof payload;

    assert.deepEqual(result.message.content, [
      { type: "text", text: "截图已经发过去了" },
    ]);
    assert.equal(server.initRequestCount(), 0);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows OpenClaw MEDIA and input attachment markers are removed without host path uploads", async () => {
  const server = await createFileUploadRelayServer("windows_path_should_not_upload");
  try {
    const drivePath = "C:\\Users\\测试 User\\Pictures\\shot.png";
    const uncPath = "\\\\fileserver\\共享\\report.pdf";
    const payload = {
      runId: "windows-user-run:user",
      sessionKey: "agent:main:session_1",
      message: {
        id: "windows-user-message",
        runId: "windows-user-run:user",
        role: "user",
        content: [{
          type: "text",
          text: `检查附件\n[media attached: ${drivePath} (image/png) | ${drivePath}]\nMEDIA:${uncPath}`,
        }],
      },
    };

    const result = await relayOutgoingMediaInHistoryResponse({
      sessionKey: payload.sessionKey,
      messages: [payload.message],
    }, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      cache: new Map(),
    }) as { messages: Array<{ content: Array<{ text?: string }> }> };

    assert.deepEqual(result.messages[0]?.content, [{ type: "text", text: "检查附件" }]);
    assert.equal(server.initRequestCount(), 0);
  } finally {
    await server.close();
  }
});

test("relayOutgoingMediaInPayload uploads assistant local artifact paths when user asked to send them", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-openclaw-artifact-"));
  const imagePath = join(root, "ChatGPT Image 2026 04 24.jpg");
  await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const server = await createFileUploadRelayServer("file_local_artifact");
  try {
    const payload = {
      runId: "run-1",
      sessionKey: "agent:main:session_1",
      state: "final",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: `Here is the image:\n${imagePath}` },
        ],
      },
    };

    const result = await relayOutgoingMediaInPayload(payload, {
      relayServerUrl: server.baseUrl,
      relaySecret: "secret",
      gatewayId: "gw_test",
      cache: new Map(),
      userMessage: `send ${imagePath} to my phone`,
    }) as typeof payload;

    assert.equal(result.message.content.length, 2);
    const image = result.message.content[1] as Record<string, unknown>;
    assert.equal(image.type, "image");
    assert.equal(image.fileId, "file_local_artifact");
    assert.equal(image.downloadUrl, "/api/mobile/files/file_local_artifact");
    assert.equal(image.downloadPath, "/api/mobile/files/file_local_artifact");
    assert.equal(image.sourceRunId, "run-1");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("relayOutgoingMediaInPayload invalidates cached local artifacts by file version and source run", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-openclaw-artifact-cache-version-"));
  const imagePath = join(root, "mutable.png");
  await writeFile(imagePath, Buffer.from([1, 2, 3, 4]));
  const server = await createFileUploadRelayServer("file_mutable");
  const cache = new Map();
  const publish = (runId: string) => relayOutgoingMediaInPayload({
    runId,
    sessionKey: "agent:main:session_1",
    state: "final",
    message: { role: "assistant", content: [{ type: "text", text: `sent ${imagePath}` }] },
  }, {
    relayServerUrl: server.baseUrl,
    relaySecret: "secret",
    gatewayId: "gw_test",
    cache,
    userMessage: `send ${imagePath} to my phone`,
  });
  try {
    const first = await publish("run-same") as any;
    await writeFile(imagePath, Buffer.from([1, 2, 3, 4, 5]));
    const changedFile = await publish("run-same") as any;
    const changedRun = await publish("run-next") as any;

    assert.equal(server.initRequestCount(), 3);
    assert.equal(first.message.content[1].fileId, "file_mutable");
    assert.equal(changedFile.message.content[1].fileId, "file_mutable_2");
    assert.equal(changedRun.message.content[1].fileId, "file_mutable_3");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("relayOutgoingMediaInPayload leaves local paths alone without send intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-openclaw-artifact-no-intent-"));
  const imagePath = join(root, "photo.jpg");
  await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  try {
    const payload = {
      runId: "run-1",
      sessionKey: "agent:main:session_1",
      state: "final",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: `The image path is ${imagePath}` },
        ],
      },
    };

    const result = await relayOutgoingMediaInPayload(payload, {
      relayServerUrl: "http://127.0.0.1:1",
      relaySecret: "secret",
      gatewayId: "gw_test",
      userMessage: "where is the image",
    });

    assert.equal(result, payload);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createOutgoingMediaFixture() {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-outgoing-media-"));
  const recordsDir = join(root, "records");
  const originalsDir = join(root, "originals");
  await mkdir(recordsDir, { recursive: true });
  await mkdir(originalsDir, { recursive: true });
  const attachmentId = "att_test";
  const imagePath = join(originalsDir, "photo.jpg");
  await writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await writeFile(join(recordsDir, `${attachmentId}.json`), JSON.stringify({
    attachmentId,
    sessionKey: "agent:main:session_1",
    alt: "photo.jpg",
    original: {
      path: imagePath,
      contentType: "image/jpeg",
      width: 20,
      height: 10,
      sizeBytes: 4,
      filename: "photo.jpg",
    },
  }));
  return { root, recordsDir, attachmentId };
}

async function createFileUploadRelayServer(fileId: string) {
  const uploads = new Map<string, {
    chunks: Buffer[];
    fileId: string;
    sizeBytes: number;
    sourceRunId?: string;
  }>();
  let lastInitBody: Record<string, unknown> | undefined;
  let initRequestCount = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (req.method === "POST" && url === "/api/host/gateways/gw_test/files/init") {
      initRequestCount += 1;
      const initBody = JSON.parse((await readRequestBody(req)).toString("utf8")) as Record<string, unknown>;
      lastInitBody = initBody;
      const uploadId = `upload_test_${initRequestCount}`;
      const resolvedFileId = initRequestCount === 1 ? fileId : `${fileId}_${initRequestCount}`;
      uploads.set(uploadId, {
        chunks: [],
        fileId: resolvedFileId,
        sizeBytes: Number(initBody.sizeBytes ?? 0),
        sourceRunId: typeof initBody.sourceRunId === "string" ? initBody.sourceRunId : undefined,
      });
      writeJson(res, {
        fileId: resolvedFileId,
        uploadId,
        chunkSize: 1024,
        expiresAt: "2026-06-02T00:00:00.000Z",
        uploadUrl: `/api/host/files/${uploadId}/chunks`,
      });
      return;
    }
    const chunkMatch = /^\/api\/host\/files\/(upload_test_\d+)\/chunks\/0$/.exec(url);
    if (req.method === "PUT" && chunkMatch) {
      uploads.get(chunkMatch[1]!)?.chunks.push(await readRequestBody(req));
      writeJson(res, { ok: true });
      return;
    }
    const completeMatch = /^\/api\/host\/files\/(upload_test_\d+)\/complete$/.exec(url);
    if (req.method === "POST" && completeMatch) {
      await readRequestBody(req);
      const upload = uploads.get(completeMatch[1]!);
      assert(upload);
      assert.equal(Buffer.concat(upload.chunks).length, upload.sizeBytes);
      writeJson(res, {
        ok: true,
        payload: {
          fileId: upload.fileId,
          gatewayId: "gw_test",
          sessionKey: "agent:main:session_1",
          fileName: "photo.jpg",
          mimeType: "image/jpeg",
          sizeBytes: upload.sizeBytes,
          imageWidth: 20,
          imageHeight: 10,
          sha256: "sha",
          origin: "host",
          createdAt: "2026-05-26T00:00:00.000Z",
          updatedAt: "2026-05-26T00:00:00.000Z",
          expiresAt: "2026-06-02T00:00:00.000Z",
          status: "ready",
          storagePath: "files/test",
          downloadPath: `/api/mobile/files/${upload.fileId}`,
          chunkSize: 1024,
          totalChunks: 1,
          sourceRunId: upload.sourceRunId,
        },
      });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    initRequestCount: () => initRequestCount,
    initBody: () => lastInitBody,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function writeJson(res: ServerResponse, body: unknown): void {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
