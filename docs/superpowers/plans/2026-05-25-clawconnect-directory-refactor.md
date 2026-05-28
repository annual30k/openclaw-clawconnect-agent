# ClawConnect Directory Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Reorganize ClawConnect agent code so CLI commands, shared relay utilities, OpenClaw-specific runtime, and Hermes runtime code have clear module boundaries.

**Architecture:** `commands/` remains CLI-facing, `core/` owns shared types and relay utilities, `openclaw/` owns OpenClaw runtime and relay integration, and `hermes/runtime/` replaces misleading `hermes/models/`. Existing behavior should remain unchanged except for the compatibility-safe `CLAWCONNECT_ASR_COMMAND` preference.

**Tech Stack:** TypeScript ESM, Node test runner, `tsx`, `ws`.

---

### Task 1: Shared Types

**Files:**
- Create: `src/core/command-types.ts`
- Create: `src/core/relay/slash-command-types.ts`
- Modify imports that currently depend on `src/commands/local-runtime.ts` or `src/relay/slash-command-catalog.ts` only for shared types.

- [x] Extract `LocalResult`, `LocalCommandContext`, and `LocalCommandEventPublisher`.
- [x] Extract `RelaySlashCommandSource` and `RelaySlashCommandDescriptor`.
- [x] Run `npm test`.

### Task 2: Hermes Runtime Rename

**Files:**
- Move: `src/hermes/models/*.ts` to `src/hermes/runtime/*.ts`
- Modify: `src/hermes/hermes-runtime.ts`, tests, and Hermes imports.

- [x] Rename directory without changing behavior.
- [x] Update all `./models/` and `../models/` imports.
- [x] Run `npm test`.

### Task 3: Shared Relay Utilities

**Files:**
- Move shared relay files to `src/core/relay/`.
- Move matching tests with modules.
- Update `voice-input.ts` to prefer `CLAWCONNECT_ASR_COMMAND` and fall back to `OPENCLAW_ASR_COMMAND`.

- [x] Move `reconnect`, `office-payload`, `mobile-chat-run-bridge`, `voice-input`, `attachment-staging`, and `chat-payload`.
- [x] Update imports from commands, Hermes, and OpenClaw code.
- [x] Run `npm test`.

### Task 4: OpenClaw Module Boundary

**Files:**
- Move OpenClaw-specific command/runtime/config/relay files to `src/openclaw/`.
- Move matching tests with modules.
- Update `runtime-adapters.ts` and generator output path.

- [x] Move OpenClaw runtime, handlers, provider config, backups, relay manager, gateway client, session, chat, voice, and slash command catalog files.
- [x] Update all imports and test globs.
- [x] Run `npm run build` and `npm test`.

### Task 5: Send File Boundary

**Files:**
- Create: `src/core/relay/file-upload.ts`
- Move: `src/commands/send-file-utils.ts` to `src/core/relay/file-upload-utils.ts`
- Create: `src/openclaw/session-store.ts`
- Modify: `src/commands/send-file.ts`, Hermes artifact upload code, tests.

- [x] Make core upload require explicit relay URL, secret, gateway ID, session key, and file path.
- [x] Keep config loading, CLI output, JSON output, and session default inference in the command wrapper.
- [x] Ensure Hermes artifact upload calls the core service directly without CLI option vocabulary.
- [x] Run `npm run build` and `npm test`.
