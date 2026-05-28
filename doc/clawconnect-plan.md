# ClawConnect Agent Architecture Review

本文基于当前 `clawconnect-agent` 代码结构，评估目录拆分是否合理，并给出可执行的重构建议。

## 1. 结论

当前结构整体可运行，测试覆盖也比较充分，但目录边界不够清晰。主要问题不是缺少一个大统一抽象，而是：

1. `src/commands/` 混入了大量 OpenClaw 本地运行时和业务逻辑。
2. `src/hermes/models/` 命名误导，里面实际是运行时执行逻辑，不是数据模型。
3. `src/relay/` 同时包含 OpenClaw 专属逻辑、共享 mobile/office/voice helper，以及通用 reconnect helper，语义过载。
4. `src/relay/relay-manager.ts` 和 `src/hermes/hermes-relay-manager.ts` 有少量 relay transport 重复，但不适合抽成重型 base class。
5. 现有 `GatewayRuntimeAdapter` 已经提供了 gateway 启动层抽象，暂时不需要引入更大的 `GatewayEngine`。

推荐方向是：**目录边界归位 + 小范围共享 helper 抽取**。不要一次性做大一统 gateway 架构。

## 2. 当前结构概览

```text
src/
├── index.ts                     # CLI entry point, commander command definitions
├── gateway-profiles.ts          # OpenClaw / Hermes capability definitions
├── runtime-adapters.ts          # gateway runtime adapter registry
├── config/                      # ClawConnect config and env loading
├── platform/                    # launchd, systemd, Windows service management
├── i18n/                        # localization
├── commands/                    # CLI commands, but also OpenClaw runtime logic
├── relay/                       # OpenClaw relay + shared relay helpers mixed together
└── hermes/                      # Hermes integration
    └── models/                  # actually Hermes runtime execution modules
```

## 3. 主要问题

### 3.1 `src/commands/` 承担了过多职责

`commands` 目录应该主要放 CLI entrypoint 和命令参数适配。但当前这些文件不是纯 CLI：

```text
src/commands/local-runtime.ts
src/commands/local-handlers.ts
src/commands/backup-manager.ts
src/commands/provider-config.ts
src/commands/provider-handlers.ts
src/commands/provider-registry.ts
```

它们处理的是 OpenClaw 本地进程启动、PATH 构造、远程命令分发、备份管理、provider 配置写入等运行时逻辑。放在 `commands/` 下会让 Hermes 或共享代码不小心依赖 CLI 层，也会让目录语义变得模糊。

建议把 OpenClaw 专属逻辑移动到 `src/openclaw/`，让 `src/commands/` 只保留 thin CLI wrapper。

### 3.2 `src/hermes/models/` 命名不准确

`models/` 通常表示 schema、plain data model 或数据库模型。但当前目录下的文件包括：

```text
hermes-runtime-chat.ts
hermes-runtime-cron.ts
hermes-runtime-skills.ts
hermes-runtime-process.ts
hermes-runtime-usage.ts
```

这些文件实际负责 Hermes CLI/Python 执行、chat streaming、cron、skills、usage snapshot 等行为。更准确的命名是：

```text
src/hermes/runtime/
```

这是低风险重命名，主要影响 import 路径，建议单独提交或作为第一阶段重构。

### 3.3 `src/relay/` 语义过载

当前 `src/relay/` 里面有三类文件：

1. OpenClaw 专属 relay / gateway 逻辑。
2. Hermes 和 OpenClaw 都会使用的共享 mobile/office/voice/file helper。
3. 通用 reconnect / transport helper。

如果 `relay/` 代表 OpenClaw relay，Hermes 不应该依赖它；如果 `relay/` 代表共享协议层，OpenClaw 专属的 gateway client 和 session context 又不应该放在里面。

建议拆分为：

```text
src/core/relay/      # 共享 relay/mobile/office/voice/file utilities
src/openclaw/relay/  # OpenClaw 专属 relay helpers
```

