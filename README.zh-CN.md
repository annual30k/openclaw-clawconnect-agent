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
- `--code-only`：只输出访问码，不打印二维码

### 环境配置

本地安装后的 agent 会在第一次运行 `clawconnect` 时自动创建 `~/.clawconnect/.env`，里面会用注释列出所有可配置项。你可以直接编辑这个文件集中维护默认配置：

```bash
$EDITOR ~/.clawconnect/.env
```

如果是在这个源码目录里开发，可以把 `.env.example` 复制为 `.env.local`。已有的 `~/.clawconnect/.env` 不会被自动覆盖。

支持的配置项：

- `CLAWCONNECT_RELAY_SERVER_URL`：未传 `--server` 时，`clawconnect pair` 使用的默认中继地址
- `CLAWCONNECT_GATEWAY_URL`：可选，本机 OpenClaw Gateway WebSocket 地址覆盖值
- `CLAWCONNECT_ENV_FILE`：可选，显式指定 env 文件路径；未设置时会依次读取 `~/.clawconnect/.env`、`.env.local`、`.env`
- `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`：Gateway 鉴权兜底值
- `OPENCLAW_TTS_ENABLED`、`OPENCLAW_TTS_VOICE`、`OPENCLAW_TTS_RATE`、`OPENCLAW_TTS_ENGINE`：语音回复默认值

Shell 里已经设置的环境变量优先级高于 env 文件。`clawconnect run`、`status`、`send-file` 会继续使用 `~/.clawconnect/config.json` 里已配对保存的 relay；如果要切换中继服务器，请执行 `clawconnect pair --server <url>` 或 `clawconnect reset`。

### 2. 前台运行

以当前终端前台方式启动代理：

```bash
clawconnect run
```

适合调试中继连接、本地 Gateway 鉴权和日志输出。

如果需要语音播报助手回复，可以显式开启：

```bash
OPENCLAW_TTS_ENABLED=1 clawconnect run
```

未设置这个开关时，助手回复保持纯文字。

### 3. 查看状态

查看当前配对信息、网关地址和后台服务状态：

```bash
clawconnect status
```

### 4. 安装后台服务

将代理安装成后台常驻服务：

```bash
clawconnect install
```

行为说明：

- macOS：安装为 `launchd` 用户服务
- Linux：优先使用 `systemd --user`
- 如果 Linux 当前环境不支持 `systemd --user`，会自动回退到 `nohup`
- Windows：注册为 Windows Task Scheduler 任务，登录时自动静默启动（`powershell -WindowStyle Hidden`）

在不支持 `systemd --user` 的 Linux 环境下，会生成一个备用启动脚本：

```bash
~/.clawconnect/clawconnect-start.sh
```

你也可以手动执行：

```bash
bash ~/.clawconnect/clawconnect-start.sh
```

### 5. 停止服务

停止后台代理服务：

```bash
clawconnect stop
```

### 6. 重启服务

重启后台代理服务：

```bash
clawconnect restart
```

### 7. 设置 Gateway Token

当本机 Gateway 使用 token 鉴权时，可以手动保存 token：

```bash
clawconnect set-token
```

### 8. 卸载服务

移除后台服务定义，但保留本地配置：

```bash
clawconnect uninstall
```

### 9. 重置配对

停止服务并清除本地配对配置：

```bash
clawconnect reset
```

### 10. 发送文件/图片

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
- 默认不启用语音回复；只有设置 `OPENCLAW_TTS_ENABLED=1` 时，agent 才会把助手回复合成为音频文件。
- 语音合成优先使用 `edge-tts-universal`，如果生成失败则回退到电脑自带的 TTS。

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
      local-handlers.ts       兼容旧命令前缀和本地维护命令
      local-runtime.ts        解析 OpenClaw 可执行文件并触发网关生命周期
      provider-handlers.ts    provider 命令分发和网关重启
      provider-config.ts      provider 配置读写
      provider-registry.ts    provider 注册信息
      backup-manager.ts       本地配置备份管理
      send-file-utils.ts      relay 地址和文件传输辅助
      *.test.ts               紧邻源码的单元测试
    config/
      config.ts               配对配置读写
      env.ts                  env 文件加载和 agent 默认配置
    i18n/
      index.ts                CLI 文案
    platform/
      service-manager.ts              跨平台服务入口
      service-manager-common.ts       通用平台辅助常量
      service-manager-linux.ts        Linux systemd/nohup 逻辑
      *.test.ts                       平台层单元测试
    relay/
      gateway-client.ts       连接并认证本地 OpenClaw Gateway
      relay-manager.ts        中继服务器桥接与命令分发
      session-context.ts      会话默认值和上下文使用量快照
      chat-payload.ts         聊天 payload 归一化
      chat-history.ts         历史消息回退
      attachment-staging.ts   附件本地落盘
      chat-send-attachments.ts 发送带附件消息的参数准备
      reconnect.ts            重连策略
      *.test.ts               relay 层单元测试
