import assert from "node:assert/strict";
import test from "node:test";
import {
  handleOpenClawThinkingCommand,
  type OpenClawThinkingGatewayClient,
} from "./thinking-handlers.js";

type GatewayCall = { method: string; params: unknown };

const MAIN_KEY = "agent:main:mobile-abc";

/** 假网关：sessions.list 返回给定行，sessions.patch 修改对应行的 thinkingLevel（不存在则新建）。 */
function createFakeGateway(initial: {
  sessions: Array<Record<string, unknown>>;
  defaults?: Record<string, unknown>;
  rejectPatch?: boolean;
}): { client: OpenClawThinkingGatewayClient; calls: GatewayCall[] } {
  const sessions = initial.sessions.map((session) => ({ ...session }));
  const calls: GatewayCall[] = [];
  const client: OpenClawThinkingGatewayClient = {
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      const record = params as Record<string, unknown>;
      if (method === "sessions.list") {
        const search = String(record.search ?? "");
        return {
          sessions: sessions.filter((session) => String(session.key).includes(search)),
          defaults: initial.defaults ?? {},
        } as T;
      }
      if (method === "sessions.patch") {
        if (initial.rejectPatch) {
          throw new Error("gateway rejected patch");
        }
        const existing = sessions.find((session) => session.key === record.key);
        if (existing) {
          existing.thinkingLevel = record.thinkingLevel;
        } else {
          sessions.push({
            key: record.key,
            thinkingLevel: record.thinkingLevel,
            thinkingDefault: initial.defaults?.thinkingDefault,
            thinkingLevels: initial.defaults?.thinkingLevels,
          });
        }
        return { ok: true } as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { client, calls };
}

const CLAUDE_LEVELS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" },
  { id: "ultra", label: "Ultra" },
];
const GPT_LEVELS = [
  { id: "off", label: "Off" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

async function run(
  method: string,
  params: unknown,
  client: OpenClawThinkingGatewayClient | null,
): Promise<{ ok: boolean; payload?: unknown; error?: string }> {
  const pending = handleOpenClawThinkingCommand(method, params, client);
  assert.ok(pending, `${method} must be routed`);
  return await pending;
}

test("OpenClaw thinking router ignores unrelated methods", () => {
  assert.equal(handleOpenClawThinkingCommand("pocketclaw.model.list", {}, null), null);
  assert.equal(handleOpenClawThinkingCommand("hermes.thinking.get", {}, null), null);
});

test("OpenClaw thinking.get selects the exact session row even when substring decoys come first", async () => {
  const { client, calls } = createFakeGateway({
    sessions: [
      { key: `${MAIN_KEY}-2`, thinkingLevel: "max", thinkingDefault: "low", thinkingLevels: GPT_LEVELS },
      { key: `x${MAIN_KEY}`, thinkingLevel: "off", thinkingDefault: "low", thinkingLevels: GPT_LEVELS },
      { key: MAIN_KEY, thinkingLevel: "high", thinkingDefault: "medium", thinkingLevels: CLAUDE_LEVELS },
    ],
    defaults: { thinkingDefault: "minimal", thinkingLevels: GPT_LEVELS },
  });

  const result = await run("pocketclaw.thinking.get", { sessionKey: MAIN_KEY }, client);

  assert.deepEqual(result, {
    ok: true,
    payload: {
      sessionKey: MAIN_KEY,
      supported: true,
      level: "high",
      defaultLevel: "medium",
      effectiveLevel: "high",
      levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
  });
  assert.deepEqual(calls, [{
    method: "sessions.list",
    params: { search: MAIN_KEY, limit: 20, includeGlobal: true, includeUnknown: true },
  }]);
});

test("OpenClaw thinking.get falls back to gateway defaults when the session does not exist yet", async () => {
  const { client } = createFakeGateway({
    sessions: [{ key: `${MAIN_KEY}-old`, thinkingLevel: "max", thinkingDefault: "high", thinkingLevels: CLAUDE_LEVELS }],
    defaults: { thinkingDefault: "low", thinkingLevels: GPT_LEVELS },
  });

  const result = await run("pocketclaw.thinking.get", { sessionKey: MAIN_KEY }, client);

  assert.deepEqual(result.payload, {
    sessionKey: MAIN_KEY,
    supported: true,
    level: null,
    defaultLevel: "low",
    effectiveLevel: "low",
    levels: ["off", "minimal", "low", "medium", "high"],
  });
});

test("OpenClaw thinking.get reports unsupported when the model only offers off", async () => {
  const { client } = createFakeGateway({
    sessions: [{ key: MAIN_KEY, thinkingLevel: null, thinkingDefault: "off", thinkingLevels: [{ id: "off", label: "Off" }] }],
  });

  const result = await run("pocketclaw.thinking.get", { sessionKey: MAIN_KEY }, client);

  assert.equal((result.payload as { supported: boolean }).supported, false);
  assert.deepEqual((result.payload as { levels: string[] }).levels, ["off"]);
});

test("OpenClaw thinking.set rejects a level outside the model levels without patching", async () => {
  const { client, calls } = createFakeGateway({
    sessions: [{ key: MAIN_KEY, thinkingLevel: null, thinkingDefault: "medium", thinkingLevels: CLAUDE_LEVELS }],
  });

  const result = await run("pocketclaw.thinking.set", { sessionKey: MAIN_KEY, level: "off" }, client);

  assert.deepEqual(result, { ok: false, error: "thinking_level_not_supported:off" });
  assert.equal(calls.some((call) => call.method === "sessions.patch"), false);
});

test("OpenClaw thinking.set patches the exact key and returns the re-read gateway state", async () => {
  const { client, calls } = createFakeGateway({
    sessions: [{ key: MAIN_KEY, thinkingLevel: null, thinkingDefault: "medium", thinkingLevels: CLAUDE_LEVELS }],
  });

  const result = await run("pocketclaw.thinking.set", { sessionKey: MAIN_KEY, level: "xhigh" }, client);

  assert.deepEqual(result.payload, {
    sessionKey: MAIN_KEY,
    supported: true,
    level: "xhigh",
    defaultLevel: "medium",
    effectiveLevel: "xhigh",
    levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
  });
  assert.deepEqual(calls.map((call) => call.method), ["sessions.list", "sessions.patch", "sessions.list"]);
  assert.deepEqual(calls[1].params, { key: MAIN_KEY, thinkingLevel: "xhigh" });
});

test("OpenClaw thinking.set with null clears the override and follows the default", async () => {
  const { client, calls } = createFakeGateway({
    sessions: [{ key: MAIN_KEY, thinkingLevel: "max", thinkingDefault: "medium", thinkingLevels: CLAUDE_LEVELS }],
  });

  const result = await run("pocketclaw.thinking.set", { sessionKey: MAIN_KEY, level: null }, client);

  assert.deepEqual(calls[1].params, { key: MAIN_KEY, thinkingLevel: null });
  assert.equal((result.payload as { level: unknown }).level, null);
  assert.equal((result.payload as { effectiveLevel: unknown }).effectiveLevel, "medium");
});

test("OpenClaw thinking.set creates the override for a not-yet-created session from defaults", async () => {
  const { client, calls } = createFakeGateway({
    sessions: [],
    defaults: { thinkingDefault: "low", thinkingLevels: GPT_LEVELS },
  });

  const result = await run("pocketclaw.thinking.set", { sessionKey: MAIN_KEY, level: "off" }, client);

  assert.deepEqual(calls[1].params, { key: MAIN_KEY, thinkingLevel: "off" });
  assert.equal((result.payload as { level: unknown }).level, "off");
  assert.equal((result.payload as { effectiveLevel: unknown }).effectiveLevel, "off");
});

test("OpenClaw thinking commands fail explicitly for invalid params, gateway errors and no connection", async () => {
  const { client } = createFakeGateway({
    sessions: [{ key: MAIN_KEY, thinkingLevel: null, thinkingDefault: "medium", thinkingLevels: CLAUDE_LEVELS }],
    rejectPatch: true,
  });

  assert.deepEqual(await run("pocketclaw.thinking.get", {}, client), { ok: false, error: "session_key_required" });
  assert.deepEqual(
    await run("pocketclaw.thinking.set", { sessionKey: MAIN_KEY }, client),
    { ok: false, error: "thinking_level_required" },
  );
  assert.deepEqual(
    await run("pocketclaw.thinking.set", { sessionKey: MAIN_KEY, level: "high" }, client),
    { ok: false, error: "gateway rejected patch" },
  );
  assert.deepEqual(
    await run("pocketclaw.thinking.get", { sessionKey: MAIN_KEY }, null),
    { ok: false, error: "gateway not connected" },
  );
});
