import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { Context, Effect, Layer, Semaphore } from "effect"

import { createAlertDispatcher, type AlertDispatcher, type AlertPolicy } from "./alerts.ts"
import { TelemetryStoreError } from "./errors.ts"
import {
  encodeTelemetryEventJson,
  redactTelemetryEvent,
  type TelemetryEvent,
  type TelemetryEventStatus,
  type TelemetryEventType,
} from "./schemas.ts"

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(MODULE_DIR, "..", "..", "..")
export const DEFAULT_TELEMETRY_DIR = path.join(REPO_ROOT, ".telemetry")
export const DEFAULT_JSONL_FILENAME = "events.jsonl"
export const DEFAULT_DB_FILENAME = "telemetry.db"

export interface TelemetryStoreOptions {
  readonly dataDir?: string | undefined
  readonly jsonlPath?: string | undefined
  readonly dbPath?: string | undefined
  readonly extraSecrets?: ReadonlyArray<string> | undefined
  readonly alertPolicy?: AlertPolicy | undefined
  readonly alertDispatcher?: AlertDispatcher | undefined
  readonly onAlertError?: ((message: string) => void) | undefined
}

export interface QueryFilterOptions {
  readonly sinceMs?: number | undefined
  readonly limit?: number | undefined
  readonly sessionId?: string | undefined
  readonly taskId?: string | undefined
  readonly domain?: string | undefined
  readonly exitCode?: number | undefined
}

export interface CommandRecord {
  readonly id: number
  readonly traceId: string
  readonly spanId: string
  readonly timestamp: string
  readonly timestampMs: number
  readonly sessionId: string | null
  readonly taskId: string | null
  readonly command: string
  readonly cwd: string | null
  readonly exitCode: number | null
  readonly durationMs: number
  readonly status: TelemetryEventStatus
}

export interface DomainAggregate {
  readonly domain: string
  readonly visits: number
  readonly downloads: number
  readonly errorCount: number
  readonly totalBytes: number
  readonly avgDurationMs: number
  readonly lastSeen: string
}

export interface DownloadRecord {
  readonly id: number
  readonly traceId: string
  readonly spanId: string
  readonly timestamp: string
  readonly timestampMs: number
  readonly sessionId: string | null
  readonly taskId: string | null
  readonly domain: string | null
  readonly url: string | null
  readonly filename: string | null
  readonly destinationPath: string | null
  readonly via: string | null
  readonly contentType: string | null
  readonly statusCode: number | null
  readonly bytesTransferred: number | null
  readonly durationMs: number
  readonly status: TelemetryEventStatus
}

export interface TopCommandAggregate {
  readonly command: string
  readonly count: number
  readonly errorCount: number
  readonly avgDurationMs: number
}

export interface TelemetrySummary {
  readonly sinceMs: number | null
  readonly totalEvents: number
  readonly commandCount: number
  readonly webVisitCount: number
  readonly fileDownloadCount: number
  readonly errorCount: number
  readonly totalBytesTransferred: number
  readonly topCommands: ReadonlyArray<TopCommandAggregate>
  readonly topDomains: ReadonlyArray<DomainAggregate>
  readonly recentDownloads: ReadonlyArray<DownloadRecord>
}

