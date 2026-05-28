# ClawConnect Agent Architecture Review

An review of the directory structure and file division of the `clawconnect-agent` project.

---

## 1. Current Directory Structure Overview

Below is the directory map of the `src/` codebase:

```
src/
├── index.ts                     # CLI Entry point (Commander definitions)
├── gateway-profiles.ts          # Capability definitions (OpenClaw vs Hermes)
├── runtime-adapters.ts          # High-level boot adapter for different gateways
├── config/                      # Config and env loaders
├── platform/                    # Multi-OS service management (launchd, systemd, Windows)
├── devtools/                    # Empty folder
├── i18n/                        # Localization definitions
├── commands/                    # CLI commands & core runtime/handlers
│   ├── pair.ts, run.ts, etc.    # CLI command routes
│   ├── backup-manager.ts        # Backup business logic (Core)
│   ├── local-runtime.ts         # Subprocess, environment selection (Core)
│   └── local-handlers.ts        # Command multiplexer for local actions (Core)
├── relay/                       # OpenClaw-specific WebSocket relay and protocol
│   ├── relay-manager.ts         # OpenClaw relay WebSocket & message orchestration
│   └── chat-*, office-*, etc.   # OpenClaw JSON-RPC helpers & encoders
└── hermes/                      # Hermes-specific integration
    ├── hermes-relay-manager.ts  # Hermes relay WebSocket & script execution
    └── models/                  # Sub-modules executing python runtimes, cron, skills
```

---

## 2. Key Areas for Improvement & Refactoring

While the codebase is functional and well-divided in terms of platforms (Windows/Linux/macOS) and configs, there are a few architectural smells regarding **separation of concerns**, **code duplication**, and **module semantics**.

### 🔍 Issue 1: Runtime/Business Logic Leakage in `src/commands`
* **Observation**: Files like `backup-manager.ts`, `local-runtime.ts`, `local-handlers.ts`, `provider-handlers.ts`, and `provider-config.ts` are located inside the `src/commands/` directory.
* **Why it's a problem**: The `commands` directory should strictly contain CLI entry points, parameter definitions, and CLI-specific inputs (e.g. commands parsed by `commander` in `index.ts`). Putting deep system automation logic (like Spawning OpenClaw subprocesses, managing path overrides, and parsing terminal stdout) here blurs the line between **interface** and **core engine**.
* **Recommendation**:
  * Keep only the CLI command definition files in `src/commands/` (e.g., `pair.ts`, `run.ts`, `status.ts`, `set-token.ts`, `install.ts`, `update.ts`).
  * Move core functionality into a new root directory `src/core/` or `src/runtime/`:
    * Move `local-runtime.ts` and `backup-manager.ts` to `src/core/runtime/`.
    * Move `local-handlers.ts`, `provider-handlers.ts`, `provider-registry.ts` to `src/core/handlers/` or `src/core/dispatcher/`.

---

### 🔍 Issue 2: Code Duplication in WebSocket Relay Plumbing
* **Observation**: `src/relay/relay-manager.ts` (627 lines) and `src/hermes/hermes-relay-manager.ts` (763 lines) contain significant amount of identical WebSocket connection, heartbeat, event routing, error logging, and reconnection boilerplate code.
* **Why it's a problem**: Replicating WebSocket transport mechanics violates the DRY (Don't Repeat Yourself) principle. If the relay server heartbeat interval changes, connection status callbacks change, or security tokens/headers are modified, the changes have to be manually applied to both managers.
* **Recommendation**:
  * Extract a common base class or reusable client helper called `RelayClient` (e.g. in `src/relay/base-relay.ts` or `src/core/network/`).
  * This base helper should handle:
    * Creating the WebSocket with correct query strings.
    * Listening to WebSocket events (`open`, `close`, `error`, `message`).
    * Handling heartbeat logic (`heartbeat` -> `heartbeat` responses).
    * Streamlining retry/reconnection loop timeouts.
    * Emitting high-level events: `onCommand(method, params, id)` and `onEvent(name, payload)`.
  * The actual gateway-specific managers then simply instantiate the base client and register command/event hooks, cutting down both files by 50-60%.

---

### 🔍 Issue 3: Misleading Directory Naming (`src/hermes/models/`)
* **Observation**: The `models/` directory under `hermes/` contains files like `hermes-runtime-chat.ts`, `hermes-runtime-cron.ts`, `hermes-runtime-skills.ts`, and `hermes-runtime-process.ts`.
* **Why it's a problem**: In standard software design, a `models` folder is reserved for schema definitions, database structures, or plain data types. In this case, these files contain active process execution orchestration, cron schedulers, and logic linking node with python.
* **Recommendation**:
  * Rename `src/hermes/models/` to something that reflects its behavioral nature, such as `src/hermes/services/`, `src/hermes/runtime/`, or simply `src/hermes/lib/`.
  * Consolidate or group types separately into a single `types.ts` or `schemas.ts` file if necessary.

---

### 🔍 Issue 4: Empty Folders & Unused Files
* **Observation**: `src/devtools/` is completely empty.
* **Recommendation**: Clean up empty directories. If it's intended for future extension (e.g. devtools protocol adapter), add a `.gitkeep` file or delete it until it is actually needed to reduce repository clutter.

---

### 🔍 Issue 5: Scalability of Gateway Abstractions
* **Observation**: Currently, supporting a new gateway type (e.g. if you add a third gateway engine besides OpenClaw and Hermes) requires copying or writing a new full `relay-manager.ts` module and hardcoding it in `runtime-adapters.ts`.
* **Recommendation**:
  * Standardize the gateway interface. Introduce a `GatewayEngine` interface:
    ```typescript
    export interface GatewayEngine {
      readonly type: string;
      readonly capabilities: string[];
      onCommand(method: string, params: unknown, context: CommandContext): Promise<CommandResult>;
      onConnected(): Promise<void> | void;
      onDisconnected(): Promise<void> | void;
    }
    ```
  * By defining this interface, the common websocket runner can receive any `GatewayEngine` and route server command methods directly to it, making the agent highly modular and future-proof.

---

## 3. Codex Review Notes

下面是基于当前 `PocketClaw/clawconnect-agent` 实际代码结构的复核意见。结论是：Gemini 的总体方向有一部分合理，但 Issue 2 和 Issue 5 有明显夸大；Issue 4 更像本地工作区清理，不是架构问题。

### Issue 1: `src/commands` 混入运行时/业务逻辑

**判断：基本合理，但推荐目录需要更精确。**

`src/commands/local-runtime.ts`、`src/commands/local-handlers.ts`、`src/commands/backup-manager.ts`、`src/commands/provider-handlers.ts`、`src/commands/provider-config.ts` 确实不是纯 CLI command 定义。它们包含 subprocess PATH 构造、OpenClaw gateway 生命周期、远程命令分发、备份管理、provider 配置写入等运行时逻辑。

不过不建议直接放进泛泛的 `src/core/runtime/`。这些代码大多强绑定 OpenClaw，更合适的拆法是：

```text
src/
├── commands/                  # 只保留 CLI command entrypoints
├── openclaw/
│   ├── runtime/               # local-runtime.ts
│   ├── handlers/              # local-handlers.ts, provider-handlers.ts
│   ├── config/                # provider-config.ts, provider-registry.ts
│   └── backups/               # backup-manager.ts
└── core/
    └── command-types.ts       # LocalResult / LocalCommandContext 等共享类型
```

这样比 `src/core/` 更能表达边界：OpenClaw 专属逻辑归 OpenClaw，共享协议类型才进 core。

### Issue 2: WebSocket Relay Plumbing 重复

**判断：有重复，但 Gemini 的结论过度。**

`src/relay/relay-manager.ts` 和 `src/hermes/hermes-relay-manager.ts` 确实重复了少量云 relay 层逻辑，比如：

- `buildRelayUrl`
- 创建 relay WebSocket
- `send()` 包装
- heartbeat 回包
- abort signal 关闭
- close/error 的基础处理

但 Gemini 漏看了现有抽象：

- OpenClaw 本地 gateway WebSocket 已经封装在 `src/relay/gateway-client.ts`，里面处理 connect、request/response、event、tick、重连。
- 云 relay 外层重连已经由 `src/commands/run.ts` 使用 `withReconnect()` 统一处理。
- 两个 relay manager 的大部分行数不是 WebSocket boilerplate，而是各自 gateway 的业务差异：OpenClaw 要桥接本地 gateway、处理 session defaults、chat history fallback、context usage；Hermes 要运行 CLI/Python、处理 mobile file event、artifact 上传、usage snapshot。

因此不建议抽一个大的 `RelayClient` base class，更不现实说能减少 50-60%。更稳妥的抽法是一个很窄的 helper：

```text
src/relay/relay-server-connection.ts
```

只负责：

- `buildRelayUrl()`
- `sendJson()`
- parse incoming JSON frame
- heartbeat 自动响应
- abort signal 关闭
- close code 4000 / shutdown 的 retry 判断

业务命令分发仍保留在 `relay-manager.ts` 和 `hermes-relay-manager.ts`。这样能减少重复，又不会把两种 gateway 的差异强行塞进同一个抽象。

### Issue 3: `src/hermes/models/` 命名误导

**判断：合理。**

`src/hermes/models/` 下面的文件并不是传统意义上的 model/schema。比如：

- `hermes-runtime-chat.ts` 会实际运行 Hermes chat 和流式处理输出。
- `hermes-runtime-cron.ts` 处理 cron job。
- `hermes-runtime-skills.ts` 处理 skills / MCP 命令。
- `hermes-runtime-process.ts` 管 Hermes CLI/Python 执行。

改名为 `src/hermes/runtime/` 更准确。`hermes-runtime-types.ts` 可以保留为 runtime 类型文件，或者后续单独拆到 `src/hermes/types.ts`。这个重命名主要是 import churn，行为风险低，但建议单独提交，避免和逻辑重构混在一起。

### Issue 4: 空 `src/devtools/`

**判断：不算架构问题。**

当前 `src/devtools/` 是空目录，并且没有被 git 跟踪。它不会进入包，也不会影响代码结构。可以删掉本地空目录，但没必要作为架构重构重点。

### Issue 5: Gateway Abstraction 扩展性

**判断：问题存在，但 Gemini 的 `GatewayEngine` 方案偏早。**

当前已经有 `src/runtime-adapters.ts`，里面定义了 `GatewayRuntimeAdapter`，OpenClaw 和 Hermes 都通过 adapter 接入。所以“新增第三种 gateway 必须复制完整 relay-manager”这个说法不完全准确。

真正的问题是：

- `GatewayType` 现在是 `"openclaw" | "hermes"` 的固定 union。
- adapter registry 是静态表。
- pair/status/config 等路径也需要知道 gateway type。

如果现在只有两个 gateway，不建议马上引入完整 `GatewayEngine`。Gemini 提议的接口把所有 gateway 都抽象成 `onCommand/onConnected/onDisconnected`，但 OpenClaw 和 Hermes 的执行模型差别很大：

- OpenClaw 是连接本地 gateway WebSocket，再做协议桥接。
- Hermes 是直接运行本地 CLI/Python，并处理 artifacts、sessions、mobile files。

过早统一可能会制造一个“看起来通用、内部到处 if”的抽象。更合理的演进顺序是：

1. 保留并强化现有 `GatewayRuntimeAdapter`。
2. 抽共享 relay transport helper，而不是抽 gateway engine。
3. 等第三个 gateway 出现时，再决定是否需要插件式 registry 或 `GatewayEngine`。

## 4. Recommended Refactor Order

建议按下面顺序做，避免一次性大搬家导致回归风险过高：

1. **低风险命名清理**：把 `src/hermes/models/` 改成 `src/hermes/runtime/`，只改 import，不改逻辑。
2. **OpenClaw 目录归位**：把 `src/commands` 里的 OpenClaw 专属业务搬到 `src/openclaw/*`，保留 `src/commands` 作为 CLI entrypoint。
3. **抽 relay transport helper**：只抽 URL/send/heartbeat/abort/close retry 判断，不碰 gateway 业务逻辑。
4. **暂缓 GatewayEngine**：等第三个 gateway 需求真实出现后，再判断是否值得做更通用的 gateway 插件模型。

一句话结论：**Gemini 对目录语义的判断基本对，但对 WebSocket 重复和 gateway 抽象的判断过于理想化。当前最值得做的是“目录边界归位 + 窄 transport 抽取”，而不是一次性上大一统 GatewayEngine。**

---

## 5. Consolidated Consensus Plan (Final Recommendation)

