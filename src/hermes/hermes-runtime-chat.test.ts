import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildHermesAssistantDeltaPayload,
  buildHermesRuntimeContextHint,
  isDuplicateHermesCronJob,
  isHermesSlashCommandMessage,
  parseHermesToolLogLine,
  parseHermesSkillsList,
  parseHermesSessionUsageSnapshot,
  parseHermesStatusSnapshot,
  selectHermesSessionForCompletedChat,
  stripHermesSecurityReviewNotices,
  stripHermesSessionResumeNotices,
  runHermesChat,
  runHermesChatHistory,
  handleHermesCommand,
} from "./hermes-runtime.js";
import { runHermesSessionExport } from "./runtime/hermes-runtime-sessions.js";
import {
  hermesModelListResultFromPayload,
  modelItemsFromHermesModelOptionsPayload,
} from "./runtime/hermes-runtime-models.js";
import {
  listStoredHermesSessions,
  mergeLiveHermesSessionsWithStoredAliases,
  parseHermesSessionsList,
  rememberHermesSession,
} from "./hermes-session-store.js";
import {
  readHermesContextLimitFromModelsDevCacheRecord,
} from "./runtime/hermes-runtime-usage.js";

import {
  restoreEnv,
  writeMutableHistoryHermesBin,
  writePagedHistoryHermesBin,
  writeFakeHermesBin,
  writeTimeoutDeniedHermesBin,
  writeAbortPartialHermesBin,
  writeSlowPartialHermesBin,
  waitForHermesDelta,
  writeHistoryCompletingHermesBin,
  writeStaleHistoryHermesBin,
  writeRepeatedUserStaleHistoryHermesBin,
  writeConcurrentDetectingHermesBin,
  writeResumeMetadataHermesBin,
  writeHistoryHermesBin,
  writeUntimedHistoryHermesBin,
} from "./hermes-runtime-test-support.js";

test("runHermesChatHistory returns OpenClaw-shaped canonical history", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-history-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  try {
    const storePath = join(root, "sessions.json");
    const binPath = writeHistoryHermesBin(root);
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;
    await rememberHermesSession("main", {
      sessionKey: "main",
      hermesSessionId: "20260529_100000_history",
      displayName: "History",
      kind: "hermes",
    });

    const result = await runHermesChatHistory({ sessionKey: "main", limit: 10 });

    assert.equal(result.ok, true);
    assert.deepEqual(result.payload, {
      sessionKey: "main",
      sessionId: "20260529_100000_history",
      messages: [
        {
          id: "m1",
          role: "user",
          content: [{ type: "text", text: "hello" }],
          createdAt: "2026-05-29T02:00:00.000Z",
          seq: 1,
        },
        {
          id: "m2",
          role: "assistant",
          content: [
            { type: "text", text: "visible reply" },
            {
              type: "file",
              attachmentId: "file-history-1",
              fileId: "file-history-1",
              fileName: "report.pdf",
              mimeType: "application/pdf",
              transferState: "available",
            },
          ],
          createdAt: "2026-05-29T02:00:01.000Z",
          seq: 2,
        },
      ],
      items: [
        {
          id: "m1",
          role: "user",
          content: [{ type: "text", text: "hello" }],
          createdAt: "2026-05-29T02:00:00.000Z",
          seq: 1,
        },
        {
          id: "m2",
          role: "assistant",
          content: [
            { type: "text", text: "visible reply" },
            {
              type: "file",
              attachmentId: "file-history-1",
              fileId: "file-history-1",
              fileName: "report.pdf",
              mimeType: "application/pdf",
              transferState: "available",
            },
          ],
          createdAt: "2026-05-29T02:00:01.000Z",
          seq: 2,
        },
      ],
      hasMore: false,
      newestCursor: "seq:2",
      timelineSnapshot: {
        protocolVersion: 2,
        eventType: "history.snapshot.page",
        gatewayId: "clawconnect",
        sessionKey: "main",
        source: "history",
        cursor: null,
        hasMore: false,
        nextCursor: null,
        newestCursor: "seq:2",
        extensions: {
          orderPolicy: "transcript",
        },
        messages: [
          {
            turnId: "history-main-1-user",
            messageId: "m1",
            role: "user",
            messageState: "completed",
            createdAt: "2026-05-29T02:00:00.000Z",
            content: [{ type: "text", text: "hello" }],
            partId: "part-text-1",
            runId: "history-main-1-user",
            seq: 1,
            turnSeq: 1,
          },
          {
            turnId: "history-main-2-assistant",
            messageId: "m2",
            role: "assistant",
            messageState: "completed",
            createdAt: "2026-05-29T02:00:01.000Z",
            content: [
              { type: "text", text: "visible reply" },
              {
                type: "file",
                attachmentId: "file-history-1",
                fileId: "file-history-1",
                fileName: "report.pdf",
                mimeType: "application/pdf",
                transferState: "available",
              },
            ],
            attachmentIds: ["file-history-1"],
            partId: "part-text-1",
            runId: "history-main-2-assistant",
            seq: 2,
            turnSeq: 2,
          },
        ],
        attachments: [],
      },
    });
    assert.equal(JSON.stringify(result.payload).includes("Resumed session"), false);
    assert.equal(JSON.stringify(result.payload).includes("NoneType"), false);
    assert.equal(JSON.stringify(result.payload).includes("session_id:"), false);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChatHistory does not emit epoch timestamps when export omits message times", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-history-untimed-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  try {
    const storePath = join(root, "sessions.json");
    const binPath = writeUntimedHistoryHermesBin(root);
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;
    await rememberHermesSession("main", {
      sessionKey: "main",
      hermesSessionId: "20260529_100000_history",
      displayName: "History",
      kind: "hermes",
    });

    const result = await runHermesChatHistory({ sessionKey: "main", limit: 10 });

    assert.equal(result.ok, true);
    const payload = result.payload as {
      messages: Array<{ createdAt: string }>;
      timelineSnapshot: { messages: Array<{ createdAt: string }> };
    };
    assert.deepEqual(payload.messages.map((message) => message.createdAt), [
      "2026-05-29T02:00:00.000Z",
      "2026-05-29T02:00:00.001Z",
    ]);
    assert.deepEqual(payload.timelineSnapshot.messages.map((message) => message.createdAt), [
      "2026-05-29T02:00:00.000Z",
      "2026-05-29T02:00:00.001Z",
    ]);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Hermes command router handles chat.history canonically", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-history-router-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  try {
    const storePath = join(root, "sessions.json");
    const binPath = writeHistoryHermesBin(root);
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;

    const result = await handleHermesCommand("chat.history", { sessionKey: "hermes:20260529_100000_history", limit: 1 });

    assert.equal(result?.ok, true);
    assert.deepEqual((result as { payload?: Record<string, unknown> }).payload?.messages, [
      {
        id: "m2",
        role: "assistant",
        content: [
          { type: "text", text: "visible reply" },
          {
            type: "file",
            attachmentId: "file-history-1",
            fileId: "file-history-1",
            fileName: "report.pdf",
            mimeType: "application/pdf",
            transferState: "available",
          },
        ],
        createdAt: "2026-05-29T02:00:01.000Z",
        seq: 2,
      },
    ]);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChatHistory reuses normalized history for the same session export hash", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-history-cache-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  try {
    const storePath = join(root, "sessions.json");
    const binPath = writePagedHistoryHermesBin(root);
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;
    await rememberHermesSession("main", {
      sessionKey: "main",
      hermesSessionId: "20260529_100000_history",
      displayName: "History",
      kind: "hermes",
    });

    const newest = await runHermesChatHistory({ sessionKey: "main", limit: 2 });
    const older = await runHermesChatHistory({
      sessionKey: "main",
      limit: 2,
      cursor: (newest.payload as { nextCursor?: string }).nextCursor,
      direction: "older",
    });

    assert.equal(newest.ok, true);
    assert.equal(older.ok, true);
    assert.deepEqual((newest.payload as { messages?: Array<{ seq: number }> }).messages?.map((message) => message.seq), [3, 4]);
    assert.deepEqual((older.payload as { messages?: Array<{ seq: number }> }).messages?.map((message) => message.seq), [1, 2]);
    const newestThirdMessage = (newest.payload as { messages?: unknown[] }).messages?.[0];
    const newerFromOlderPage = await runHermesChatHistory({
      sessionKey: "main",
      limit: 1,
      cursor: (older.payload as { newestCursor?: string }).newestCursor,
      direction: "newer",
    });
    assert.equal(newerFromOlderPage.ok, true);
    assert.equal((newerFromOlderPage.payload as { messages?: unknown[] }).messages?.[0], newestThirdMessage);

    const explicitSessionIdPage = await runHermesChatHistory({
      sessionKey: "main",
      sessionId: "20260529_100000_history",
      limit: 1,
      cursor: "seq:2",
      direction: "newer",
    });
    assert.equal(explicitSessionIdPage.ok, true);
    assert.equal((explicitSessionIdPage.payload as { messages?: unknown[] }).messages?.[0], newestThirdMessage);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});

