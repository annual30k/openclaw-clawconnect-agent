# ClawConnect Agent 使用说明

`ClawConnect Agent` 是运行在 macOS、Linux 或 Windows 主机上的 OpenClaw 远程连接代理，用于把本机 OpenClaw Gateway 接入你的中继站，供移动端远程访问。

## 安装

```bash
npm install -g clawconnect-agent
```

安装完成后可使用命令：

```bash
clawconnect --help
```

Windows 会自动保留 npm 的 `clawconnect.cmd` 入口，并移除同目录下会被严格 PowerShell 执行策略优先拦截的 npm `.ps1` 包装器，因此不需要降低系统执行策略。若安装时使用了 `--ignore-scripts`，可在 PowerShell 中改用 `clawconnect.cmd`。

## 使用方式

### 1. 配对

生成移动端扫码配对用的二维码：

```bash
clawconnect pair
```

如果只想输出配对码，不打印二维码：

```bash
clawconnect pair --code-only
```

可选参数：

- `-n, --name <name>`：指定这台主机在移动端显示的名称
- `-s, --server <url>`：指定中继服务器地址
- `-p, --profile <name>`：指定本机配置 profile；同一台主机同时配对 OpenClaw 和 Hermes Agent 时必须分开
- `--gateway-type <type>`：指定网关类型，可选 `openclaw` 或 `hermes`
- `--code-only`：只输出访问码，不打印二维码

### 2. 同时配对 OpenClaw 和 Hermes Agent

同一台电脑上同时运行 OpenClaw 和 Hermes Agent 时，必须使用不同的 `--profile`。这样两条链路会使用不同的本地配置、日志和后台服务，避免 OpenClaw 与 Hermes Agent 串到一起。

配对 OpenClaw：

```bash
clawconnect pair-openclaw
```

配对 Hermes Agent：

```bash
clawconnect pair-hermes
```

如果使用本地开发 Relay `http://127.0.0.1:8080`，加一个 `--local` 即可：

```bash
clawconnect pair-openclaw --local
clawconnect pair-hermes --local
```

上面的快捷命令等价于下面的完整写法。

OpenClaw：

```bash
clawconnect pair \
  --profile openclaw \
  --server http://127.0.0.1:8080 \
  --gateway-type openclaw \
  --name "Mac OpenClaw"
```

Hermes Agent：

```bash
clawconnect pair \
  --profile hermes \
  --server http://127.0.0.1:8080 \
  --gateway-type hermes \
  --name "Mac Hermes Agent"
```

每条命令执行后，使用移动端扫码，或在移动端输入终端打印的配对码。配对 payload 会带上 `gatewayType`，Relay 会校验手机端请求的类型和主机注册的类型是否一致；类型不一致会拒绝绑定，避免 OpenClaw 手机网关绑定到 Hermes Agent 主机，或反过来绑定错误。

配对完成后，安装已配对的后台服务：

```bash
clawconnect install
```

不带 `--profile` 时，`clawconnect install` 会安装当前能找到的所有已配对 profile。只想指定一个 profile 时，可以用 `clawconnect install-openclaw`、`clawconnect install-hermes`，或 `clawconnect install --profile <name>`。

清除失效凭证时也必须使用同一个 profile。如果 `pair-openclaw` 或 `pair-hermes` 提示凭证无效，不要只运行默认 `clawconnect reset`，而是重置对应 profile：

```bash
clawconnect reset-openclaw
clawconnect reset-hermes
```

查看两个实例：

```bash
clawconnect status-all
```

单独重启或停止某一个实例：

```bash
clawconnect restart-openclaw
clawconnect restart-hermes
clawconnect stop-openclaw
clawconnect stop-hermes
```

本机配置文件位置：

```text
~/.clawconnect/profiles/openclaw/config.json
~/.clawconnect/profiles/hermes/config.json
```

终态事件和命令响应会先写入权限受限、按 profile/Relay/gateway 隔离的
`reliable-outbox-v1/` WAL，再发送到 Relay。未收到 ACK 的条目在 Agent
崩溃或服务重启后仍会按原始内容重放；`clawconnect reset --profile <name>`
会清除对应 profile 的可靠投递状态，而 `uninstall` 会保留它。

macOS 后台服务名：

```text
com.openclaw.clawconnect.agent.openclaw
com.openclaw.clawconnect.agent.hermes
```

### 环境配置

