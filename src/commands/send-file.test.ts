import assert from "assert/strict";
import { createHash } from "crypto";
import { createServer, type IncomingMessage } from "http";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Writable } from "stream";
import { calculateChunkCount, inferMimeType, normalizeSessionKey, toRelayHttpBase } from "../core/relay/file-upload-utils.js";
import { sendFileCommand } from "./send-file.js";

test("utility helpers normalize relay URLs and chunk counts", () => {
  assert.equal(toRelayHttpBase("wss://relay.example.com"), "https://relay.example.com");
  assert.equal(toRelayHttpBase("ws://relay.example.com/base/"), "http://relay.example.com/base");
  assert.equal(inferMimeType("photo.PNG"), "image/png");
  assert.equal(inferMimeType("lecture.mp3"), "audio/mpeg");
  assert.equal(
    inferMimeType("report.docx"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.equal(inferMimeType("archive.unknownext"), "application/octet-stream");
  assert.equal(normalizeSessionKey("  "), "main");
  assert.equal(normalizeSessionKey("chat-1"), "chat-1");
  assert.equal(calculateChunkCount(0, 4096), 1);
  assert.equal(calculateChunkCount(8193, 4096), 3);
});

test("send-file uploads chunks and finalizes the transfer", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "clawconnect-send-file-"));
  const filePath = join(tempDir, "hello.txt");
  const fileBytes = Buffer.from("abcdefghij", "utf8");
  await writeFile(filePath, fileBytes);

  const expectedSha256 = createHash("sha256").update(fileBytes).digest("hex");
  const chunkBodies: Buffer[] = [];

  let initBody: Record<string, unknown> | undefined;
  let completeBody: Record<string, unknown> | undefined;

  const server = createServer(async (req, res) => {
    try {
      const body = await readRequestBody(req);

      if (req.method === "POST" && req.url === "/api/host/gateways/gw-1/files/init") {
        initBody = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        assert.equal(initBody.secret, "secret-123");
        assert.equal(initBody.sessionKey, "main");
        assert.equal(initBody.fileName, "hello.txt");
        assert.equal(initBody.mimeType, "text/plain");
        assert.equal(initBody.sizeBytes, fileBytes.byteLength);
        assert.equal(initBody.senderDisplayName, "Host Mac");
        assert.equal(initBody.transcript, "这是要展示的转写文本");
        assert.equal(initBody.sourceRunId, "run-voice-1");
        assert.equal(initBody.sha256, expectedSha256);
        assert.equal(typeof initBody.clientCreatedAt, "string");

        sendJson(res, {
          fileId: "file_test",
          uploadId: "up_test",
          chunkSize: 4,
          expiresAt: "2030-01-01T00:00:00.000Z",
          uploadUrl: "/api/host/files/up_test/chunks",
        });
        return;
      }

      if (req.method === "PUT" && req.url === "/api/host/files/up_test/chunks/0") {
        chunkBodies.push(body);
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === "PUT" && req.url === "/api/host/files/up_test/chunks/1") {
        chunkBodies.push(body);
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === "PUT" && req.url === "/api/host/files/up_test/chunks/2") {
        chunkBodies.push(body);
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === "POST" && req.url === "/api/host/files/up_test/complete") {
        completeBody = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        assert.equal(completeBody.totalChunks, 3);

        sendJson(res, {
          ok: true,
          payload: {
            fileId: "file_test",
            gatewayId: "gw-1",
            sessionKey: "main",
            fileName: "hello.txt",
            mimeType: "text/plain",
            sizeBytes: fileBytes.byteLength,
            sha256: expectedSha256,
            origin: "host",
            senderDisplayName: "Host Mac",
            createdAt: "2030-01-01T00:00:00.000Z",
            updatedAt: "2030-01-01T00:00:00.000Z",
            expiresAt: "2030-01-08T00:00:00.000Z",
            status: "completed",
            storagePath: "/tmp/file_test.txt",
            downloadPath: "/api/mobile/files/file_test",
            downloadUrl: "/api/mobile/files/file_test",
            chunkSize: 4,
            totalChunks: 3,
          },
        });
        return;
      }

      throw new Error(`unexpected route: ${req.method} ${req.url}`);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const stderr = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  try {
    const result = await sendFileCommand(
      {
        filePath,
        gateway: "gw-1",
        session: "main",
        json: true,
        transcript: "这是要展示的转写文本",
        sourceRunId: "run-voice-1",
      },
      {
        loadConfig: () => ({
          relayServerUrl: baseUrl,
          gatewayId: "gw-1",
          relaySecret: "secret-123",
          displayName: "Host Mac",
        }),
        fetchImpl: fetch,
        stdout,
        stderr,
      },
    );

    assert.equal(result.fileId, "file_test");
    assert.equal(result.uploadId, "up_test");
    assert.equal(result.downloadPath, "/api/mobile/files/file_test");
    assert.equal(result.downloadUrl, `${baseUrl}/api/mobile/files/file_test`);
    assert.equal(result.totalChunks, 3);
    assert.equal(chunkBodies.length, 3);
    assert.deepEqual(Buffer.concat(chunkBodies), fileBytes);
    assert.ok(initBody);
    assert.ok(completeBody);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("send-file includes image dimensions for PNG uploads", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "clawconnect-send-file-image-"));
  const filePath = join(tempDir, "photo.png");
  const fileBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5dXhsAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(filePath, fileBytes);

  const expectedSha256 = createHash("sha256").update(fileBytes).digest("hex");
  let initBody: Record<string, unknown> | undefined;

  const server = createServer(async (req, res) => {
    try {
      const body = await readRequestBody(req);

      if (req.method === "POST" && req.url === "/api/host/gateways/gw-1/files/init") {
        initBody = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        assert.equal(initBody.fileName, "photo.png");
        assert.equal(initBody.mimeType, "image/png");
        assert.equal(initBody.sizeBytes, fileBytes.byteLength);
        assert.equal(initBody.imageWidth, 1);
        assert.equal(initBody.imageHeight, 1);
        assert.equal(initBody.sha256, expectedSha256);
        assert.equal(typeof initBody.clientCreatedAt, "string");

        sendJson(res, {
          fileId: "file_png",
          uploadId: "up_png",
          chunkSize: 4096,
          expiresAt: "2030-01-01T00:00:00.000Z",
          uploadUrl: "/api/host/files/up_png/chunks",
        });
        return;
      }

      if (req.method === "PUT" && req.url === "/api/host/files/up_png/chunks/0") {
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === "POST" && req.url === "/api/host/files/up_png/complete") {
        sendJson(res, {
          ok: true,
          payload: {
            fileId: "file_png",
            gatewayId: "gw-1",
            sessionKey: "main",
            fileName: "photo.png",
            mimeType: "image/png",
            sizeBytes: fileBytes.byteLength,
            imageWidth: 1,
            imageHeight: 1,
            sha256: expectedSha256,
            origin: "host",
            senderDisplayName: "Host Mac",
            createdAt: "2030-01-01T00:00:00.000Z",
            updatedAt: "2030-01-01T00:00:00.000Z",
            expiresAt: "2030-01-08T00:00:00.000Z",
            status: "completed",
            storagePath: "/tmp/file_png.png",
            downloadPath: "/api/mobile/files/file_png",
            downloadUrl: "/api/mobile/files/file_png",
            chunkSize: 4096,
            totalChunks: 1,
          },
        });
        return;
      }

      throw new Error(`unexpected route: ${req.method} ${req.url}`);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const stderr = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  try {
    const result = await sendFileCommand(
      { filePath, gateway: "gw-1", session: "main", json: true },
      {
        loadConfig: () => ({
          relayServerUrl: baseUrl,
          gatewayId: "gw-1",
          relaySecret: "secret-123",
          displayName: "Host Mac",
        }),
        fetchImpl: fetch,
        stdout,
        stderr,
      },
    );

    assert.equal(result.imageWidth, 1);
    assert.equal(result.imageHeight, 1);
    assert.ok(initBody);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("send-file infers source run id from OpenClaw environment", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "clawconnect-send-file-source-run-"));
  const filePath = join(tempDir, "hello.txt");
  await writeFile(filePath, "hello", "utf8");

  let initBody: Record<string, unknown> | undefined;
  const server = createServer(async (req, res) => {
    try {
      const body = await readRequestBody(req);
      if (req.method === "POST" && req.url === "/api/host/gateways/gw-1/files/init") {
        initBody = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        sendJson(res, {
          fileId: "file_env",
          uploadId: "up_env",
          chunkSize: 1024,
          expiresAt: "2030-01-01T00:00:00.000Z",
          uploadUrl: "/api/host/files/up_env/chunks",
        });
        return;
      }
      if (req.method === "PUT" && req.url === "/api/host/files/up_env/chunks/0") {
        sendJson(res, { ok: true });
        return;
      }
      if (req.method === "POST" && req.url === "/api/host/files/up_env/complete") {
        sendJson(res, {
          ok: true,
          payload: {
            fileId: "file_env",
            gatewayId: "gw-1",
            sessionKey: "main",
            fileName: "hello.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
            sha256: "sha",
            origin: "host",
            createdAt: "2030-01-01T00:00:00.000Z",
            updatedAt: "2030-01-01T00:00:00.000Z",
            expiresAt: "2030-01-01T00:00:00.000Z",
            status: "completed",
            storagePath: "/tmp/hello.txt",
            downloadPath: "/api/mobile/files/file_env",
            chunkSize: 1024,
            totalChunks: 1,
            sourceRunId: "env-run-1",
          },
        });
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await sendFileCommand(
      {
        filePath,
        gateway: "gw-1",
        session: "main",
        json: true,
      },
      {
        loadConfig: () => ({
          relayServerUrl: `http://127.0.0.1:${address.port}`,
          gatewayId: "gw-1",
          relaySecret: "secret-123",
        }),
        fetchImpl: fetch,
        stdout: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
        stderr: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
        env: { OPENCLAW_RUN_ID: "env-run-1:user" },
      },
    );

    assert.equal(initBody?.sourceRunId, "env-run-1");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("send-file infers source run id from the active OpenClaw send-file tool call", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "clawconnect-send-file-openclaw-run-"));
  const filePath = join(tempDir, "hello.txt");
  await writeFile(filePath, "hello", "utf8");

  const sessionStoreRoot = join(tempDir, ".openclaw");
  const sessionsDir = join(sessionStoreRoot, "agents", "main", "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const sessionKey = "agent:main:ios-device-1";
  const transcriptPath = join(sessionsDir, "session-1.jsonl");
  await writeFile(
    join(sessionsDir, "sessions.json"),
    JSON.stringify({
      [sessionKey]: {
        sessionId: "session-1",
        sessionFile: "session-1.jsonl",
        updatedAt: 2000,
      },
    }),
  );
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({
        type: "message",
        id: "assistant-older",
        timestamp: "2030-01-01T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "older" }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "assistant-send-run",
        timestamp: "2030-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            name: "exec",
            arguments: {
              command: `clawconnect send-file --profile openclaw --json ${filePath}`,
            },
          }],
        },
      }),
    ].join("\n"),
    "utf8",
  );

  let initBody: Record<string, unknown> | undefined;
  const server = createServer(async (req, res) => {
    try {
      const body = await readRequestBody(req);
      if (req.method === "POST" && req.url === "/api/host/gateways/gw-1/files/init") {
        initBody = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        sendJson(res, {
          fileId: "file_openclaw_run",
          uploadId: "up_openclaw_run",
          chunkSize: 1024,
          expiresAt: "2030-01-01T00:00:00.000Z",
          uploadUrl: "/api/host/files/up_openclaw_run/chunks",
        });
        return;
      }
      if (req.method === "PUT" && req.url === "/api/host/files/up_openclaw_run/chunks/0") {
        sendJson(res, { ok: true });
        return;
      }
      if (req.method === "POST" && req.url === "/api/host/files/up_openclaw_run/complete") {
        sendJson(res, {
          ok: true,
          payload: {
            fileId: "file_openclaw_run",
            gatewayId: "gw-1",
            sessionKey,
            fileName: "hello.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
            sha256: "sha",
            origin: "host",
            createdAt: "2030-01-01T00:00:00.000Z",
            updatedAt: "2030-01-01T00:00:00.000Z",
            expiresAt: "2030-01-01T00:00:00.000Z",
            status: "completed",
            storagePath: "/tmp/hello.txt",
            downloadPath: "/api/mobile/files/file_openclaw_run",
            chunkSize: 1024,
            totalChunks: 1,
            sourceRunId: "assistant-send-run",
          },
        });
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await sendFileCommand(
      {
        filePath,
        gateway: "gw-1",
        session: sessionKey,
        json: true,
      },
      {
        loadConfig: () => ({
          relayServerUrl: `http://127.0.0.1:${address.port}`,
          gatewayId: "gw-1",
          relaySecret: "secret-123",
          gatewayType: "openclaw",
        }),
        fetchImpl: fetch,
        stdout: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
        stderr: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
        env: {},
        sessionStoreRoot,
      },
    );

    assert.equal(initBody?.sourceRunId, "assistant-send-run");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("send-file infers the latest active session when session is omitted", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "clawconnect-send-file-session-"));
  const filePath = join(tempDir, "sample.mp3");
  const fileBytes = Buffer.from("active-session-mp3", "utf8");
  await writeFile(filePath, fileBytes);

  const sessionStoreRoot = join(tempDir, ".openclaw");
  const sessionsDir = join(sessionStoreRoot, "agents", "main", "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, "sessions.json"),
    JSON.stringify(
      {
        "agent:main:main": { updatedAt: 1000 },
        "agent:main:ios-selected": { updatedAt: 2000 },
        "agent:main:archive": { updatedAt: 1500 },
      },
      null,
      2,
    ),
  );

  const expectedSessionKey = "agent:main:ios-selected";
  const expectedSha256 = createHash("sha256").update(fileBytes).digest("hex");

  let initBody: Record<string, unknown> | undefined;

  const server = createServer(async (req, res) => {
    try {
      const body = await readRequestBody(req);

      if (req.method === "POST" && req.url === "/api/host/gateways/gw-1/files/init") {
        initBody = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        assert.equal(initBody.sessionKey, expectedSessionKey);
        assert.equal(initBody.fileName, "sample.mp3");
        assert.equal(initBody.mimeType, "audio/mpeg");
        assert.equal(initBody.sha256, expectedSha256);
        assert.equal(typeof initBody.clientCreatedAt, "string");

        sendJson(res, {
          fileId: "file_inferred",
          uploadId: "up_inferred",
          chunkSize: 1024,
          expiresAt: "2030-01-01T00:00:00.000Z",
          uploadUrl: "/api/host/files/up_inferred/chunks",
        });
        return;
      }

      if (req.method === "PUT" && req.url === "/api/host/files/up_inferred/chunks/0") {
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === "POST" && req.url === "/api/host/files/up_inferred/complete") {
        sendJson(res, {
          ok: true,
          payload: {
            fileId: "file_inferred",
            gatewayId: "gw-1",
            sessionKey: expectedSessionKey,
            fileName: "sample.mp3",
            mimeType: "audio/mpeg",
            sizeBytes: fileBytes.byteLength,
            sha256: expectedSha256,
            origin: "host",
            senderDisplayName: "Host Mac",
            createdAt: "2030-01-01T00:00:00.000Z",
            updatedAt: "2030-01-01T00:00:00.000Z",
            expiresAt: "2030-01-08T00:00:00.000Z",
            status: "completed",
            storagePath: "/tmp/file_inferred.mp3",
            downloadPath: "/api/mobile/files/file_inferred",
            downloadUrl: "/api/mobile/files/file_inferred",
            chunkSize: 1024,
            totalChunks: 1,
          },
        });
        return;
      }

      throw new Error(`unexpected route: ${req.method} ${req.url}`);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const stderr = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  try {
    const result = await sendFileCommand(
      { filePath, gateway: "gw-1", json: true },
      {
        loadConfig: () => ({
          relayServerUrl: baseUrl,
          gatewayId: "gw-1",
          relaySecret: "secret-123",
          displayName: "Host Mac",
        }),
        fetchImpl: fetch,
        stdout,
        stderr,
        sessionStoreRoot,
      },
    );

    assert.equal(result.sessionKey, expectedSessionKey);
    assert.ok(initBody);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("send-file uses the current ClawConnect chat session from env for Hermes uploads", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "clawconnect-send-file-hermes-session-"));
  const filePath = join(tempDir, "spiderman.jpg");
  const fileBytes = Buffer.from("current-hermes-session-image", "utf8");
  await writeFile(filePath, fileBytes);

  const expectedSessionKey = "ios-750154e6-4730-43af-80b9-8ffbaeb6c744";
  const expectedSha256 = createHash("sha256").update(fileBytes).digest("hex");

  let initBody: Record<string, unknown> | undefined;

  const server = createServer(async (req, res) => {
    try {
      const body = await readRequestBody(req);

      if (req.method === "POST" && req.url === "/api/host/gateways/gw-1/files/init") {
        initBody = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        assert.equal(initBody.sessionKey, expectedSessionKey);
        assert.equal(initBody.fileName, "spiderman.jpg");
        assert.equal(initBody.mimeType, "image/jpeg");
        assert.equal(initBody.sha256, expectedSha256);

        sendJson(res, {
          fileId: "file_hermes_session",
          uploadId: "up_hermes_session",
          chunkSize: 1024,
          expiresAt: "2030-01-01T00:00:00.000Z",
          uploadUrl: "/api/host/files/up_hermes_session/chunks",
        });
        return;
      }

      if (req.method === "PUT" && req.url === "/api/host/files/up_hermes_session/chunks/0") {
        sendJson(res, { ok: true });
        return;
      }

      if (req.method === "POST" && req.url === "/api/host/files/up_hermes_session/complete") {
        sendJson(res, {
          ok: true,
          payload: {
            fileId: "file_hermes_session",
            gatewayId: "gw-1",
            sessionKey: expectedSessionKey,
            fileName: "spiderman.jpg",
            mimeType: "image/jpeg",
            sizeBytes: fileBytes.byteLength,
            sha256: expectedSha256,
            origin: "host",
            senderDisplayName: "Host Mac",
            createdAt: "2030-01-01T00:00:00.000Z",
            updatedAt: "2030-01-01T00:00:00.000Z",
            expiresAt: "2030-01-08T00:00:00.000Z",
            status: "completed",
            storagePath: "/tmp/file_hermes_session.jpg",
            downloadPath: "/api/mobile/files/file_hermes_session",
            downloadUrl: "/api/mobile/files/file_hermes_session",
            chunkSize: 1024,
            totalChunks: 1,
          },
        });
        return;
      }

      throw new Error(`unexpected route: ${req.method} ${req.url}`);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const stdout = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const stderr = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  try {
    const result = await sendFileCommand(
      { filePath, gateway: "gw-1", json: true },
      {
        loadConfig: () => ({
          relayServerUrl: baseUrl,
          gatewayId: "gw-1",
          relaySecret: "secret-123",
          displayName: "Host Mac",
          gatewayType: "hermes",
        }),
        fetchImpl: fetch,
        stdout,
        stderr,
        env: { CLAWCONNECT_SESSION_KEY: expectedSessionKey },
      },
    );

    assert.equal(result.sessionKey, expectedSessionKey);
    assert.ok(initBody);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

function sendJson(res: import("http").ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
