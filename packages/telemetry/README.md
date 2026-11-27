# @clanker-whips/telemetry

Local metrics and tracing pipeline for Pi coding agents.

This package runs natively on Node.js v22.18+ with Effect-TS v4 and Node's built-in `node:sqlite` (`DatabaseSync`). It needs zero native build scripts.

## What it captures

1. **Pi extension (`src/pi-extension.ts`)** - hooks Pi `tool_call` and `tool_result` events to record:
   - `command` events for `bash` tool calls (redacted command, working directory, exit code, duration, session ID, task ID).
   - `web_visit` events for web-search or browser tools and HTTP(S) URLs referenced in commands.
   - `file_download` events for download commands (`curl -o/-O`, `wget`, `git clone`, `pnpm add/install`, `npm install`, `pip install`, `cargo install`, `gh release download`) and file writes (`write`).
2. **Local outbound metadata proxy (`src/proxy.ts`)** - forwards HTTP and HTTPS traffic while logging metadata only:
   - Binds to `127.0.0.1` only by default.
   - Handles `CONNECT host:port` tunnels for HTTPS without TLS interception (logs host, port, duration, bytes in, bytes out).
   - Forwards plain HTTP requests and logs method, redacted URL, domain, status code, `content-type`, `content-disposition`, `content-length`, and bytes transferred.
   - Flags HTTP file downloads automatically from `Content-Disposition`, binary/archive `Content-Type`, or archive/binary URL extensions.

## Storage, correlation, and redaction

- Events follow an OpenTelemetry-shaped schema (`traceId`, `spanId`, `parentSpanId`, `timestamp`, `sessionId`, `taskId`, `eventType`, `durationMs`, `status`, and structured `attributes`).
- W3C `TRACEPARENT` headers and environment variables propagate trace and parent-span IDs across tool calls and proxy hops.
- Every event is redacted before it hits disk. Redaction removes `Bearer` and `Basic` credentials, `CLANKER_UPDATES_TOKEN`, Telegram `/bot<token>` paths, API key prefixes, sensitive environment assignments, URL userinfo, sensitive query parameters, and sensitive HTTP headers.
- Every event is written to both:
  - Append-only JSONL: `<dir>/events.jsonl` (mode `0600`)
  - Indexed local SQLite: `<dir>/telemetry.db` (mode `0600`, WAL mode)
- Default data directory: `CLANKER_TELEMETRY_DIR` or `<repo>/.telemetry`. All `.telemetry/`, `*.db`, `*.db-wal`, `*.db-shm`, and `*.jsonl` files are gitignored.

## Setup

### 1. Install workspace dependencies

```bash
pnpm install
```

### 2. Wire the Pi extension

Choose one option to load the extension in Pi:

**Option A - Add to `~/.pi/agent/settings.json`:**

```json
{
  "extensions": [
    "/path/to/clanker_whips/packages/telemetry/src/pi-extension.ts"
  ]
}
```

**Option B - Symlink into `~/.pi/agent/extensions/`:**

```bash
ln -s /path/to/clanker_whips/packages/telemetry/src/pi-extension.ts \
  ~/.pi/agent/extensions/clanker-telemetry.ts
```

**Option C - Load for a single Pi run:**

```bash
pi -e /path/to/clanker_whips/packages/telemetry/src/pi-extension.ts
```

Optional environment variables for the extension:

- `CLANKER_TELEMETRY_DIR` - directory for `events.jsonl` and `telemetry.db`
- `CLANKER_TASK_ID` (or `FIRSTMATE_TASK_ID`) - task identifier attached to spans
- `TRACEPARENT` - incoming W3C trace context (`00-<traceId>-<spanId>-<flags>`)
- `CLANKER_TELEMETRY_ALLOWED_DOMAINS` - comma-separated domain allowlist for anomaly alerts
- `CLANKER_TELEMETRY_MAX_DOWNLOAD_BYTES` - transfer size alert threshold in bytes
- `CLANKER_TELEMETRY_ALERT_CMD` - alert command receiving alert text on stdin

The extension logs warnings to stderr if storage fails and never blocks or crashes a Pi turn.

### 3. Run the local outbound metadata proxy

Start the proxy on localhost:

```bash
pnpm run telemetry -- proxy --port 8899
```

Point agent shells or tools at the proxy:

```bash
export HTTP_PROXY="http://127.0.0.1:8899"
export HTTPS_PROXY="http://127.0.0.1:8899"
export NO_PROXY="127.0.0.1,localhost"
```

Send `SIGINT` or `SIGTERM` for a clean shutdown.

### 4. Optional Telegram anomaly alerts

Pass `--allow-domain`, `--max-download-bytes`, and `--alert-cmd` to notify via `scripts/telegram-bridge.mjs --send -`:

```bash
pnpm run telemetry -- proxy \
  --port 8899 \
  --allow-domain github.com \
  --allow-domain "*.github.com" \
  --allow-domain registry.npmjs.org \
  --max-download-bytes 52428800 \
  --alert-cmd "node /path/to/clanker_whips/scripts/telegram-bridge.mjs --send -"
```

The alert command runs without a shell and receives the redacted alert body on stdin plus `CLANKER_ALERT_KIND`, `CLANKER_ALERT_DOMAIN`, and `CLANKER_ALERT_MESSAGE` environment variables.

## Querying metrics

```bash
# Totals plus top commands, top domains, and recent downloads
pnpm run telemetry -- summary --since 24h

# Recent shell commands (filterable by --since, --limit, --session, --task, --exit-code)
pnpm run telemetry -- commands --since 24h --limit 25

# Visited domains and transfer totals
pnpm run telemetry -- domains --since 7d --limit 20

# Recorded file downloads and file writes
pnpm run telemetry -- downloads --since 24h --limit 20

# Machine-readable JSON output
pnpm run telemetry -- summary --since 24h --json
```

Use `--dir <path>` on any subcommand to query a specific telemetry directory.

## Verification and tests

```bash
pnpm --filter @clanker-whips/telemetry run typecheck
pnpm --filter @clanker-whips/telemetry run test
```
