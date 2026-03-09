# ClawConnect Agent 使用说明

`ClawConnect Agent` 是运行在 macOS 或 Linux 主机上的 OpenClaw 远程连接代理，用于把本机 OpenClaw Gateway 接入你的中继站，供移动端远程访问。

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

### 2. 前台运行

以当前终端前台方式启动代理：

```bash
clawconnect run
```

适合调试中继连接、本地 Gateway 鉴权和日志输出。

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

### 7. 卸载服务

移除后台服务定义，但保留本地配置：

```bash
clawconnect uninstall
```

### 8. 重置配对

停止服务并清除本地配对配置：

```bash
clawconnect reset
```

## 工作原理

整个链路如下：

1. 在主机上运行 `clawconnect pair`，向中继站注册当前设备
2. 使用移动端扫描二维码或输入访问码完成绑定
3. `ClawConnect Agent` 与中继站保持长连接
4. `ClawConnect Agent` 再连接本机 OpenClaw Gateway
5. 移动端的聊天、模型切换、技能操作等请求，通过中继转发到本机 OpenClaw

## 本地目录

代理默认使用以下目录：

```bash
~/.clawconnect/
```

常见文件包括：

- `config.json`：配对配置
- `device-identity.json`：本机身份信息
- `clawconnect.log`：运行日志
- `clawconnect-error.log`：错误日志
- `clawconnect-start.sh`：Linux `nohup` 启动脚本

## 前置要求

- macOS 或 Linux
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
