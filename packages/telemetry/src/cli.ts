#!/usr/bin/env node

import path from "node:path"
import { fileURLToPath } from "node:url"
import { Cause, Effect, Exit, Option } from "effect"

import type { AlertPolicy } from "./alerts.ts"
import { TelemetryConfigError } from "./errors.ts"
import { DEFAULT_PROXY_HOST, DEFAULT_PROXY_PORT, startTelemetryProxy } from "./proxy.ts"
import { redactText } from "./redact.ts"
import {
  openTelemetryStore,
  type CommandRecord,
  type DomainAggregate,
  type DownloadRecord,
  type QueryFilterOptions,
  type TelemetrySummary,
} from "./store.ts"

export const TELEMETRY_CLI_USAGE = `Usage: clanker-telemetry <command> [options]

Local metrics and tracing CLI for Pi agents (JSONL + SQLite + metadata proxy).

Commands:
  summary      Show totals, top commands, top domains, and recent downloads
  commands     List recorded shell commands
  domains      List visited domains and transfer totals
  downloads    List recorded file downloads and file writes
  proxy        Run the local outbound HTTP/HTTPS metadata-only forward proxy

Common query options:
  --since <duration|iso>   Filter events since relative duration (e.g. 30m, 24h, 7d) or ISO timestamp
  --limit <n>              Maximum number of rows (default: 20, summary top lists: 10)
  --session <id>           Filter by session ID
  --task <id>              Filter by task ID
  --domain <host>          Filter by domain name
  --exit-code <n>          Filter commands by exit code
  --dir <path>             Telemetry storage directory (default: CLANKER_TELEMETRY_DIR or <repo>/.telemetry)
  --json                   Output machine-readable JSON

Proxy options:
  --host <ip>                  Bind host (default: 127.0.0.1)
  --port <n>                   Listen port (default: 8899)
  --allow-domain <domain>      Allowlisted domain (repeatable or comma-separated; supports *.example.com)
  --max-download-bytes <n>     Alert threshold for large transfers in bytes
  --alert-cmd <cmd>            Command to run on anomaly alert (receives alert text on stdin)
  --allow-non-loopback         Explicitly allow binding proxy outside loopback (unsafe)

General options:
  -h, --help               Show this help message
`

const DURATION_UNITS_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

export function parseDurationToSinceMs(
  raw: string,
  nowMs: number = Date.now(),
): Effect.Effect<number, TelemetryConfigError> {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return Effect.fail(new TelemetryConfigError({ message: "--since value cannot be empty" }))
  }

  const relMatch = /^(\d+)(ms|s|m|h|d|w)$/i.exec(trimmed)
  if (relMatch?.[1] !== undefined && relMatch[2] !== undefined) {
    const amount = Number.parseInt(relMatch[1], 10)
    const unit = DURATION_UNITS_MS[relMatch[2].toLowerCase()]
    if (unit !== undefined && Number.isSafeInteger(amount)) {
      return Effect.succeed(Math.max(0, nowMs - amount * unit))
    }
  }

  const parsedDate = Date.parse(trimmed)
  if (!Number.isNaN(parsedDate)) {
    return Effect.succeed(Math.max(0, Math.round(parsedDate)))
  }

  return Effect.fail(
    new TelemetryConfigError({
      message: `Invalid --since value "${raw}". Use a duration like 15m, 24h, 7d or an ISO timestamp.`,
    }),
  )
}

export type TelemetrySubcommand = "summary" | "commands" | "domains" | "downloads" | "proxy"

export interface ParsedTelemetryCliArgs {
  readonly help: boolean
  readonly command: TelemetrySubcommand | undefined
  readonly since: string | undefined
  readonly limit: number | undefined
  readonly sessionId: string | undefined
  readonly taskId: string | undefined
  readonly domain: string | undefined
  readonly exitCode: number | undefined
  readonly dataDir: string | undefined
  readonly json: boolean
  readonly host: string | undefined
  readonly port: number | undefined
  readonly allowNonLoopback: boolean
  readonly allowedDomains: ReadonlyArray<string>
  readonly maxDownloadBytes: number | undefined
  readonly alertCmd: string | undefined
}

const VALID_COMMANDS = new Set<TelemetrySubcommand>([
  "summary",
  "commands",
  "domains",
  "downloads",
  "proxy",
])