### 3.4 WebSocket transport 有重复，但不要抽重型 `RelayClient`

`src/relay/relay-manager.ts` 和 `src/hermes/hermes-relay-manager.ts` 共同包含：

```text
buildRelayUrl()
new WebSocket(...)
send JSON frame
server heartbeat echo
AbortSignal close
close/error handling
close code 4000 / shutdown retry decision
```

这部分可以抽取。

但两个 manager 的主体业务差异很大：

```text
OpenClaw:
- 连接本地 OpenClaw gateway WebSocket
- 桥接 gateway request/response/event
- 处理 session defaults
- 处理 chat history fallback
- 处理 context usage refresh

Hermes:
- 直接运行 Hermes CLI / Python
- 管理 mobile file event
- 上传 artifacts
- 处理 Hermes sessions / usage snapshot
- 动态收集 Hermes slash command catalog
```

因此不建议抽一个大 `RelayClient` base class，更不建议把 gateway 行为统一进 `onCommand/onConnected/onDisconnected` 这种宽接口。更稳妥的是抽一个很窄的 transport helper。

推荐目标：

```text
src/core/relay/relay-server-connection.ts
```

职责只包括：

```text
- build relay WebSocket URL
- 创建 relay WebSocket
- sendJson()
- parse incoming JSON frame
- echo server heartbeat frame
- close on AbortSignal
- 根据 close code / shutdown signal 判断是否 retry
```

不应该包括：

```text
- 自己启动 reconnect loop
- 新增 client-side heartbeat timer
- 管理 OpenClaw 本地 gateway tick/reconnect
- 承担 gateway-specific command dispatch
```

外层 reconnect 已经由 `withReconnect()` 处理，OpenClaw 本地 gateway reconnect 已经在 `OpenClawGatewayClient` 内部处理。

### 3.5 暂缓 `GatewayEngine`

当前 `src/runtime-adapters.ts` 已经定义了 `GatewayRuntimeAdapter`，OpenClaw 和 Hermes 都通过 adapter 接入。现阶段只有两个 gateway，不需要马上引入更大的 `GatewayEngine`。

真正存在的问题是：

```text
- GatewayType 仍是 "openclaw" | "hermes" 静态 union
- adapter registry 是静态表
- pair/status/config 等路径仍需要知道 gateway type
```

这些问题可以等第三个 gateway 出现时再重新评估。现在过早统一，容易得到一个表面通用、内部到处 `if gatewayType` 的抽象。

## 4. 推荐目标结构

```text
src/
├── index.ts
├── gateway-profiles.ts
├── runtime-adapters.ts
├── config/
├── platform/
├── i18n/
├── commands/
│   ├── pair.ts
│   ├── run.ts
│   ├── status.ts
│   ├── install.ts
│   ├── update.ts
│   ├── set-token.ts
│   └── send-file.ts              # CLI wrapper only
├── core/
│   ├── command-types.ts
│   └── relay/
│       ├── relay-server-connection.ts
│       ├── reconnect.ts
│       ├── file-upload.ts
│       ├── file-upload-utils.ts
│       ├── office-payload.ts
│       ├── mobile-chat-run-bridge.ts
│       ├── voice-input.ts
│       ├── attachment-staging.ts
│       ├── chat-payload.ts
│       └── slash-command-types.ts
├── openclaw/
│   ├── relay-manager.ts
│   ├── gateway-client.ts
│   ├── runtime/
│   │   └── local-runtime.ts
│   ├── handlers/
│   │   ├── local-handlers.ts
│   │   └── provider-handlers.ts
│   ├── config/
│   │   ├── provider-config.ts
│   │   └── provider-registry.ts
│   ├── backups/
│   │   └── backup-manager.ts
│   └── relay/
│       ├── session-context.ts
│       ├── chat-history.ts
│       ├── chat-send-attachments.ts
│       ├── openclaw-voice-input.ts
│       ├── slash-command-catalog.ts
│       └── slash-command-catalog.generated.ts
└── hermes/
    ├── hermes-relay-manager.ts
    ├── hermes-runtime.ts
    ├── hermes-session-store.ts
    ├── hermes-voice-input.ts
    └── runtime/
        ├── hermes-runtime-artifacts.ts
        ├── hermes-runtime-backups.ts
        ├── hermes-runtime-chat.ts
        ├── hermes-runtime-command-router.ts
        ├── hermes-runtime-command-utils.ts
        ├── hermes-runtime-cron.ts
        ├── hermes-runtime-lifecycle.ts
        ├── hermes-runtime-models.ts
        ├── hermes-runtime-process.ts
        ├── hermes-runtime-sessions.ts
        ├── hermes-runtime-skills.ts
        ├── hermes-runtime-types.ts
        ├── hermes-runtime-usage.ts
        └── hermes-runtime-values.ts
```

