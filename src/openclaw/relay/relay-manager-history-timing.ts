export const CHAT_HISTORY_FETCH_TIMEOUT_MS = 3000;
// A terminal chat event normally carries its own text. Give the transcript a
// short enrichment window only when that event has no media, because OpenClaw
// message-tool deliveries are committed as delivery-mirror rows immediately
// before the final text event.
export const CHAT_HISTORY_MEDIA_ENRICHMENT_TIMEOUT_MS = 1200;
export const CHAT_HISTORY_FALLBACK_INITIAL_DELAY_MS = 1200;
export const CHAT_HISTORY_FALLBACK_RETRY_DELAY_MS = 1800;
export const CHAT_HISTORY_FALLBACK_MAX_ATTEMPTS = 120;
export const CHAT_HISTORY_FINAL_RETRY_DELAY_MS = 750;
