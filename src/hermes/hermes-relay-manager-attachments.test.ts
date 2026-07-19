import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  hydrateCanonicalHermesAttachment,
  partitionRecentHermesAttachments,
} from "./hermes-relay-manager.js";
import {
  cleanupExpiredHermesInbox,
  sanitizeHermesUserAttachmentMarkers,
} from "./runtime/hermes-runtime-chat.js";

test("hydrateCanonicalHermesAttachment downloads the exact Relay file and verifies it", async () => {
  const bytes = Buffer.from("hermes-canonical-image");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let requestedUrl = "";
  let requestedSecret = "";

  const hydrated = await hydrateCanonicalHermesAttachment({
    fileId: "file_turn_1",
    fileName: "photo.png",
    mimeType: "image/png",
    sizeBytes: bytes.length,
    sha256,
  }, {
    relayServerUrl: "https://relay.example/base",
    relaySecret: "relay-secret",
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedSecret = new Headers(init?.headers).get("X-Relay-Secret") ?? "";
      return new Response(bytes, { status: 200 });
    },
  }) as Record<string, unknown>;

  assert.equal(requestedUrl, "https://relay.example/api/mobile/files/file_turn_1");
  assert.equal(requestedSecret, "relay-secret");
  assert.equal(hydrated.fileId, "file_turn_1");
  assert.equal(hydrated.content, bytes.toString("base64"));
});

test("hydrateCanonicalHermesAttachment rejects a digest mismatch", async () => {
  await assert.rejects(
    hydrateCanonicalHermesAttachment({
      fileId: "file_turn_2",
      sizeBytes: 3,
      sha256: "0".repeat(64),
    }, {
      relayServerUrl: "https://relay.example",
      relaySecret: "relay-secret",
      fetchImpl: async () => new Response(Buffer.from("abc"), { status: 200 }),
    }),
    /canonical_attachment_sha256_mismatch/,
  );
});

test("hydrateCanonicalHermesAttachment preserves legacy inline attachments", async () => {
  const legacy = { fileName: "legacy.txt", content: "bGVnYWN5" };
  assert.deepEqual(await hydrateCanonicalHermesAttachment(legacy, {
    relayServerUrl: "https://relay.example",
    relaySecret: "relay-secret",
  }), legacy);
});

test("Hermes recent attachment fallback only consumes files from the current run", () => {
  const previous = { fileId: "file_previous", sourceRunId: "run-previous" };
  const current = { fileId: "file_current", sourceRunId: "run-current" };
  const unscoped = { fileId: "file_unscoped" };

  const partition = partitionRecentHermesAttachments([previous, current, unscoped], "run-current");

  assert.deepEqual(partition.matched, [current]);
  assert.deepEqual(partition.unmatched, [previous, unscoped]);
});

test("Hermes recent attachment fallback consumes nothing when the command has no run id", () => {
  const previous = { fileId: "file_previous", sourceRunId: "run-previous" };
  const unscoped = { fileId: "file_unscoped" };

  const partition = partitionRecentHermesAttachments([previous, unscoped], undefined);

  assert.deepEqual(partition.matched, []);
  assert.deepEqual(partition.unmatched, [previous, unscoped]);
});

test("Hermes neutralizes user supplied local file markers", () => {
  assert.equal(
    sanitizeHermesUserAttachmentMarkers("inspect [file attached: /etc/passwd]"),
    "inspect ［file attached: /etc/passwd]",
  );
});

test("cleanupExpiredHermesInbox removes only expired run directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawconnect-hermes-inbox-"));
  const oldRun = join(root, "main", "old-run");
  const freshRun = join(root, "main", "fresh-run");
  try {
    await mkdir(oldRun, { recursive: true });
    await mkdir(freshRun, { recursive: true });
    await writeFile(join(oldRun, "old.txt"), "old");
    await writeFile(join(freshRun, "fresh.txt"), "fresh");
    const nowMs = Date.now();
    const oldDate = new Date(nowMs - 48 * 60 * 60 * 1000);
    await utimes(oldRun, oldDate, oldDate);

    await cleanupExpiredHermesInbox(root, nowMs, 24 * 60 * 60 * 1000);

    await assert.rejects(stat(oldRun));
    assert.equal((await stat(freshRun)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
