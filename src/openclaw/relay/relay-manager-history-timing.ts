export const CHAT_HISTORY_FETCH_TIMEOUT_MS = 3000;
// A terminal chat event normally carries its own text. Give the transcript a
// bounded enrichment window so OpenClaw delivery-mirror rows committed around
// the final event can contribute media without delaying the run indefinitely.
export const CHAT_HISTORY_MEDIA_ENRICHMENT_TIMEOUT_MS = 1200;
