import {
  forgetHermesSession,
  getMappedHermesSessionId,
  rememberHermesSession,
} from "../hermes-session-store.js";
import {
  runHermesPython,
  sanitizeHermesChatOutput,
} from "./hermes-runtime-process.js";
import type { HermesChatResult } from "./hermes-runtime-types.js";
import { collectHermesUsageSnapshot } from "./hermes-runtime-usage.js";

const HERMES_SLASH_COMMAND_SCRIPT = String.raw`
import contextlib
import io
import json
import os
import sys

from rich.console import Console

import cli as cli_mod
from cli import HermesCLI

command = os.environ.get("CLAWCONNECT_HERMES_SLASH_COMMAND", "").strip()
resume = os.environ.get("CLAWCONNECT_HERMES_SLASH_RESUME", "").strip() or None
if command and not command.startswith("/"):
    command = "/" + command

with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    cli = HermesCLI(model=None, compact=True, resume=resume, verbose=False)

buf = io.StringIO()
cli.console = Console(file=buf, force_terminal=True, width=120)

def approve_once(prompt=""):
    if prompt:
        print(prompt, end="")
    return "1"

def approve_once_modal(*args, **kwargs):
    return "once"

try:
    cli._prompt_text_input = approve_once
    cli._prompt_text_input_modal = approve_once_modal
except Exception:
    pass

old_cprint = getattr(cli_mod, "_cprint", None)
if old_cprint is not None:
    cli_mod._cprint = lambda text: print(text)

try:
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        keep_going = cli.process_command(command)
    pending_inputs = []
    pending_queue = getattr(cli, "_pending_input", None)
    if pending_queue is not None:
        while True:
            try:
                pending_inputs.append(pending_queue.get_nowait())
            except Exception:
                break
    payload = {
        "ok": True,
        "output": buf.getvalue().rstrip(),
        "sessionId": getattr(cli, "session_id", None),
        "keepGoing": bool(keep_going),
        "pendingInputs": pending_inputs,
    }
except Exception as exc:
    payload = {
        "ok": False,
        "output": buf.getvalue().rstrip(),
        "error": str(exc),
        "sessionId": getattr(cli, "session_id", None),
    }
finally:
    if old_cprint is not None:
        cli_mod._cprint = old_cprint

sys.stdout.write(json.dumps(payload, ensure_ascii=False))
`;

export function isHermesSlashCommandMessage(message: string): boolean {
  return /^\/[A-Za-z0-9][\w-]*(?:\s|$)/.test(message.trim());
}

export async function runHermesSlashCommand(params: {
  message: string;
  sessionKey: string;
  hermesSessionId?: unknown;
  runQueuedChat?: (message: string, hermesSessionId?: string) => Promise<HermesChatResult>;
}): Promise<HermesChatResult> {
  const command = params.message.trim();
  const resume = typeof params.hermesSessionId === "string" && params.hermesSessionId.trim().length > 0
    ? params.hermesSessionId.trim()
    : await getMappedHermesSessionId(params.sessionKey);

  const raw = runHermesPython(HERMES_SLASH_COMMAND_SCRIPT, {
    CLAWCONNECT_HERMES_SLASH_COMMAND: command,
    CLAWCONNECT_HERMES_SLASH_RESUME: resume ?? "",
  });

  const payload = parseHermesSlashCommandPayload(raw);
  const output = sanitizeHermesChatOutput(payload.output ?? "").trim();
  if (!payload.ok) {
    const message = [output, payload.error].filter(Boolean).join("\n").trim() || "hermes_slash_command_failed";
    throw new Error(message);
  }

  const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim().length > 0
    ? payload.sessionId.trim()
    : undefined;
  if (sessionId) {
    await rememberHermesSession(params.sessionKey, {
      sessionKey: params.sessionKey,
      hermesSessionId: sessionId,
      displayName: sessionId,
      label: command,
      lastActivityAt: new Date().toISOString(),
      kind: "hermes",
    });
  }
  if (/^\/(?:new|reset)\b/i.test(command) && resume && sessionId && sessionId !== resume) {
    await forgetHermesSession(resume, resume);
  }

  if (payload.pendingInputs && payload.pendingInputs.length > 0) {
    const queuedMessage = payload.pendingInputs.join("\n\n").trim();
    if (queuedMessage && params.runQueuedChat) {
      const queued = await params.runQueuedChat(queuedMessage, sessionId);
      return {
        ...queued,
        output: [output, queued.output].filter((part) => part && part !== "(no output)").join("\n\n") || queued.output,
      };
    }
  }

  const usage = await collectHermesUsageSnapshot(sessionId);
  return {
    output: output || "(no output)",
    sessionKey: params.sessionKey,
    artifactPaths: [],
    usage,
  };
}

function parseHermesSlashCommandPayload(raw: string): {
  ok: boolean;
  output?: string;
  error?: string;
  sessionId?: string;
  pendingInputs?: string[];
} {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid_hermes_slash_command_payload");
  }
  const record = parsed as Record<string, unknown>;
  return {
    ok: record.ok === true,
    output: typeof record.output === "string" ? record.output : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
    pendingInputs: Array.isArray(record.pendingInputs)
      ? record.pendingInputs.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : undefined,
  };
}
