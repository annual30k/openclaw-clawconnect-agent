import {
  buildMessageCompletedEvent,
  buildMessagePartDeltaEvent,
  buildRunAbortedEvent,
  buildRunCompletedEvent,
  buildRunErrorEvent,
} from "./timeline-event-builder.js";
import type { TimelineContentBlock } from "./timeline-event-log.js";

export type MobileChatRun = {
  runId: string;
  sessionKey: string;
};

export type MobileAssistantUsage = {
  currentModel?: string;
  provider?: string;
  contextUsage?: number;
  contextLimit?: number;
};

const PROTOCOL_TYPING_MARKER = "[[clawlink:typing]]";
const COMMAND_DENIED_TIMEOUT_MESSAGE = "Timeout – denying command";
const protocolTypingMarkerRegex = /^(?:\[\[clawlink:typing]]\s*)+$/;
const hermesCommandDeniedTimeoutRegex = /\bTimeout\b\s*[–—-]\s*denying command\b/i;

export type CanonicalMobileAssistantText = {
  text: string;
  shouldPublish: boolean;
  controlError?: string;
};

type CanonicalizeMobileAssistantTextOptions = {
  preserveWhitespace?: boolean;
};

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function timelineTextContent(event: { content: TimelineContentBlock[] }): string {
  const firstText = event.content.find((block) => block.type === "text" && typeof block.text === "string");
  return typeof firstText?.text === "string" ? firstText.text : "";
}

export function resolveMobileChatRun(params: {
  preferredRunId?: string;
  requestId?: string;
  sessionKey?: string;
  fallbackPrefix: string;
}): MobileChatRun {
  return {
    runId: nonEmpty(params.preferredRunId) ?? nonEmpty(params.requestId) ?? `${params.fallbackPrefix}-${Date.now()}`,
    sessionKey: nonEmpty(params.sessionKey) ?? "main",
  };
}

export function isCanonicalMobileChatControlError(text: string): boolean {
  return text
    .split(/\r?\n|\r/)
    .some((line) => hermesCommandDeniedTimeoutRegex.test(line.trim()));
}