test("runHermesChatHistory invalidates normalized history when the export hash changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "hermes-chat-history-cache-invalidate-"));
  const previousStore = process.env.CLAWCONNECT_HERMES_SESSION_STORE;
  const previousBin = process.env.HERMES_BIN;
  try {
    const storePath = join(root, "sessions.json");
    const payloadPath = join(root, "history-payload.json");
    const binPath = writeMutableHistoryHermesBin(root, payloadPath);
    process.env.CLAWCONNECT_HERMES_SESSION_STORE = storePath;
    process.env.HERMES_BIN = binPath;
    await rememberHermesSession("main", {
      sessionKey: "main",
      hermesSessionId: "20260529_100000_history",
      displayName: "History",
      kind: "hermes",
    });
    writeFileSync(payloadPath, JSON.stringify({
      sessionId: "20260529_100000_history",
      messages: [{ id: "m1", role: "assistant", content: "first", createdAt: "2026-05-29T02:00:01.000Z" }],
    }));

    const first = await runHermesChatHistory({ sessionKey: "main", limit: 1 });
    writeFileSync(payloadPath, JSON.stringify({
      sessionId: "20260529_100000_history",
      messages: [{ id: "m1", role: "assistant", content: "second", createdAt: "2026-05-29T02:00:01.000Z" }],
    }));
    const second = await runHermesChatHistory({ sessionKey: "main", limit: 1 });

    const firstMessage = (first.payload as { messages?: Array<{ content: unknown }> }).messages?.[0];
    const secondMessage = (second.payload as { messages?: Array<{ content: unknown }> }).messages?.[0];
    assert.deepEqual(firstMessage?.content, [{ type: "text", text: "first" }]);
    assert.deepEqual(secondMessage?.content, [{ type: "text", text: "second" }]);
    assert.notEqual(secondMessage, firstMessage);
  } finally {
    restoreEnv("CLAWCONNECT_HERMES_SESSION_STORE", previousStore);
    restoreEnv("HERMES_BIN", previousBin);
    rmSync(root, { recursive: true, force: true });
  }
});
