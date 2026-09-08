import type { HistoryMessage } from "./chat-history.js";

/** Reunite OpenClaw's explicit stream-segment projections with their archive row.
 * Only shared transcript identities qualify; equal text/seq alone never does. */
export function restoreGatewayHistoryMessages(messages: HistoryMessage[]): HistoryMessage[] {
  const rows = new Map<string, HistoryMessage>();
  const segments = new Map<string, Map<string, HistoryMessage>>();
  const identity = (m: HistoryMessage): string | undefined => {
    const meta = m.__openclaw as Record<string, unknown> | undefined;
    const position = meta?.transcriptPosition as Record<string, unknown> | undefined;
    return typeof meta?.id === "string" && typeof position?.source === "string"
      ? JSON.stringify([position.source, meta.id, m.role]) : undefined;
  };
  for (const message of messages) {
    const key = identity(message);
    const fallback = message.openclawStreamFallback as Record<string, unknown> | undefined;
    if (!key) continue;
    if (fallback?.source === "segment" && typeof fallback.itemId === "string") {
      const group = segments.get(key) ?? new Map<string, HistoryMessage>();
      group.set(fallback.itemId, message);
      segments.set(key, group);
    } else if (!rows.has(key)) {
      // The archive row is the position authority. Do not let an earlier
      // transport-only stream segment move the reconstructed message.
      rows.set(key, message);
    }
  }
  const emitted = new Set<string>();
  return messages.flatMap(message => {
    const key = identity(message);
    if (!key || !segments.has(key)) return [withInputMedia(message)];
    const fallback = message.openclawStreamFallback as Record<string, unknown> | undefined;
    const isSegment = fallback?.source === "segment" && typeof fallback.itemId === "string";
    const row = rows.get(key);
    // If an archive row exists, the sidecar has no independent position. It
    // is folded only when its row is reached, even when the sidecar arrived
    // earlier in the host response.
    if (isSegment && row) return [];
    if (row && row !== message) return [];
    if (emitted.has(key)) return [];
    emitted.add(key);
    const fragments = [...segments.get(key)!.values()];
    const blocks = (m: HistoryMessage) => typeof m.content === "string"
      ? (m.content ? [{ type: "text", text: m.content }] : []) : m.content ?? [];
    return [withInputMedia({ ...row ?? message, content: [
      ...fragments.flatMap(blocks), ...(row ? blocks(row) : []),
    ] })];
  });
}

function withInputMedia(message: HistoryMessage): HistoryMessage {
  const meta = message.__openclaw as Record<string, unknown> | undefined;
  if (message.role !== "user" || !Array.isArray(meta?.media)) return message;
  const content = typeof message.content === "string"
    ? (message.content ? [{ type: "text", text: message.content }] : []) : message.content ?? [];
  const existingUrls = new Set(content.map(block => (block as Record<string, unknown>).url));
  const media = meta.media.filter((value): value is Record<string, unknown> =>
    Boolean(value && typeof value === "object" && typeof value.url === "string" && value.url.startsWith("media://inbound/") && !existingUrls.has(value.url)));
  return { ...message, content: [...content, ...media.map(value => ({
    type: value.kind === "image" ? "image" : "file", url: value.url,
    fileName: value.fileName, mimeType: value.contentType, sizeBytes: value.sizeBytes,
  }))] };
}