export function canonicalizeMobileAssistantText(
  text: string,
  options: CanonicalizeMobileAssistantTextOptions = {},
): CanonicalMobileAssistantText {
  if (isCanonicalMobileChatControlError(text)) {
    return {
      text: "",
      shouldPublish: false,
      controlError: COMMAND_DENIED_TIMEOUT_MESSAGE,
    };
  }

  const lines = text.split(/\r?\n|\r/);
  const stripped = lines
    .filter((line) => {
      const trimmed = line.trim();
      return !/^\s*↻?\s*Resumed session\b/i.test(trimmed)
        && !/^session_id:\s*\S+/i.test(trimmed)
        && !/^Error:\s*'NoneType'\s+object\s+is\s+not\s+iterable\s*$/i.test(trimmed);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  const trimmed = stripped.trim();
  if (!trimmed || trimmed === PROTOCOL_TYPING_MARKER || protocolTypingMarkerRegex.test(trimmed)) {
    return { text: "", shouldPublish: false };
  }
  return { text: options.preserveWhitespace ? stripped : trimmed, shouldPublish: true };
}

export function buildCanonicalMobileAssistantDeltaPayload(params: {
  run: MobileChatRun;
  seq: number;
  timestampMs: number;
  delta: string;
}) {
  const timelineEvent = buildMessagePartDeltaEvent({
    gatewayId: "clawconnect",
    sessionKey: params.run.sessionKey,
    turnId: params.run.runId,
    runId: params.run.runId,
    role: "assistant",
    seq: params.seq,
    turnSeq: params.seq,
    now: () => new Date(params.timestampMs),
    content: [{ type: "text", text: params.delta }],
  });
  const text = timelineTextContent(timelineEvent);
  return {
    runId: params.run.runId,
    sessionKey: params.run.sessionKey,
    state: "delta",
    role: "assistant",
    seq: params.seq,
    ts: params.timestampMs,
    delta: text,
    message: {
      role: "assistant",
      timestamp: params.timestampMs,
      content: [{ type: "text", text }],
    },
  };
}

export function buildMobileAssistantDeltaPayload(params: {
  run: MobileChatRun;
  seq: number;
  timestampMs: number;
  delta: string;
}) {
  return buildCanonicalMobileAssistantDeltaPayload(params);
}

export function buildCanonicalMobileAssistantStreamingPayload(params: {
  run: MobileChatRun;
  seq?: number;
  text: string;
}) {
  const timelineEvent = buildMessagePartDeltaEvent({
    gatewayId: "clawconnect",
    sessionKey: params.run.sessionKey,
    turnId: params.run.runId,
    runId: params.run.runId,
    role: "assistant",
    seq: params.seq,
    turnSeq: params.seq,
    content: [{ type: "text", text: params.text }],
  });
  const text = timelineTextContent(timelineEvent);
  return {
    runId: params.run.runId,
    sessionKey: params.run.sessionKey,
    state: "streaming",
    role: "assistant",
    ...(params.seq !== undefined ? { seq: params.seq } : {}),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

export function buildMobileAssistantStreamingPayload(params: {
  run: MobileChatRun;
  seq?: number;
  text: string;
}) {
  return buildCanonicalMobileAssistantStreamingPayload(params);
}

export function buildCanonicalMobileAssistantFinalPayload(params: {
  run: MobileChatRun;
  text: string;
  contentBlocks?: TimelineContentBlock[];
  includeTimelineEvents?: boolean;
} & MobileAssistantUsage) {
  const content = [
    { type: "text", text: params.text },
    ...(params.contentBlocks ?? []),
  ];
  const timelineEvent = buildMessageCompletedEvent({
    gatewayId: "clawconnect",
    sessionKey: params.run.sessionKey,
    turnId: params.run.runId,
    runId: params.run.runId,
    role: "assistant",
    content,
  });
  const text = timelineTextContent(timelineEvent);
  return {
    runId: params.run.runId,
    sessionKey: params.run.sessionKey,
    state: "final",
    role: "assistant",
    ...(params.currentModel !== undefined ? { currentModel: params.currentModel } : {}),
    ...(params.provider !== undefined ? { provider: params.provider } : {}),
    ...(params.contextUsage !== undefined ? { contextUsage: params.contextUsage } : {}),
    ...(params.contextLimit !== undefined ? { contextLimit: params.contextLimit } : {}),
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        ...(params.contentBlocks ?? []),
      ],
    },
    ...(params.includeTimelineEvents
      ? {
        timelineEvents: [
          timelineEvent,
          buildRunCompletedEvent({
            gatewayId: "clawconnect",
            sessionKey: params.run.sessionKey,
            turnId: params.run.runId,
            runId: params.run.runId,
            role: "assistant",
          }),
        ],
      }
      : {}),
  };
}

export function buildMobileAssistantFinalPayload(params: {
  run: MobileChatRun;
  text: string;
  contentBlocks?: TimelineContentBlock[];
  includeTimelineEvents?: boolean;
} & MobileAssistantUsage) {
  return buildCanonicalMobileAssistantFinalPayload(params);
}

export function buildCanonicalMobileAssistantErrorPayload(params: {
  run: MobileChatRun;
  errorMessage: string;
  includeTimelineEvents?: boolean;
}) {
  const timelineEvent = buildRunErrorEvent({
    gatewayId: "clawconnect",
    sessionKey: params.run.sessionKey,
    turnId: params.run.runId,
    runId: params.run.runId,
    role: "assistant",
    userMessage: params.errorMessage,
  });
  const errorMessage = timelineEvent.error?.userMessage ?? params.errorMessage;
  return {
    runId: params.run.runId,
    sessionKey: params.run.sessionKey,
    state: "error",
    role: "assistant",
    errorMessage,
    message: {
      role: "assistant",
      content: [{ type: "text", text: errorMessage }],
    },
    ...(params.includeTimelineEvents ? { timelineEvents: [timelineEvent] } : {}),
  };
}

export function buildMobileAssistantErrorPayload(params: {
  run: MobileChatRun;
  errorMessage: string;
  includeTimelineEvents?: boolean;
}) {
  return buildCanonicalMobileAssistantErrorPayload(params);
}

export function buildMobileAssistantAbortedPayload(params: {
  run: MobileChatRun;
  userMessage?: string;
  includeTimelineEvents?: boolean;
}) {
  const timelineEvent = buildRunAbortedEvent({
    gatewayId: "clawconnect",
    sessionKey: params.run.sessionKey,
    turnId: params.run.runId,
    runId: params.run.runId,
    role: "assistant",
    userMessage: params.userMessage,
  });
  return {
    runId: params.run.runId,
    sessionKey: params.run.sessionKey,
    state: "aborted",
    role: "assistant",
    ...(params.userMessage ? { errorMessage: params.userMessage } : {}),
    ...(params.includeTimelineEvents ? { timelineEvents: [timelineEvent] } : {}),
  };
}