function parseIntFlag(
  raw: string,
  flag: string,
  opts: { readonly min?: number | undefined; readonly max?: number | undefined } = {},
): Effect.Effect<number, TelemetryConfigError> {
  if (!/^-?\d+$/.test(raw.trim())) {
    return Effect.fail(new TelemetryConfigError({ message: `${flag} must be an integer` }))
  }
  const value = Number.parseInt(raw.trim(), 10)
  if (!Number.isSafeInteger(value)) {
    return Effect.fail(new TelemetryConfigError({ message: `${flag} is out of range` }))
  }
  if (opts.min !== undefined && value < opts.min) {
    return Effect.fail(new TelemetryConfigError({ message: `${flag} must be >= ${opts.min}` }))
  }
  if (opts.max !== undefined && value > opts.max) {
    return Effect.fail(new TelemetryConfigError({ message: `${flag} must be <= ${opts.max}` }))
  }
  return Effect.succeed(value)
}

export const parseTelemetryCliArgs = Effect.fn("parseTelemetryCliArgs")(function*(
  argv: ReadonlyArray<string>,
): Effect.fn.Return<ParsedTelemetryCliArgs, TelemetryConfigError> {
  let help = false
  let command: TelemetrySubcommand | undefined
  let since: string | undefined
  let limit: number | undefined
  let sessionId: string | undefined
  let taskId: string | undefined
  let domain: string | undefined
  let exitCode: number | undefined
  let dataDir: string | undefined
  let json = false
  let host: string | undefined
  let port: number | undefined
  let allowNonLoopback = false
  const allowedDomains: Array<string> = []
  let maxDownloadBytes: number | undefined
  let alertCmd: string | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined || arg === "--") {
      continue
    }
    if (arg === "-h" || arg === "--help") {
      help = true
      continue
    }
    if (arg === "--json") {
      json = true
      continue
    }
    if (arg === "--allow-non-loopback") {
      allowNonLoopback = true
      continue
    }

    if (!arg.startsWith("-") && command === undefined) {
      if (VALID_COMMANDS.has(arg as TelemetrySubcommand)) {
        command = arg as TelemetrySubcommand
        continue
      }
      return yield* new TelemetryConfigError({
        message: `Unknown command: ${arg}`,
      })
    }

    const eqIdx = arg.indexOf("=")
    const flag = eqIdx === -1 ? arg : arg.slice(0, eqIdx)

    const readValue = (): Effect.Effect<string, TelemetryConfigError> => {
      if (eqIdx !== -1) {
        return Effect.succeed(arg.slice(eqIdx + 1))
      }
      const next = argv[i + 1]
      if (next === undefined) {
        return Effect.fail(
          new TelemetryConfigError({
            message: `Missing value for option: ${flag}`,
          }),
        )
      }
      i += 1
      return Effect.succeed(next)
    }

    switch (flag) {
      case "--since":
        since = yield* readValue()
        break
      case "--limit":
        limit = yield* parseIntFlag(yield* readValue(), "--limit", { min: 1, max: 1000 })
        break
      case "--session":
        sessionId = yield* readValue()
        break
      case "--task":
        taskId = yield* readValue()
        break
      case "--domain":
        domain = yield* readValue()
        break
      case "--exit-code":
        exitCode = yield* parseIntFlag(yield* readValue(), "--exit-code")
        break
      case "--dir":
        dataDir = yield* readValue()
        break
      case "--host":
        host = yield* readValue()
        break
      case "--port":
        port = yield* parseIntFlag(yield* readValue(), "--port", { min: 0, max: 65535 })
        break
      case "--allow-domain": {
        const raw = yield* readValue()
        for (const item of raw.split(",")) {
          const cleaned = item.trim()
          if (cleaned.length > 0) {
            allowedDomains.push(cleaned)
          }
        }
        break
      }
      case "--max-download-bytes":
        maxDownloadBytes = yield* parseIntFlag(yield* readValue(), "--max-download-bytes", {
          min: 1,
        })
        break
      case "--alert-cmd":
        alertCmd = yield* readValue()
        break
      default:
        return yield* new TelemetryConfigError({
          message: `Unknown option: ${arg}`,
        })
    }
  }

  return {
    help,
    command,
    since,
    limit,
    sessionId,
    taskId,
    domain,
    exitCode,
    dataDir,
    json,
    host,
    port,
    allowNonLoopback,
    allowedDomains,
    maxDownloadBytes,
    alertCmd,
  }
})

export function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return "-"
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

function truncate(text: string, maxLen: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim()
  if (singleLine.length <= maxLen) {
    return singleLine
  }
  return `${singleLine.slice(0, Math.max(0, maxLen - 3))}...`
}

