export type AgentIdentityInfo = {
  name?: string;
  emoji?: string;
};

export function parseIdentityFromMarkdown(content: string): AgentIdentityInfo {
  const result: AgentIdentityInfo = {};
  if (!content || typeof content !== "string") {
    return result;
  }

  // 1. Check YAML frontmatter if present
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (fmMatch) {
    const fm = fmMatch[1];
    const nameMatch = /(?:^|\n)\s*name\s*:\s*['"]?([^'"\n\r]+)['"]?/i.exec(fm);
    if (nameMatch?.[1]?.trim()) {
      result.name = nameMatch[1].trim();
    }
    const emojiMatch = /(?:^|\n)\s*emoji\s*:\s*['"]?([^'"\n\r]+)['"]?/i.exec(fm);
    if (emojiMatch?.[1]?.trim()) {
      result.emoji = emojiMatch[1].trim();
    }
  }

  // 2. Match lines like: - **Name:** 贾维斯 or Name: 贾维斯
  if (!result.name) {
    const nameMatch = /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?Name(?:\*\*)?\s*:\s*(.+?)(?:\r?\n|$)/i.exec(content);
    if (nameMatch?.[1]) {
      const cleaned = nameMatch[1].replace(/^\*\*|\*\*$/g, "").replace(/^['"]|['"]$/g, "").trim();
      if (cleaned) {
        result.name = cleaned;
      }
    }
  }

  // 3. Match lines like: - **Emoji:** 🦞 or Emoji: 🦞
  if (!result.emoji) {
    const emojiMatch = /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?Emoji(?:\*\*)?\s*:\s*(.+?)(?:\r?\n|$)/i.exec(content);
    if (emojiMatch?.[1]) {
      const cleaned = emojiMatch[1].replace(/^\*\*|\*\*$/g, "").replace(/^['"]|['"]$/g, "").trim();
      if (cleaned) {
        result.emoji = cleaned;
      }
    }
  }

  return result;
}

export type GatewayRequestClient = {
  request: (method: string, params?: unknown, options?: any) => Promise<any>;
};

export async function enrichAgentsListWithIdentities(
  rawResult: unknown,
  client: GatewayRequestClient,
): Promise<unknown> {
  if (!rawResult || typeof rawResult !== "object") {
    return rawResult;
  }

  let agentsList: Record<string, unknown>[] | undefined;
  if (Array.isArray(rawResult)) {
    agentsList = rawResult as Record<string, unknown>[];
  } else if (Array.isArray((rawResult as Record<string, unknown>).agents)) {
    agentsList = (rawResult as Record<string, unknown>).agents as Record<string, unknown>[];
  } else if (Array.isArray((rawResult as Record<string, unknown>).items)) {
    agentsList = (rawResult as Record<string, unknown>).items as Record<string, unknown>[];
  }

  if (!agentsList || agentsList.length === 0) {
    return rawResult;
  }

  await Promise.all(
    agentsList.map(async (ag) => {
      if (!ag || typeof ag !== "object") return;
      const id = String(ag.id || "").trim();
      if (!id) return;

      const identity = ag.identity && typeof ag.identity === "object" && !Array.isArray(ag.identity)
        ? (ag.identity as Record<string, unknown>)
        : undefined;

      const hasName = typeof identity?.name === "string" && identity.name.trim().length > 0;
      const hasEmoji = typeof identity?.emoji === "string" && identity.emoji.trim().length > 0;

      if (!hasName || !hasEmoji) {
        try {
          const fileRes = (await client.request("agents.files.get", {
            agentId: id,
            name: "IDENTITY.md",
          })) as { file?: { content?: unknown; missing?: boolean }; content?: unknown } | undefined;

          const content = typeof fileRes?.file?.content === "string"
            ? fileRes.file.content
            : typeof fileRes?.content === "string"
            ? fileRes.content
            : "";

          if (content) {
            const parsed = parseIdentityFromMarkdown(content);
            if (!ag.identity || typeof ag.identity !== "object") {
              ag.identity = {};
            }
            const currentIdentity = ag.identity as Record<string, unknown>;
            if (!currentIdentity.name && parsed.name) {
              currentIdentity.name = parsed.name;
            }
            if (!currentIdentity.emoji && parsed.emoji) {
              currentIdentity.emoji = parsed.emoji;
            }
            if (!ag.name && parsed.name) {
              ag.name = parsed.name;
            }
            if (!ag.displayName && parsed.name) {
              ag.displayName = parsed.name;
            }
            if (!ag.emoji && parsed.emoji) {
              ag.emoji = parsed.emoji;
            }
          }
        } catch {
          // Gracefully continue if IDENTITY.md is not found or fails to read
        }
      }

      // Propagate existing identity fields to top-level displayName / emoji if not already set
      const finalIdentity = ag.identity as Record<string, unknown> | undefined;
      if (!ag.displayName && typeof finalIdentity?.name === "string" && finalIdentity.name.trim()) {
        ag.displayName = finalIdentity.name.trim();
      }
      if (!ag.emoji && typeof finalIdentity?.emoji === "string" && finalIdentity.emoji.trim()) {
        ag.emoji = finalIdentity.emoji.trim();
      }
    }),
  );

  return rawResult;
}
