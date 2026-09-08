import assert from "node:assert/strict";
import test from "node:test";
import {
  enrichAgentsListWithIdentities,
  parseIdentityFromMarkdown,
} from "./agent-identity-helpers.js";

test("parseIdentityFromMarkdown parses markdown list with bold keys", () => {
  const md = `# IDENTITY.md - Who Am I?

- **Name:** 贾维斯
- **Creature:** 龙虾大管家 🦞
- **Vibe:** 毒舌但靠谱型 (sarcastic but reliable)
- **Emoji:** 🦞
- **Avatar:**

---
Updated 2026-03-26`;

  const parsed = parseIdentityFromMarkdown(md);
  assert.equal(parsed.name, "贾维斯");
  assert.equal(parsed.emoji, "🦞");
});

test("parseIdentityFromMarkdown parses plain list and yaml frontmatter", () => {
  const plainMd = `- Name: 测试智能体
- Emoji: 🤖`;
  const parsedPlain = parseIdentityFromMarkdown(plainMd);
  assert.equal(parsedPlain.name, "测试智能体");
  assert.equal(parsedPlain.emoji, "🤖");

  const yamlMd = `---
name: "健康管家"
emoji: "🩺"
---
# Content`;
  const parsedYaml = parseIdentityFromMarkdown(yamlMd);
  assert.equal(parsedYaml.name, "健康管家");
  assert.equal(parsedYaml.emoji, "🩺");
});

test("parseIdentityFromMarkdown returns empty object for empty or missing text", () => {
  assert.deepEqual(parseIdentityFromMarkdown(""), {});
  assert.deepEqual(parseIdentityFromMarkdown("# Just a heading\nNo identity fields"), {});
});

test("enrichAgentsListWithIdentities fetches IDENTITY.md for agents missing identity", async () => {
  const requestedFiles: { agentId: string; name: string }[] = [];
  const mockClient = {
    request: async (method: string, params?: unknown) => {
      if (method === "agents.files.get") {
        const p = params as { agentId: string; name: string };
        requestedFiles.push(p);
        if (p.agentId === "main") {
          return {
            agentId: "main",
            workspace: "/home/user/.openclaw/workspace",
            file: {
              name: "IDENTITY.md",
              path: "/home/user/.openclaw/workspace/IDENTITY.md",
              missing: false,
              content: `# IDENTITY.md\n- **Name:** 贾维斯\n- **Emoji:** 🦞\n`,
            },
          };
        }
      }
      throw new Error(`Unhandled method: ${method}`);
    },
  };

  const agentsResult = {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [
      { id: "main" },
      { id: "health-manager", identity: { name: "健康管家", emoji: "🩺" } },
    ],
  };

  const enriched = (await enrichAgentsListWithIdentities(agentsResult, mockClient)) as typeof agentsResult;

  // Only "main" should have been queried
  assert.equal(requestedFiles.length, 1);
  assert.equal(requestedFiles[0].agentId, "main");
  assert.equal(requestedFiles[0].name, "IDENTITY.md");

  // "main" agent should now have identity and top-level fields
  const mainAgent = enriched.agents[0] as any;
  assert.equal(mainAgent.identity?.name, "贾维斯");
  assert.equal(mainAgent.identity?.emoji, "🦞");
  assert.equal(mainAgent.displayName, "贾维斯");
  assert.equal(mainAgent.emoji, "🦞");

  // "health-manager" should retain identity and get top-level fields
  const healthAgent = enriched.agents[1] as any;
  assert.equal(healthAgent.identity?.name, "健康管家");
  assert.equal(healthAgent.identity?.emoji, "🩺");
  assert.equal(healthAgent.displayName, "健康管家");
  assert.equal(healthAgent.emoji, "🩺");
});

test("enrichAgentsListWithIdentities handles array shape and survives file get errors", async () => {
  const mockClient = {
    request: async () => {
      throw new Error("File not found");
    },
  };

  const agentsArray = [{ id: "unknown-agent" }];
  const enriched = await enrichAgentsListWithIdentities(agentsArray, mockClient);
  assert.deepEqual(enriched, [{ id: "unknown-agent" }]);
});
