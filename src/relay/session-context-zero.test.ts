import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("readContextUsageSnapshot preserves a zero-token current session", () => {
  const tempHome = mkdtempSync(join(tmpdir(), "clawconnect-home-"));
  try {
    const sessionsDir = join(tempHome, ".openclaw", "agents", "main", "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    const sessionKey = "agent:main:ios-706ac916-2d30-418e-ad57-03696e69137c";
    const sessionId = "45fd540d-2892-40ce-a8bb-10af9ab40b0e";
    const sessionFile = join(sessionsDir, `${sessionId}.jsonl`);

    writeFileSync(
      join(sessionsDir, "sessions.json"),
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId,
            sessionFile,
            model: "MiniMax-M2.5",
            contextTokens: 128000,
            inputTokens: 0,
            outputTokens: 0,
            totalTokensFresh: false,
          },
        },
        null,
        2,
      ),
    );

    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: "2026-04-03T01:38:32.157Z",
          cwd: "/",
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-1",
          timestamp: "2026-04-03T01:40:16.748Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "status" }],
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
            },
          },
        }),
        "",
      ].join("\n"),
    );

    const script = `
      import assert from "node:assert/strict";
      import { readContextUsageSnapshot, DEFAULT_GATEWAY_SESSION_DEFAULTS } from "./src/relay/session-context.ts";

      const snapshot = await readContextUsageSnapshot(
        "agent:main:ios-706ac916-2d30-418e-ad57-03696e69137c",
        DEFAULT_GATEWAY_SESSION_DEFAULTS,
      );

      assert(snapshot);
      process.stdout.write(JSON.stringify(snapshot));
    `;

    const stdout = execFileSync(
      "node",
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: tempHome,
        },
        encoding: "utf8",
      },
    );

    const snapshot = JSON.parse(stdout.trim()) as {
      currentModel?: string;
      contextUsage?: number;
      contextLimit?: number;
      promptTokens?: number;
    };

    assert.equal(snapshot.currentModel, "MiniMax-M2.5");
    assert.equal(snapshot.contextUsage, 0);
    assert.equal(snapshot.contextLimit, 128000);
    assert.equal(snapshot.promptTokens, 0);
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});
