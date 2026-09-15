import assert from "assert/strict";
import { createHash } from "crypto";
import { createServer, type IncomingMessage } from "http";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Writable } from "stream";
import { calculateChunkCount, inferMimeType, normalizeSessionKey, toRelayHttpBase } from "../core/relay/file-upload-utils.js";
import {
  markOpenClawActiveRunTerminal,
  recordOpenClawActiveRun,
  resolveOpenClawActiveRun,
} from "../openclaw/relay/openclaw-active-run-state.js";
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
        assert.equal(initBody.sourceRole, "assistant");
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
        session: "agent:main:main",
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
      {
        filePath,
        gateway: "gw-1",
        session: "agent:main:main",
        sourceRunId: "run-png-1",
        json: true,
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

    assert.equal(result.imageWidth, 1);
    assert.equal(result.imageHeight, 1);
    assert.ok(initBody);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("send-file accepts an explicit OpenClaw session and source run from bridge environment", async () => {
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
        session: "agent:main:main",
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
        env: {
          CLAWCONNECT_SOURCE_RUN_ID: "env-run-1",
          CLAWCONNECT_SESSION_KEY: "agent:main:main",
        },
      },
    );

    assert.equal(initBody?.sourceRunId, "env-run-1");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("send-file refuses OpenClaw active-run guessing even when a typed record exists", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "clawconnect-send-file-no-guess-"));
  const filePath = join(tempDir, "sample.mp3");
  await writeFile(filePath, "active-session-mp3", "utf8");
  const previousActiveRunStore = process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE;
  process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE = join(tempDir, "active-runs.json");
  await recordOpenClawActiveRun({ gatewayId: "gw-1", sessionKey: "agent:main:ios-selected", sourceRunId: "run-selected" });
  try {
    await assert.rejects(
      () => sendFileCommand(
        { filePath, gateway: "gw-1", json: true },
        {
          loadConfig: () => ({
            relayServerUrl: "http://127.0.0.1:1",
            gatewayId: "gw-1",
            relaySecret: "secret-123",
            gatewayType: "openclaw",
          }),
        },
      ),
      { message: "openclaw_send_file_requires_explicit_session_and_source_run_id" },
    );
  } finally {
    if (previousActiveRunStore === undefined) delete process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE;
    else process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE = previousActiveRunStore;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("send-file refuses an unqualified OpenClaw Relay alias even with an explicit source run", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "clawconnect-send-file-unqualified-session-"));
  const filePath = join(tempDir, "sample.txt");
  await writeFile(filePath, "unqualified-session", "utf8");
  try {
    await assert.rejects(
      () => sendFileCommand(
        { filePath, gateway: "gw-1", session: "main", sourceRunId: "run-explicit", json: true },
        {
          loadConfig: () => ({
            relayServerUrl: "http://127.0.0.1:1",
            gatewayId: "gw-1",
            relaySecret: "secret-123",
            gatewayType: "openclaw",
          }),
        },
      ),
      { message: "openclaw_send_file_requires_full_agent_session_key" },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("send-file uses an explicit OpenClaw session and source run instead of active-run guessing", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "clawconnect-send-file-session-"));
  const filePath = join(tempDir, "sample.mp3");
  const fileBytes = Buffer.from("active-session-mp3", "utf8");
  await writeFile(filePath, fileBytes);

  const previousActiveRunStore = process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE;
  process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE = join(tempDir, "active-runs.json");
  await recordOpenClawActiveRun({ gatewayId: "gw-1", sessionKey: "agent:main:ios-selected", sourceRunId: "run-selected" });

  const expectedSessionKey = "ios-selected";
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
      {
        filePath,
        gateway: "gw-1",
        session: "agent:main:ios-selected",
        sourceRunId: "run-selected",
        json: true,
      },
      {
        loadConfig: () => ({
          relayServerUrl: baseUrl,
          gatewayId: "gw-1",
          relaySecret: "secret-123",
          displayName: "Host Mac",
          gatewayType: "openclaw",
        }),
        fetchImpl: fetch,
        stdout,
        stderr,
        sessionStoreRoot: join(tempDir, ".openclaw"),
      },
    );

    assert.equal(result.sessionKey, expectedSessionKey);
    assert.equal(initBody?.sourceRunId, "run-selected");
    assert.ok(initBody);
  } finally {
    if (previousActiveRunStore === undefined) delete process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE;
    else process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE = previousActiveRunStore;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("send-file keeps same-run two files and binds a rapid next round explicitly", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "clawconnect-send-file-dual-"));
  const firstPath = join(tempDir, "first.png");
  const secondPath = join(tempDir, "second.png");
  const nextPath = join(tempDir, "next.png");
  await writeFile(firstPath, Buffer.from("first", "utf8"));
  await writeFile(secondPath, Buffer.from("second", "utf8"));
  await writeFile(nextPath, Buffer.from("next", "utf8"));
  const previousActiveRunStore = process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE;
  process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE = join(tempDir, "active-runs.json");
  await recordOpenClawActiveRun({ gatewayId: "gw-dual", sessionKey: "agent:main:main", sourceRunId: "run-dual" });
  await recordOpenClawActiveRun({ gatewayId: "gw-dual", sessionKey: "agent:main:main", sourceRunId: "run-dual-next" });
  const initBodies: Array<Record<string, unknown>> = [];
  let transferNumber = 0;

  const server = createServer(async (req, res) => {
    try {
      const body = await readRequestBody(req);
      if (req.method === "POST" && req.url === "/api/host/gateways/gw-dual/files/init") {
        const init = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        initBodies.push(init);
        transferNumber += 1;
        sendJson(res, {
          fileId: `file_dual_${transferNumber}`,
          uploadId: `up_dual_${transferNumber}`,
          chunkSize: 4096,
          expiresAt: "2030-01-01T00:00:00.000Z",
          uploadUrl: `/api/host/files/up_dual_${transferNumber}/chunks`,
        });
        return;
      }
      const chunkMatch = /^\/api\/host\/files\/(up_dual_[1-3])\/chunks\/0$/.exec(req.url ?? "");
      if (req.method === "PUT" && chunkMatch) {
        sendJson(res, { ok: true });
        return;
      }
      const completeMatch = /^\/api\/host\/files\/(up_dual_[1-3])\/complete$/.exec(req.url ?? "");
      if (req.method === "POST" && completeMatch) {
        const number = Number.parseInt(completeMatch[1].slice("up_dual_".length), 10);
        const init = initBodies[number - 1];
        sendJson(res, {
          ok: true,
          payload: {
            fileId: `file_dual_${number}`,
            gatewayId: "gw-dual",
            sessionKey: "main",
            fileName: init.fileName,
            mimeType: init.mimeType,
            sizeBytes: init.sizeBytes,
            sha256: init.sha256,
            origin: "host",
            createdAt: "2030-01-01T00:00:00.000Z",
            updatedAt: "2030-01-01T00:00:00.000Z",
            expiresAt: "2030-01-08T00:00:00.000Z",
            status: "completed",
            storagePath: `/tmp/file_dual_${number}.png`,
            downloadPath: `/api/mobile/files/file_dual_${number}`,
            downloadUrl: `/api/mobile/files/file_dual_${number}`,
            chunkSize: 4096,
            totalChunks: 1,
          },
        });
        return;
      }
      throw new Error(`unexpected route: ${req.method} ${req.url}`);
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const deps = {
    loadConfig: () => ({
      relayServerUrl: baseUrl,
      gatewayId: "gw-dual",
      relaySecret: "secret-123",
      gatewayType: "openclaw" as const,
    }),
    fetchImpl: fetch,
    stdout: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    stderr: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
  };

  try {
    const first = await sendFileCommand({
      filePath: firstPath,
      session: "agent:main:main",
      sourceRunId: "run-dual",
      json: true,
    }, deps);
    const second = await sendFileCommand({
      filePath: secondPath,
      session: "agent:main:main",
      sourceRunId: "run-dual",
      json: true,
    }, deps);
    const next = await sendFileCommand({
      filePath: nextPath,
      session: "agent:main:main",
      sourceRunId: "run-dual-next",
      json: true,
    }, deps);
    assert.deepEqual([first.fileId, second.fileId, next.fileId], ["file_dual_1", "file_dual_2", "file_dual_3"]);
    assert.deepEqual(initBodies.map((body) => [body.sourceRunId, body.fileName]), [
      ["run-dual", "first.png"],
      ["run-dual", "second.png"],
      ["run-dual-next", "next.png"],
    ]);
    assert.equal(
      (await resolveOpenClawActiveRun({
        gatewayId: "gw-dual",
        sessionKey: "agent:main:main",
        sourceRunId: "run-dual",
      }))?.sourceRunId,
      "run-dual",
    );
  } finally {
    if (previousActiveRunStore === undefined) delete process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE;
    else process.env.CLAWCONNECT_OPENCLAW_ACTIVE_RUN_STORE = previousActiveRunStore;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("send-file binds concurrent agents with the same Relay alias by explicit full session and run", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "clawconnect-send-file-agent-concurrency-"));
  const mainPath = join(tempDir, "main.png");
  const healthPath = join(tempDir, "health.png");
  await writeFile(mainPath, "main-agent", "utf8");
  await writeFile(healthPath, "health-agent", "utf8");
  const initBodies: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    try {
      const body = await readRequestBody(req);
      if (req.method === "POST" && req.url === "/api/host/gateways/gw-agents/files/init") {
        const init = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        initBodies.push(init);
        const number = initBodies.length;
        sendJson(res, {
          fileId: `file_agent_${number}`,
          uploadId: `up_agent_${number}`,
          chunkSize: 1024,
          expiresAt: "2030-01-01T00:00:00.000Z",
          uploadUrl: `/api/host/files/up_agent_${number}/chunks`,
        });
        return;
      }
      const chunkMatch = /^\/api\/host\/files\/(up_agent_[12])\/chunks\/0$/.exec(req.url ?? "");
      if (req.method === "PUT" && chunkMatch) {
        sendJson(res, { ok: true });
        return;
      }
      const completeMatch = /^\/api\/host\/files\/(up_agent_[12])\/complete$/.exec(req.url ?? "");
      if (req.method === "POST" && completeMatch) {
        const number = completeMatch[1].endsWith("1") ? 1 : 2;
        const init = initBodies[number - 1]!;
        sendJson(res, {
          ok: true,
          payload: {
            fileId: `file_agent_${number}`,
            gatewayId: "gw-agents",
            sessionKey: init.sessionKey,
            fileName: init.fileName,
            mimeType: init.mimeType,
            sizeBytes: init.sizeBytes,
            sha256: init.sha256,
            origin: "host",
            createdAt: "2030-01-01T00:00:00.000Z",
            updatedAt: "2030-01-01T00:00:00.000Z",
            expiresAt: "2030-01-08T00:00:00.000Z",
            status: "completed",
            storagePath: `/tmp/file_agent_${number}.png`,
            downloadPath: `/api/mobile/files/file_agent_${number}`,
            downloadUrl: `/api/mobile/files/file_agent_${number}`,
            chunkSize: 1024,
            totalChunks: 1,
            sourceRunId: init.sourceRunId,
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
  const deps = {
    loadConfig: () => ({
      relayServerUrl: `http://127.0.0.1:${address.port}`,
      gatewayId: "gw-agents",
      relaySecret: "secret-123",
      gatewayType: "openclaw" as const,
    }),
    fetchImpl: fetch,
    stdout: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    stderr: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
  };
  try {
    const [main, health] = await Promise.all([
      sendFileCommand({
        filePath: mainPath,
        session: "agent:main:main",
        sourceRunId: "run-main-agent",
        json: true,
      }, deps),
      sendFileCommand({
        filePath: healthPath,
        session: "agent:health-manager:main",
        sourceRunId: "run-health-agent",
        json: true,
      }, deps),
    ]);
    assert.deepEqual([main.fileId, health.fileId].sort(), ["file_agent_1", "file_agent_2"]);
    assert.deepEqual(
      initBodies
        .map((body) => [body.sessionKey, body.sourceRunId, body.fileName])
        .sort((left, right) => String(left[1]).localeCompare(String(right[1]))),
      [
        ["main", "run-health-agent", "health.png"],
        ["main", "run-main-agent", "main.png"],
      ],
    );
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