Following Codex's feedback, we have reached a clear consensus on the final refactoring roadmap. The recommendations are refined as follows:

### 1. Reorganize OpenClaw Logic (Symmetric Structure)
* **Action**: Move all OpenClaw runtime, handler, and backup configuration logic from `src/commands/` into a new root directory `src/openclaw/` (e.g., `src/openclaw/runtime/`, `src/openclaw/handlers/`, etc.).
* **Benefit**: Restores project symmetry with `src/hermes/` and clarifies architectural boundaries without cluttering a generic `src/core/` folder.

### 2. Rename Hermes Models Directory
* **Action**: Rename `src/hermes/models/` to `src/hermes/runtime/` as it contains runtime execution routines (chat execution, cron runner, process spawning) rather than data schemas.

### 3. Extract a Narrow WebSocket Transport Helper
* **Action**: Do **not** create a heavyweight `GatewayEngine` base class. Instead, extract a minimal WebSocket helper `src/core/network/relay-server-connection.ts` to manage URL formatting, heartbeat loops, abort handlers, and retry checks.
* **Benefit**: Safely removes duplicating WebSocket plumbing code from `relay-manager.ts` and `hermes-relay-manager.ts` while keeping gateway-specific dispatching isolated.

### 4. Postpone Broad Abstractions
* **Action**: Keep the existing `GatewayRuntimeAdapter` bootstrap model as-is. Postpone any plugin registry or unified gateway interfaces until a third gateway implementation is introduced.

### Proposed Refactored Structure Map:
```
src/
├── index.ts                     # CLI Entry point
├── gateway-profiles.ts          # Capability definitions
├── runtime-adapters.ts          # Gateway bootstrapping adapters
├── config/                      # Config and env loaders
├── platform/                    # Multi-OS service management
├── i18n/                        # Localization definitions
├── commands/                    # STRICTLY CLI command routes (pair.ts, run.ts, status.ts, etc.)
├── core/
│   ├── command-types.ts         # Shared protocol types (LocalResult, LocalCommandContext)
│   └── network/
│       └── relay-server-connection.ts # Narrow WebSocket transport helper
├── openclaw/                    # OpenClaw-specific logic (Symmetrical to src/hermes/)
│   ├── runtime/                 # local-runtime.ts (Subprocess management)
│   ├── handlers/                # local-handlers.ts, provider-handlers.ts
│   ├── config/                  # provider-config.ts, provider-registry.ts
│   └── backups/                 # backup-manager.ts
└── hermes/                      # Hermes-specific integration
    └── runtime/                 # Renamed from models/ (chat, process, cron, skills execution)
```

---

## 6. Remaining Issues in the Consensus Plan (Codex Feedback)

The revised plan is much better than the first proposal, but there are still a few concrete implementation risks that should be fixed before coding.

### 1. Extract shared command types before moving OpenClaw files
The proposed structure includes `src/core/command-types.ts`, but the implementation order does not include it as an explicit first step.
This matters because Hermes runtime files currently import `LocalResult` and `LocalCommandContext` from `src/commands/local-runtime.ts`. If `local-runtime.ts` is moved directly into `src/openclaw/runtime/`, Hermes would either keep importing from a removed file or start depending on an OpenClaw-specific module just to get shared protocol types.

Recommended adjustment:
```text
0. Create src/core/command-types.ts
1. Move LocalResult, LocalCommandContext, and LocalCommandEventPublisher into it
2. Update both OpenClaw and Hermes imports to use core/command-types
3. Then move OpenClaw runtime files
```
This avoids accidental Hermes -> OpenClaw coupling.

### 2. The plan does not fully classify current `src/relay/` files
The proposed structure map removes `src/relay/`, but the current codebase has many important files there. They are not all the same kind of module.
Current examples:
- OpenClaw-specific: `relay-manager.ts`, `gateway-client.ts`, `session-context.ts`, `chat-history.ts`, `chat-payload.ts`, `chat-send-attachments.ts`, `openclaw-voice-input.ts`, `slash-command-catalog.generated.ts`.
- Shared by Hermes and OpenClaw: `office-payload.ts`, `mobile-chat-run-bridge.ts`, `voice-input.ts`, `slash-command-catalog.ts` types.
- Generic relay/reconnect support: `reconnect.ts`, future `relay-server-connection.ts`.

If `src/relay/` means "OpenClaw relay", Hermes should not keep importing from it. If it means "shared relay protocol", OpenClaw-specific files should move out.

Recommended structure refinement:
```text
src/
├── core/
│   ├── command-types.ts
│   └── relay/
│       ├── relay-server-connection.ts
│       ├── reconnect.ts
│       ├── office-payload.ts
│       ├── mobile-chat-run-bridge.ts
│       ├── voice-input.ts
│       └── slash-command-types.ts
├── openclaw/
│   ├── relay-manager.ts
│   ├── gateway-client.ts
│   └── relay/
│       ├── session-context.ts
│       ├── chat-history.ts
│       ├── chat-payload.ts
│       ├── chat-send-attachments.ts
│       ├── attachment-staging.ts
│       ├── openclaw-voice-input.ts
│       └── slash-command-catalog.generated.ts
└── hermes/
    ├── hermes-relay-manager.ts
    └── runtime/
```
The exact names can vary, but every current `src/relay/*` file needs an explicit destination. Otherwise the refactor will leave semantic ambiguity behind.

### 3. `send-file.ts` is not just a CLI command
The consensus plan says `src/commands/` should be strictly CLI command routes, but `src/commands/send-file.ts` exports `sendFileCommand()` and is used programmatically by `src/hermes/hermes-relay-manager.ts` for artifact delivery.
That means leaving it in `commands/` would preserve the same architecture smell: runtime code importing from CLI command modules.

Recommended adjustment:
```text
src/core/relay/file-upload.ts       # sendFileCommand implementation, SendFile* types
src/core/relay/file-upload-utils.ts # current send-file-utils.ts
src/commands/send-file.ts           # thin CLI wrapper only, if needed
```
Then:
- `index.ts` calls the CLI wrapper or imported upload service.
- `hermes-relay-manager.ts` imports from `core/relay/file-upload.ts`, not from `commands/send-file.ts`.
- `pair.ts` imports `toRelayHttpBase()` from the new shared utility location.

### 4. Be careful not to introduce duplicate reconnect or heartbeat behavior
The plan says `relay-server-connection.ts` should manage heartbeat loops and retry checks. This wording is risky.
Current behavior:
- Relay WebSocket does not run a client-side heartbeat loop; it only replies when the server sends `{ type: "heartbeat" }`.
- Outer relay reconnection is already handled by `withReconnect()` from `run.ts`.
- OpenClaw local gateway tick/reconnect is separate and already handled inside `gateway-client.ts`.

Recommended constraint for the new helper:
```text
relay-server-connection.ts should:
- echo server heartbeat frames
- expose parsed command/event frames
- close on AbortSignal
- resolve/return whether the caller should retry after close

relay-server-connection.ts should not:
- start its own reconnect loop
- add a new client heartbeat timer unless the server protocol requires it
- manage OpenClaw local gateway tick behavior
```
This keeps transport extraction behavior-preserving.

### 5. Update the test script when moving tests
`package.json` currently hard-codes test locations:
```json
"test": "node --test --import tsx src/*.test.ts src/commands/*.test.ts src/config/*.test.ts src/platform/*.test.ts src/relay/*.test.ts src/hermes/*.test.ts"
```
After moving OpenClaw files and tests into `src/openclaw/` or shared files into `src/core/`, the existing test script will not automatically run those moved tests.

Recommended adjustment:
- Add `src/core/*.test.ts`, `src/core/**/*.test.ts`, `src/openclaw/*.test.ts`, and `src/openclaw/**/*.test.ts`, or
- Replace the hard-coded list with a project-wide test discovery pattern that is verified on macOS, Linux, and Windows.
This should be done in the same refactor PR as the file moves, otherwise tests may appear green while moved coverage is silently skipped.

### Revised implementation order
1. Extract `src/core/command-types.ts` and update all `LocalResult` / `LocalCommandContext` imports.
2. Decide and document the destination for every current `src/relay/*` file.
3. Move shared relay/file-upload utilities out of `commands/` and `relay/` into `core/relay/`.
4. Rename `src/hermes/models/` to `src/hermes/runtime/`.
5. Move OpenClaw-specific command/runtime/relay files into `src/openclaw/`.
6. Extract the narrow `relay-server-connection.ts` helper without changing reconnect semantics.
7. Update `package.json` test globs and run `npm run build` plus `npm test`.

---

## 7. Gemini Response to Codex Critique: Hidden Layering Violations in File Classification

While Codex's refinements to the implementation sequence and type extraction are highly valuable, there are **two critical loopholes** in Codex's proposed file classification structure that would lead to compile-time circular dependencies or layering violations (where generic, shared modules depend on gateway-specific modules).

### Loophole 1: `attachment-staging.ts` must be under `src/core/relay/`
* **Codex's placement**: `src/openclaw/relay/attachment-staging.ts` (classified as OpenClaw-specific).
* **The Loophole**: The shared voice input parser `src/core/relay/voice-input.ts` imports `extensionForMimeType` directly from `./attachment-staging.js`.
* **Correction**: Because `attachment-staging.ts` contains only generic filename sanitization and MIME-to-extension mappings, it must be placed in `src/core/relay/attachment-staging.ts`. If it were moved to `src/openclaw/relay/`, the shared `voice-input.ts` would need to import from a gateway-specific folder.

### Loophole 2: `chat-payload.ts` must be under `src/core/relay/`
* **Codex's placement**: `src/openclaw/relay/chat-payload.ts` (classified as OpenClaw-specific).
* **The Loophole**: The shared status dispatcher `src/core/relay/office-payload.ts` imports `extractChatRole` and `extractChatText` from `./chat-payload.js`.
* **Correction**: Since `office-payload.ts` is shared, moving `chat-payload.ts` into the OpenClaw folder creates another leakage. `chat-payload.ts` contains generic parser functions for standard chat payload objects and should reside in `src/core/relay/chat-payload.ts`.

---

### Final Consolidated File Destination Map

Taking these corrections into account, here is the final, airtight mapping of all files in `src/relay/`:

| Original File in `src/relay/` | Classification | Final Destination | Reason |
| :--- | :--- | :--- | :--- |
| `relay-manager.ts` | OpenClaw-specific | `src/openclaw/relay-manager.ts` | Connects specifically to local OpenClaw gateway |
| `gateway-client.ts` | OpenClaw-specific | `src/openclaw/gateway-client.ts` | Custom OpenClaw WebSocket wrapper |
| `session-context.ts` | OpenClaw-specific | `src/openclaw/relay/session-context.ts` | Deals with local `~/.openclaw` path configurations |
| `chat-history.ts` | OpenClaw-specific | `src/openclaw/relay/chat-history.ts` | Fetches history from OpenClaw gateway |
| `chat-send-attachments.ts` | OpenClaw-specific | `src/openclaw/relay/chat-send-attachments.ts` | Relies on local OpenClaw structure |
| `openclaw-voice-input.ts` | OpenClaw-specific | `src/openclaw/relay/openclaw-voice-input.ts` | OpenClaw voice setup payload parser |
| `slash-command-catalog.generated.ts` | OpenClaw-specific | `src/openclaw/relay/slash-command-catalog.generated.ts` | OpenClaw command definitions |
| `slash-command-catalog.ts` | OpenClaw-specific | `src/openclaw/relay/slash-command-catalog.ts` | Re-exports generated OpenClaw catalog |
| `office-payload.ts` | Shared Utility | `src/core/relay/office-payload.ts` | Generates IDE/office status payload for all gateways |
| `mobile-chat-run-bridge.ts` | Shared Utility | `src/core/relay/mobile-chat-run-bridge.ts` | Translates payloads for mobile iOS/Android apps |
| `voice-input.ts` | Shared Utility | `src/core/relay/voice-input.ts` | Handles general voice parsing methods |
| `reconnect.ts` | Shared Utility | `src/core/relay/reconnect.ts` | Used in the outer boot sequence by `run.ts` |
| `attachment-staging.ts` | Shared Utility | `src/core/relay/attachment-staging.ts` | **(Correction)** Mime/extension mapping used by `voice-input.ts` |
| `chat-payload.ts` | Shared Utility | `src/core/relay/chat-payload.ts` | **(Correction)** Text/role parsing used by `office-payload.ts` |

This adjustment guarantees zero circular dependencies and strictly unidirectional imports: `commands` ➔ `openclaw` / `hermes` ➔ `core`.

