import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { afterEach } from "node:test";
import { WebSocket } from "ws";

import {
  RELIABLE_RELAY_EVENT_DELIVERY_ID_MAX_LENGTH,
  RELIABLE_RELAY_OUTBOX_STORAGE_SCOPE,
  RELIABLE_RELAY_RESPONSE_ID_MAX_LENGTH,
  ReliableRelayOutbox,
} from "./reliable-relay-outbox.js";
import {
  clearReliableRelayOutboxesForTests,
  RELIABLE_RELAY_OUTBOX_MAX_GATEWAYS,
  reliableRelayOutboxForGateway,
} from "./reliable-relay-outbox-registry.js";
import type {
  ReliableRelayOutboxStore,
  StoredReliableRelayOutboxEntry,
} from "./reliable-relay-outbox-store.js";

const temporaryDirectories: string[] = [];
const TEST_RELAY_IDENTITY = "https://relay.test";

afterEach(() => {
  clearReliableRelayOutboxesForTests();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ACK-capable Relay keeps canonical terminal until event_ack and replays exact envelope", () => {
  const firstWrites: string[] = [];
  const secondWrites: string[] = [];
  const firstSocket = fakeSocket((value, callback) => {
    firstWrites.push(value);
    callback();
  });
  const secondSocket = fakeSocket((value, callback) => {
    secondWrites.push(value);
    callback();
  });
  const outbox = new ReliableRelayOutbox("gw-1");

  const enqueue = outbox.enqueueIfReliable(terminalEnvelope());
  assert.equal(enqueue.status, "accepted");
  assert.equal(firstWrites.length, 0, "reliable frames must wait for Relay hello negotiation");

  outbox.attach(firstSocket, "acknowledged");
  assert.equal(outbox.pendingCount, 1);
  assert.equal(outbox.pendingAckCount, 1);
  const firstWire = JSON.parse(firstWrites[0]!) as Record<string, unknown>;
  assert.match(String(firstWire.deliveryId), /^delivery_[a-f0-9]{32}$/);

  outbox.detach(firstSocket);
  outbox.attach(secondSocket, "acknowledged");
  assert.deepEqual(secondWrites, firstWrites);
  assert.equal(outbox.pendingCount, 1);

  assert.equal(outbox.acknowledge(String(firstWire.deliveryId)), true);
  assert.equal(outbox.pendingCount, 0);
  assert.equal(outbox.pendingBytes, 0);
  outbox.clear();
});

test("legacy Relay removes reliable entries only after successful ws.send callback", () => {
  let callback: ((error?: Error) => void) | undefined;
  const writes: string[] = [];
  const socket = fakeSocket((value, completion) => {
    writes.push(value);
    callback = completion;
  });
  const outbox = new ReliableRelayOutbox("gw-legacy");
  outbox.enqueueIfReliable(terminalEnvelope("legacy"));
  outbox.attach(socket, "legacy_write_confirmed");

  assert.equal(writes.length, 1);
  assert.equal(outbox.pendingCount, 1);
  callback?.();
  assert.equal(outbox.pendingCount, 0);
  assert.equal(outbox.acknowledge("unused"), false);
});

test("legacy write failure preserves the entry for a later connection", () => {
  const errors: Error[] = [];
  const failedSocket = fakeSocket((_value, callback) => callback(new Error("write failed")));
  const replayed: string[] = [];
  const healthySocket = fakeSocket((value, callback) => {
    replayed.push(value);
    callback();
  });
  const outbox = new ReliableRelayOutbox("gw-legacy-retry", {
    onError: (error) => { errors.push(error); },
  });
  outbox.enqueueIfReliable({ type: "res", id: "cmd-1", ok: true });
  outbox.attach(failedSocket, "legacy_write_confirmed");

  assert.equal(errors[0]?.message, "write failed");
  assert.equal(outbox.pendingCount, 1);
  outbox.attach(healthySocket, "legacy_write_confirmed");
  assert.deepEqual(replayed, ['{"type":"res","id":"cmd-1","ok":true}']);
  assert.equal(outbox.pendingCount, 0);
});

