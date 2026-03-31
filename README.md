# ClawConnect Agent

> OpenClaw host agent for macOS and Linux hosts — connects your gateway machine to your ClawConnect relay server.

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

### Run

Start the host agent:

```bash
clawconnect run
```

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

On Linux hosts without `systemd --user`, `clawconnect install` will generate a fallback launcher at:

```bash
~/.clawconnect/clawconnect-start.sh
```

You can start it manually with:

```bash
bash ~/.clawconnect/clawconnect-start.sh
```

### Stop Service

Stop the host agent background service:

```bash
clawconnect stop
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

## How It Works

1. **Pair** — Generate a QR code
2. **Scan QR with mobile app** — iOS or Android app pairs with your host
3. **Run** — Host agent stays connected to your relay server
4. **Communicate** — Mobile app sends commands through the relay to OpenClaw
5. **Send files** — Use `clawconnect send-file <path>` to deliver a local file or image into the chat session

## Requirements

- macOS or Linux
- Node.js 18+

## License

MIT
