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
- `-p, --profile <name>` — Local profile name. Use separate profiles when pairing more than one gateway type on the same host
- `--gateway-type <type>` — Gateway type: `openclaw` or `hermes`
- `--code-only` — Print only the access code and skip QR code output

### Pair OpenClaw and Hermes Agent on the Same Host

Use separate ClawConnect profiles so OpenClaw and Hermes Agent do not share the same local config, log file, or background service.

Pair OpenClaw:

```bash
clawconnect pair-openclaw
```

Pair Hermes Agent:

```bash
clawconnect pair-hermes
```

When using the local development relay at `http://127.0.0.1:8080`, add `--local`:

```bash
clawconnect pair-openclaw --local
clawconnect pair-hermes --local
```

The shortcut commands expand to the profile-aware form below.

OpenClaw:

```bash
clawconnect pair \
  --profile openclaw \
  --server http://127.0.0.1:8080 \
  --gateway-type openclaw \
  --name "Mac OpenClaw"
```

Hermes Agent:

```bash
clawconnect pair \
  --profile hermes \
  --server http://127.0.0.1:8080 \
  --gateway-type hermes \
  --name "Mac Hermes Agent"
```

After each command, scan the QR code in the mobile app or enter the printed access code. The pairing payload includes `gatewayType`, and the relay rejects mismatched pairing attempts so an OpenClaw mobile gateway cannot bind to a Hermes Agent host, or the reverse.

Check both instances:

```bash
clawconnect status-all
```

Restart or stop a single instance:

```bash
clawconnect restart-openclaw
clawconnect restart-hermes
clawconnect stop-openclaw
clawconnect stop-hermes
```

Profile config files:

```text
~/.clawconnect/profiles/openclaw/config.json
~/.clawconnect/profiles/hermes/config.json
```

macOS launchd service labels:

```text
com.openclaw.clawconnect.agent.openclaw
com.openclaw.clawconnect.agent.hermes
```

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
- `OPENCLAW_ASR_COMMAND` — host-side speech-to-text command for ClawLink `chat.voice.send` messages. The agent saves the audio to a temporary file and runs this command; it must print the transcript to stdout. Placeholders: `{file}`, `{language}`, `{mimeType}`

Shell environment variables take priority over env files. Existing pairing credentials in `~/.clawconnect/config.json` or `~/.clawconnect/profiles/<profile>/config.json` still take priority for `clawconnect run`, `status`, and `send-file`; run `clawconnect pair --profile <name> --server <url>` or `clawconnect reset --profile <name>` when you intentionally switch relay servers.

### Run

Start the host agent:

```bash
clawconnect run
```

Optional: let ClawLink send raw voice messages and have the host transcribe them before forwarding text to OpenClaw or Hermes Agent:

```bash
OPENCLAW_ASR_COMMAND='/usr/local/bin/transcribe-audio {file} {language}' clawconnect run
```

If `OPENCLAW_ASR_COMMAND` is not configured, voice messages fail with `voice_asr_not_configured`.

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
