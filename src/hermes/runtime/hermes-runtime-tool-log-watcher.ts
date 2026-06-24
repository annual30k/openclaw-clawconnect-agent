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

export function createHermesToolLogWatcher(onEvent: (event: HermesToolLogEvent) => void): {
  start: () => void;
  stop: () => void;
} {
  let offset = 0;
  let timer: NodeJS.Timeout | undefined;
  try {
    offset = statSync(HERMES_AGENT_LOG_FILE).size;
  } catch {
    offset = 0;
  }

  const poll = (): void => {
    let content = "";
    try {
      const bytes = readFileSync(HERMES_AGENT_LOG_FILE);
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
      timer = setInterval(poll, 250);
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
    if (/\b(?:running|started|executing|start)\b/i.test(detail)) {
      return {
        toolName,
        phase: "streaming",
        text: `${toolName} ${detail}`.trim(),
        isError: false,
      };
    }
    const failed = /\b(?:failed|error|errored|denied|aborted)\b/i.test(detail);
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
  let toolName = normalizeHermesToolName(loggerName);
  let detail = (toolLogger[2] ?? "").trim();
  if (/\b(?:Shutting down \d+ remaining sandbox(?:\(es\))?|Manually cleaned up environment|Cleaned \d+ environments?)\b/i.test(detail)) {
    return null;
  }
  const nestedTool = detail.match(/^([A-Za-z0-9_.-]+):\s*(.+)$/);
  if (nestedTool) {
    toolName = normalizeHermesToolName(nestedTool[1] ?? toolName);
    detail = (nestedTool[2] ?? "").trim();
  }
  if (!detail) {
    return null;
  }
  return {
    toolName,
    phase: "streaming",
    text: `${toolName}: ${detail}`,
  };
}

function normalizeHermesToolName(rawName: string): string {
  const normalized = rawName
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/_tools$/i, "")
    .replace(/_tool$/i, "");
  return normalized || "tool";
}