本地安装后的 agent 会在第一次运行 `clawconnect` 时自动创建 `~/.clawconnect/.env`，里面会用注释列出所有可配置项。你可以直接编辑这个文件集中维护默认配置：

```bash
$EDITOR ~/.clawconnect/.env
```

如果是在这个源码目录里开发，可以把 `.env.example` 复制为 `.env.local`。已有的 `~/.clawconnect/.env` 不会被自动覆盖。

支持的配置项：

- `CLAWCONNECT_RELAY_SERVER_URL`：未传 `--server` 时，`clawconnect pair` 使用的默认中继地址
- `CLAWCONNECT_GATEWAY_URL`：可选，本机 OpenClaw Gateway WebSocket 地址覆盖值
- `OPENCLAW_GATEWAY_PORT`：只覆盖 OpenClaw Gateway 端口；`CLAWCONNECT_GATEWAY_URL` 优先级更高
- `OPENCLAW_HOME` / `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH`：OpenClaw 官方路径覆盖；源码、Homebrew、容器挂载、独立服务用户和多网关安装都应使用这些值
- `OPENCLAW_BIN` / `OPENCLAW_PACKAGE_BIN` / `OPENCLAW_INSTALL_DIR`：OpenClaw 不在 PATH 或不是 npm 安装时，指定 CLI/JS 入口或安装根目录
- `HERMES_HOME` / `HERMES_BIN` / `HERMES_PYTHON`：Hermes 数据目录、CLI 与 Python 覆盖；Windows 会先自动探测 `%LOCALAPPDATA%\hermes`
- `HERMES_SKILLS_DIR` / `CLAWCONNECT_HERMES_STATE_DB`：可选，单独指定 Hermes 技能目录和状态数据库路径
- `CLAWCONNECT_HERMES_API_URL` / `CLAWCONNECT_HERMES_API_KEY`：Hermes API 完整地址与鉴权；也兼容 Hermes 自己的 `API_SERVER_HOST`、`API_SERVER_PORT`、`API_SERVER_KEY`
- `CLAWCONNECT_ENV_FILE`：可选，显式指定 env 文件路径；未设置时会依次读取 `~/.clawconnect/.env`、`.env.local`、`.env`
- `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`：Gateway 鉴权兜底值
- `CLAWCONNECT_ASR_COMMAND`：宿主机语音转文字命令。ClawLink 发送 `chat.voice.send` 后，agent 会把音频保存到临时文件，并执行这个命令；命令必须把识别文本输出到 stdout。可用占位符：`{file}`、`{language}`、`{mimeType}`
- `OPENCLAW_ASR_COMMAND`：旧版语音转文字命令兜底值；同时设置时优先使用 `CLAWCONNECT_ASR_COMMAND`

Shell 里已经设置的环境变量优先级高于 env 文件。`clawconnect run`、`status`、`send-file` 会继续使用 `~/.clawconnect/config.json` 或 `~/.clawconnect/profiles/<profile>/config.json` 里已配对保存的 relay；如果要切换中继服务器，请执行 `clawconnect pair --profile <name> --server <url>` 或 `clawconnect reset --profile <name>`。

例如 OpenClaw 使用自定义状态目录和 `19001` 端口时：

```dotenv
OPENCLAW_STATE_DIR=D:\OpenClawData
OPENCLAW_CONFIG_PATH=D:\OpenClawData\openclaw.json
OPENCLAW_GATEWAY_PORT=19001
OPENCLAW_BIN=D:\Apps\OpenClaw\openclaw.cmd
```

Hermes 原生 Windows 非默认安装可配置：

```dotenv
HERMES_HOME=D:\HermesData
HERMES_BIN=D:\Hermes\hermes-agent\venv\Scripts\hermes.exe
HERMES_PYTHON=D:\Hermes\hermes-agent\venv\Scripts\python.exe
CLAWCONNECT_HERMES_STATE_DB=D:\HermesData\state.db
CLAWCONNECT_HERMES_API_URL=http://127.0.0.1:9642
```

保存后执行 `clawconnect restart --profile <name>`，再用 `clawconnect status --profile <name>` 核对实际使用的 Gateway、state/config、Hermes home/API。如仅使用 Hermes CLI，可以不配置 API URL。

### 3. 前台运行

以当前终端前台方式启动代理：

```bash
clawconnect run
```

适合调试中继连接、本地 Gateway 鉴权和日志输出。

如果需要让手机端直接发送语音、由宿主机识别后再转发给 OpenClaw 或 Hermes Agent，请配置本机 ASR 命令：