```

测试文件和源码采用邻近放置的方式，统一以 `*.test.ts` 命名。它们会被 `npm test` 执行，但不会进入发布包。

## 关键模块与功能

- `src/index.ts` 是 CLI 入口，负责命令注册和顶层错误处理。
- `src/commands/pair.ts` 负责主机配对、保存 relay 配置，并在配对后安装后台服务。
- `src/commands/run.ts` 负责前台启动 relay 循环，供服务管理或调试使用。
- `src/commands/send-file.ts` 负责把本地文件或图片上传到已配对的聊天会话。
- `src/commands/install.ts` 负责后台服务的安装、重启、停止、卸载和重置。
- `src/commands/set-token.ts` 负责在需要 token 鉴权时保存本地 Gateway Token。
- `src/commands/local-handlers.ts` 负责兼容旧命令前缀，以及备份、恢复、日志、doctor、gateway 重启等本地维护命令。
- `src/commands/local-runtime.ts` 负责解析 `openclaw` 可执行文件并触发网关生命周期动作。
- `src/commands/provider-handlers.ts` 负责 provider 专属命令分发，并复用同一套 gateway 重启逻辑。
- `src/config/env.ts` 负责加载 `.env` 文件，并集中维护 relay、Gateway 等 agent 默认配置。
- `src/platform/service-manager.ts` 负责 macOS、Linux 和 Windows 的跨平台服务管理入口。
- `src/relay/relay-manager.ts` 负责中继服务器与本地 Gateway 的桥接、命令分发，以及 chat/history 回退处理。
- `src/relay/gateway-client.ts` 负责连接 OpenClaw Gateway，并处理设备身份认证。
- `src/relay/session-context.ts` 负责读取会话默认值和上下文使用量快照。
- `src/relay/chat-payload.ts`、`src/relay/chat-history.ts`、`src/relay/attachment-staging.ts`、`src/relay/chat-send-attachments.ts` 负责聊天数据归一化、历史回退和附件暂存。
- `src/config/config.ts` 负责读写 `~/.clawconnect` 下的本地配对配置。
- `src/i18n/index.ts` 负责 CLI 文案。

## 重要函数

- `pairCommand()` 负责主机配对、生成配对 payload，并持久化 relay 配置。
- `runCommand()` 负责启动前台 relay 客户端循环，供后台服务使用。
- `sendFileCommand()` 负责暂存本地文件并上传到已配对的聊天会话。
- `installCommand()`、`restartCommand()`、`stopCommand()`、`uninstallCommand()`、`resetCommand()` 负责服务生命周期管理。
- `statusCommand()` 负责打印配对配置、Gateway 状态和服务健康信息。
- `setTokenCommand()` 负责保存本地 OpenClaw Gateway Token。
- `handleLocalCommand()` 和 `handleProviderCommand()` 负责在转发前处理本地控制平面命令。
- `OpenClawGatewayClient` 负责管理 Gateway WebSocket、重连和请求/响应帧。
- `canonicalizeRelayParams()`、`extractGatewaySessionDefaults()`、`buildContextUsageFingerprint()` 负责统一 relay 协议 payload。
- `normalizeChatEventPayload()`、`extractChatText()`、`extractHistoryOutcome()`、`withMessageText()` 负责稳定聊天事件与历史回退结果。
- `buildAttachmentStagingPath()` 和 `resolveAttachmentFileName()` 负责附件暂存路径和文件名处理。
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