## 5. 文件归类建议

### 5.1 `src/commands/*`

| 当前文件 | 建议目标 | 说明 |
| --- | --- | --- |
| `pair.ts` | `src/commands/pair.ts` | CLI command，可保留 |
| `run.ts` | `src/commands/run.ts` | CLI command，可保留 |
| `status.ts` | `src/commands/status.ts` | CLI command，可保留 |
| `install.ts` | `src/commands/install.ts` | CLI/service command，可保留 |
| `update.ts` | `src/commands/update.ts` | CLI/service command，可保留 |
| `set-token.ts` | `src/commands/set-token.ts` | CLI command，可保留 |
| `send-file.ts` | `src/commands/send-file.ts` | 保留为 CLI wrapper，核心上传逻辑移走 |
| `send-file-utils.ts` | `src/core/relay/file-upload-utils.ts` | 共享文件上传 utility |
| `local-runtime.ts` | `src/openclaw/runtime/local-runtime.ts` | OpenClaw 本地运行时 |
| `local-handlers.ts` | `src/openclaw/handlers/local-handlers.ts` | OpenClaw local command router |
| `backup-manager.ts` | `src/openclaw/backups/backup-manager.ts` | OpenClaw config backup |
| `provider-config.ts` | `src/openclaw/config/provider-config.ts` | OpenClaw provider config |
| `provider-registry.ts` | `src/openclaw/config/provider-registry.ts` | OpenClaw provider registry |
| `provider-handlers.ts` | `src/openclaw/handlers/provider-handlers.ts` | OpenClaw provider command handler |

### 5.2 `src/relay/*`

| 当前文件 | 建议目标 | 说明 |
| --- | --- | --- |
| `relay-manager.ts` | `src/openclaw/relay-manager.ts` | OpenClaw relay manager |
| `gateway-client.ts` | `src/openclaw/gateway-client.ts` | OpenClaw local gateway WebSocket client |
| `session-context.ts` | `src/openclaw/relay/session-context.ts` | OpenClaw session/context path logic |
| `chat-history.ts` | `src/openclaw/relay/chat-history.ts` | OpenClaw chat history fallback |
| `chat-send-attachments.ts` | `src/openclaw/relay/chat-send-attachments.ts` | OpenClaw chat attachment payload |
| `openclaw-voice-input.ts` | `src/openclaw/relay/openclaw-voice-input.ts` | OpenClaw voice command adapter |
| `slash-command-catalog.ts` | `src/openclaw/relay/slash-command-catalog.ts` | OpenClaw slash command catalog export |
| `slash-command-catalog.generated.ts` | `src/openclaw/relay/slash-command-catalog.generated.ts` | OpenClaw generated catalog |
| `reconnect.ts` | `src/core/relay/reconnect.ts` | shared reconnect helper |
| `office-payload.ts` | `src/core/relay/office-payload.ts` | shared office/status payload builder |
| `mobile-chat-run-bridge.ts` | `src/core/relay/mobile-chat-run-bridge.ts` | shared mobile chat payload converter |
| `voice-input.ts` | `src/core/relay/voice-input.ts` | shared ASR / voice input helper |
| `attachment-staging.ts` | `src/core/relay/attachment-staging.ts` | shared MIME / staging path helper |
| `chat-payload.ts` | `src/core/relay/chat-payload.ts` | shared chat payload parser |