```bash
CLAWCONNECT_ASR_COMMAND='/usr/local/bin/transcribe-audio {file} {language}' clawconnect run
```

未配置 `CLAWCONNECT_ASR_COMMAND`，且也没有旧版 `OPENCLAW_ASR_COMMAND` 兜底时，宿主机收到语音消息会返回 `voice_asr_not_configured`。

### 4. 查看状态

查看当前配对信息、网关地址和后台服务状态：

```bash
clawconnect status
```

### 5. 安装后台服务

将代理安装成后台常驻服务：

```bash
clawconnect install
```

行为说明：

- macOS：安装为 `launchd` 用户服务
- Linux：优先使用 `systemd --user`
- 如果 Linux 当前环境不支持 `systemd --user`，会自动回退到 `nohup`
- Windows：优先注册为有限权限的 Windows Task Scheduler 任务；若系统策略要求管理员权限，则自动使用当前用户的启动项，二者都会在登录时静默启动且无需管理员提权

Windows 的不同 profile 使用独立后台启动项（例如 `ClawConnectAgent-openclaw`、`ClawConnectAgent-hermes`）和独立 UTF-8 日志，不会互相覆盖。

Linux 的不同 profile 也完全隔离：systemd 服务名分别类似
`clawconnect-agent-openclaw.service`、`clawconnect-agent-hermes.service`，
nohup 的 PID、启动脚本和日志位于各自 profile 目录。

在不支持 `systemd --user` 的 Linux 环境下，会生成一个备用启动脚本：

```bash
~/.clawconnect/clawconnect-start.sh
~/.clawconnect/profiles/<profile>/clawconnect-start.sh
```

你也可以手动执行：

```bash
bash ~/.clawconnect/clawconnect-start.sh
```

### 6. 停止服务

停止后台代理服务：

```bash
clawconnect stop
```

### 7. 重启服务

重启后台代理服务：

```bash
clawconnect restart
```

### 8. 设置 Gateway Token

当本机 Gateway 使用 token 鉴权时，可以手动保存 token：

```bash
clawconnect set-token
```

### 9. 卸载服务

移除后台服务定义，但保留本地配置：

```bash
clawconnect uninstall
```

### 10. 重置配对

停止服务并清除本地配对配置：

```bash
clawconnect reset
```

快捷配对命令使用独立 profile。修复 OpenClaw 或 Hermes 配对时，请使用对应的 reset 命令：

```bash
clawconnect reset-openclaw
clawconnect reset-hermes
```

自定义 profile 仍使用 `clawconnect reset --profile <name>`。

### 11. 升级到最新版本

升级全局 npm 安装的包；如果已安装后台服务，会在升级成功后自动重启服务：

```bash
clawconnect update
```

说明：

- `update` 底层执行的是 `npm install -g clawconnect-agent@latest`
- 如果你当前运行的是本地源码目录，而不是全局 npm 安装，这个命令只会升级全局包
- 如果你的 npm 全局目录需要更高权限，请按终端提示手动执行对应命令

### 12. 发送文件/图片

把本地图片或其他文件发到已配对的聊天会话：

```bash
clawconnect send-file ~/Pictures/demo.jpg
```

可选参数：

- `-g, --gateway <id>`：覆盖本地配置里的网关 ID
- `-s, --session <key>`：指定聊天会话，不传时默认使用最近活跃会话
- `--json`：以 JSON 输出上传结果

说明：

- `send-file` 会先把文件上传到 relay，再把文件消息发到手机端。
- 图片类型会在 iPhone 聊天里显示预览图，其他类型则显示文件卡片。
- `chat.send` 的 `attachments` 目前只是本地落盘引用，不是跨设备文件传输入口。

## 代码结构