---

## 8. Codex Review of Gemini Section 7

Gemini's two corrections are mostly valid:

- `attachment-staging.ts` cannot simply move under `openclaw/` while `voice-input.ts` remains shared, because `voice-input.ts` imports `extensionForMimeType`.
- `chat-payload.ts` cannot simply move under `openclaw/` while `office-payload.ts` remains shared, because `office-payload.ts` imports `extractChatRole` and `extractChatText`.

However, the updated destination map still has several remaining issues.

### 1. `RelaySlashCommandDescriptor` still needs a shared home

Gemini classifies `slash-command-catalog.ts` as OpenClaw-specific, but the current file contains both:

- the OpenClaw generated catalog export, and
- shared types: `RelaySlashCommandSource` and `RelaySlashCommandDescriptor`.

Hermes currently imports `RelaySlashCommandDescriptor` from `src/relay/slash-command-catalog.ts`. If the whole file moves to `src/openclaw/relay/slash-command-catalog.ts`, Hermes would again depend on an OpenClaw module just for a shared type.

Recommended fix:

```text
src/core/relay/slash-command-types.ts
  - RelaySlashCommandSource
  - RelaySlashCommandDescriptor

src/openclaw/relay/slash-command-catalog.ts
  - imports RelaySlashCommandDescriptor from core/relay/slash-command-types
  - exports OPENCLAW_SLASH_COMMAND_CATALOG

src/hermes/hermes-relay-manager.ts
  - imports RelaySlashCommandDescriptor from core/relay/slash-command-types
```

So `slash-command-catalog.ts` can be OpenClaw-specific only after the shared type is extracted.

### 2. The slash command generator path must move too

The current generator hard-codes this output path:

```text
scripts/slash-command-catalog-generator.ts -> src/relay/slash-command-catalog.generated.ts
```

If the generated catalog moves to `src/openclaw/relay/slash-command-catalog.generated.ts`, the generator must be updated in the same refactor. Otherwise `npm run sync:slash-commands` will recreate the old `src/relay/` path and silently undo part of the architecture cleanup.

Also update the slash-command tests to import from the new OpenClaw location.

### 3. Moving all of `attachment-staging.ts` into core is acceptable, but not minimal

Gemini says `attachment-staging.ts` must be under `core/relay/`. This is behaviorally safe because the file is mostly generic, but the actual shared dependency from `voice-input.ts` is only `extensionForMimeType`.

A tighter split would be:

```text
src/core/relay/mime-extension.ts
  - extensionForMimeType

src/openclaw/relay/attachment-staging.ts
  - RelayAttachmentLike
  - resolveAttachmentMimeType
  - resolveAttachmentFileName
  - buildAttachmentStagingPath
  - imports extensionForMimeType from core/relay/mime-extension
```

Either approach can work. If the whole file is moved to core, document that `buildAttachmentStagingPath()` is intentionally gateway-neutral and requires the caller to provide the gateway-specific outbound directory.

### 4. `voice-input.ts` is shared but still has OpenClaw-branded configuration

If `voice-input.ts` moves to `src/core/relay/`, it will still reference `OPENCLAW_ASR_COMMAND` and return a setup message mentioning that env var. Hermes uses the same helper today, so this is already shared behavior, but it is a naming leak in a core module.

Recommended compatibility-safe fix:

```text
Use CLAWCONNECT_ASR_COMMAND first.
Fall back to OPENCLAW_ASR_COMMAND for backward compatibility.
Update the setup message to mention CLAWCONNECT_ASR_COMMAND, with OPENCLAW_ASR_COMMAND as legacy fallback.
```

This avoids putting OpenClaw-branded config in a shared core relay helper while preserving existing installs.

### 5. Moving `sendFileCommand()` to core must not preserve the `~/.openclaw` default

The earlier plan moves `send-file.ts` into `src/core/relay/file-upload.ts`. That is right for artifact upload reuse, but the current implementation infers the latest session from `~/.openclaw` when no session is passed.

If moved as-is, `core/relay/file-upload.ts` would contain an OpenClaw-specific default session store path.

Recommended split:

```text
src/core/relay/file-upload.ts
  - upload implementation
  - requires explicit sessionKey or injected resolveSessionKey dependency

src/openclaw/session-store.ts
  - OpenClaw latest-session inference from ~/.openclaw

src/commands/send-file.ts
  - CLI wrapper
  - applies OpenClaw default session inference for the CLI case
```

Hermes artifact upload already passes a session key, so it should not need the OpenClaw session-store fallback.

### Updated final constraints

Before implementation, add these constraints to the plan:

1. Extract `core/relay/slash-command-types.ts` before moving any slash command catalog files.
2. Update `scripts/slash-command-catalog-generator.ts` output path when moving the generated OpenClaw catalog.
3. Decide whether `attachment-staging.ts` moves wholesale to core or splits `extensionForMimeType` into a smaller core MIME utility.
4. Make shared `voice-input.ts` prefer `CLAWCONNECT_ASR_COMMAND` with `OPENCLAW_ASR_COMMAND` fallback.
5. Do not move `sendFileCommand()` into core with a hard-coded `~/.openclaw` session fallback.

---

## 9. Gemini Response to Codex Review of Section 7: Final Architectural Alignment

We completely agree with Codex's feedback on Section 7. These 5 points address crucial edge cases that would otherwise leak OpenClaw-specific constraints into the shared core.

We adopt all 5 recommendations in full:

1. **Slash Command Types**: We will extract `src/core/relay/slash-command-types.ts` containing the shared interfaces and types first, before relocating any OpenClaw catalog files.
2. **Catalog Generator Script**: We will update `scripts/slash-command-catalog-generator.ts` to output to `src/openclaw/relay/slash-command-catalog.generated.ts` and update the respective tests.
3. **MIME Mapping**: To minimize new file creation, we will move the entire `attachment-staging.ts` to `src/core/relay/attachment-staging.ts`. We will document that `buildAttachmentStagingPath` is gateway-neutral as it requires an injected output path.
4. **ASR Env Naming**: We will update `src/core/relay/voice-input.ts` to check `CLAWCONNECT_ASR_COMMAND` first, falling back to `OPENCLAW_ASR_COMMAND` for legacy support.
5. **Decouple default CLI Session Store from File Upload Logic**: The programmatic `src/core/relay/file-upload.ts` will strictly require an explicit `sessionKey`. The logic for inferring the session from `~/.openclaw` will be separated into a local utility and applied solely within the CLI command layer (`src/commands/send-file.ts`).

---

### Final Consolidated File Destination Map (Airtight Version)

Here is the finalized directory mapping representing the complete consensus of Gemini and Codex:

| Original File | Classification | Final Destination | Reason |
| :--- | :--- | :--- | :--- |
| `src/commands/send-file.ts` | CLI Wrapper | `src/commands/send-file.ts` | CLI wrapper; applies OpenClaw session inference default |
| `src/commands/send-file-utils.ts` | Shared Utility | `src/core/relay/file-upload-utils.ts` | Shared utility logic for chunk calculations and MIME detection |
| **(New)** | Shared Service | `src/core/relay/file-upload.ts` | Programmatic file upload client logic; requires explicit `sessionKey` |
| `src/commands/local-runtime.ts` | OpenClaw Core | `src/openclaw/runtime/local-runtime.ts` | Spawns and manages local OpenClaw gateway processes |
| `src/commands/local-handlers.ts` | OpenClaw Core | `src/openclaw/handlers/local-handlers.ts` | Local command routing for OpenClaw |
| `src/commands/backup-manager.ts` | OpenClaw Core | `src/openclaw/backups/backup-manager.ts` | Local OpenClaw backup zip logic |
| `src/commands/provider-*.ts` | OpenClaw Core | `src/openclaw/config/` and `/handlers/` | OpenClaw provider configuration and registries |
| `src/relay/relay-manager.ts` | OpenClaw Core | `src/openclaw/relay-manager.ts` | WebSocket adapter for OpenClaw |
| `src/relay/gateway-client.ts` | OpenClaw Core | `src/openclaw/gateway-client.ts` | OpenClaw local gateway RPC WebSocket |
| `src/relay/session-context.ts` | OpenClaw Core | `src/openclaw/relay/session-context.ts` | OpenClaw path and context config mapping |
| `src/relay/chat-history.ts` | OpenClaw Core | `src/openclaw/relay/chat-history.ts` | OpenClaw-specific history sync fallback |
| `src/relay/chat-send-attachments.ts` | OpenClaw Core | `src/openclaw/relay/chat-send-attachments.ts` | Prepares OpenClaw custom attachment structure |
| `src/relay/openclaw-voice-input.ts` | OpenClaw Core | `src/openclaw/relay/openclaw-voice-input.ts` | Parses OpenClaw custom voice input ASR events |
| `src/relay/slash-command-catalog.ts` | OpenClaw Core | `src/openclaw/relay/slash-command-catalog.ts` | Exposes catalog; imports types from core |
| `src/relay/slash-command-catalog.generated.ts` | OpenClaw Core | `src/openclaw/relay/slash-command-catalog.generated.ts` | OpenClaw generated catalog output |
| `src/relay/office-payload.ts` | Shared Core | `src/core/relay/office-payload.ts` | Generic payload mapping for IDE status indicator |
| `src/relay/mobile-chat-run-bridge.ts` | Shared Core | `src/core/relay/mobile-chat-run-bridge.ts` | Generic mobile payload converters |
| `src/relay/voice-input.ts` | Shared Core | `src/core/relay/voice-input.ts` | Shared ASR validation; supports `CLAWCONNECT_ASR_COMMAND` |
| `src/relay/reconnect.ts` | Shared Core | `src/core/relay/reconnect.ts` | Shared reconnect helper for the runner |
| `src/relay/attachment-staging.ts` | Shared Core | `src/core/relay/attachment-staging.ts` | Shared MIME mapping |
| `src/relay/chat-payload.ts` | Shared Core | `src/core/relay/chat-payload.ts` | Shared chat payload extraction |

This represents a clean, robust, and highly maintainable refactoring plan.

---

## 10. Codex Review of Gemini Section 9

Gemini's Section 9 is broadly reasonable and can be used as the implementation baseline. The remaining changes are implementation constraints rather than major architecture disagreements.

### 1. `core/relay/file-upload.ts` must be a pure programmatic service

Gemini correctly says the core file upload service should require an explicit `sessionKey`, but that is not enough by itself.

The current `send-file.ts` also does all of the following:

- reads local config via `readConfig()`
- writes progress and summary output to `stdout` / `stderr`
- supports CLI formatting through `json`
- resolves default sessions from `~/.openclaw`

None of those should move into `src/core/relay/file-upload.ts`.

Recommended API boundary:

```text
src/core/relay/file-upload.ts
  - uploadFileToRelay(request, deps?)
  - request includes relayServerUrl, relaySecret, gatewayId, sessionKey, filePath
  - deps may include fetchImpl and optional progress callback
  - no readConfig()
  - no stdout/stderr writes
  - no CLI json option
  - no ~/.openclaw fallback

src/commands/send-file.ts
  - reads config
  - resolves CLI session default
  - prints progress / JSON output
  - calls uploadFileToRelay()
```

This prevents a "core" module from remaining coupled to CLI concerns.

### 2. `send-file` session default must be gateway-aware

Gemini says the CLI wrapper should apply the OpenClaw session inference default. That is correct only for OpenClaw profiles.

For Hermes profiles, falling back to `~/.openclaw` would be wrong. The CLI wrapper should branch on `config.gatewayType`:

```text
OpenClaw:
  explicit --session, else infer latest from ~/.openclaw, else "main"

Hermes:
  explicit --session, else "main" or a Hermes session-store based default
```

The existing Hermes session store is under `src/hermes/hermes-session-store.ts`, so if Hermes needs "latest session" behavior, implement that there rather than reusing OpenClaw session inference.

### 3. Update the slash command generator robustly

Gemini already notes that `scripts/slash-command-catalog-generator.ts` must output to `src/openclaw/relay/slash-command-catalog.generated.ts`.

Add one more implementation detail: the generator should ensure the output directory exists before writing:

```ts
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, rendered, "utf8");
```

This keeps `npm run sync:slash-commands` robust after directory moves or clean checkouts.

### 4. Move tests with their modules, not as a follow-up

The Section 9 file map lists production files only. The implementation plan should explicitly move matching tests at the same time:

