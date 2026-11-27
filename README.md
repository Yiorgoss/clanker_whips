# clanker_whips

Agent skills, packages, scripts, and lints pnpm workspace monorepo.

## Requirements

- Node.js `>=22.18.0` (native TypeScript execution and built-in `node:sqlite`)
- `pnpm`

## Workspace layout

- `packages/telegram-bridge` (`@clanker-whips/telegram-bridge`) - Effect-TS two-way Telegram bridge for firstmate (`--send` one-shot alerts and long-polling bridge).
- `packages/telemetry` (`@clanker-whips/telemetry`) - Local metrics and tracing pipeline for Pi agents: Pi `tool_call`/`tool_result` extension, local outbound HTTP/HTTPS metadata-only forward proxy, append-only OTel-shaped JSONL + SQLite store, CLI query tool, and optional anomaly alert hook. See [`packages/telemetry/README.md`](packages/telemetry/README.md).
- `scripts/` - Compatibility CLI entrypoints (`scripts/telegram-bridge.ts` and `scripts/telegram-bridge.mjs`) forwarding to `@clanker-whips/telegram-bridge`. See [`scripts/README.md`](scripts/README.md).
- `skills/` - Reusable agent skills:
  - [`tigerstyle`](skills/tigerstyle/SKILL.md) - TigerStyle programming principles ordered by safety, performance, and developer experience.
- `lints/` - Workspace lint packages (_none yet_).

## Common commands

```bash
# Install workspace links and dependencies
pnpm install

# Typecheck root scripts and all workspace packages
pnpm run typecheck

# Run all workspace test suites
pnpm test

# Run the telemetry CLI
pnpm run telemetry -- --help

# Run the Telegram bridge compatibility entrypoint
node scripts/telegram-bridge.mjs --help
```