```text
clawconnect-agent/
  README.md
  README.zh-CN.md
  package.json
  tsconfig.json
  tsconfig.build.json
  src/
    index.ts                  CLI 入口和命令注册
    commands/
      pair.ts                 配对、写入配置、安装后台服务
      run.ts                  前台运行 relay 主循环
      send-file.ts            将本地文件/图片发送到已配对会话
      status.ts               查看配对与服务状态
      install.ts              install / restart / stop / uninstall / reset
      set-token.ts            手动保存 Gateway Token
      *.test.ts               紧邻源码的单元测试
    core/
      command-types.ts        共享本地命令结果和上下文类型
      relay/
        file-upload.ts              纯 relay 文件上传服务
        file-upload-utils.ts        relay 地址和文件传输辅助
        relay-server-connection.ts  relay URL、JSON 帧、abort 和 close retry 辅助
        reconnect.ts                重连策略
        office-payload.ts           office/status payload 构造
        mobile-chat-run-bridge.ts   移动端 chat run payload 转换
        voice-input.ts              共享语音输入 / ASR 参数处理
        attachment-staging.ts       附件 MIME 和暂存路径辅助
        chat-payload.ts             聊天 payload 归一化
        slash-command-types.ts      slash command 共享类型
    config/
      config.ts               配对配置读写
      env.ts                  env 文件加载和 agent 默认配置
    hermes/
      hermes-relay-manager.ts Hermes relay 桥接
      hermes-runtime.ts       Hermes runtime 聚合入口
      hermes-session-store.ts Hermes 会话别名存储
      hermes-voice-input.ts   Hermes 语音输入适配
      runtime/
        hermes-runtime-*.ts   Hermes CLI/Python、chat、cron、skills、models、usage 等执行模块
    i18n/
      index.ts                CLI 文案
    openclaw/
      relay-manager.ts        OpenClaw 中继服务器桥接与命令分发
      gateway-client.ts       连接并认证本地 OpenClaw Gateway
      session-store.ts        OpenClaw 最新会话推断
      runtime/
        local-runtime.ts      解析 OpenClaw 可执行文件并触发网关生命周期
      handlers/
        local-handlers.ts     兼容旧命令前缀和本地维护命令
        provider-handlers.ts  provider 命令分发和网关重启
      config/
        provider-config.ts    provider 配置读写
        provider-registry.ts  provider 注册信息
      backups/
        backup-manager.ts     本地配置备份管理
      relay/
        session-context.ts    会话默认值和上下文使用量快照
        chat-history.ts       历史消息回退
        chat-send-attachments.ts 发送带附件消息的参数准备
        openclaw-voice-input.ts  OpenClaw 语音命令适配
        slash-command-catalog.ts OpenClaw slash command 目录
        slash-command-catalog.generated.ts 生成的 OpenClaw slash command 目录
    platform/
      service-manager.ts              跨平台服务入口
      service-manager-common.ts       通用平台辅助常量
      service-manager-linux.ts        Linux systemd/nohup 逻辑
      *.test.ts                       平台层单元测试
```

测试文件和源码采用邻近放置的方式，统一以 `*.test.ts` 命名。它们会被 `npm test` 执行，但不会进入发布包。

## 关键模块与功能

- `src/index.ts` 是 CLI 入口，负责命令注册和顶层错误处理。
- `src/commands/pair.ts` 负责主机配对、保存 relay 配置，并在配对后安装后台服务。
- `src/commands/run.ts` 负责前台启动 relay 循环，供服务管理或调试使用。
- `src/commands/send-file.ts` 是发送本地文件或图片到已配对聊天会话的 CLI wrapper。
- `src/commands/install.ts` 负责后台服务的安装、重启、停止、卸载和重置。
- `src/commands/set-token.ts` 负责在需要 token 鉴权时保存本地 Gateway Token。
- `src/core/relay/file-upload.ts` 是纯程序化 relay 文件上传服务，供 CLI 和 Hermes artifact delivery 复用。
- `src/core/relay/relay-server-connection.ts` 提供共享 relay URL、JSON 帧、abort close 和 close retry 判断。
- `src/core/relay/office-payload.ts`、`mobile-chat-run-bridge.ts`、`voice-input.ts`、`attachment-staging.ts`、`chat-payload.ts` 是 gateway-neutral 的 relay 工具。
- `src/openclaw/handlers/local-handlers.ts` 负责兼容旧命令前缀，以及备份、恢复、日志、doctor、gateway 重启等本地维护命令。
- `src/openclaw/runtime/local-runtime.ts` 负责解析 `openclaw` 可执行文件并触发网关生命周期动作。
- `src/openclaw/handlers/provider-handlers.ts` 负责 provider 专属命令分发，并复用同一套 gateway 重启逻辑。
- `src/openclaw/relay-manager.ts` 负责中继服务器与本地 OpenClaw Gateway 的桥接、命令分发，以及 chat/history 回退处理。
- `src/openclaw/gateway-client.ts` 负责连接 OpenClaw Gateway，并处理设备身份认证。
- `src/openclaw/relay/session-context.ts` 负责读取会话默认值和上下文使用量快照。
- `src/openclaw/relay/chat-history.ts`、`chat-send-attachments.ts` 负责 OpenClaw 专属历史回退和 `chat.send` 附件暂存。
- `src/hermes/hermes-relay-manager.ts` 负责 Hermes runtime 与 relay server 的桥接。
- `src/hermes/runtime/` 放置 Hermes CLI/Python、chat、cron、skills、models、sessions、usage 和 lifecycle 等执行模块。
- `src/config/env.ts` 负责加载 `.env` 文件，并集中维护 relay、Gateway 等 agent 默认配置。
- `src/platform/service-manager.ts` 负责 macOS、Linux 和 Windows 的跨平台服务管理入口。
- `src/config/config.ts` 负责读写 `~/.clawconnect` 下的本地配对配置。
- `src/i18n/index.ts` 负责 CLI 文案。

