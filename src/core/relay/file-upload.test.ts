import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { uploadFileToRelay } from "./file-upload.js";

type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!headers) {
    return normalized;
  }
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      normalized[key.toLowerCase()] = value;
    });
    return normalized;
  }
  const entries = Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [key, value] of entries) {
    normalized[key.toLowerCase()] = String(value);
  }
  return normalized;
}

test("host uploads present the gateway secret on init, every chunk and completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clawconnect-file-upload-test-"));
  const filePath = join(directory, "report.txt");
  // 10 字节、分片 4 字节 => 3 个分片，覆盖多分片场景。
  await writeFile(filePath, "0123456789");
  const requests: RecordedRequest[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers: normalizeHeaders(init?.headers),
      body: init?.body,
    });
    if (url.endsWith("/files/init")) {
      return jsonResponse({
        fileId: "file_1",
        uploadId: "up_1",
        chunkSize: 4,
        expiresAt: "2030-01-01T00:00:00.000Z",
        uploadUrl: "/api/host/files/up_1/chunks",
      });
    }
    if (url.endsWith("/complete")) {
      return jsonResponse({
        ok: true,
        payload: {
          fileId: "file_1",
          gatewayId: "gw_1",
          sessionKey: "main",
          fileName: "report.txt",
          mimeType: "text/plain",
          sizeBytes: 10,
          sha256: "sha",
          origin: "host",
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z",
          expiresAt: "2030-01-08T00:00:00.000Z",
          status: "completed",
          storagePath: "/data/report.txt",
          downloadPath: "/api/mobile/files/file_1",
          chunkSize: 4,
          totalChunks: 3,
        },
      });
    }
    return jsonResponse({ ok: true });
  };

  try {
    const result = await uploadFileToRelay({
      relayServerUrl: "http://127.0.0.1:8080",
      relaySecret: "relay-secret",
      gatewayId: "gw_1",
      sessionKey: "main",
      filePath,
    }, { fetchImpl });

    assert.equal(result.totalChunks, 3);
    assert.equal(result.uploadId, "up_1");

    const [init, ...rest] = requests;
    assert.equal(init.method, "POST");
    assert.ok(init.url.endsWith("/api/host/gateways/gw_1/files/init"));
    assert.equal((JSON.parse(String(init.body)) as { secret?: string }).secret, "relay-secret");

    const chunks = rest.filter((request) => request.method === "PUT");
    assert.deepEqual(
      chunks.map((request) => new URL(request.url).pathname),
      ["/api/host/files/up_1/chunks/0", "/api/host/files/up_1/chunks/1", "/api/host/files/up_1/chunks/2"],
    );
    for (const chunk of chunks) {
      assert.equal(chunk.headers["x-relay-secret"], "relay-secret");
    }

    const complete = requests.at(-1);
    assert.ok(complete);
    assert.equal(complete.method, "POST");
    assert.equal(new URL(complete.url).pathname, "/api/host/files/up_1/complete");
    assert.equal(complete.headers["x-relay-secret"], "relay-secret");
    assert.deepEqual(JSON.parse(String(complete.body)), { totalChunks: 3 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
