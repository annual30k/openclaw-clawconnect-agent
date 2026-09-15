import { readFileSync, statSync } from "fs";
import type { ToolState } from "../../core/relay/timeline-event-log.js";
import { HERMES_AGENT_LOG_FILE, stripAnsi } from "./hermes-runtime-process.js";
import type { HermesToolLogEvent } from "./hermes-runtime-types.js";

export function hermesToolState(event: HermesToolLogEvent): ToolState {
  if (event.phase === "completed") {
    return "success";
  }
  if (event.phase === "failed") {
    return "failed";
  }
  return "streaming_output";
}

export function createHermesToolLogWatcher(
  onEvent: (event: HermesToolLogEvent) => void,
  options: {
    logFile?: string;
    pollIntervalMs?: number;
  } = {},
): {
  start: () => void;
  stop: () => void;
} {
  const logFile = options.logFile ?? HERMES_AGENT_LOG_FILE;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  let offset = 0;
  let timer: NodeJS.Timeout | undefined;
  try {
    offset = statSync(logFile).size;
  } catch {
    offset = 0;
  }

  const poll = (): void => {
    let content = "";
    try {
      const bytes = readFileSync(logFile);
      if (bytes.length < offset) {
        offset = 0;
      }
      if (bytes.length === offset) {
        return;
      }
      content = bytes.subarray(offset).toString("utf8");
      offset = bytes.length;
    } catch {
      return;
    }
    for (const line of content.split(/\r?\n/)) {
      const event = parseHermesToolLogLine(line);
      if (event) {
        onEvent(event);
      }
    }
  };

  return {
    start: () => {
      if (timer) {
        return;
      }
      timer = setInterval(poll, pollIntervalMs);
      timer.unref?.();
    },
    stop: () => {
      poll();
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

export function parseHermesToolLogLine(line: string): HermesToolLogEvent | null {
  const clean = stripAnsi(line).trim();
  if (!clean) {
    return null;
  }

  const executor = clean.match(/\bagent\.tool_executor:\s*tool\s+([A-Za-z0-9_.-]+)\s+(.+)$/i);
  if (executor) {
    const toolName = normalizeHermesToolName(executor[1] ?? "tool");
    const detail = (executor[2] ?? "").trim();
    // `agent.tool_executor` is a fixed Hermes logger grammar.  Accept only
    // its anchored lifecycle phrases; arbitrary detail prose is not evidence
    // that a tool started, completed, or failed.
    if (/^(?:running|started|executing|start)$/i.test(detail)) {
      return {
        toolName,
        phase: "streaming",
        text: `${toolName} ${detail}`.trim(),
        isError: false,
      };
    }
    const failed = /^(?:failed|errored|denied|aborted)(?:\b|\s*[:(])/i.test(detail)
      || /^returned\s+error\s*:/i.test(detail);
    const completed = /^(?:completed|finished)(?:\b|\s*[(])/i.test(detail);
    if (!failed && !completed) return null;
    return {
      toolName,
      phase: failed ? "failed" : "completed",
      text: `${toolName} ${detail}`.trim(),
      isError: failed,
    };
  }

  const toolLogger = clean.match(/\btools\.([A-Za-z0-9_.-]+):\s*(.+)$/i);
  if (!toolLogger) {
    return null;
  }
  const loggerName = toolLogger[1] ?? "tool";
  if (!/(?:_tool|_tools)$/i.test(loggerName)) {
    return null;
  }
  // `tools.*` lines contain human-facing logger prose without a typed
  // lifecycle receipt. Do not turn that prose into a tool execution event.
  return null;
}

function normalizeHermesToolName(rawName: string): string {
  const normalized = rawName
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/_tools$/i, "")
    .replace(/_tool$/i, "");
  return normalized || "tool";
}