```text
src/relay/attachment-staging.test.ts      -> src/core/relay/attachment-staging.test.ts
src/relay/relay-helpers.test.ts           -> src/core/relay/chat-payload.test.ts or equivalent
src/relay/office-payload.test.ts          -> src/core/relay/office-payload.test.ts
src/relay/mobile-chat-run-bridge.test.ts  -> src/core/relay/mobile-chat-run-bridge.test.ts
src/relay/voice-input.test.ts             -> src/core/relay/voice-input.test.ts
src/relay/gateway-client.test.ts          -> src/openclaw/gateway-client.test.ts
src/relay/slash-command-catalog.test.ts   -> src/openclaw/relay/slash-command-catalog.test.ts
```

Then update `package.json` test globs in the same change. Otherwise the refactor can look green while moved tests are skipped.

### 5. Keep generated catalog typing as `as const`

The current generated `slash-command-catalog.generated.ts` ends with `] as const;`, which keeps literal `source: "OpenClaw"` typing intact. Preserve that when moving the file. Without it, the generated `source` values can widen to `string` and become incompatible with `RelaySlashCommandDescriptor`.

### Final adjustment

Use Gemini Section 9 as the base plan, with these added constraints:

1. Core file upload service must not read config, write CLI logs, format CLI JSON, or infer OpenClaw sessions.
2. CLI `send-file` default session behavior must branch by gateway type.
3. Slash command generator must create the new output directory before writing.
4. Tests must move with modules and `package.json` test globs must be updated in the same PR.
5. Preserve `as const` in the generated OpenClaw slash command catalog.

---

## 11. Gemini Response to Codex Review of Section 9: Complete and Finalized Refactoring Plan

We fully accept Codex's Section 10 feedback. These 5 points establish precise programmatic boundaries and ensure there are no side-effects or naming/context leaks during refactoring.

We incorporate these final constraints into our implementation blueprint:

1. **Pure Upload API**: `src/core/relay/file-upload.ts` will expose a clean `uploadFileToRelay` function that receives all configurations (URL, secret, gateway, session, filePath) explicitly and accepts optional dependency injections (`fetchImpl`, progress hook). It will not reference `readConfig`, write to `stdout`/`stderr`, or handle CLI json flags.
2. **Gateway-Aware CLI Defaults**: The CLI wrapper `src/commands/send-file.ts` will parse the active configuration and branch defaults based on `config.gatewayType` (applying `~/.openclaw` latest-session inference exclusively for OpenClaw profiles, and defaulting to `"main"` or Hermes session store for Hermes profiles).
3. **Directory Creation in Generator**: The script `scripts/slash-command-catalog-generator.ts` will use `mkdirSync(dirname(outputPath), { recursive: true })` to safeguard writes on clean checkouts.
4. **Synchronous Test Migration**: Every test file will be relocated in the same commit as its respective source file (matching the mapping below) to preserve CI pipeline coverage.
5. **Literal Types**: We will retain `as const` typing in the generated catalog to ensure literal types are preserved.

---

### Final Consolidated File Destination Map (Production & Tests)

| File / Test Path | Category | Final Destination |
| :--- | :--- | :--- |
| `src/commands/send-file.ts` | CLI Command Wrapper | `src/commands/send-file.ts` |
| `src/commands/send-file-utils.ts` | Shared Utility | `src/core/relay/file-upload-utils.ts` |
| **(New)** | Shared Programmatic Service | `src/core/relay/file-upload.ts` |
| `src/commands/local-runtime.ts` | OpenClaw Core | `src/openclaw/runtime/local-runtime.ts` |
| `src/commands/local-runtime.test.ts` | OpenClaw Test | `src/openclaw/runtime/local-runtime.test.ts` |
| `src/commands/local-handlers.ts` | OpenClaw Core | `src/openclaw/handlers/local-handlers.ts` |
| `src/commands/local-handlers.doctor-fix.test.ts` | OpenClaw Test | `src/openclaw/handlers/local-handlers.doctor-fix.test.ts` |
| `src/commands/local-handlers.logs.test.ts` | OpenClaw Test | `src/openclaw/handlers/local-handlers.logs.test.ts` |
| `src/commands/backup-manager.ts` | OpenClaw Core | `src/openclaw/backups/backup-manager.ts` |
| `src/commands/provider-config.ts` | OpenClaw Core | `src/openclaw/config/provider-config.ts` |
| `src/commands/provider-handlers.ts` | OpenClaw Core | `src/openclaw/handlers/provider-handlers.ts` |
| `src/commands/provider-registry.ts` | OpenClaw Core | `src/openclaw/config/provider-registry.ts` |
| `src/relay/relay-manager.ts` | OpenClaw Core | `src/openclaw/relay-manager.ts` |
| `src/relay/gateway-client.ts` | OpenClaw Core | `src/openclaw/gateway-client.ts` |
| `src/relay/gateway-client.test.ts` | OpenClaw Test | `src/openclaw/gateway-client.test.ts` |
| `src/relay/session-context.ts` | OpenClaw Core | `src/openclaw/relay/session-context.ts` |
| `src/relay/session-context-zero.test.ts` | OpenClaw Test | `src/openclaw/relay/session-context-zero.test.ts` |
| `src/relay/chat-history.ts` | OpenClaw Core | `src/openclaw/relay/chat-history.ts` |
| `src/relay/chat-send-attachments.ts` | OpenClaw Core | `src/openclaw/relay/chat-send-attachments.ts` |
| `src/relay/chat-send-attachments.test.ts` | OpenClaw Test | `src/openclaw/relay/chat-send-attachments.test.ts` |
| `src/relay/openclaw-voice-input.ts` | OpenClaw Core | `src/openclaw/relay/openclaw-voice-input.ts` |
| `src/relay/slash-command-catalog.ts` | OpenClaw Core | `src/openclaw/relay/slash-command-catalog.ts` |
| `src/relay/slash-command-catalog.generated.ts` | OpenClaw Core | `src/openclaw/relay/slash-command-catalog.generated.ts` |
| `src/relay/slash-command-catalog.test.ts` | OpenClaw Test | `src/openclaw/relay/slash-command-catalog.test.ts` |
| `src/relay/attachment-staging.ts` | Shared Utility | `src/core/relay/attachment-staging.ts` |
| `src/relay/attachment-staging.test.ts` | Shared Test | `src/core/relay/attachment-staging.test.ts` |
| `src/relay/chat-payload.ts` | Shared Utility | `src/core/relay/chat-payload.ts` |
| `src/relay/relay-helpers.test.ts` | Shared Test | `src/core/relay/chat-payload.test.ts` |
| `src/relay/office-payload.ts` | Shared Core | `src/core/relay/office-payload.ts` |
| `src/relay/office-payload.test.ts` | Shared Test | `src/core/relay/office-payload.test.ts` |
| `src/relay/mobile-chat-run-bridge.ts` | Shared Core | `src/core/relay/mobile-chat-run-bridge.ts` |
| `src/relay/mobile-chat-run-bridge.test.ts` | Shared Test | `src/core/relay/mobile-chat-run-bridge.test.ts` |
| `src/relay/voice-input.ts` | Shared Core | `src/core/relay/voice-input.ts` |
| `src/relay/voice-input.test.ts` | Shared Test | `src/core/relay/voice-input.test.ts` |
| `src/relay/reconnect.ts` | Shared Core | `src/core/relay/reconnect.ts` |

This plan is finalized and ready for execution.

---

## 12. Codex Review of Gemini Section 11

Gemini Section 11 is close to executable, but it is not fully complete yet. The remaining issues are mostly omissions from the final destination map.

### 1. `src/core/command-types.ts` is missing from the final map

Earlier sections agreed that shared command protocol types must be extracted before moving OpenClaw files. Section 11 does not include that file in the production map.

This must be an explicit first migration step:

```text
src/core/command-types.ts
  - LocalResult
  - LocalCommandEventPublisher
  - LocalCommandContext
```

Then update:

- OpenClaw runtime/handlers imports
- Hermes runtime command router/chat/cron/skills/session/model imports
- Provider handlers imports

Without this step, Hermes will still depend on the moved OpenClaw `local-runtime.ts` just for shared types.

### 2. Hermes `models/` -> `runtime/` disappeared from the final map

The original consensus included renaming `src/hermes/models/` to `src/hermes/runtime/`, but Section 11's final table does not list those files or tests.

Add this migration explicitly:

```text
src/hermes/models/*.ts              -> src/hermes/runtime/*.ts
src/hermes/hermes-runtime.ts        -> update all ./models/* re-exports to ./runtime/*
src/hermes/hermes-relay-manager.ts  -> update runHermesPython import
src/hermes/hermes-runtime.test.ts   -> update ./models/* imports
src/hermes/hermes-runtime-lifecycle.test.ts -> update ./models/* import
```

This was one of the original architecture smells, so it should not be dropped from the final execution plan.

### 3. Several command tests are missing from the migration map

Section 11 moves some OpenClaw command tests, but omits:

```text
src/commands/remote-restart.test.ts
src/commands/voice-reply-removal.test.ts
```

Both import `./local-handlers.js` dynamically and exercise OpenClaw local command behavior. They should move with `local-handlers.ts`:

```text
src/commands/remote-restart.test.ts      -> src/openclaw/handlers/remote-restart.test.ts
src/commands/voice-reply-removal.test.ts -> src/openclaw/handlers/voice-reply-removal.test.ts
```

### 4. `send-file.test.ts` should be split or explicitly classified

Section 11 leaves `src/commands/send-file.ts` in place but does not say what happens to `src/commands/send-file.test.ts`.

The current test covers two different layers:

- shared utilities and upload behavior
- CLI-style wrapper behavior, config loading, stdout/stderr, JSON output, and session defaults

After extracting `src/core/relay/file-upload.ts`, split the test coverage:

```text
src/commands/send-file.test.ts
  - CLI wrapper behavior
  - config loading
  - gateway-aware default session behavior
  - stdout/stderr and JSON output

src/core/relay/file-upload.test.ts
  - upload init/chunk/complete flow
  - sha256 and image metadata
  - retry/error behavior

src/core/relay/file-upload-utils.test.ts
  - toRelayHttpBase
  - inferMimeType
  - calculateChunkCount
  - normalizeSessionKey, if it remains there
```

Otherwise the new core service could be under-tested or the command test could keep depending on internals that moved out.

### 5. Non-moved files still need import updates listed

The map focuses on moved files, but several files stay in place and still need import rewrites:

```text
src/index.ts
  - send-file wrapper/service import, if the exported command surface changes

src/commands/pair.ts
  - toRelayHttpBase import from core/relay/file-upload-utils

src/commands/run.ts
  - withReconnect import from core/relay/reconnect

src/runtime-adapters.ts
  - runRelayManager import from openclaw/relay-manager

src/hermes/hermes-relay-manager.ts
  - office/mobile/voice/slash/file-upload imports from core/relay

src/hermes/hermes-voice-input.ts
  - prepareVoiceSendParams import from core/relay/voice-input
```

These should be part of the checklist so the refactor does not leave compile errors hidden until the end.

### 6. Final status

Section 11 is directionally sound, but replace "finalized and ready for execution" with:

```text
Ready after adding:
1. core/command-types.ts to the migration map
2. Hermes models -> runtime file/test mapping
3. missing OpenClaw handler tests
4. send-file test split
5. import-update checklist for non-moved files
```

After those additions, the plan is coherent enough to implement.

---

## 13. Gemini Response to Codex Review of Section 11: Final Airtight Refactoring Blueprint

We fully endorse Codex's Section 12 feedback. These additions complete the refactoring plan by accounting for every single file, test suite, and import adjustment needed to achieve zero compile-time warnings and zero architectural leaks.

We integrate these final parameters:

1. **Explicit Shared Types File**: Added `src/core/command-types.ts` to the map.
2. **Hermes Runtime Rename**: Added `src/hermes/runtime/` production and test files to the map.
3. **Missing Handler Tests**: Added `remote-restart.test.ts` and `voice-reply-removal.test.ts` to the map under `src/openclaw/handlers/`.
4. **Test Splitting**: We will split `send-file.test.ts` into three focused test files: CLI command wrapper test, core file upload test, and utility helper test.
5. **Non-Moved Import Checklist**: Added a clear import-rewriting checklist for static files.

---

### Final Consolidated File Destination Map (Production & Tests)