### 5.3 `src/hermes/models/*`

| 当前目录 | 建议目标 | 说明 |
| --- | --- | --- |
| `src/hermes/models/*` | `src/hermes/runtime/*` | 只改目录名，不改行为 |

## 6. 需要提前处理的边界

### 6.1 先抽共享 command types

Hermes runtime 当前会引用 `LocalResult` / `LocalCommandContext`。如果直接把 `local-runtime.ts` 移到 `openclaw/`，Hermes 会因为共享类型继续依赖 OpenClaw 模块。

应先创建：

```text
src/core/command-types.ts
```

放入：

```typescript
export type LocalResult =
  | { ok: true; payload?: unknown }
  | { ok: false; error: string };

export type LocalCommandEventPublisher = (event: {
  type: "event";
  event: string;
  payload: unknown;
}) => void;

export type LocalCommandContext = {
  requestId?: string;
  gatewayId?: string;
  publishEvent?: LocalCommandEventPublisher;
};
```

然后 OpenClaw 和 Hermes 都从 `core/command-types` import。

### 6.2 先抽 slash command shared types

`slash-command-catalog.ts` 现在既有 OpenClaw catalog，也有共享类型。Hermes 只需要类型，不应该依赖 OpenClaw catalog。

应先创建：

```text
src/core/relay/slash-command-types.ts
```

放入：

```text
RelaySlashCommandSource
RelaySlashCommandDescriptor
```

然后：

```text
src/openclaw/relay/slash-command-catalog.ts
  imports RelaySlashCommandDescriptor from core/relay/slash-command-types
  exports OPENCLAW_SLASH_COMMAND_CATALOG

src/hermes/hermes-relay-manager.ts
  imports RelaySlashCommandDescriptor from core/relay/slash-command-types
```

### 6.3 更新 slash command generator

如果生成文件移动到：

```text
src/openclaw/relay/slash-command-catalog.generated.ts
```

则必须同步更新：

```text
scripts/slash-command-catalog-generator.ts
scripts/sync-slash-command-catalog.ts
相关 tests
```

否则 `npm run sync:slash-commands` 会重新生成旧路径，破坏目录清理。

### 6.4 `send-file.ts` 需要拆 CLI 和核心上传

`send-file.ts` 当前既是 CLI command，也被 Hermes relay manager 程序化调用用于 artifact delivery。这会让运行时模块依赖 CLI command。

建议拆成：

```text
src/core/relay/file-upload.ts
  - uploadFileToRelay(request, deps?)
  - request 显式包含 relayServerUrl, relaySecret, gatewayId, sessionKey, filePath
  - 不 readConfig()
  - 不写 stdout/stderr
  - 不处理 --json
  - 不从 ~/.openclaw 推断 session

src/commands/send-file.ts
  - 读取 config
  - 处理 CLI 参数和输出
  - 按 gatewayType 解析默认 session
  - 调用 uploadFileToRelay()
```

特别注意：Hermes artifact upload 应显式传入 session key，不应触发 `~/.openclaw` fallback。

### 6.5 shared `voice-input.ts` 不应继续只暴露 OpenClaw 命名

`voice-input.ts` 如果移动到 `core/relay/`，应优先使用：

```text
CLAWCONNECT_ASR_COMMAND
```

并保留 legacy fallback：

```text
OPENCLAW_ASR_COMMAND
```

错误提示也应优先引导用户配置 `CLAWCONNECT_ASR_COMMAND`，再说明 `OPENCLAW_ASR_COMMAND` 仍兼容。

### 6.6 `attachment-staging.ts` 可整体移动到 core

`voice-input.ts` 依赖 `extensionForMimeType()`，所以不能把整个 `attachment-staging.ts` 放到 OpenClaw 下，除非再拆出一个更小的 MIME utility。

