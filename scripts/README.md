# Scripts

## `telegram-bridge.mjs`

A zero-dependency Node.js script that connects a private Telegram chat to a local `firstmate` inbox.

- **Inbound (Telegram -> Firstmate):** Long-polls Telegram `getUpdates` (`timeout=30`) and submits allowed text messages idempotently via `<FIRSTMATE_HOME>/bin/fm-inbox.sh note --request-id tg-<update_id> --json -- <text>`.
- **Outbound (Firstmate -> Telegram):** Polls `<FIRSTMATE_HOME>/bin/fm-inbox.sh receipts --all-replies` and sends each new reply once, splitting messages longer than 4000 characters at newline or space boundaries.
- **One-shot alerts (`--send`):** Sends a direct Telegram message from a command or stdin without starting the bridge loop.

### Security rules

- Keep secrets in a local `.env` file only. Never commit `.env` or real tokens.
- The bridge refuses to start if `CLANKER_UPDATES_TOKEN` is missing or `CLANKER_UPDATES_CHAT_ID` is not a positive numeric chat ID.
- Only private chats whose `chat.id` strictly matches `CLANKER_UPDATES_CHAT_ID` are accepted. All other private chats, groups, supergroups, and channels are silently ignored.
- Local state is stored in `.telegram-bridge-state.json` (gitignored, mode `0600`) so restarts do not replay old updates or duplicate delivered replies.
- Error logs and exceptions redact the bot token.

### Setup

1. Copy `.env.example` to `.env` in the repository root:

   ```bash
   cp .env.example .env
   chmod 600 .env
   ```

2. Edit `.env` with your bot token from `@BotFather` and your numeric private chat ID:

   ```dotenv
   CLANKER_UPDATES_TOKEN=your_bot_token
   CLANKER_UPDATES_CHAT_ID=123456789
   # Optional: defaults to $HOME/firstmate
   # FIRSTMATE_HOME=/path/to/firstmate
   ```

   Environment variables already set in the shell take precedence over `.env`.

### Running the bridge

```bash
node scripts/telegram-bridge.mjs
```

Optional flags:

- `--firstmate-home <dir>` - override `FIRSTMATE_HOME` (default: `$HOME/firstmate`)
- `--env-file <path>` - path to `.env` file (default: `<repo>/.env`)
- `--state-file <path>` - path to local state file (default: `<repo>/.telegram-bridge-state.json`)
- `--poll-timeout <sec>` - Telegram `getUpdates` long-poll timeout in seconds (default: `30`)
- `--reply-poll-ms <ms>` - interval between outbound reply polls in milliseconds (default: `3000`)

Send `SIGINT` or `SIGTERM` for a clean shutdown.

### One-shot alerts (`--send`)

Send a direct alert using the same `.env` configuration:

```bash
node scripts/telegram-bridge.mjs --send "Build finished"
```

Or read the alert body from stdin:

```bash
printf 'Worker wedged on lane 2\nCheck logs\n' | node scripts/telegram-bridge.mjs --send -
```

You can also wire this into firstmate `config/wedge-alarm` using a `command:` target:

```text
command: node /path/to/clanker_whips/scripts/telegram-bridge.mjs --send -
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
ExecStart=/usr/bin/env node /path/to/clanker_whips/scripts/telegram-bridge.mjs
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

### Tests

Run the test suite with Node's built-in test runner:

```bash
node --test scripts/telegram-bridge.test.mjs
```
