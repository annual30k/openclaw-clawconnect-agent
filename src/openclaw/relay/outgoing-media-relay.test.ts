import assert from "assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  relayOutgoingMediaInHistoryResponse,
  relayOutgoingMediaInPayload,
} from "./outgoing-media-relay.js";

test("relayOutgoingMediaInPayload uploads OpenClaw outgoing media and rewrites the image block", async () => {
  const fixture = await createOutgoingMediaFixture();
  const server = await createFileUploadRelayServer("file_outgoing_payload");
  try {
    const payload = {
      message: {
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
    assert.equal(image.gatewayId, "gw_test");
    assert.equal(image.sessionKey, "agent:main:session_1");
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
  const receivedChunks: Buffer[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (req.method === "POST" && url === "/api/host/gateways/gw_test/files/init") {
      await readRequestBody(req);
      writeJson(res, {
        fileId,
        uploadId: "upload_test",
        chunkSize: 1024,
        expiresAt: "2026-06-02T00:00:00.000Z",
        uploadUrl: "/api/host/files/upload_test/chunks",
      });
      return;
    }
    if (req.method === "PUT" && url === "/api/host/files/upload_test/chunks/0") {
      receivedChunks.push(await readRequestBody(req));
      writeJson(res, { ok: true });
      return;
    }
    if (req.method === "POST" && url === "/api/host/files/upload_test/complete") {
      await readRequestBody(req);
      assert.equal(Buffer.concat(receivedChunks).length, 4);
      writeJson(res, {
        ok: true,
        payload: {
          fileId,
          gatewayId: "gw_test",
          sessionKey: "agent:main:session_1",
          fileName: "photo.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 4,
          imageWidth: 20,
          imageHeight: 10,
          sha256: "sha",
          origin: "host",
          createdAt: "2026-05-26T00:00:00.000Z",
          updatedAt: "2026-05-26T00:00:00.000Z",
          expiresAt: "2026-06-02T00:00:00.000Z",
          status: "ready",
          storagePath: "files/test",
          downloadPath: `/api/mobile/files/${fileId}`,
          chunkSize: 1024,
          totalChunks: 1,
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