test("recoverable delta never enters the reliable outbox", () => {
  const outbox = new ReliableRelayOutbox("gw-delta");
  const handled = outbox.enqueueIfReliable({
    type: "event",
    event: "chat",
    payload: {
      state: "delta",
      timelineEvents: [{ eventId: "evt-delta", eventType: "message.part.delta" }],
    },
  });

  assert.equal(handled.status, "not_reliable");
  assert.equal(outbox.pendingCount, 0);
});

test("accepted and terminal responses require separate ACK phases", () => {
  const writes: string[] = [];
  const socket = fakeSocket((value, callback) => {
    writes.push(value);
    callback();
  });
  const outbox = new ReliableRelayOutbox("gw-response-phases");
  outbox.attach(socket, "acknowledged");
  outbox.enqueueIfReliable({ type: "res", id: "cmd-phases", ok: true, responsePhase: "accepted" });
  outbox.enqueueIfReliable({ type: "res", id: "cmd-phases", ok: true, responsePhase: "terminal" });

  assert.equal(writes.length, 2);
  assert.equal(outbox.pendingCount, 2);
  assert.equal(outbox.acknowledgeResponse("cmd-phases", "accepted"), true);
  assert.equal(outbox.pendingCount, 1);
  assert.equal(outbox.acknowledgeResponse("cmd-phases", "accepted"), false);
  assert.equal(outbox.acknowledgeResponse("cmd-phases", "terminal"), true);
  assert.equal(outbox.pendingCount, 0);
  outbox.clear();
});

test("disconnect while a write callback is pending does not block ACK-mode replay", () => {
  let pendingCallback: ((error?: Error) => void) | undefined;
  const firstSocket = fakeSocket((_value, callback) => {
    pendingCallback = callback;
  });
  const replayed: string[] = [];
  const secondSocket = fakeSocket((value, callback) => {
    replayed.push(value);
    callback();
  });
  const outbox = new ReliableRelayOutbox("gw-race");
  outbox.attach(firstSocket, "acknowledged");
  outbox.enqueueIfReliable(terminalEnvelope("race"));

  outbox.detach(firstSocket);
  outbox.attach(secondSocket, "acknowledged");
  assert.equal(replayed.length, 1);
  pendingCallback?.(new Error("old socket closed"));
  assert.equal(replayed.length, 1);
  assert.equal(outbox.pendingCount, 1);
  outbox.clear();
});