export interface TelemetryStoreShape {
  readonly jsonlPath: string
  readonly dbPath: string
  readonly record: (event: TelemetryEvent) => Effect.Effect<TelemetryEvent, TelemetryStoreError>
  readonly querySummary: (
    options?: QueryFilterOptions,
  ) => Effect.Effect<TelemetrySummary, TelemetryStoreError>
  readonly queryCommands: (
    options?: QueryFilterOptions,
  ) => Effect.Effect<ReadonlyArray<CommandRecord>, TelemetryStoreError>
  readonly queryDomains: (
    options?: QueryFilterOptions,
  ) => Effect.Effect<ReadonlyArray<DomainAggregate>, TelemetryStoreError>
  readonly queryDownloads: (
    options?: QueryFilterOptions,
  ) => Effect.Effect<ReadonlyArray<DownloadRecord>, TelemetryStoreError>
  readonly queryEvents: (
    options?: QueryFilterOptions & { readonly eventType?: TelemetryEventType | undefined },
  ) => Effect.Effect<ReadonlyArray<TelemetryEvent>, TelemetryStoreError>
  readonly close: Effect.Effect<void, TelemetryStoreError>
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS telemetry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  timestamp TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  session_id TEXT,
  task_id TEXT,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  name TEXT NOT NULL,
  duration_ms REAL NOT NULL,
  status TEXT NOT NULL,
  domain TEXT,
  command TEXT,
  url TEXT,
  filename TEXT,
  destination_path TEXT,
  via TEXT,
  content_type TEXT,
  cwd TEXT,
  exit_code INTEGER,
  status_code INTEGER,
  bytes_transferred INTEGER,
  attributes_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_timestamp_ms
  ON telemetry_events(timestamp_ms DESC);

CREATE INDEX IF NOT EXISTS idx_events_type_ts
  ON telemetry_events(event_type, timestamp_ms DESC);

CREATE INDEX IF NOT EXISTS idx_events_domain_ts
  ON telemetry_events(domain, timestamp_ms DESC);

CREATE INDEX IF NOT EXISTS idx_events_session_task_ts
  ON telemetry_events(session_id, task_id, timestamp_ms DESC);

CREATE INDEX IF NOT EXISTS idx_events_exit_code_ts
  ON telemetry_events(exit_code, timestamp_ms DESC);

CREATE INDEX IF NOT EXISTS idx_events_trace_id
  ON telemetry_events(trace_id);
`

export function resolveTelemetryPaths(options: TelemetryStoreOptions = {}): {
  readonly dataDir: string
  readonly jsonlPath: string
  readonly dbPath: string
} {
  const envDir = process.env.CLANKER_TELEMETRY_DIR
  const dataDir = path.resolve(
    options.dataDir ?? (envDir && envDir.trim().length > 0 ? envDir : DEFAULT_TELEMETRY_DIR),
  )
  const jsonlPath = path.resolve(options.jsonlPath ?? path.join(dataDir, DEFAULT_JSONL_FILENAME))
  const dbPath = path.resolve(options.dbPath ?? path.join(dataDir, DEFAULT_DB_FILENAME))
  return { dataDir, jsonlPath, dbPath }
}

function asNullableString(val: unknown): string | null {
  return typeof val === "string" && val.length > 0 ? val : null
}

function asNullableInt(val: unknown): number | null {
  return typeof val === "number" && Number.isInteger(val) ? val : null
}

function buildWhereClause(
  options: QueryFilterOptions & { readonly eventType?: TelemetryEventType | undefined },
): { readonly sql: string; readonly params: Array<SQLInputValue> } {
  const clauses: Array<string> = []
  const params: Array<SQLInputValue> = []

  if (options.eventType !== undefined) {
    clauses.push("event_type = ?")
    params.push(options.eventType)
  }
  if (options.sinceMs !== undefined) {
    clauses.push("timestamp_ms >= ?")
    params.push(Math.max(0, Math.round(options.sinceMs)))
  }
  if (options.sessionId !== undefined) {
    clauses.push("session_id = ?")
    params.push(options.sessionId)
  }
  if (options.taskId !== undefined) {
    clauses.push("task_id = ?")
    params.push(options.taskId)
  }
  if (options.domain !== undefined) {
    clauses.push("domain = ?")
    params.push(options.domain.toLowerCase())
  }
  if (options.exitCode !== undefined) {
    clauses.push("exit_code = ?")
    params.push(options.exitCode)
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  }
}

export const openTelemetryStore = Effect.fn("openTelemetryStore")(function*(
  options: TelemetryStoreOptions = {},
): Effect.fn.Return<TelemetryStoreShape, TelemetryStoreError> {
  const { jsonlPath, dbPath } = resolveTelemetryPaths(options)
  const extraSecrets = options.extraSecrets ?? []
  const alertDispatcher = options.alertDispatcher ?? (
    options.alertPolicy !== undefined
      ? createAlertDispatcher(options.alertPolicy, { onError: options.onAlertError })
      : undefined
  )

  const db = yield* Effect.try({
    try: () => {
      fsSync.mkdirSync(path.dirname(jsonlPath), { recursive: true, mode: 0o700 })
      fsSync.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 })

      const database = new DatabaseSync(dbPath)
      database.exec("PRAGMA journal_mode = WAL;")
      database.exec("PRAGMA synchronous = NORMAL;")
      database.exec("PRAGMA busy_timeout = 5000;")
      database.exec(SCHEMA_SQL)

      try {
        fsSync.chmodSync(dbPath, 0o600)
      } catch {
        // best-effort on platforms/filesystems without POSIX chmod
      }

      return database
    },
    catch: (err) =>
      new TelemetryStoreError({
        operation: "init",
        path: dbPath,
        message: `Failed to initialize telemetry store: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }),
  })

  const insertStmt = db.prepare(`
    INSERT INTO telemetry_events (
      trace_id,
      span_id,
      parent_span_id,
      timestamp,
      timestamp_ms,
      session_id,
      task_id,
      source,
      event_type,
      name,
      duration_ms,
      status,
      domain,
      command,
      url,
      filename,
      destination_path,
      via,
      content_type,
      cwd,
      exit_code,
      status_code,
      bytes_transferred,
      attributes_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const writeLock = yield* Semaphore.make(1)
  let closed = false

  const record = Effect.fn("TelemetryStore.record")(function*(
    rawEvent: TelemetryEvent,
  ): Effect.fn.Return<TelemetryEvent, TelemetryStoreError> {
    if (closed) {
      return yield* new TelemetryStoreError({
        operation: "write",
        path: dbPath,
        message: "Telemetry store is closed",
      })
    }

    const event = redactTelemetryEvent(rawEvent, extraSecrets)

    const encodedLine = yield* encodeTelemetryEventJson(event).pipe(
      Effect.mapError((err) =>
        new TelemetryStoreError({
          operation: "write",
          path: jsonlPath,
          message: `Failed to encode telemetry event: ${err.message}`,
        })
      ),
    )

    yield* writeLock.withPermit(
      Effect.gen(function*() {
        if (closed) {
          return yield* new TelemetryStoreError({
            operation: "write",
            path: dbPath,
            message: "Telemetry store is closed",
          })
        }

        yield* Effect.tryPromise({
          try: async () => {
            await fs.mkdir(path.dirname(jsonlPath), { recursive: true, mode: 0o700 })
            await fs.appendFile(jsonlPath, `${encodedLine}\n`, {
              encoding: "utf8",
              mode: 0o600,
            })
            await fs.chmod(jsonlPath, 0o600).catch(() => {})
          },
          catch: (err) =>
            new TelemetryStoreError({
              operation: "write",
              path: jsonlPath,
              message: `Failed to append JSONL telemetry event: ${
                err instanceof Error ? err.message : String(err)
              }`,
            }),
        })

        yield* Effect.try({
          try: () => {
            const attrs = event.attributes
            insertStmt.run(
              event.traceId,
              event.spanId,
              event.parentSpanId,
              event.timestamp,
              event.timestampMs,
              event.sessionId,
              event.taskId,
              event.source,
              event.eventType,
              event.name,
              event.durationMs,
              event.status,
              event.domain,
              asNullableString(attrs.command),
              asNullableString(attrs.url),
              asNullableString(attrs.filename),
              asNullableString(attrs.destinationPath),
              asNullableString(attrs.via),
              asNullableString(attrs.contentType),
              asNullableString(attrs.cwd),
              event.exitCode,
              asNullableInt(attrs.statusCode),
              event.bytesTransferred,
              JSON.stringify(attrs),
            )
          },
          catch: (err) =>
            new TelemetryStoreError({
              operation: "write",
              path: dbPath,
              message: `Failed to insert SQLite telemetry event: ${
                err instanceof Error ? err.message : String(err)
              }`,
            }),
        })
      }),
    )

    if (alertDispatcher !== undefined) {
      yield* alertDispatcher.inspectAndAlert(event)
    }

    return event
  })

  const queryCommands = Effect.fn("TelemetryStore.queryCommands")(function*(
    filter: QueryFilterOptions = {},
  ): Effect.fn.Return<ReadonlyArray<CommandRecord>, TelemetryStoreError> {
    return yield* Effect.try({
      try: () => {
        const limit = Math.max(1, Math.min(1000, Math.round(filter.limit ?? 50)))
        const where = buildWhereClause({ ...filter, eventType: "command" })
        const stmt = db.prepare(`
          SELECT
            id, trace_id, span_id, timestamp, timestamp_ms, session_id, task_id,
            command, cwd, exit_code, duration_ms, status, name
          FROM telemetry_events
          ${where.sql}
          ORDER BY timestamp_ms DESC, id DESC
          LIMIT ?
        `)
        const rows = stmt.all(...where.params, limit) as Array<Record<string, unknown>>
        return rows.map((row) => ({
          id: Number(row.id),
          traceId: String(row.trace_id),
          spanId: String(row.span_id),
          timestamp: String(row.timestamp),
          timestampMs: Number(row.timestamp_ms),
          sessionId: row.session_id === null ? null : String(row.session_id),
          taskId: row.task_id === null ? null : String(row.task_id),
          command: row.command === null ? String(row.name) : String(row.command),
          cwd: row.cwd === null ? null : String(row.cwd),
          exitCode: row.exit_code === null ? null : Number(row.exit_code),
          durationMs: Number(row.duration_ms),
          status: String(row.status) as TelemetryEventStatus,
        }))
      },
      catch: (err) =>
        new TelemetryStoreError({
          operation: "query",
          path: dbPath,
          message: `Failed to query commands: ${err instanceof Error ? err.message : String(err)}`,
        }),
    })
  })

  const queryDomains = Effect.fn("TelemetryStore.queryDomains")(function*(
    filter: QueryFilterOptions = {},
  ): Effect.fn.Return<ReadonlyArray<DomainAggregate>, TelemetryStoreError> {
    return yield* Effect.try({
      try: () => {
        const limit = Math.max(1, Math.min(1000, Math.round(filter.limit ?? 50)))
        const where = buildWhereClause(filter)
        const extraClause = where.sql.length > 0
          ? `${where.sql} AND domain IS NOT NULL AND domain != ''`
          : "WHERE domain IS NOT NULL AND domain != ''"
        const stmt = db.prepare(`
          SELECT
            domain,
            SUM(CASE WHEN event_type = 'web_visit' THEN 1 ELSE 0 END) AS visits,
            SUM(CASE WHEN event_type = 'file_download' THEN 1 ELSE 0 END) AS downloads,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
            COALESCE(SUM(COALESCE(bytes_transferred, 0)), 0) AS total_bytes,
            COALESCE(AVG(duration_ms), 0) AS avg_duration_ms,
            MAX(timestamp) AS last_seen
          FROM telemetry_events
          ${extraClause}
          GROUP BY domain
          ORDER BY (visits + downloads) DESC, total_bytes DESC, domain ASC
          LIMIT ?
        `)
        const rows = stmt.all(...where.params, limit) as Array<Record<string, unknown>>
        return rows.map((row) => ({
          domain: String(row.domain),
          visits: Number(row.visits),
          downloads: Number(row.downloads),
          errorCount: Number(row.error_count),
          totalBytes: Number(row.total_bytes),
          avgDurationMs: Math.round(Number(row.avg_duration_ms) * 100) / 100,
          lastSeen: String(row.last_seen),
        }))
      },
      catch: (err) =>
        new TelemetryStoreError({
          operation: "query",
          path: dbPath,
          message: `Failed to query domains: ${err instanceof Error ? err.message : String(err)}`,
        }),
    })
  })

  const queryDownloads = Effect.fn("TelemetryStore.queryDownloads")(function*(
    filter: QueryFilterOptions = {},
  ): Effect.fn.Return<ReadonlyArray<DownloadRecord>, TelemetryStoreError> {
    return yield* Effect.try({
      try: () => {
        const limit = Math.max(1, Math.min(1000, Math.round(filter.limit ?? 50)))
        const where = buildWhereClause({ ...filter, eventType: "file_download" })
        const stmt = db.prepare(`
          SELECT
            id, trace_id, span_id, timestamp, timestamp_ms, session_id, task_id,
            domain, url, filename, destination_path, via, content_type,
            status_code, bytes_transferred, duration_ms, status
          FROM telemetry_events
          ${where.sql}
          ORDER BY timestamp_ms DESC, id DESC
          LIMIT ?
        `)
        const rows = stmt.all(...where.params, limit) as Array<Record<string, unknown>>
        return rows.map((row) => ({
          id: Number(row.id),
          traceId: String(row.trace_id),
          spanId: String(row.span_id),
          timestamp: String(row.timestamp),
          timestampMs: Number(row.timestamp_ms),
          sessionId: row.session_id === null ? null : String(row.session_id),
          taskId: row.task_id === null ? null : String(row.task_id),
          domain: row.domain === null ? null : String(row.domain),
          url: row.url === null ? null : String(row.url),
          filename: row.filename === null ? null : String(row.filename),
          destinationPath: row.destination_path === null ? null : String(row.destination_path),
          via: row.via === null ? null : String(row.via),
          contentType: row.content_type === null ? null : String(row.content_type),
          statusCode: row.status_code === null ? null : Number(row.status_code),
          bytesTransferred: row.bytes_transferred === null ? null : Number(row.bytes_transferred),
          durationMs: Number(row.duration_ms),
          status: String(row.status) as TelemetryEventStatus,
        }))
      },
      catch: (err) =>
        new TelemetryStoreError({
          operation: "query",
          path: dbPath,
          message: `Failed to query downloads: ${err instanceof Error ? err.message : String(err)}`,
        }),
    })
  })

  const querySummary = Effect.fn("TelemetryStore.querySummary")(function*(
    filter: QueryFilterOptions = {},
  ): Effect.fn.Return<TelemetrySummary, TelemetryStoreError> {
    const topLimit = Math.max(1, Math.min(100, Math.round(filter.limit ?? 10)))

    const totals = yield* Effect.try({
      try: () => {
        const where = buildWhereClause(filter)
        const stmt = db.prepare(`
          SELECT
            COUNT(*) AS total_events,
            SUM(CASE WHEN event_type = 'command' THEN 1 ELSE 0 END) AS command_count,
            SUM(CASE WHEN event_type = 'web_visit' THEN 1 ELSE 0 END) AS web_visit_count,
            SUM(CASE WHEN event_type = 'file_download' THEN 1 ELSE 0 END) AS file_download_count,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
            COALESCE(SUM(COALESCE(bytes_transferred, 0)), 0) AS total_bytes
          FROM telemetry_events
          ${where.sql}
        `)
        const row = stmt.get(...where.params) as Record<string, unknown> | undefined
        return {
          totalEvents: Number(row?.total_events ?? 0),
          commandCount: Number(row?.command_count ?? 0),
          webVisitCount: Number(row?.web_visit_count ?? 0),
          fileDownloadCount: Number(row?.file_download_count ?? 0),
          errorCount: Number(row?.error_count ?? 0),
          totalBytesTransferred: Number(row?.total_bytes ?? 0),
        }
      },
      catch: (err) =>
        new TelemetryStoreError({
          operation: "query",
          path: dbPath,
          message: `Failed to query summary totals: ${
            err instanceof Error ? err.message : String(err)
          }`,
        }),
    })

    const topCommands = yield* Effect.try({
      try: () => {
        const where = buildWhereClause({ ...filter, eventType: "command" })
        const stmt = db.prepare(`
          SELECT
            COALESCE(command, name) AS cmd,
            COUNT(*) AS count,
            SUM(CASE WHEN status = 'error' OR (exit_code IS NOT NULL AND exit_code != 0) THEN 1 ELSE 0 END) AS error_count,
            COALESCE(AVG(duration_ms), 0) AS avg_duration_ms
          FROM telemetry_events
          ${where.sql}
          GROUP BY cmd
          ORDER BY count DESC, cmd ASC
          LIMIT ?
        `)
        const rows = stmt.all(...where.params, topLimit) as Array<Record<string, unknown>>
        return rows.map((row) => ({
          command: String(row.cmd),
          count: Number(row.count),
          errorCount: Number(row.error_count),
          avgDurationMs: Math.round(Number(row.avg_duration_ms) * 100) / 100,
        }))
      },
      catch: (err) =>
        new TelemetryStoreError({
          operation: "query",
          path: dbPath,
          message: `Failed to query top commands: ${
            err instanceof Error ? err.message : String(err)
          }`,
        }),
    })

    const topDomains = yield* queryDomains({ ...filter, limit: topLimit })
    const recentDownloads = yield* queryDownloads({ ...filter, limit: topLimit })

    return {
      sinceMs: filter.sinceMs ?? null,
      ...totals,
      topCommands,
      topDomains,
      recentDownloads,
    }
  })

  const queryEvents = Effect.fn("TelemetryStore.queryEvents")(function*(
    filter: QueryFilterOptions & { readonly eventType?: TelemetryEventType | undefined } = {},
  ): Effect.fn.Return<ReadonlyArray<TelemetryEvent>, TelemetryStoreError> {
    return yield* Effect.try({
      try: () => {
        const limit = Math.max(1, Math.min(1000, Math.round(filter.limit ?? 100)))
        const where = buildWhereClause(filter)
        const stmt = db.prepare(`
          SELECT
            trace_id, span_id, parent_span_id, timestamp, timestamp_ms,
            session_id, task_id, source, event_type, name, duration_ms,
            status, domain, exit_code, bytes_transferred, attributes_json
          FROM telemetry_events
          ${where.sql}
          ORDER BY timestamp_ms DESC, id DESC
          LIMIT ?
        `)
        const rows = stmt.all(...where.params, limit) as Array<Record<string, unknown>>
        return rows.map((row) => {
          let attributes: Record<string, unknown> = {}
          try {
            attributes = JSON.parse(String(row.attributes_json)) as Record<string, unknown>
          } catch {
            attributes = {}
          }
          return {
            schemaVersion: 1 as const,
            traceId: String(row.trace_id),
            spanId: String(row.span_id),
            parentSpanId: row.parent_span_id === null ? null : String(row.parent_span_id),
            timestamp: String(row.timestamp),
            timestampMs: Number(row.timestamp_ms),
            sessionId: row.session_id === null ? null : String(row.session_id),
            taskId: row.task_id === null ? null : String(row.task_id),
            source: String(row.source) as TelemetryEvent["source"],
            eventType: String(row.event_type) as TelemetryEventType,
            name: String(row.name),
            durationMs: Number(row.duration_ms),
            status: String(row.status) as TelemetryEventStatus,
            domain: row.domain === null ? null : String(row.domain),
            exitCode: row.exit_code === null ? null : Number(row.exit_code),
            bytesTransferred: row.bytes_transferred === null ? null : Number(row.bytes_transferred),
            attributes,
          }
        })
      },
      catch: (err) =>
        new TelemetryStoreError({
          operation: "query",
          path: dbPath,
          message: `Failed to query events: ${err instanceof Error ? err.message : String(err)}`,
        }),
    })
  })

  const close = Effect.try({
    try: () => {
      if (!closed) {
        closed = true
        db.close()
      }
    },
    catch: (err) =>
      new TelemetryStoreError({
        operation: "close",
        path: dbPath,
        message: `Failed to close telemetry store: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }),
  })

  return {
    jsonlPath,
    dbPath,
    record,
    querySummary,
    queryCommands,
    queryDomains,
    queryDownloads,
    queryEvents,
    close,
  }
})

export class TelemetryStore extends Context.Service<TelemetryStore, TelemetryStoreShape>()(
  "clanker-whips/telemetry/TelemetryStore",
) {
  static layerFile(
    options: TelemetryStoreOptions = {},
  ): Layer.Layer<TelemetryStore, TelemetryStoreError> {
    return Layer.effect(
      TelemetryStore,
      Effect.acquireRelease(openTelemetryStore(options), (store) =>
        store.close.pipe(Effect.ignore),
      ).pipe(Effect.map((store) => TelemetryStore.of(store))),
    )
  }

  static layerTest(impl: TelemetryStoreShape): Layer.Layer<TelemetryStore> {
    return Layer.succeed(TelemetryStore, impl)
  }
}
