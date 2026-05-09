# ClawConnect Agent

> OpenClaw host agent for macOS, Linux and Windows hosts — connects your gateway machine to your ClawConnect relay server.

## Installation

```bash
npm install -g clawconnect-agent
```

## Usage

### Pair

Generate a QR code for mobile pairing:

```bash
clawconnect pair
```

Print only the pairing code without rendering a QR code:

```bash
clawconnect pair --code-only
```

Options:
- `-n, --name <name>` — Display name for this host
- `-s, --server <url>` — Relay server URL
- `--code-only` — Print only the access code and skip QR code output

### Environment Configuration

For an installed agent, the CLI creates `~/.clawconnect/.env` with all configurable values documented as comments the first time `clawconnect` runs. You can edit that file to keep defaults in one place:

```bash
$EDITOR ~/.clawconnect/.env
```

When developing from this package directory, you can copy `.env.example` to `.env.local`. Existing `~/.clawconnect/.env` files are never overwritten automatically.

Supported values:

- `CLAWCONNECT_RELAY_SERVER_URL` — default relay URL used by `clawconnect pair` when `--server` is omitted
- `CLAWCONNECT_GATEWAY_URL` — optional local Gateway websocket URL override
- `CLAWCONNECT_ENV_FILE` — optional explicit env file path. When unset, the agent reads `~/.clawconnect/.env`, then `.env.local`, then `.env`
- `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD` — Gateway auth fallback
- `OPENCLAW_TTS_ENABLED`, `OPENCLAW_TTS_VOICE`, `OPENCLAW_TTS_RATE`, `OPENCLAW_TTS_ENGINE` — voice reply defaults

Shell environment variables take priority over env files. Existing pairing credentials in `~/.clawconnect/config.json` still take priority for `clawconnect run`, `status`, and `send-file`; run `clawconnect pair --server <url>` or `clawconnect reset` when you intentionally switch relay servers.

### Run

Start the host agent:

```bash
clawconnect run
```

Optional: enable assistant voice replies only when you want audio output by setting:

```bash
OPENCLAW_TTS_ENABLED=1 clawconnect run
```

When this flag is not set, assistant replies stay text-only.

### Check Status

Show pairing config and background service status:

```bash
clawconnect status
```

### Install Background Service

Install as a background service:

```bash
clawconnect install
```

- macOS: installs a `launchd` user agent
- Linux: prefers `systemd --user`, and falls back to `nohup` when `systemctl --user` is unavailable
- Windows: registers a Windows Task Scheduler task that auto-starts at logon with silent console (`powershell -WindowStyle Hidden`)

On Linux hosts without `systemd --user`, `clawconnect install` will generate a fallback launcher at:

```bash
~/.clawconnect/clawconnect-start.sh
```

You can start it manually with:

```bash
bash ~/.clawconnect/clawconnect-start.sh
```

### Restart Service

Restart the background service:

```bash
clawconnect restart
```

### Stop Service

Stop the host agent background service:

```bash
clawconnect stop
```

### Set Gateway Token

Store the OpenClaw Gateway token locally when token auth is enabled:

```bash
clawconnect set-token
```

### Remove Service

Remove the background service (keeps config):

```bash
clawconnect uninstall
```

### Reset Pairing

Stop the service and clear local pairing config:

```bash
clawconnect reset
```

### Update to the Latest Version

Upgrade the globally installed npm package and restart the background service automatically when one is installed:

```bash
clawconnect update
```

Notes:
- `update` runs `npm install -g clawconnect-agent@latest` under the hood.
- If you are running from a local source checkout instead of a global npm install, this command upgrades only the global package.
- If your npm global prefix requires elevated permissions, rerun the printed command with the privileges appropriate for your machine.

### Send Files / Images

Send a local file into the paired chat session:

```bash
clawconnect send-file ~/Pictures/demo.jpg
```

Options:
- `-g, --gateway <id>` — Override the gateway ID from local config
- `-s, --session <key>` — Target chat session key. If omitted, the latest active session is used
- `--json` — Print the upload result as JSON

Notes:
- `send-file` uploads through the relay and posts a file message to mobile.
- Image MIME types render as preview cards in the iPhone chat UI.
- `chat.send` attachments are local staging references, not the cross-device file transfer path.
- Voice replies are disabled by default; set `OPENCLAW_TTS_ENABLED=1` to have the agent synthesize assistant replies as audio files.
- The agent now prefers `edge-tts-universal` for synthesis and falls back to the computer's built-in TTS on failure.

## Project Structure