export function formatSummaryText(summary: TelemetrySummary): string {
  const lines: Array<string> = []
  lines.push("Telemetry Summary")
  lines.push("-----------------")
  if (summary.sinceMs !== null) {
    lines.push(`Window since : ${new Date(summary.sinceMs).toISOString()}`)
  }
  lines.push(
    `Totals       : ${summary.totalEvents} events (${summary.commandCount} commands, ${summary.webVisitCount} web visits, ${summary.fileDownloadCount} downloads, ${summary.errorCount} errors)`,
  )
  lines.push(`Bytes        : ${formatBytes(summary.totalBytesTransferred)}`)

  lines.push("")
  lines.push("Top Commands:")
  if (summary.topCommands.length === 0) {
    lines.push("  (none)")
  } else {
    for (const item of summary.topCommands) {
      lines.push(
        `  ${String(item.count).padStart(4)}x  err=${item.errorCount}  avg=${item.avgDurationMs}ms  ${truncate(item.command, 90)}`,
      )
    }
  }

  lines.push("")
  lines.push("Top Domains:")
  if (summary.topDomains.length === 0) {
    lines.push("  (none)")
  } else {
    for (const item of summary.topDomains) {
      lines.push(
        `  ${item.domain} - visits=${item.visits} downloads=${item.downloads} err=${item.errorCount} bytes=${formatBytes(item.totalBytes)}`,
      )
    }
  }

  lines.push("")
  lines.push("Recent Downloads:")
  if (summary.recentDownloads.length === 0) {
    lines.push("  (none)")
  } else {
    for (const item of summary.recentDownloads) {
      const target = item.filename ?? item.destinationPath ?? item.url ?? "(unknown)"
      lines.push(
        `  ${item.timestamp}  ${item.domain ?? "local"}  ${truncate(target, 60)}  via=${item.via ?? "-"}  bytes=${formatBytes(item.bytesTransferred)}`,
      )
    }
  }

  return `${lines.join("\n")}\n`
}

export function formatCommandsText(rows: ReadonlyArray<CommandRecord>): string {
  if (rows.length === 0) {
    return "No commands recorded.\n"
  }
  const lines = rows.map((row) =>
    `${row.timestamp}  exit=${row.exitCode ?? "-"}  ${row.durationMs}ms  ${truncate(row.command, 100)}`
  )
  return `${lines.join("\n")}\n`
}

export function formatDomainsText(rows: ReadonlyArray<DomainAggregate>): string {
  if (rows.length === 0) {
    return "No domains recorded.\n"
  }
  const lines = rows.map((row) =>
    `${row.domain}  visits=${row.visits}  downloads=${row.downloads}  errors=${row.errorCount}  bytes=${formatBytes(row.totalBytes)}  last=${row.lastSeen}`
  )
  return `${lines.join("\n")}\n`
}

export function formatDownloadsText(rows: ReadonlyArray<DownloadRecord>): string {
  if (rows.length === 0) {
    return "No downloads recorded.\n"
  }
  const lines = rows.map((row) => {
    const target = row.filename ?? row.destinationPath ?? row.url ?? "(unknown)"
    return `${row.timestamp}  ${row.domain ?? "local"}  ${truncate(target, 60)}  via=${row.via ?? "-"}  status=${row.statusCode ?? row.status}  bytes=${formatBytes(row.bytesTransferred)}`
  })
  return `${lines.join("\n")}\n`
}

function extractFailureMessage(cause: Cause.Cause<unknown>): string {
  const errOpt = Cause.findErrorOption(cause)
  if (Option.isSome(errOpt)) {
    const err = errOpt.value
    if (typeof err === "object" && err !== null && "message" in err && typeof err.message === "string") {
      return err.message
    }
    return String(err)
  }
  const squashed = Cause.squash(cause)
  if (squashed instanceof Error) {
    return squashed.message
  }
  return String(squashed)
}

export interface RunTelemetryCliOptions {
  readonly stdout?: ((chunk: string) => void) | undefined
  readonly stderr?: ((chunk: string) => void) | undefined
  readonly nowMs?: number | undefined
}