test("ACK timeout disconnects but never removes the unacknowledged entry", () => {
  let now = 0;
  let timeoutCallback: (() => void) | undefined;
  let closeCode = 0;
  let closeReason = "";
  const firstSocket = fakeSocket((_value, callback) => callback(), (code, reason) => {
    closeCode = code;
    closeReason = reason;
  });
  const replayed: string[] = [];
  const secondSocket = fakeSocket((value, callback) => {
    replayed.push(value);
    callback();
  });
  const outbox = new ReliableRelayOutbox("gw-timeout", {
    ackTimeoutMs: 100,
    now: () => now,
    setTimer: (callback) => {
      timeoutCallback = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => { timeoutCallback = undefined; },
    onError: () => undefined,
  });
  outbox.attach(firstSocket, "acknowledged");
  outbox.enqueueIfReliable(terminalEnvelope("timeout"));

  now = 100;
  timeoutCallback?.();
  assert.equal(closeCode, 1013);
  assert.equal(closeReason, "reliable_ack_timeout");
  assert.equal(outbox.pendingCount, 1);

  outbox.attach(secondSocket, "acknowledged");
  assert.equal(replayed.length, 1);
  assert.equal(outbox.pendingCount, 1);
  outbox.clear();
});

test("outbox saturation returns controlled rejection and preserves existing entry", () => {
  const errors: Error[] = [];
  const outbox = new ReliableRelayOutbox("gw-bounded", {
    maxEntries: 1,
    maxBytes: 1_000_000,
    onError: (error) => { errors.push(error); },
  });
  assert.equal(outbox.enqueueIfReliable(terminalEnvelope("kept")).status, "accepted");

  const rejected = outbox.enqueueIfReliable({ type: "res", id: "cmd-overflow", ok: true });
  assert.equal(rejected.status, "rejected");
  if (rejected.status === "rejected") {
    assert.equal(rejected.reason, "outbox_full");
    assert.match(rejected.error.message, /reliable_relay_outbox_full/);
  }
  assert.equal(errors.length, 1);
  assert.equal(outbox.pendingCount, 1);
});

test("same reliable key is idempotent only when the queued wire content is identical", () => {
  const outbox = new ReliableRelayOutbox("gw-content-bound", { onError: () => undefined });
  const original = { type: "res", id: "cmd-content", ok: true, payload: { value: 1 } };

  assert.deepEqual(outbox.enqueueIfReliable(original), {
    status: "accepted",
    key: "response_ack:cmd-content:response",
    duplicate: false,
  });
  assert.deepEqual(outbox.enqueueIfReliable({ ...original, payload: { value: 1 } }), {
    status: "accepted",
    key: "response_ack:cmd-content:response",
    duplicate: true,
  });

  const conflicting = outbox.enqueueIfReliable({ ...original, payload: { value: 2 } });
  assert.equal(conflicting.status, "rejected");
  if (conflicting.status === "rejected") {
    assert.equal(conflicting.reason, "invalid_message");
    assert.match(conflicting.error.message, /duplicate_content_mismatch/);
  }
  assert.equal(outbox.pendingCount, 1, "the originally accepted response must remain authoritative");
});

test("queued reliable envelope is detached from later caller mutation", () => {
  const writes: string[] = [];
  const socket = fakeSocket((value, callback) => {
    writes.push(value);
    callback();
  });
  const outbox = new ReliableRelayOutbox("gw-snapshot");
  const message = { type: "res", id: "cmd-snapshot", ok: true, payload: { value: 1 } };

  outbox.enqueueIfReliable(message);
  message.payload.value = 2;
  outbox.attach(socket, "acknowledged");

  assert.deepEqual(JSON.parse(writes[0]!), {
    type: "res",
    id: "cmd-snapshot",
    ok: true,
    payload: { value: 1 },
  });
  outbox.clear();
});

test("IDs that Relay cannot ACK are rejected locally without throwing", () => {
  const outbox = new ReliableRelayOutbox("gw-id-limits", { onError: () => undefined });
  const response = outbox.enqueueIfReliable({
    type: "res",
    id: "r".repeat(RELIABLE_RELAY_RESPONSE_ID_MAX_LENGTH + 1),
    ok: true,
  });
  const terminal = terminalEnvelope("long-delivery-id");
  terminal.deliveryId = "d".repeat(RELIABLE_RELAY_EVENT_DELIVERY_ID_MAX_LENGTH + 1);
  const event = outbox.enqueueIfReliable(terminal);

  assert.equal(response.status, "rejected");
  if (response.status === "rejected") {
    assert.equal(response.reason, "invalid_message");
    assert.match(response.error.message, /response_id_too_long/);
  }
  assert.equal(event.status, "rejected");
  if (event.status === "rejected") {
    assert.equal(event.reason, "invalid_message");
    assert.match(event.error.message, /delivery_id_too_long/);
  }
  assert.equal(outbox.pendingCount, 0);
});

test("invalid response IDs and phases are controlled rejections", () => {
  const outbox = new ReliableRelayOutbox("gw-invalid-response", { onError: () => undefined });
  const missingId = outbox.enqueueIfReliable({ type: "res", id: "   ", ok: true });
  const invalidPhase = outbox.enqueueIfReliable({
    type: "res",
    id: "cmd-invalid-phase",
    ok: true,
    responsePhase: "partial",
  });

  assert.equal(missingId.status, "rejected");
  assert.equal(invalidPhase.status, "rejected");
  assert.equal(outbox.pendingCount, 0);
});

test("invalid canonical terminal is rejected without throwing from callback boundaries", () => {
  const outbox = new ReliableRelayOutbox("gw-invalid", { onError: () => undefined });
  const result = outbox.enqueueIfReliable({
    type: "event",
    event: "chat",
    payload: {
      state: "final",
      timelineEvents: [{ eventType: "message.completed" }],
    },
  });

  assert.equal(result.status, "rejected");
  if (result.status === "rejected") assert.equal(result.reason, "invalid_message");
  assert.equal(outbox.pendingCount, 0);
});

test("gateway registry limit returns an explicit result instead of throwing", () => {
  const storageDirectory = temporaryDirectory();
  for (let index = 0; index < RELIABLE_RELAY_OUTBOX_MAX_GATEWAYS; index += 1) {
    const lookup = reliableRelayOutboxForGateway(`gw-${index}`, {
      storageDirectory,
      relayIdentity: TEST_RELAY_IDENTITY,
    });
    assert.equal(lookup.status, "ready");
    if (lookup.status === "ready") {
      assert.equal(lookup.outbox.enqueueIfReliable(terminalEnvelope(String(index))).status, "accepted");
    }
  }

  const rejected = reliableRelayOutboxForGateway("gw-over-limit", {
    storageDirectory,
    relayIdentity: TEST_RELAY_IDENTITY,
  });
  assert.equal(rejected.status, "rejected");
  if (rejected.status === "rejected") assert.equal(rejected.reason, "gateway_limit_reached");
});

test("gateway registry requires a Relay identity instead of risking cross-Relay replay", () => {
  const lookup = reliableRelayOutboxForGateway("gw-no-relay", {
    storageDirectory: temporaryDirectory(),
  });
  assert.equal(lookup.status, "rejected");
  if (lookup.status === "rejected") assert.equal(lookup.reason, "relay_identity_required");
});

test("an attached empty outbox is not eligible for registry eviction", () => {
  const outbox = new ReliableRelayOutbox("gw-active-empty");
  const socket = fakeSocket((_value, callback) => callback());
  assert.equal(outbox.isIdleForRegistryEviction, true);
  outbox.attach(socket, "acknowledged");
  assert.equal(outbox.isIdleForRegistryEviction, false);
  outbox.detach(socket);
  assert.equal(outbox.isIdleForRegistryEviction, true);
});

test("durable outbox restores exact unacknowledged envelopes after a process restart", () => {
  assert.equal(RELIABLE_RELAY_OUTBOX_STORAGE_SCOPE, "profile_relay_gateway_disk");
  const storageDirectory = temporaryDirectory();
  const firstProcess = durableOutbox("gw-durable", storageDirectory);
  assert.equal(firstProcess.enqueueIfReliable(terminalEnvelope("durable")).status, "accepted");
  assert.equal(firstProcess.pendingCount, 1);
  firstProcess.dispose();

  const writes: string[] = [];
  const restartedProcess = durableOutbox("gw-durable", storageDirectory);
  restartedProcess.attach(fakeSocket((value, callback) => {
    writes.push(value);
    callback();
  }), "acknowledged");

  assert.equal(restartedProcess.pendingCount, 1);
  assert.equal(writes.length, 1);
  assert.equal((JSON.parse(writes[0]!) as { payload: { timelineEvents: unknown[] } }).payload.timelineEvents.length, 2);
  const deliveryId = String((JSON.parse(writes[0]!) as { deliveryId: string }).deliveryId);
  assert.equal(restartedProcess.acknowledge(deliveryId), true);
  restartedProcess.dispose();

  const afterAckRestart = durableOutbox("gw-durable", storageDirectory);
  assert.equal(afterAckRestart.pendingCount, 0, "durable ACK removal must survive another restart");
  afterAckRestart.dispose();
});

test("enqueue is persisted before the first WebSocket write", () => {
  const calls: string[] = [];
  const storage = recordingStore({
    put: () => { calls.push("put"); },
  });
  const outbox = new ReliableRelayOutbox("gw-write-ahead", { storage });
  outbox.attach(fakeSocket((_value, callback) => {
    calls.push("send");
    callback();
  }), "acknowledged");

  assert.equal(outbox.enqueueIfReliable(terminalEnvelope("write-ahead")).status, "accepted");
  assert.deepEqual(calls, ["put", "send"]);
});

test("storage write failure rejects safely and never sends an unpersisted frame", () => {
  const writes: string[] = [];
  const outbox = new ReliableRelayOutbox("gw-storage-write-failure", {
    storage: recordingStore({ put: () => { throw new Error("disk full"); } }),
    onError: () => undefined,
  });
  outbox.attach(fakeSocket((value, callback) => {
    writes.push(value);
    callback();
  }), "acknowledged");

  const result = outbox.enqueueIfReliable(terminalEnvelope("disk-full"));
  assert.equal(result.status, "rejected");
  if (result.status === "rejected") assert.equal(result.reason, "storage_unavailable");
  assert.equal(outbox.pendingCount, 0);
  assert.equal(writes.length, 0);
});

test("ACK storage failure keeps the frame pending for replay", () => {
  let stored: StoredReliableRelayOutboxEntry | undefined;
  let closeReason = "";
  const storage = recordingStore({
    put: (entry) => { stored = entry; },
    remove: () => { throw new Error("read only filesystem"); },
  });
  const outbox = new ReliableRelayOutbox("gw-ack-storage-failure", {
    storage,
    onError: () => undefined,
  });
  const socket = fakeSocket((_value, callback) => callback(), (_code, reason) => {
    closeReason = reason;
  });
  outbox.attach(socket, "acknowledged");
  outbox.enqueueIfReliable(terminalEnvelope("ack-storage-failure"));

  assert.equal(outbox.acknowledge(stored?.deliveryId ?? ""), false);
  assert.equal(outbox.pendingCount, 1);
  assert.equal(closeReason, "reliable_storage_failed");
});

test("a torn final WAL record is truncated and the prior durable state is recovered", () => {
  const storageDirectory = temporaryDirectory();
  const firstProcess = durableOutbox("gw-torn-tail", storageDirectory);
  firstProcess.enqueueIfReliable(terminalEnvelope("torn-tail"));
  firstProcess.dispose();
  const walPath = onlyWalPath(storageDirectory);
  const durableBytes = readFileSync(walPath).byteLength;
  appendFileSync(walPath, "{\"v\":1,\"kind\":\"remove\"");

  const restartedProcess = durableOutbox("gw-torn-tail", storageDirectory);
  assert.equal(restartedProcess.pendingCount, 1);
  restartedProcess.dispose();
  assert.equal(readFileSync(walPath).byteLength, durableBytes);
});

test("a hard-killed writer is recovered by a fresh process", () => {
  const storageDirectory = temporaryDirectory();
  const moduleUrl = new URL("./reliable-relay-outbox.ts", import.meta.url).href;
  const script = `
    const { ReliableRelayOutbox } = await import(${JSON.stringify(moduleUrl)});
    const outbox = new ReliableRelayOutbox("gw-hard-kill", {
      storageDirectory: ${JSON.stringify(storageDirectory)},
      relayIdentity: ${JSON.stringify(TEST_RELAY_IDENTITY)},
    });
    const result = outbox.enqueueIfReliable({ type: "res", id: "response-before-crash", ok: true });
    if (result.status !== "accepted") process.exit(2);
    process.kill(process.pid, "SIGKILL");
  `;
  const child = spawnSync(process.execPath, [
    "--import", "tsx",
    "--input-type=module",
    "--eval", script,
  ], { encoding: "utf8" });
  assert.equal(child.error, undefined);
  assert.notEqual(child.status, 0);

  const recovered = durableOutbox("gw-hard-kill", storageDirectory);
  assert.equal(recovered.pendingCount, 1);
  const writes: string[] = [];
  recovered.attach(fakeSocket((value, callback) => {
    writes.push(value);
    callback();
  }), "acknowledged");
  assert.deepEqual(JSON.parse(writes[0]!), { type: "res", id: "response-before-crash", ok: true });
  recovered.dispose();
});

test("an incomplete higher generation never supersedes the prior checkpoint", () => {
  const storageDirectory = temporaryDirectory();
  const firstProcess = durableOutbox("gw-incomplete-generation", storageDirectory);
  firstProcess.enqueueIfReliable(terminalEnvelope("incomplete-generation"));
  firstProcess.dispose();
  const currentPath = onlyWalPath(storageDirectory);
  const currentName = basename(currentPath);
  const nextName = currentName.replace(/\.1\.wal$/, ".2.wal");
  const currentLines = readFileSync(currentPath, "utf8")
    .replace('"generation":1', '"generation":2')
    .split("\n");
  // A real compaction writes header + all live puts before its checkpoint.
  const incomplete = `${currentLines[0]}\n${currentLines[2]}\n`;
  writeFileSync(join(storageDirectory, nextName), incomplete);

  const restartedProcess = durableOutbox("gw-incomplete-generation", storageDirectory);
  assert.equal(restartedProcess.pendingCount, 1);
  restartedProcess.dispose();
  assert.equal(readdirSync(storageDirectory).filter((name) => name.endsWith(".wal")).length, 1);
});

test("a second writer for the same profile and gateway is rejected", () => {
  const storageDirectory = temporaryDirectory();
  const owner = durableOutbox("gw-single-writer", storageDirectory);
  assert.throws(
    () => durableOutbox("gw-single-writer", storageDirectory),
    /reliable_outbox_store_locked/,
  );
  owner.dispose();
});

test("stale-lock recovery is serialized and fails closed if another recovery owns the gate", () => {
  const storageDirectory = temporaryDirectory();
  const owner = durableOutbox("gw-stale-lock-race", storageDirectory);
  owner.dispose();
  const walName = readdirSync(storageDirectory).find((name) => name.endsWith(".wal"));
  assert.ok(walName);
  const namespaceHash = walName.split(".")[0]!;
  const lockPath = join(storageDirectory, `${namespaceHash}.lock`);
  const recoveryPath = join(dirname(storageDirectory), `${basename(storageDirectory)}.operation-lock`);
  writeFileSync(lockPath, JSON.stringify({ pid: 99_999_999, token: "stale" }));
  mkdirSync(recoveryPath);

  assert.throws(
    () => durableOutbox("gw-stale-lock-race", storageDirectory),
    /reliable_outbox_store_operation_locked/,
  );
  assert.equal(readFileSync(lockPath, "utf8"), JSON.stringify({ pid: 99_999_999, token: "stale" }));

  rmSync(recoveryPath, { recursive: true, force: true });
  const recovered = durableOutbox("gw-stale-lock-race", storageDirectory);
  recovered.dispose();
});

test("an unverifiable owner lock fails closed instead of being guessed stale", () => {
  const storageDirectory = temporaryDirectory();
  const owner = durableOutbox("gw-invalid-owner-lock", storageDirectory);
  owner.dispose();
  const walName = readdirSync(storageDirectory).find((name) => name.endsWith(".wal"));
  assert.ok(walName);
  const lockPath = join(storageDirectory, `${walName.split(".")[0]}.lock`);
  writeFileSync(lockPath, "not-valid-owner-metadata");

  assert.throws(
    () => durableOutbox("gw-invalid-owner-lock", storageDirectory),
    /reliable_outbox_store_locked/,
  );
  assert.equal(readFileSync(lockPath, "utf8"), "not-valid-owner-metadata");
});

test("the same gateway id on another Relay uses an isolated durable namespace", () => {
  const storageDirectory = temporaryDirectory();
  const production = durableOutbox("gw-shared-id", storageDirectory, "https://relay.production.test");
  production.enqueueIfReliable({ type: "res", id: "production-only", ok: true });
  production.dispose();

  const development = durableOutbox("gw-shared-id", storageDirectory, "https://relay.development.test");
  assert.equal(development.pendingCount, 0);
  development.dispose();

  const productionRestart = durableOutbox("gw-shared-id", storageDirectory, "https://relay.production.test/");
  assert.equal(productionRestart.pendingCount, 1, "canonical trailing slash must retain the matching namespace");
  productionRestart.dispose();
});

test("durable storage supports Windows-style user paths containing spaces and Unicode", () => {
  const root = temporaryDirectory();
  const storageDirectory = join(root, "用户 Data With Spaces", "reliable-outbox-v1");
  mkdirSync(storageDirectory, { recursive: true });
  const firstProcess = durableOutbox("gw-unicode-path", storageDirectory);
  firstProcess.enqueueIfReliable({ type: "res", id: "unicode-path", ok: true });
  firstProcess.dispose();

  const restartedProcess = durableOutbox("gw-unicode-path", storageDirectory);
  assert.equal(restartedProcess.pendingCount, 1);
  restartedProcess.dispose();
});

test("registry reports corrupt durable state as controlled storage unavailability", () => {
  const storageDirectory = temporaryDirectory();
  const owner = durableOutbox("gw-corrupt", storageDirectory);
  owner.dispose();
  writeFileSync(onlyWalPath(storageDirectory), "{ definitely-not-json }\n");

  const lookup = reliableRelayOutboxForGateway("gw-corrupt", {
    storageDirectory,
    relayIdentity: TEST_RELAY_IDENTITY,
  });
  assert.equal(lookup.status, "rejected");
  if (lookup.status === "rejected") assert.equal(lookup.reason, "storage_unavailable");
});

function terminalEnvelope(suffix = "default"): Record<string, unknown> {
  return {
    type: "event",
    event: "chat",
    payload: {
      state: "final",
      timelineEvents: [
        { eventId: `evt-message-completed-${suffix}`, eventType: "message.completed" },
        { eventId: `evt-run-completed-${suffix}`, eventType: "run.completed" },
      ],
    },
  };
}

function fakeSocket(
  send: (value: string, callback: (error?: Error) => void) => void,
  close: (code: number, reason: string) => void = () => undefined,
): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (
      value: string,
      _options: { compress: boolean },
      callback: (error?: Error) => void,
    ) => send(value, callback),
    close,
    terminate: () => undefined,
  } as unknown as WebSocket;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "clawconnect-outbox-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function durableOutbox(
  gatewayId: string,
  storageDirectory: string,
  relayIdentity = TEST_RELAY_IDENTITY,
): ReliableRelayOutbox {
  return new ReliableRelayOutbox(gatewayId, {
    storageDirectory,
    relayIdentity,
  });
}

function onlyWalPath(directory: string): string {
  const names = readdirSync(directory).filter((name) => name.endsWith(".wal"));
  assert.equal(names.length, 1);
  return join(directory, names[0]!);
}

function recordingStore(overrides: Partial<ReliableRelayOutboxStore>): ReliableRelayOutboxStore {
  return {
    load: () => [],
    put: () => undefined,
    remove: () => undefined,
    close: () => undefined,
    ...overrides,
  };
}