```text
clawconnect-agent/
  README.md
  README.zh-CN.md
  package.json
  tsconfig.json
  tsconfig.build.json
  src/
    index.ts
    commands/
      pair.ts
      run.ts
      send-file.ts
      status.ts
      install.ts
      set-token.ts
      local-handlers.ts
      local-runtime.ts
      provider-handlers.ts
      provider-config.ts
      provider-registry.ts
      backup-manager.ts
      send-file-utils.ts
      *.test.ts
    config/
      config.ts
      env.ts
    i18n/
      index.ts
    platform/
      service-manager.ts
      service-manager-common.ts
      service-manager-linux.ts
      *.test.ts
    relay/
      gateway-client.ts
      relay-manager.ts
      session-context.ts
      chat-payload.ts
      chat-history.ts
      attachment-staging.ts
      chat-send-attachments.ts
      reconnect.ts
      *.test.ts
```

Tests are colocated with the source as `*.test.ts`. They run with `npm test`, and the build/publish flow excludes them from the package tarball.

## Key Modules and Responsibilities

- `src/index.ts` is the CLI entrypoint. It wires every command together and handles top-level errors.
- `src/commands/pair.ts` registers a host, saves relay config, and installs the background service after pairing.
- `src/commands/run.ts` starts the relay loop in the foreground for service-managed or debug runs.
- `src/commands/send-file.ts` uploads local files or images into the paired chat session.
- `src/commands/install.ts` manages service install, restart, stop, uninstall, and reset flows.
- `src/commands/set-token.ts` stores a local Gateway token when token auth is required.
- `src/commands/local-handlers.ts` handles legacy command prefixes and local maintenance actions such as backup, restore, logs, doctor, and gateway restart.
- `src/commands/local-runtime.ts` resolves the `openclaw` binary and triggers gateway lifecycle actions.
- `src/commands/provider-handlers.ts` routes provider-specific commands and reuses the same gateway restart path.
- `src/config/env.ts` loads `.env` files and exposes agent defaults such as relay and Gateway URLs.
- `src/platform/service-manager.ts` exposes a cross-platform service facade for macOS, Linux, and Windows.
- `src/relay/relay-manager.ts` bridges the relay server and the local Gateway, dispatches commands, and handles chat/history fallbacks.
- `src/relay/gateway-client.ts` manages the websocket connection to OpenClaw Gateway and device authentication.
- `src/relay/session-context.ts` reads session defaults and context usage snapshots.
- `src/relay/chat-payload.ts`, `src/relay/chat-history.ts`, `src/relay/attachment-staging.ts`, and `src/relay/chat-send-attachments.ts` handle chat normalization, fallback, and attachment staging.
- `src/config/config.ts` reads and writes local pairing config under `~/.clawconnect`.
- `src/i18n/index.ts` contains the localized CLI strings.

## Key Functions

- `pairCommand()` registers a host, generates the pairing payload, and persists relay config.
- `runCommand()` starts the foreground relay client loop used by the background service.
- `sendFileCommand()` stages a local file and uploads it into the paired chat session.
- `installCommand()`, `restartCommand()`, `stopCommand()`, `uninstallCommand()`, and `resetCommand()` manage the service lifecycle.
- `statusCommand()` prints pairing config, gateway state, and service health.
- `setTokenCommand()` stores the local OpenClaw Gateway token.
- `handleLocalCommand()` and `handleProviderCommand()` process local control-plane commands before forwarding to the gateway.
- `OpenClawGatewayClient` manages the gateway websocket, reconnects, and request/response frames.
- `canonicalizeRelayParams()`, `extractGatewaySessionDefaults()`, and `buildContextUsageFingerprint()` normalize relay protocol payloads.
- `normalizeChatEventPayload()`, `extractChatText()`, `extractHistoryOutcome()`, and `withMessageText()` keep chat payloads stable across relay and gateway responses.
- `buildAttachmentStagingPath()` and `resolveAttachmentFileName()` manage file staging for attachments.
- `getServiceStatus()`, `installService()`, `restartService()`, `stopService()`, and `uninstallService()` implement platform-specific service control.

## How It Works

1. **Pair** — Generate a QR code
2. **Scan QR with mobile app** — iOS or Android app pairs with your host
3. **Run** — Host agent stays connected to your relay server
4. **Communicate** — Mobile app sends commands through the relay to OpenClaw
5. **Send files** — Use `clawconnect send-file <path>` to deliver a local file or image into the chat session

## Requirements

- macOS, Linux, or Windows 10 / Server 2016+
- Node.js 18+

## License

MIT