export async function runTelemetryCli(
  argv: ReadonlyArray<string> = process.argv.slice(2),
  options: RunTelemetryCliOptions = {},
): Promise<number> {
  const writeOut = options.stdout ?? ((chunk: string) => process.stdout.write(chunk))
  const writeErr = options.stderr ?? ((chunk: string) => process.stderr.write(chunk))

  const parsedExit = await Effect.runPromiseExit(parseTelemetryCliArgs(argv))
  if (Exit.isFailure(parsedExit)) {
    writeErr(`[clanker-telemetry] ERROR: ${redactText(extractFailureMessage(parsedExit.cause))}\n`)
    return 1
  }

  const cli = parsedExit.value
  if (cli.help || cli.command === undefined) {
    writeOut(TELEMETRY_CLI_USAGE)
    return 0
  }

  if (cli.command === "proxy") {
    const alertPolicy: AlertPolicy | undefined =
      cli.alertCmd !== undefined ||
        cli.allowedDomains.length > 0 ||
        cli.maxDownloadBytes !== undefined
        ? {
          alertCmd: cli.alertCmd,
          allowedDomains: cli.allowedDomains.length > 0 ? cli.allowedDomains : undefined,
          maxDownloadBytes: cli.maxDownloadBytes,
        }
        : undefined

    const startExit = await Effect.runPromiseExit(
      startTelemetryProxy({
        host: cli.host ?? DEFAULT_PROXY_HOST,
        port: cli.port ?? DEFAULT_PROXY_PORT,
        allowNonLoopback: cli.allowNonLoopback,
        storeOptions: { dataDir: cli.dataDir },
        alertPolicy,
        sessionId: cli.sessionId,
        taskId: cli.taskId,
        onLog: (line) => writeOut(`${line}\n`),
        onError: (line) => writeErr(`${line}\n`),
      }),
    )

    if (Exit.isFailure(startExit)) {
      writeErr(`[clanker-telemetry] ERROR: ${redactText(extractFailureMessage(startExit.cause))}\n`)
      return 1
    }

    const running = startExit.value
    await new Promise<void>((resolve) => {
      let stopping = false
      const onSignal = (sig: NodeJS.Signals) => {
        if (stopping) {
          return
        }
        stopping = true
        writeOut(`[telemetry-proxy] received ${sig}, shutting down\n`)
        void running.stop().finally(() => {
          process.removeListener("SIGINT", onSignal)
          process.removeListener("SIGTERM", onSignal)
          resolve()
        })
      }
      process.once("SIGINT", onSignal)
      process.once("SIGTERM", onSignal)
    })
    return 0
  }

  let sinceMs: number | undefined
  if (cli.since !== undefined) {
    const sinceExit = await Effect.runPromiseExit(
      parseDurationToSinceMs(cli.since, options.nowMs),
    )
    if (Exit.isFailure(sinceExit)) {
      writeErr(`[clanker-telemetry] ERROR: ${redactText(extractFailureMessage(sinceExit.cause))}\n`)
      return 1
    }
    sinceMs = sinceExit.value
  }

  const filter: QueryFilterOptions = {
    sinceMs,
    limit: cli.limit,
    sessionId: cli.sessionId,
    taskId: cli.taskId,
    domain: cli.domain,
    exitCode: cli.exitCode,
  }

  const queryCommand = cli.command

  const queryProgram = Effect.scoped(
    Effect.gen(function*() {
      const store = yield* Effect.acquireRelease(
        openTelemetryStore({ dataDir: cli.dataDir }),
        (s) => s.close.pipe(Effect.ignore),
      )

      switch (queryCommand) {
        case "summary": {
          const summary = yield* store.querySummary({
            ...filter,
            limit: cli.limit ?? 10,
          })
          return cli.json ? `${JSON.stringify(summary, null, 2)}\n` : formatSummaryText(summary)
        }
        case "commands": {
          const rows = yield* store.queryCommands({
            ...filter,
            limit: cli.limit ?? 20,
          })
          return cli.json ? `${JSON.stringify(rows, null, 2)}\n` : formatCommandsText(rows)
        }
        case "domains": {
          const rows = yield* store.queryDomains({
            ...filter,
            limit: cli.limit ?? 20,
          })
          return cli.json ? `${JSON.stringify(rows, null, 2)}\n` : formatDomainsText(rows)
        }
        case "downloads": {
          const rows = yield* store.queryDownloads({
            ...filter,
            limit: cli.limit ?? 20,
          })
          return cli.json ? `${JSON.stringify(rows, null, 2)}\n` : formatDownloadsText(rows)
        }
      }
    }),
  )

  const queryExit = await Effect.runPromiseExit(queryProgram)
  if (Exit.isFailure(queryExit)) {
    writeErr(`[clanker-telemetry] ERROR: ${redactText(extractFailureMessage(queryExit.cause))}\n`)
    return 1
  }

  writeOut(queryExit.value)
  return 0
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectExecution) {
  const exitCode = await runTelemetryCli()
  process.exitCode = exitCode
}