两种方案都可以：

```text
方案 A:
src/core/relay/attachment-staging.ts

方案 B:
src/core/relay/mime-extension.ts
src/openclaw/relay/attachment-staging.ts
```

为了减少文件拆分，建议采用方案 A，并在代码里保持 `buildAttachmentStagingPath()` 由调用方注入 gateway-specific outbound dir。

### 6.7 更新 test script

`package.json` 当前 test script 写死了目录 glob。移动测试文件后，要同步加入：

```text
src/core/*.test.ts
src/core/**/*.test.ts
src/openclaw/*.test.ts
src/openclaw/**/*.test.ts
```

或者改成经过验证的全项目 test discovery pattern。否则测试可能显示通过，但被移动的测试没有运行。

## 7. 推荐实施顺序

建议分阶段做，避免一次性大搬家造成回归难以定位。

### Phase 1: 低风险共享类型抽取

1. 新建 `src/core/command-types.ts`。
2. 移动 `LocalResult` / `LocalCommandContext` / `LocalCommandEventPublisher`。
3. 新建 `src/core/relay/slash-command-types.ts`。
4. 更新 Hermes/OpenClaw 相关 imports。
5. 跑 `npm test`。

### Phase 2: Hermes 目录重命名

1. `src/hermes/models/` 改名为 `src/hermes/runtime/`。
2. 更新 `src/hermes/hermes-runtime.ts` 和测试 imports。
3. 不改行为。
4. 跑 `npm test`。

### Phase 3: 拆出 shared relay utilities

1. 移动 shared relay files 到 `src/core/relay/`。
2. 拆 `send-file.ts`，新增 `core/relay/file-upload.ts`。
3. 让 `commands/send-file.ts` 只做 CLI wrapper。
4. 让 Hermes artifact upload 依赖 `core/relay/file-upload.ts`。
5. 更新 `voice-input.ts` 的 ASR env 命名。
6. 跑 `npm test`。

### Phase 4: OpenClaw 目录归位

1. 新建 `src/openclaw/`。
2. 移动 OpenClaw runtime、handlers、config、backups。
3. 移动 OpenClaw relay manager、gateway client、session/chat/slash helpers。
4. 更新 slash command generator 输出路径。
5. 更新所有 imports 和 tests。
6. 更新 `package.json` test glob。
7. 跑 `npm run build` 和 `npm test`。

### Phase 5: 抽窄 relay transport helper

1. 新建 `src/core/relay/relay-server-connection.ts`。
2. 只抽 URL/send/parse/heartbeat echo/abort close/retry decision。
3. 不改变 reconnect 语义。
4. 分别改造 OpenClaw 和 Hermes relay manager 使用这个 helper。
5. 跑 `npm run build` 和 `npm test`。

## 8. 不建议现在做的事

暂时不建议：

```text
- 引入大统一 GatewayEngine
- 把 OpenClaw 和 Hermes command dispatch 塞进同一个 base class
- 在 relay-server-connection.ts 内部新增 reconnect loop
- 在 shared core 中保留 ~/.openclaw session fallback
- 一次 PR 同时移动所有文件并重写 relay 行为
```

这些改动风险较高，收益不明确，应该等第三个 gateway 或明确的新协议需求出现后再评估。

## 9. 最终判断

`clawconnect-agent` 现在最大的问题是目录边界和命名，而不是抽象层不够多。

合理的目标是：

```text
commands = CLI wrappers
core = shared protocol/types/transport/utilities
openclaw = OpenClaw-specific runtime and relay
hermes = Hermes-specific runtime and relay
runtime-adapters = gateway bootstrap selection
```

按这个方向重构后，OpenClaw、Hermes、共享协议层三者的依赖方向会更清楚：

```text
commands -> openclaw / hermes / core
openclaw -> core
hermes -> core
core -> no gateway-specific modules
```

这比当前结构更容易维护，也为将来新增 gateway 留出了空间，同时避免过早设计一个沉重的通用 gateway framework。