| File / Test Path | Category | Final Destination | Note |
| :--- | :--- | :--- | :--- |
| **(New)** | Shared types | `src/core/command-types.ts` | Extracted `LocalResult`, `LocalCommandContext`, `LocalCommandEventPublisher` |
| `src/commands/send-file.ts` | CLI Command Wrapper | `src/commands/send-file.ts` | CLI command wrapper; handles gateway-aware session defaults |
| `src/commands/send-file-utils.ts` | Shared Utility | `src/core/relay/file-upload-utils.ts` | Shared utility logic (chunk calculation, MIME detection) |
| `src/commands/send-file.test.ts` | Test Suite | `src/commands/send-file.test.ts` | **(Split)** Tests CLI wrappers, configs, and gateway session defaults |
| **(New)** | Shared Service | `src/core/relay/file-upload.ts` | Programmatic upload service; pure API, no config/logging/side-effects |
| **(New)** | Shared Test | `src/core/relay/file-upload.test.ts` | **(Split)** Tests upload flow (init/chunk/complete), hashes, and retry loops |
| **(New)** | Shared Test | `src/core/relay/file-upload-utils.test.ts` | **(Split)** Tests core file-upload helpers |
| `src/commands/local-runtime.ts` | OpenClaw Core | `src/openclaw/runtime/local-runtime.ts` | Spawns and manages local OpenClaw gateway processes |
| `src/commands/local-runtime.test.ts` | OpenClaw Test | `src/openclaw/runtime/local-runtime.test.ts` | Tests local subprocess selection |
| `src/commands/local-handlers.ts` | OpenClaw Core | `src/openclaw/handlers/local-handlers.ts` | Local command routing for OpenClaw |
| `src/commands/local-handlers.doctor-fix.test.ts` | OpenClaw Test | `src/openclaw/handlers/local-handlers.doctor-fix.test.ts` | Tests OpenClaw Doctor fix stream execution |
| `src/commands/local-handlers.logs.test.ts` | OpenClaw Test | `src/openclaw/handlers/local-handlers.logs.test.ts` | Tests OpenClaw logs reading and parsing |
| `src/commands/backup-manager.ts` | OpenClaw Core | `src/openclaw/backups/backup-manager.ts` | Local OpenClaw backup zip logic |
| `src/commands/provider-config.ts` | OpenClaw Core | `src/openclaw/config/provider-config.ts` | OpenClaw provider configuration |
| `src/commands/provider-handlers.ts` | OpenClaw Core | `src/openclaw/handlers/provider-handlers.ts` | OpenClaw provider command dispatcher |
| `src/commands/provider-registry.ts` | OpenClaw Core | `src/openclaw/config/provider-registry.ts` | OpenClaw provider registry definition |
| `src/relay/relay-manager.ts` | OpenClaw Core | `src/openclaw/relay-manager.ts` | WebSocket adapter for OpenClaw |
| `src/relay/gateway-client.ts` | OpenClaw Core | `src/openclaw/gateway-client.ts` | OpenClaw local gateway RPC WebSocket |
| `src/relay/gateway-client.test.ts` | OpenClaw Test | `src/openclaw/gateway-client.test.ts` | Tests gateway client connectivity |
| `src/relay/session-context.ts` | OpenClaw Core | `src/openclaw/relay/session-context.ts` | OpenClaw path and context config mapping |
| `src/relay/session-context-zero.test.ts` | OpenClaw Test | `src/openclaw/relay/session-context-zero.test.ts` | Tests OpenClaw zero context updates |
| `src/relay/chat-history.ts` | OpenClaw Core | `src/openclaw/relay/chat-history.ts` | OpenClaw-specific history sync fallback |
| `src/relay/chat-send-attachments.ts` | OpenClaw Core | `src/openclaw/relay/chat-send-attachments.ts` | Prepares OpenClaw custom attachment structure |
| `src/relay/chat-send-attachments.test.ts` | OpenClaw Test | `src/openclaw/relay/chat-send-attachments.test.ts` | Tests custom attachment formats |
| `src/relay/openclaw-voice-input.ts` | OpenClaw Core | `src/openclaw/relay/openclaw-voice-input.ts` | Parses OpenClaw custom voice input ASR events |
| `src/relay/slash-command-catalog.ts` | OpenClaw Core | `src/openclaw/relay/slash-command-catalog.ts` | Exposes catalog; imports types from core |
| `src/relay/slash-command-catalog.generated.ts` | OpenClaw Core | `src/openclaw/relay/slash-command-catalog.generated.ts` | OpenClaw generated catalog output |
| `src/relay/slash-command-catalog.test.ts` | OpenClaw Test | `src/openclaw/relay/slash-command-catalog.test.ts` | Tests OpenClaw command listings |
| `src/commands/remote-restart.test.ts` | OpenClaw Test | `src/openclaw/handlers/remote-restart.test.ts` | Tests OpenClaw gateway restarts |
| `src/commands/voice-reply-removal.test.ts` | OpenClaw Test | `src/openclaw/handlers/voice-reply-removal.test.ts` | Tests OpenClaw voice replies |
| `src/relay/office-payload.ts` | Shared Core | `src/core/relay/office-payload.ts` | Generic payload mapping for IDE status indicator |
| `src/relay/office-payload.test.ts` | Shared Test | `src/core/relay/office-payload.test.ts` | Tests status payload mappings |
| `src/relay/mobile-chat-run-bridge.ts` | Shared Core | `src/core/relay/mobile-chat-run-bridge.ts` | Generic mobile payload converters |
| `src/relay/mobile-chat-run-bridge.test.ts` | Shared Test | `src/core/relay/mobile-chat-run-bridge.test.ts` | Tests mobile response transformations |
| `src/relay/voice-input.ts` | Shared Core | `src/core/relay/voice-input.ts` | Shared ASR validation; supports `CLAWCONNECT_ASR_COMMAND` |
| `src/relay/voice-input.test.ts` | Shared Test | `src/core/relay/voice-input.test.ts` | Tests voice error classifications |
| `src/relay/reconnect.ts` | Shared Core | `src/core/relay/reconnect.ts` | Shared reconnect helper for the runner |
| `src/relay/attachment-staging.ts` | Shared Core | `src/core/relay/attachment-staging.ts` | Shared MIME mapping |
| `src/relay/attachment-staging.test.ts` | Shared Test | `src/core/relay/attachment-staging.test.ts` | Tests MIME-to-extension configurations |
| `src/relay/chat-payload.ts` | Shared Core | `src/core/relay/chat-payload.ts` | Shared chat payload extraction |
| `src/relay/relay-helpers.test.ts` | Shared Test | `src/core/relay/chat-payload.test.ts` | Tests chat payload normalization |
| `src/hermes/models/*.ts` | Hermes Runtime | `src/hermes/runtime/*.ts` | All sub-modules running Hermes Python scripts, cron, and skills |
| `src/hermes/hermes-runtime.ts` | Hermes Bootloader | `src/hermes/hermes-runtime.ts` | Hermes runtime entrypoint; updates re-exports to `runtime/*` |
| `src/hermes/hermes-relay-manager.ts` | Hermes WebSocket | `src/hermes/hermes-relay-manager.ts` | WebSocket adapter for Hermes |
| `src/hermes/hermes-runtime.test.ts` | Hermes Test | `src/hermes/hermes-runtime.test.ts` | Updates tests to import from `src/hermes/runtime/` |
| `src/hermes/hermes-runtime-lifecycle.test.ts` | Hermes Test | `src/hermes/hermes-runtime-lifecycle.test.ts` | Updates lifecycle tests to import from `src/hermes/runtime/` |

---

### Non-Moved Files Import Checklist

When executing this refactor, ensure these files are updated to maintain clean compilation:

* [ ] **`src/index.ts`**: Update imports of `sendFileCommand` if interface changes, and adjust `pairCommand`/`runCommand` if needed.
* [ ] **`src/commands/pair.ts`**: Update `toRelayHttpBase` import path to `../core/relay/file-upload-utils.js`.
* [ ] **`src/commands/run.ts`**: Update `withReconnect` import path to `../core/relay/reconnect.js`.
* [ ] **`src/runtime-adapters.ts`**: Update `runRelayManager` import path to `./openclaw/relay-manager.js`.
* [ ] **`src/hermes/hermes-relay-manager.ts`**:
  * [ ] Update `sendFileCommand` import to `../core/relay/file-upload.js`.
  * [ ] Update `buildMobileAssistant*` and `resolveMobileChatRun` imports to `../core/relay/mobile-chat-run-bridge.js`.
  * [ ] Update `buildOfficeEventPayload` import to `../core/relay/office-payload.js`.
  * [ ] Update `voiceInputSetupMessage` import to `../core/relay/voice-input.js`.
* [ ] **`src/hermes/hermes-voice-input.ts`**: Update `prepareVoiceSendParams` import to `../core/relay/voice-input.js`.

---

### Final Refactoring Order of Actions

We will execute the cleanup using this rigorous sequence to prevent regressions:

1. **Step 0**: Create `src/core/command-types.ts`, relocate `LocalResult`, `LocalCommandContext`, and `LocalCommandEventPublisher`, and update all imports across both Hermes and OpenClaw modules.
2. **Step 1**: Create `src/core/relay/slash-command-types.ts`, relocate `RelaySlashCommandSource` and `RelaySlashCommandDescriptor`, and update imports in Hermes and OpenClaw catalogs.
3. **Step 2**: Rename `src/hermes/models/` to `src/hermes/runtime/` and update all relative imports and re-exports.
4. **Step 3**: Relocate all shared utilities (`attachment-staging.ts`, `chat-payload.ts`, `office-payload.ts`, `voice-input.ts`, `mobile-chat-run-bridge.ts`, `reconnect.ts`) and their test suites into `src/core/relay/`.
5. **Step 4**: Split `src/commands/send-file.ts` and `src/commands/send-file.test.ts` into CLI handlers and a pure programmatic service (`src/core/relay/file-upload.ts` & `file-upload.test.ts`).
6. **Step 5**: Relocate all remaining OpenClaw-specific files (`relay-manager.ts`, `gateway-client.ts`, `session-context.ts`, `chat-history.ts`, `chat-send-attachments.ts`, `openclaw-voice-input.ts`, `slash-command-catalog*`) and tests into `src/openclaw/`.
7. **Step 6**: Update `scripts/slash-command-catalog-generator.ts` with output directory creation and new generated pathing.
8. **Step 7**: Extract the narrow transport helper `relay-server-connection.ts` under `src/core/relay/` and refit both managers.
9. **Step 8**: Update `package.json` globs, run `npm run build` and `npm test` to verify zero compile or runtime failures.

This plan is finalized and ready for implementation.

---

## 14. Codex Review of Gemini Section 13

Section 13 is mostly coherent and much closer to an executable plan. There are still a few remaining gaps that should be fixed before implementation.

### 1. Add the OpenClaw session-store utility to the file map

The plan says `send-file.ts` will handle gateway-aware defaults and infer latest OpenClaw sessions only for OpenClaw profiles, but the file map does not include the new OpenClaw session utility.

Add this explicitly:

```text
(New) src/openclaw/session-store.ts
  - inferLatestOpenClawSessionKey()
  - owns ~/.openclaw session-store traversal
```

Then `src/commands/send-file.ts` can import it only when applying OpenClaw CLI defaults. This prevents `core/relay/file-upload.ts` from gaining any `~/.openclaw` knowledge.

### 2. Hermes artifact upload needs an adapter, not just an import rewrite

The import checklist says:

```text
src/hermes/hermes-relay-manager.ts:
  Update sendFileCommand import to ../core/relay/file-upload.js
```

That is not enough. The current Hermes artifact path calls `sendFileCommand(buildHermesArtifactSendOptions(...))`, and the old `sendFileCommand()` reads config internally. The new `uploadFileToRelay()` should not read config, so Hermes must pass relay config explicitly from `HermesRelayManagerOptions`.

Recommended adjustment:

```text
buildHermesArtifactUploadRequest(params, opts)
  - relayServerUrl: opts.relayServerUrl
  - relaySecret: opts.relaySecret
  - gatewayId: opts.gatewayId
  - sessionKey: chat.sessionKey
  - filePath: artifactPath
  - sourceRunId: runId
```

Then Hermes should call:

```text
await uploadFileToRelay(request, { fetchImpl, onProgress? })
```

Do not keep a `SendFileCommandOptions`-shaped adapter in Hermes if the core API no longer accepts command-style options like `json`, `gateway`, or `session`.

### 3. Add `relay-server-connection.ts` to the map and tests

Step 7 mentions extracting the narrow transport helper, but Section 13's file map does not list the new file.

Add:

```text
(New) src/core/relay/relay-server-connection.ts
(New) src/core/relay/relay-server-connection.test.ts
```

Test coverage should verify only behavior-preserving transport mechanics:

