# Scripts

## `telegram-bridge.ts` (`telegram-bridge.mjs` shim)

An Effect-TS (v4) script that runs natively under Node.js v22+ (no build step) and connects a private Telegram chat to a local `firstmate` inbox.

- **Inbound (Telegram -> Firstmate):** Long-polls Telegram `getUpdates` (`timeout=30`) and submits allowed text messages idempotently via `<FIRSTMATE_HOME>/bin/fm-inbox.sh note --request-id tg-<update_id> --json -- <text>` without a shell.
- **Outbound (Firstmate -> Telegram):** Polls `<FIRSTMATE_HOME>/bin/fm-inbox.sh receipts --all-replies` on an Effect `Schedule` and sends each new reply once, splitting messages longer than 4000 characters at newline or space boundaries.
- **One-shot alerts (`--send`):** Sends a direct Telegram message from a command argument or stdin without starting the bridge loop.
- **Compatibility shim (`telegram-bridge.mjs`):** Thin CLI forwarder to `telegram-bridge.ts` so existing callers invoking `node scripts/telegram-bridge.mjs ...` keep working unchanged.

### Architecture

The implementation lives under `scripts/telegram-bridge/` and uses Effect v4 primitives:

- `Schema` decoders for config, Telegram Bot API payloads, `fm-inbox.sh` JSON responses, and persisted state (`.telegram-bridge-state.json`).
- `Schema.TaggedError` typed errors (`ConfigError`, `TelegramApiError`, `InboxCommandError`, `StateStoreError`).
- `Context.Service` and `Layer` abstractions (`BridgeConfig`, `BridgeLogger`, `TelegramClient`, `FirstmateInbox`, `StateStore`) for modular composition and in-memory unit testing.
- `Schedule` for bounded exponential backoff (honoring Telegram `retry_after`), announce retries, and outbound polling cadence.
- Fiber interruption and structured concurrency for clean `SIGINT` and `SIGTERM` shutdown without dangling handles.

### Security rules

- Keep secrets in a local `.env` file only. Never commit `.env` or real tokens.
- The bridge refuses to start if `CLANKER_UPDATES_TOKEN` is missing or invalid, or if `CLANKER_UPDATES_CHAT_ID` is not a positive numeric private chat ID.
- Only private chats whose `chat.id` strictly matches `CLANKER_UPDATES_CHAT_ID` are accepted. All other private chats, groups, supergroups, and channels are silently ignored.
- Local state is stored atomically in `.telegram-bridge-state.json` (gitignored, mode `0600`) so restarts do not replay old updates or duplicate delivered replies.
- Bot tokens are wrapped in `Redacted` and redacted from all logs, URLs, and error messages.

### Setup

1. Install dependencies with `pnpm` (requires Node.js v22.18+):

   ```bash
   pnpm install
   ```

2. Copy `.env.example` to `.env` in the repository root:

   ```bash
   cp .env.example .env
   chmod 600 .env
   ```

3. Edit `.env` with your bot token from `@BotFather` and your numeric private chat ID:

   ```dotenv
   CLANKER_UPDATES_TOKEN=your_bot_token
   CLANKER_UPDATES_CHAT_ID=123456789
   # Optional: defaults to $HOME/firstmate
   # FIRSTMATE_HOME=/path/to/firstmate
   ```

   Environment variables already set in the shell take precedence over `.env`.

### Running the bridge

```bash
node scripts/telegram-bridge.ts
```

The compatibility shim runs the same Effect-TS bridge:

```bash
node scripts/telegram-bridge.mjs
```

Optional flags:

- `--firstmate-home <dir>` - override `FIRSTMATE_HOME` (default: `$HOME/firstmate`)
- `--env-file <path>` - path to `.env` file (default: `<repo>/.env`)
- `--state-file <path>` - path to local state file (default: `<repo>/.telegram-bridge-state.json`)
- `--api-base <url>` - Telegram API base URL (default: `https://api.telegram.org`)
- `--poll-timeout <sec>` - Telegram `getUpdates` long-poll timeout in seconds (default: `30`)
- `--reply-poll-ms <ms>` - interval between outbound reply polls in milliseconds (default: `3000`)

Send `SIGINT` or `SIGTERM` for a clean shutdown.

### One-shot alerts (`--send`)

Send a direct alert using the same `.env` configuration:

```bash
node scripts/telegram-bridge.ts --send "Build finished"
```

Or read the alert body from stdin:

```bash
printf 'Worker wedged on lane 2\nCheck logs\n' | node scripts/telegram-bridge.ts --send -
```

You can wire either `scripts/telegram-bridge.ts` or `scripts/telegram-bridge.mjs` into firstmate `config/wedge-alarm` using a `command:` target:

```text
command: node /path/to/clanker_whips/scripts/telegram-bridge.ts --send -
```

### systemd user service example

Create `~/.config/systemd/user/clanker-telegram-bridge.service`:

```ini
[Unit]
Description=Clanker Whips Firstmate Telegram Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/clanker_whips
ExecStart=/usr/bin/env node /path/to/clanker_whips/scripts/telegram-bridge.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Enable and start the service:

```bash
systemctl --user daemon-reload
systemctl --user enable --now clanker-telegram-bridge.service
systemctl --user status clanker-telegram-bridge.service
```

### Verification and tests

Run typechecking and the test suite with Node's built-in test runner:

```bash
pnpm exec tsc --noEmit
node --test
```