## 重要函数

- `pairCommand()` 负责主机配对、生成配对 payload，并持久化 relay 配置。
- `runCommand()` 负责启动前台 relay 客户端循环，供后台服务使用。
- `sendFileCommand()` 负责 CLI 配置、会话默认值和输出格式，并委托 `uploadFileToRelay()` 上传。
- `uploadFileToRelay()` 使用显式 relay URL、secret、gateway ID 和 session key 上传文件。
- `installCommand()`、`restartCommand()`、`stopCommand()`、`uninstallCommand()`、`resetCommand()` 负责服务生命周期管理。
- `statusCommand()` 负责打印配对配置、Gateway 状态和服务健康信息。
- `setTokenCommand()` 负责保存本地 OpenClaw Gateway Token。
- `handleLocalCommand()` 和 `handleProviderCommand()` 负责在转发前处理 OpenClaw 本地控制平面命令。
- `OpenClawGatewayClient` 负责管理 Gateway WebSocket、重连和请求/响应帧。
- `canonicalizeRelayParams()`、`extractGatewaySessionDefaults()`、`buildContextUsageFingerprint()` 负责统一 relay 协议 payload。
- `normalizeChatEventPayload()`、`extractChatText()`、`extractHistoryOutcome()`、`withMessageText()` 负责稳定聊天事件与历史回退结果。
- `buildAttachmentStagingPath()` 和 `resolveAttachmentFileName()` 负责附件暂存路径和文件名处理。
- `buildRelayUrl()`、`sendRelayJson()`、`parseRelayFrame()`、`shouldRetryRelayClose()` 负责 OpenClaw 和 Hermes 共享的窄 relay transport 行为。
- `getServiceStatus()`、`installService()`、`restartService()`、`stopService()`、`uninstallService()` 负责跨平台服务控制。

## 工作原理

整个链路如下：

1. 在主机上运行 `clawconnect pair`，向中继站注册当前设备
2. 使用移动端扫描二维码或输入访问码完成绑定
3. `ClawConnect Agent` 与中继站保持长连接
4. `ClawConnect Agent` 再连接本机 OpenClaw Gateway
5. 移动端的聊天、模型切换、技能操作等请求，通过中继转发到本机 OpenClaw
6. 本机文件可通过 `clawconnect send-file <path>` 发送到聊天会话，并在手机端作为文件消息展示

## 本地目录

代理默认使用以下目录：

```bash
~/.clawconnect/
```

常见文件包括：

- `config.json`：配对配置
- `.env`：agent 默认环境配置
- `device-identity.json`：本机身份信息
- `clawconnect.log`：运行日志
- `clawconnect-error.log`：错误日志
- `clawconnect-start.sh`：Linux `nohup` 启动脚本

## 前置要求

- macOS、Linux 或 Windows 10 / Server 2016+
- Node.js `18+`
- 本机已安装并可运行 `openclaw`
- 本机 OpenClaw Gateway 能正常启动

## 常见问题

### 配对成功但手机显示离线

优先检查：

- `clawconnect status`
- 中继服务器地址是否正确
- 本机网络是否可访问中继站
- 后台服务是否已启动

### 中继在线但 OpenClaw 连不上

检查：

- 本地 OpenClaw 是否正在运行
- Gateway 端口是否正确
- Gateway Token / Password 是否匹配

### 需要手动设置 Gateway Token

如果自动读取本地 OpenClaw 配置失败，可手动设置：

```bash
clawconnect set-token
```

## 建议

- 不要把此代理默认装在高敏感生产机器上
- 不使用远控时可执行 `clawconnect stop`
- 定期重置配对关系
- 不要泄露 `~/.clawconnect/config.json`

## 许可证

MIT