- relay URL construction
- JSON frame parsing
- server heartbeat echo
- abort signal closes the socket
- close code `4000` and aborted signal return no-retry

It should not introduce a new reconnect loop or client heartbeat timer.

### 4. Move the generated catalog path before moving/running the generator

The current order moves OpenClaw slash-command files in Step 5, then updates the generator path in Step 6. That is workable if no one runs the generator mid-refactor, but it is safer to update the generator at the same time as Step 1 or Step 5.

Recommended constraint:

```text
When moving slash-command-catalog.generated.ts:
  - update scripts/slash-command-catalog-generator.ts in the same commit
  - ensure mkdirSync(dirname(outputPath), { recursive: true })
  - run npm run sync:slash-commands once
  - confirm no src/relay/slash-command-catalog.generated.ts is recreated
```

### 5. Rename or replace `buildHermesArtifactSendOptions`

After replacing `sendFileCommand()` with `uploadFileToRelay()`, the helper name `buildHermesArtifactSendOptions()` becomes misleading because it currently returns CLI command options:

```text
{
  filePath,
  gateway,
  session,
  json,
  sourceRunId
}
```

Rename it to match the new API:

```text
buildHermesArtifactUploadRequest()
```

and update `src/hermes/hermes-relay-manager.test.ts` accordingly. This avoids leaving CLI vocabulary inside Hermes runtime code.

### 6. Final status

Section 13 is directionally right, but before implementation add:

1. `(New) src/openclaw/session-store.ts`
2. `(New) src/core/relay/relay-server-connection.ts` and test
3. Explicit Hermes artifact upload request adapter
4. Generator path update in the same step as generated catalog move
5. Rename `buildHermesArtifactSendOptions()` to a non-CLI upload-request helper

After these are added, the plan is strong enough to execute.

---

## 15. Gemini Response to Codex Review of Section 13: Final Refactoring Specification

We fully accept Codex's Section 14 feedback. These final alignments ensure that the programmatic API interfaces are strictly typed and decoupled from CLI configs, and all newly created helper modules are mapped.

We integrate these final parameters:

1. **Explicit Session Store Module**: Added `src/openclaw/session-store.ts` to the map to encapsulate the `~/.openclaw` directory traversal.
2. **Explicit Connection Helper Modules**: Added `src/core/relay/relay-server-connection.ts` and its test to the map.
3. **Pure Upload Adapter in Hermes**: We will rename `buildHermesArtifactSendOptions` to `buildHermesArtifactUploadRequest`, which maps parameters explicitly to the `uploadFileToRelay` request shape (passing down relay config directly from `HermesRelayManagerOptions`), removing all command-line wrapper option models from the Hermes runtime.
4. **Co-located Generator Path Updates**: We will group the generator script path update and the generated catalog relocation into a single commit.

---

### Final Consolidated File Destination Map (Production & Tests)

| File / Test Path | Category | Final Destination | Note |
| :--- | :--- | :--- | :--- |
| **(New)** | Shared types | `src/core/command-types.ts` | Extracted `LocalResult`, `LocalCommandContext`, `LocalCommandEventPublisher` |
| `src/commands/send-file.ts` | CLI Command Wrapper | `src/commands/send-file.ts` | CLI command wrapper; handles gateway-aware session defaults |
| `src/commands/send-file-utils.ts` | Shared Utility | `src/core/relay/file-upload-utils.ts` | Shared utility logic (chunk calculation, MIME detection) |
| `src/commands/send-file.test.ts` | Test Suite | `src/commands/send-file.test.ts` | **(Split)** Tests CLI wrappers, configs, and gateway session defaults |
| **(New)** | Shared Service | `src/core/relay/file-upload.ts` | Programmatic upload service; pure API, no config/logging/side-effects |
| **(New)** | Shared Test | `src/core/relay/file-upload.test.ts` | **(Split)** Tests upload flow (init/chunk/complete), hashes, and retry loops |
| **(New)** | Shared Test | `src/core/relay/file-upload-utils.test.ts` | **(Split)** Tests core file-upload helpers |
| **(New)** | Shared Transport | `src/core/relay/relay-server-connection.ts` | Exposes narrow WebSocket transport helper (heartbeat, abort) |
| **(New)** | Shared Test | `src/core/relay/relay-server-connection.test.ts` | Tests WebSocket URL, heartbeat responses, and abort triggers |
| **(New)** | OpenClaw Helper | `src/openclaw/session-store.ts` | Local latest-session inference traversing `~/.openclaw` |
| `src/commands/local-runtime.ts` | OpenClaw Core | `src/openclaw/runtime/local-runtime.ts` | Spawns and manages local OpenClaw gateway processes |
| `src/commands/local-runtime.test.ts` | OpenClaw Test | `src/openclaw/runtime/local-runtime.test.ts` | Tests local subprocess selection |
| `src/commands/local-handlers.ts` | OpenClaw Core | `src/openclaw/handlers/local-handlers.ts` | Local command routing for OpenClaw |
| `src/commands/local-handlers.doctor-fix.test.ts` | OpenClaw Test | `src/openclaw/handlers/local-handlers.doctor-fix.test.ts` | Tests OpenClaw Doctor fix stream execution |
| `src/commands/local-handlers.logs.test.ts` | OpenClaw Test | `src/openclaw/handlers/local-handlers.logs.test.ts` | Tests OpenClaw logs reading and parsing |
| `src/commands/backup-manager.ts` | OpenClaw Core | `src/openclaw/backups/backup-manager.ts` | Local OpenClaw backup zip logic |
| `src/commands/provider-config.ts` | OpenClaw Core | `src/openclaw/config/provider-config.ts` | OpenClaw provider configuration |
| `src/commands/provider-handlers.ts` | OpenClaw Core | `src/openclaw/handlers/provider-handlers.ts` | OpenClaw provider command dispatcher |
| `src/commands/provider-registry.ts` | OpenClaw Core | `src/openclaw/config/provider-registry.ts` | OpenClaw provider registry definition |
| `src/relay/relay-manager.ts` | OpenClaw Core | `src/openclaw/relay-manager.ts` | WebSocket adapter for OpenClaw |
| `src/relay/gateway-client.ts` | OpenClaw Core | `src/openclaw/gateway-client.ts` | OpenClaw local gateway RPC WebSocket |
| `src/relay/gateway-client.test.ts` | OpenClaw Test | `src/openclaw/gateway-client.test.ts` | Tests gateway client connectivity |
| `src/relay/session-context.ts` | OpenClaw Core | `src/openclaw/relay/session-context.ts` | OpenClaw path and context config mapping |
| `src/relay/session-context-zero.test.ts` | OpenClaw Test | `src/openclaw/relay/session-context-zero.test.ts` | Tests OpenClaw zero context updates |
| `src/relay/chat-history.ts` | OpenClaw Core | `src/openclaw/relay/chat-history.ts` | OpenClaw-specific history sync fallback |
| `src/relay/chat-send-attachments.ts` | OpenClaw Core | `src/openclaw/relay/chat-send-attachments.ts` | Prepares OpenClaw custom attachment structure |
| `src/relay/chat-send-attachments.test.ts` | OpenClaw Test | `src/openclaw/relay/chat-send-attachments.test.ts` | Tests custom attachment formats |
| `src/relay/openclaw-voice-input.ts` | OpenClaw Core | `src/openclaw/relay/openclaw-voice-input.ts` | Parses OpenClaw custom voice input ASR events |
| `src/relay/slash-command-catalog.ts` | OpenClaw Core | `src/openclaw/relay/slash-command-catalog.ts` | Exposes catalog; imports types from core |
| `src/relay/slash-command-catalog.generated.ts` | OpenClaw Core | `src/openclaw/relay/slash-command-catalog.generated.ts` | OpenClaw generated catalog output |
| `src/relay/slash-command-catalog.test.ts` | OpenClaw Test | `src/openclaw/relay/slash-command-catalog.test.ts` | Tests OpenClaw command listings |
| `src/commands/remote-restart.test.ts` | OpenClaw Test | `src/openclaw/handlers/remote-restart.test.ts` | Tests OpenClaw gateway restarts |
| `src/commands/voice-reply-removal.test.ts` | OpenClaw Test | `src/openclaw/handlers/voice-reply-removal.test.ts` | Tests OpenClaw voice replies |
| `src/relay/office-payload.ts` | Shared Core | `src/core/relay/office-payload.ts` | Generic payload mapping for IDE status indicator |
| `src/relay/office-payload.test.ts` | Shared Test | `src/core/relay/office-payload.test.ts` | Tests status payload mappings |
| `src/relay/mobile-chat-run-bridge.ts` | Shared Core | `src/core/relay/mobile-chat-run-bridge.ts` | Generic mobile payload converters |
| `src/relay/mobile-chat-run-bridge.test.ts` | Shared Test | `src/core/relay/mobile-chat-run-bridge.test.ts` | Tests mobile response transformations |
| `src/relay/voice-input.ts` | Shared Core | `src/core/relay/voice-input.ts` | Shared ASR validation; supports `CLAWCONNECT_ASR_COMMAND` |
| `src/relay/voice-input.test.ts` | Shared Test | `src/core/relay/voice-input.test.ts` | Tests voice error classifications |
| `src/relay/reconnect.ts` | Shared Core | `src/core/relay/reconnect.ts` | Shared reconnect helper for the runner |
| `src/relay/attachment-staging.ts` | Shared Core | `src/core/relay/attachment-staging.ts` | Shared MIME mapping |
| `src/relay/attachment-staging.test.ts` | Shared Test | `src/core/relay/attachment-staging.test.ts` | Tests MIME-to-extension configurations |
| `src/relay/chat-payload.ts` | Shared Core | `src/core/relay/chat-payload.ts` | Shared chat payload extraction |
| `src/relay/relay-helpers.test.ts` | Shared Test | `src/core/relay/chat-payload.test.ts` | Tests chat payload normalization |
| `src/hermes/models/*.ts` | Hermes Runtime | `src/hermes/runtime/*.ts` | All sub-modules running Hermes Python scripts, cron, and skills |
| `src/hermes/hermes-runtime.ts` | Hermes Bootloader | `src/hermes/hermes-runtime.ts` | Hermes runtime entrypoint; updates re-exports to `runtime/*` |
| `src/hermes/hermes-relay-manager.ts` | Hermes WebSocket | `src/hermes/hermes-relay-manager.ts` | WebSocket adapter for Hermes |
| `src/hermes/hermes-runtime.test.ts` | Hermes Test | `src/hermes/hermes-runtime.test.ts` | Updates tests to import from `src/hermes/runtime/` |
| `src/hermes/hermes-runtime-lifecycle.test.ts` | Hermes Test | `src/hermes/hermes-runtime-lifecycle.test.ts` | Updates lifecycle tests to import from `src/hermes/runtime/` |

---

### Non-Moved Files Import Checklist

When executing this refactor, ensure these files are updated to maintain clean compilation:

* [ ] **`src/index.ts`**: Update imports of `sendFileCommand` if interface changes, and adjust `pairCommand`/`runCommand` if needed.
* [ ] **`src/commands/pair.ts`**: Update `toRelayHttpBase` import path to `../core/relay/file-upload-utils.js`.
* [ ] **`src/commands/run.ts`**: Update `withReconnect` import path to `../core/relay/reconnect.js`.
* [ ] **`src/runtime-adapters.ts`**: Update `runRelayManager` import path to `./openclaw/relay-manager.js`.
* [ ] **`src/hermes/hermes-relay-manager.ts`**:
  * [ ] Update `sendFileCommand` import to `../core/relay/file-upload.js` and rewrite upload call using `uploadFileToRelay` shape with config values parsed from options.
  * [ ] Rename `buildHermesArtifactSendOptions` to `buildHermesArtifactUploadRequest`.
  * [ ] Update `buildMobileAssistant*` and `resolveMobileChatRun` imports to `../core/relay/mobile-chat-run-bridge.js`.
  * [ ] Update `buildOfficeEventPayload` import to `../core/relay/office-payload.js`.
  * [ ] Update `voiceInputSetupMessage` import to `../core/relay/voice-input.js`.
* [ ] **`src/hermes/hermes-voice-input.ts`**: Update `prepareVoiceSendParams` import to `../core/relay/voice-input.js`.

---

### Final Refactoring Order of Actions

We will execute the cleanup using this rigorous sequence to prevent regressions:

1. **Step 0**: Create `src/core/command-types.ts`, relocate `LocalResult`, `LocalCommandContext`, and `LocalCommandEventPublisher`, and update all imports across both Hermes and OpenClaw modules.
2. **Step 1**: Create `src/core/relay/slash-command-types.ts`, relocate `RelaySlashCommandSource` and `RelaySlashCommandDescriptor`, and update imports in Hermes and OpenClaw catalogs.
3. **Step 2**: Rename `src/hermes/models/` to `src/hermes/runtime/` and update all relative imports and re-exports.
4. **Step 3**: Relocate all shared utilities (`attachment-staging.ts`, `chat-payload.ts`, `office-payload.ts`, `voice-input.ts`, `mobile-chat-run-bridge.ts`, `reconnect.ts`) and their test suites into `src/core/relay/`.
5. **Step 4**: Split `src/commands/send-file.ts` and `src/commands/send-file.test.ts` into CLI handlers, a session utility (`src/openclaw/session-store.ts`), and a pure programmatic service (`src/core/relay/file-upload.ts` & `file-upload.test.ts`).
6. **Step 5**: Relocate all remaining OpenClaw-specific files (`relay-manager.ts`, `gateway-client.ts`, `session-context.ts`, `chat-history.ts`, `chat-send-attachments.ts`, `openclaw-voice-input.ts`, `slash-command-catalog.ts`) and tests into `src/openclaw/`.
7. **Step 6**: Update `scripts/slash-command-catalog-generator.ts` with output directory creation and relocate `slash-command-catalog.generated.ts` in the same commit.
8. **Step 7**: Extract the narrow transport helper `relay-server-connection.ts` under `src/core/relay/` and refit both managers.
9. **Step 8**: Update `package.json` globs, run `npm run build` and `npm test` to verify zero compile or runtime failures.

This plan is finalized and ready for implementation.

---

## 16. Codex Review of Gemini Section 15

Section 15 is now very close. The architecture direction is reasonable, but a few concrete omissions remain before calling it final.

### 1. `src/core/relay/slash-command-types.ts` is still missing from the file map

The action order correctly says Step 1 creates `src/core/relay/slash-command-types.ts`, but the final destination table does not list it.

Add this row:

```text
(New) Shared type | src/core/relay/slash-command-types.ts
  - RelaySlashCommandSource
  - RelaySlashCommandDescriptor
```

Without this explicit row, implementers may move `slash-command-catalog.ts` but forget to split the shared type used by Hermes.

### 2. Hermes tests need explicit update rows

The map includes `hermes-runtime.test.ts` and `hermes-runtime-lifecycle.test.ts`, but omits two existing tests that will be affected:

```text
src/hermes/hermes-relay-manager.test.ts
src/hermes/hermes-voice-input.test.ts
```

Add them to the table or checklist:

```text
src/hermes/hermes-relay-manager.test.ts
  - update buildHermesArtifactSendOptions -> buildHermesArtifactUploadRequest
  - expected output should match uploadFileToRelay request shape
  - assert no CLI-only fields remain: json, gateway, session

src/hermes/hermes-voice-input.test.ts
  - update env setup to cover CLAWCONNECT_ASR_COMMAND
  - keep a fallback test for OPENCLAW_ASR_COMMAND compatibility
```

### 3. Core `voice-input.test.ts` must validate the new env precedence

Section 15 says `voice-input.ts` supports `CLAWCONNECT_ASR_COMMAND`, but the test migration row only says "Tests voice error classifications".

The moved `src/core/relay/voice-input.test.ts` should explicitly cover:

```text
1. CLAWCONNECT_ASR_COMMAND is used when present
2. OPENCLAW_ASR_COMMAND still works as legacy fallback
3. CLAWCONNECT_ASR_COMMAND wins when both are set
4. setup message mentions CLAWCONNECT_ASR_COMMAND and legacy OPENCLAW_ASR_COMMAND fallback
```

Otherwise the compatibility behavior can regress silently.

### 4. Refine the Hermes import checklist wording

The checklist still says:

```text
Update sendFileCommand import to ../core/relay/file-upload.js
```

That wording is misleading after the API split. It should say:

```text
Replace sendFileCommand with uploadFileToRelay from ../core/relay/file-upload.js.
Remove SendFileCommandOptions from Hermes runtime code.
Rename buildHermesArtifactSendOptions to buildHermesArtifactUploadRequest.
```

This prevents carrying command-wrapper vocabulary into Hermes.

### 5. Add the generator script to the non-moved checklist

Section 15 mentions generator relocation in the action order, but not in the checklist. Add:

```text
scripts/slash-command-catalog-generator.ts
  - defaultOutputPath -> src/openclaw/relay/slash-command-catalog.generated.ts
  - mkdirSync(dirname(outputPath), { recursive: true }) before writeFileSync

scripts/sync-slash-command-catalog.ts
  - no path change required unless generator API changes
```

### Final status

Section 15 is reasonable as the base plan. Before implementation, add:

1. `src/core/relay/slash-command-types.ts` to the file map
2. `src/hermes/hermes-relay-manager.test.ts` and `src/hermes/hermes-voice-input.test.ts` update rows
3. explicit ASR env precedence tests
4. clearer Hermes `uploadFileToRelay` wording
5. generator script checklist rows

After these additions, the plan is sufficiently complete to execute.

---

## 17. Concrete Solutions for Section 16 Remaining Issues

This section turns the remaining issues from Section 16 into explicit implementation actions.

### 1. Add `src/core/relay/slash-command-types.ts`

Create a dedicated shared type module:

```ts
// src/core/relay/slash-command-types.ts
export type RelaySlashCommandSource = "OpenClaw" | "Hermes" | "ClawConnect";

export interface RelaySlashCommandDescriptor {
  source: RelaySlashCommandSource;
  command: string;
  title: string;
  detail: string;
}
```

Then update imports:

```text
src/openclaw/relay/slash-command-catalog.ts
  - import type { RelaySlashCommandDescriptor } from "../../core/relay/slash-command-types.js"

src/hermes/hermes-relay-manager.ts
  - import type { RelaySlashCommandDescriptor } from "../core/relay/slash-command-types.js"
```

The OpenClaw catalog file should only export `OPENCLAW_SLASH_COMMAND_CATALOG`; shared descriptor types must live in core.

### 2. Add explicit Hermes test migrations

Add these rows to the migration map:

```text
src/hermes/hermes-relay-manager.test.ts
  -> src/hermes/hermes-relay-manager.test.ts
  - update artifact upload test for buildHermesArtifactUploadRequest()

src/hermes/hermes-voice-input.test.ts
  -> src/hermes/hermes-voice-input.test.ts
  - update env tests for CLAWCONNECT_ASR_COMMAND and legacy OPENCLAW_ASR_COMMAND
```

Update `hermes-relay-manager.test.ts` expectation from CLI command options:

```ts
{
  filePath: "/tmp/reply.jpg",
  gateway: "gw-1",
  session: "main",
  json: true,
  sourceRunId: "run-voice-1",
}
```

to upload request shape:

```ts
{
  relayServerUrl: "https://relay.example",
  relaySecret: "secret-1",
  gatewayId: "gw-1",
  sessionKey: "main",
  filePath: "/tmp/reply.jpg",
  sourceRunId: "run-voice-1",
}
```

Also assert the request does **not** contain command-wrapper fields:

```ts
assert.equal("json" in request, false);
assert.equal("gateway" in request, false);
assert.equal("session" in request, false);
```

### 3. Add ASR environment precedence tests

Update the moved `src/core/relay/voice-input.test.ts` with explicit env behavior:

```text
Test 1: uses CLAWCONNECT_ASR_COMMAND when set
Test 2: falls back to OPENCLAW_ASR_COMMAND when CLAWCONNECT_ASR_COMMAND is absent
Test 3: CLAWCONNECT_ASR_COMMAND wins when both are set
Test 4: voiceInputSetupMessage mentions CLAWCONNECT_ASR_COMMAND and legacy OPENCLAW_ASR_COMMAND
```

Implementation rule for `voice-input.ts`:

```ts
const command =
  process.env.CLAWCONNECT_ASR_COMMAND?.trim()
  || process.env.OPENCLAW_ASR_COMMAND?.trim();
```

The setup message should be updated to say:

```text
安装完成后会写入 CLAWCONNECT_ASR_COMMAND；旧版 OPENCLAW_ASR_COMMAND 仍兼容。
```

`src/hermes/hermes-voice-input.test.ts` should also switch its primary setup to `CLAWCONNECT_ASR_COMMAND`, while one core test preserves legacy fallback coverage.

### 4. Replace Hermes `sendFileCommand` vocabulary with `uploadFileToRelay`

Update the checklist item from:

```text
Update sendFileCommand import to ../core/relay/file-upload.js
```

to:

```text
Replace sendFileCommand with uploadFileToRelay from ../core/relay/file-upload.js.
Remove SendFileCommandOptions from Hermes runtime code.
Rename buildHermesArtifactSendOptions to buildHermesArtifactUploadRequest.
```

Suggested Hermes helper:

```ts
export function buildHermesArtifactUploadRequest(params: {
  artifactPath: string;
  relayServerUrl: string;
  relaySecret: string;
  gatewayId: string;
  sessionKey: string;
  runId: string;
}): FileUploadRequest {
  return {
    relayServerUrl: params.relayServerUrl,
    relaySecret: params.relaySecret,
    gatewayId: params.gatewayId,
    sessionKey: params.sessionKey,
    filePath: params.artifactPath,
    sourceRunId: params.runId,
  };
}
```

Hermes call site should pass config from `HermesRelayManagerOptions`:

```ts
await uploadFileToRelay(
  buildHermesArtifactUploadRequest({
    artifactPath,
    relayServerUrl: opts.relayServerUrl,
    relaySecret: opts.relaySecret,
    gatewayId: opts.gatewayId,
    sessionKey: chat.sessionKey,
    runId,
  }),
);
```

Do not keep `SendFileCommandOptions`, `json`, `gateway`, or `session` in Hermes runtime code.

### 5. Add generator script checklist and implementation change

Add these checklist rows:

```text
scripts/slash-command-catalog-generator.ts
  - defaultOutputPath -> src/openclaw/relay/slash-command-catalog.generated.ts
  - mkdirSync(dirname(outputPath), { recursive: true }) before writeFileSync

scripts/sync-slash-command-catalog.ts
  - no path change required unless generator API changes
```

Implementation patch shape:

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const defaultOutputPath = resolve(repoRoot, "src/openclaw/relay/slash-command-catalog.generated.ts");

// inside writeOpenClawSlashCommandCatalog()
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, rendered, "utf8");
```

Verification after moving the catalog:

```text
npm run sync:slash-commands
test -f src/openclaw/relay/slash-command-catalog.generated.ts
test ! -f src/relay/slash-command-catalog.generated.ts
```

### Final Implementation Gate

The refactor is ready to execute once the plan includes these five concrete actions:

1. Add `src/core/relay/slash-command-types.ts` to the file map.
2. Add Hermes relay-manager and voice-input test updates to the migration checklist.
3. Add ASR env precedence tests and update the setup message.
4. Replace Hermes artifact upload command-wrapper vocabulary with `uploadFileToRelay` request vocabulary.
5. Update the slash command generator path and ensure output directory creation.

---

## 18. Gemini Response to Codex Review of Section 15: Final Architectural Integration

We completely agree with Codex's feedback in Section 16 and Section 17. All five points are highly accurate and resolve critical implementation gaps.

We have integrated these final updates into the plan:
1. **Slash Command Types**: Added `src/core/relay/slash-command-types.ts` explicitly to the file destination map to prevent imports of shared types from OpenClaw-specific modules.
2. **Hermes Test Updates**: Added `src/hermes/hermes-relay-manager.test.ts` and `src/hermes/hermes-voice-input.test.ts` to the migration checklist.
3. **ASR Env Precedence Verification**: Added explicit test specifications for `CLAWCONNECT_ASR_COMMAND` precedence in `voice-input.test.ts`.
4. **Hermes Upload Vocabulary**: Updated the checklist and Hermes helper interface to use `uploadFileToRelay` instead of `sendFileCommand`, removing command-wrapper details.
5. **Catalog Generator Output Path**: Added checklist items to update `scripts/slash-command-catalog-generator.ts` output paths and guarantee output directory creation.
6. **OpenClaw Session Store**: Added `src/openclaw/session-store.ts` to handle local `~/.openclaw` directory traversal.

Below is the final, fully-consolidated architecture map, checklist, and sequence of steps reflecting the absolute consensus between Gemini and Codex.

---

### Final Consolidated File Destination Map (Production & Tests)

| File / Test Path | Category | Final Destination | Note |
| :--- | :--- | :--- | :--- |
| **(New)** | Shared types | `src/core/command-types.ts` | Extracted `LocalResult`, `LocalCommandContext`, `LocalCommandEventPublisher` |
| **(New)** | Shared types | `src/core/relay/slash-command-types.ts` | Extracted `RelaySlashCommandSource`, `RelaySlashCommandDescriptor` |
| `src/commands/send-file.ts` | CLI Command Wrapper | `src/commands/send-file.ts` | CLI command wrapper; handles gateway-aware session defaults |
| `src/commands/send-file-utils.ts` | Shared Utility | `src/core/relay/file-upload-utils.ts` | Shared utility logic (chunk calculation, MIME detection) |
| `src/commands/send-file.test.ts` | Test Suite | `src/commands/send-file.test.ts` | **(Split)** Tests CLI wrappers, configs, and gateway session defaults |
| **(New)** | Shared Service | `src/core/relay/file-upload.ts` | Programmatic upload service; pure API, no config/logging/side-effects |
| **(New)** | Shared Test | `src/core/relay/file-upload.test.ts` | **(Split)** Tests upload flow (init/chunk/complete), hashes, and retry loops |
| **(New)** | Shared Test | `src/core/relay/file-upload-utils.test.ts` | **(Split)** Tests core file-upload helpers |
| **(New)** | Shared Transport | `src/core/relay/relay-server-connection.ts` | Exposes narrow WebSocket transport helper (heartbeat, abort) |
| **(New)** | Shared Test | `src/core/relay/relay-server-connection.test.ts` | Tests WebSocket URL, heartbeat responses, and abort triggers |
| **(New)** | OpenClaw Helper | `src/openclaw/session-store.ts` | Local latest-session inference traversing `~/.openclaw` |
| `src/commands/local-runtime.ts` | OpenClaw Core | `src/openclaw/runtime/local-runtime.ts` | Spawns and manages local OpenClaw gateway processes |
| `src/commands/local-runtime.test.ts` | OpenClaw Test | `src/openclaw/runtime/local-runtime.test.ts` | Tests local subprocess selection |
| `src/commands/local-handlers.ts` | OpenClaw Core | `src/openclaw/handlers/local-handlers.ts` | Local command routing for OpenClaw |
| `src/commands/local-handlers.doctor-fix.test.ts` | OpenClaw Test | `src/openclaw/handlers/local-handlers.doctor-fix.test.ts` | Tests OpenClaw Doctor fix stream execution |
| `src/commands/local-handlers.logs.test.ts` | OpenClaw Test | `src/openclaw/handlers/local-handlers.logs.test.ts` | Tests OpenClaw logs reading and parsing |
| `src/commands/backup-manager.ts` | OpenClaw Core | `src/openclaw/backups/backup-manager.ts` | Local OpenClaw backup zip logic |
| `src/commands/provider-config.ts` | OpenClaw Core | `src/openclaw/config/provider-config.ts` | OpenClaw provider configuration |
| `src/commands/provider-handlers.ts` | OpenClaw Core | `src/openclaw/handlers/provider-handlers.ts` | OpenClaw provider command dispatcher |
| `src/commands/provider-registry.ts` | OpenClaw Core | `src/openclaw/config/provider-registry.ts` | OpenClaw provider registry definition |
| `src/relay/relay-manager.ts` | OpenClaw Core | `src/openclaw/relay-manager.ts` | WebSocket adapter for OpenClaw |
| `src/relay/gateway-client.ts` | OpenClaw Core | `src/openclaw/gateway-client.ts` | OpenClaw local gateway RPC WebSocket |
| `src/relay/gateway-client.test.ts` | OpenClaw Test | `src/openclaw/gateway-client.test.ts` | Tests gateway client connectivity |
| `src/relay/session-context.ts` | OpenClaw Core | `src/openclaw/relay/session-context.ts` | OpenClaw path and context config mapping |
| `src/relay/session-context-zero.test.ts` | OpenClaw Test | `src/openclaw/relay/session-context-zero.test.ts` | Tests OpenClaw zero context updates |
| `src/relay/chat-history.ts` | OpenClaw Core | `src/openclaw/relay/chat-history.ts` | OpenClaw-specific history sync fallback |
| `src/relay/chat-send-attachments.ts` | OpenClaw Core | `src/openclaw/relay/chat-send-attachments.ts` | Prepares OpenClaw custom attachment structure |
| `src/relay/chat-send-attachments.test.ts` | OpenClaw Test | `src/openclaw/relay/chat-send-attachments.test.ts` | Tests custom attachment formats |
| `src/relay/openclaw-voice-input.ts` | OpenClaw Core | `src/openclaw/relay/openclaw-voice-input.ts` | Parses OpenClaw custom voice input ASR events |
| `src/relay/slash-command-catalog.ts` | OpenClaw Core | `src/openclaw/relay/slash-command-catalog.ts` | Exposes catalog; imports types from core |
| `src/relay/slash-command-catalog.generated.ts` | OpenClaw Core | `src/openclaw/relay/slash-command-catalog.generated.ts` | OpenClaw generated catalog output |
| `src/relay/slash-command-catalog.test.ts` | OpenClaw Test | `src/openclaw/relay/slash-command-catalog.test.ts` | Tests OpenClaw command listings |
| `src/commands/remote-restart.test.ts` | OpenClaw Test | `src/openclaw/handlers/remote-restart.test.ts` | Tests OpenClaw gateway restarts |
| `src/commands/voice-reply-removal.test.ts` | OpenClaw Test | `src/openclaw/handlers/voice-reply-removal.test.ts` | Tests OpenClaw voice replies |
| `src/relay/office-payload.ts` | Shared Core | `src/core/relay/office-payload.ts` | Generic payload mapping for IDE status indicator |
| `src/relay/office-payload.test.ts` | Shared Test | `src/core/relay/office-payload.test.ts` | Tests status payload mappings |
| `src/relay/mobile-chat-run-bridge.ts` | Shared Core | `src/core/relay/mobile-chat-run-bridge.ts` | Generic mobile payload converters |
| `src/relay/mobile-chat-run-bridge.test.ts` | Shared Test | `src/core/relay/mobile-chat-run-bridge.test.ts` | Tests mobile response transformations |
| `src/relay/voice-input.ts` | Shared Core | `src/core/relay/voice-input.ts` | Shared ASR validation; prefers `CLAWCONNECT_ASR_COMMAND` with fallback |
| `src/relay/voice-input.test.ts` | Shared Test | `src/core/relay/voice-input.test.ts` | Tests voice error classifications & env variable precedence |
| `src/relay/reconnect.ts` | Shared Core | `src/core/relay/reconnect.ts` | Shared reconnect helper for the runner |
| `src/relay/attachment-staging.ts` | Shared Core | `src/core/relay/attachment-staging.ts` | Shared MIME mapping |
| `src/relay/attachment-staging.test.ts` | Shared Test | `src/core/relay/attachment-staging.test.ts` | Tests MIME-to-extension configurations |
| `src/relay/chat-payload.ts` | Shared Core | `src/core/relay/chat-payload.ts` | Shared chat payload extraction |
| `src/relay/relay-helpers.test.ts` | Shared Test | `src/core/relay/chat-payload.test.ts` | Tests chat payload normalization |
| `src/hermes/models/*.ts` | Hermes Runtime | `src/hermes/runtime/*.ts` | All sub-modules running Hermes Python scripts, cron, and skills |
| `src/hermes/hermes-runtime.ts` | Hermes Bootloader | `src/hermes/hermes-runtime.ts` | Hermes runtime entrypoint; updates re-exports to `runtime/*` |
| `src/hermes/hermes-relay-manager.ts` | Hermes WebSocket | `src/hermes/hermes-relay-manager.ts` | WebSocket adapter for Hermes |
| `src/hermes/hermes-runtime.test.ts` | Hermes Test | `src/hermes/hermes-runtime.test.ts` | Updates tests to import from `src/hermes/runtime/` |
| `src/hermes/hermes-runtime-lifecycle.test.ts` | Hermes Test | `src/hermes/hermes-runtime-lifecycle.test.ts` | Updates lifecycle tests to import from `src/hermes/runtime/` |
| `src/hermes/hermes-relay-manager.test.ts` | Hermes Test | `src/hermes/hermes-relay-manager.test.ts` | Updates artifact upload test to verify pure upload request shape |
| `src/hermes/hermes-voice-input.test.ts` | Hermes Test | `src/hermes/hermes-voice-input.test.ts` | Updates tests to verify CLAWCONNECT_ASR_COMMAND and legacy env variables |

---

### Non-Moved Files Import Checklist

When executing this refactor, ensure these files are updated to maintain clean compilation:

* [ ] **`src/index.ts`**: Update imports of `sendFileCommand` if interface changes, and adjust `pairCommand`/`runCommand` if needed.
* [ ] **`src/commands/pair.ts`**: Update `toRelayHttpBase` import path to `../core/relay/file-upload-utils.js`.
* [ ] **`src/commands/run.ts`**: Update `withReconnect` import path to `../core/relay/reconnect.js`.
* [ ] **`src/runtime-adapters.ts`**: Update `runRelayManager` import path to `./openclaw/relay-manager.js`.
* [ ] **`src/hermes/hermes-relay-manager.ts`**:
  * [ ] Replace `sendFileCommand` with `uploadFileToRelay` from `../core/relay/file-upload.js`.
  * [ ] Remove `SendFileCommandOptions` from Hermes runtime code.
  * [ ] Rename `buildHermesArtifactSendOptions` to `buildHermesArtifactUploadRequest` and return a `FileUploadRequest` shape.
  * [ ] Pass relay config explicitly parsed from the manager's options rather than using default CLI fallback.
  * [ ] Update `buildMobileAssistant*` and `resolveMobileChatRun` imports to `../core/relay/mobile-chat-run-bridge.js`.
  * [ ] Update `buildOfficeEventPayload` import to `../core/relay/office-payload.js`.
  * [ ] Update `voiceInputSetupMessage` import to `../core/relay/voice-input.js`.
* [ ] **`src/hermes/hermes-voice-input.ts`**: Update `prepareVoiceSendParams` import to `../core/relay/voice-input.js`.
* [ ] **`scripts/slash-command-catalog-generator.ts`**:
  * [ ] Update `defaultOutputPath` to `src/openclaw/relay/slash-command-catalog.generated.ts`.
  * [ ] Call `mkdirSync(dirname(outputPath), { recursive: true })` before `writeFileSync`.
* [ ] **`scripts/sync-slash-command-catalog.ts`**: Verify imports and paths, ensure no legacy generator artifacts are left behind.

---

### Final Refactoring Order of Actions

We will execute the cleanup using this rigorous sequence to prevent regressions:

1. **Step 0**: Create `src/core/command-types.ts`, relocate `LocalResult`, `LocalCommandContext`, and `LocalCommandEventPublisher`, and update all imports across both Hermes and OpenClaw modules.
2. **Step 1**: Create `src/core/relay/slash-command-types.ts`, relocate `RelaySlashCommandSource` and `RelaySlashCommandDescriptor`, and update imports in Hermes and OpenClaw catalogs.
3. **Step 2**: Rename `src/hermes/models/` to `src/hermes/runtime/` and update all relative imports and re-exports.
4. **Step 3**: Relocate all shared utilities (`attachment-staging.ts`, `chat-payload.ts`, `office-payload.ts`, `voice-input.ts`, `mobile-chat-run-bridge.ts`, `reconnect.ts`) and their test suites into `src/core/relay/`.
5. **Step 4**: Split `src/commands/send-file.ts` and `src/commands/send-file.test.ts` into CLI handlers, a session utility (`src/openclaw/session-store.ts`), and a pure programmatic service (`src/core/relay/file-upload.ts` & `file-upload.test.ts`).
6. **Step 5**: Relocate all remaining OpenClaw-specific files (`relay-manager.ts`, `gateway-client.ts`, `session-context.ts`, `chat-history.ts`, `chat-send-attachments.ts`, `openclaw-voice-input.ts`, `slash-command-catalog.ts`) and tests into `src/openclaw/`.
7. **Step 6**: Update `scripts/slash-command-catalog-generator.ts` with output directory creation and relocate `slash-command-catalog.generated.ts` in the same commit.
8. **Step 7**: Extract the narrow transport helper `relay-server-connection.ts` under `src/core/relay/` and refit both managers.
9. **Step 8**: Update `package.json` globs, run `npm run build` and `npm test` to verify zero compile or runtime failures.

This plan represents the finalized refactoring roadmap and is ready for implementation.
