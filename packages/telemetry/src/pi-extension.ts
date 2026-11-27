import path from "node:path"
import { Cause, Effect, Exit } from "effect"

import type { AlertPolicy } from "./alerts.ts"
import {
  classifyBashCommand,
  extractDomainFromUrl,
  extractUrlsFromText,
  isBashToolName,
  isFileWriteToolName,
  isWebOrBrowserToolName,
} from "./classifier.ts"
import { redactText, redactUrl } from "./redact.ts"
import {
  makeTelemetryEvent,
  type TelemetryEvent,
  type TelemetryEventStatus,
} from "./schemas.ts"
import {
  openTelemetryStore,
  type TelemetryStoreOptions,
  type TelemetryStoreShape,
} from "./store.ts"
import { createChildSpanContext, createSpanContext, type SpanContext } from "./trace.ts"

/**
 * Minimal structural interfaces matching Pi's ExtensionAPI and tool lifecycle events.
 * Keeping these structural avoids requiring host-only packages in dependencies while
 * remaining fully type-safe under Node v22 native TypeScript and Pi's jiti loader.
 */
export interface PiSessionManagerLike {
  readonly getSessionId?: (() => string | undefined) | undefined
  readonly getSessionFile?: (() => string | undefined) | undefined
}

export interface PiExtensionContextLike {
  readonly cwd?: string | undefined
  readonly sessionManager?: PiSessionManagerLike | undefined
}

export interface PiToolCallEventLike {
  readonly toolName: string
  readonly toolCallId?: string | undefined
  readonly parentToolCallId?: string | undefined
  readonly input?: Record<string, unknown> | undefined
}

export interface PiToolResultEventLike {
  readonly toolName: string
  readonly toolCallId?: string | undefined
  readonly parentToolCallId?: string | undefined
  readonly input?: Record<string, unknown> | undefined
  readonly content?: unknown
  readonly details?: Record<string, unknown> | undefined
  readonly isError?: boolean | undefined
}

export type PiEventHandler<TEvent> = (
  event: TEvent,
  ctx?: PiExtensionContextLike,
) => Promise<void> | void

export interface PiExtensionAPILike {
  on(event: "tool_call", handler: PiEventHandler<PiToolCallEventLike>): void
  on(event: "tool_result", handler: PiEventHandler<PiToolResultEventLike>): void
  on(event: "session_shutdown", handler: PiEventHandler<Record<string, unknown>>): void
  on(event: string, handler: PiEventHandler<Record<string, unknown>>): void
}

export interface TelemetryExtensionOptions {
  readonly store?: TelemetryStoreShape | undefined
  readonly storeOptions?: TelemetryStoreOptions | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly now?: (() => number) | undefined
  readonly warn?: ((message: string) => void) | undefined
}

interface PendingToolCall {
  readonly startedAtMs: number
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly cwd: string | null
  readonly sessionId: string | null
  readonly taskId: string | null
  readonly spanContext: SpanContext
}

function readAlertPolicyFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): AlertPolicy | undefined {
  const alertCmd = env.CLANKER_TELEMETRY_ALERT_CMD?.trim()
  const rawAllowed = env.CLANKER_TELEMETRY_ALLOWED_DOMAINS?.trim()
  const rawMaxBytes = env.CLANKER_TELEMETRY_MAX_DOWNLOAD_BYTES?.trim()

  const allowedDomains = rawAllowed
    ? rawAllowed.split(",").map((item) => item.trim()).filter((item) => item.length > 0)
    : undefined
  const parsedMaxBytes = rawMaxBytes && /^\d+$/.test(rawMaxBytes)
    ? Number.parseInt(rawMaxBytes, 10)
    : undefined

  if (!alertCmd && !allowedDomains?.length && parsedMaxBytes === undefined) {
    return undefined
  }
  return {
    alertCmd: alertCmd || undefined,
    allowedDomains,
    maxDownloadBytes: parsedMaxBytes,
  }
}

function resolveSessionId(
  ctx: PiExtensionContextLike | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const fromManager = ctx?.sessionManager?.getSessionId?.()
  if (typeof fromManager === "string" && fromManager.trim().length > 0) {
    return fromManager.trim()
  }
  const sessionFile = ctx?.sessionManager?.getSessionFile?.()
  if (typeof sessionFile === "string" && sessionFile.trim().length > 0) {
    return path.basename(sessionFile.trim())
  }
  const fromEnv = env.PI_SESSION_ID ?? env.CLANKER_SESSION_ID
  return fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : null
}

function resolveTaskId(env: Readonly<Record<string, string | undefined>>): string | null {
  const raw = env.CLANKER_TASK_ID ?? env.FIRSTMATE_TASK_ID ?? env.TASK_ID
  return raw && raw.trim().length > 0 ? raw.trim() : null
}

function extractStringField(
  input: Readonly<Record<string, unknown>> | undefined,
  keys: ReadonlyArray<string>,
): string | null {
  if (input === undefined) {
    return null
  }
  for (const key of keys) {
    const val = input[key]
    if (typeof val === "string" && val.trim().length > 0) {
      return val
    }
  }
  return null
}

function extractResultText(content: unknown): string {
  if (typeof content === "string") {
    return content
  }
  if (Array.isArray(content)) {
    const parts: Array<string> = []
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item)
      } else if (
        typeof item === "object" &&
        item !== null &&
        "text" in item &&
        typeof item.text === "string"
      ) {
        parts.push(item.text)
      }
    }
    return parts.join("\n")
  }
  return ""
}

function extractExitCode(event: PiToolResultEventLike): number {
  const details = event.details
  if (details !== undefined) {
    const raw = details.exitCode ?? details.exit_code ?? details.code
    if (typeof raw === "number" && Number.isInteger(raw)) {
      return raw
    }
  }
  if (event.isError === false) {
    return 0
  }
  const text = extractResultText(event.content)
  const match = /exited with code (-?\d+)/i.exec(text) ?? /exit code[:\s]+(-?\d+)/i.exec(text)
  if (match?.[1] !== undefined) {
    const parsed = Number.parseInt(match[1], 10)
    if (Number.isInteger(parsed)) {
      return parsed
    }
  }
  return event.isError === true ? 1 : 0
}

function collectInputUrls(input: Readonly<Record<string, unknown>> | undefined): ReadonlyArray<string> {
  if (input === undefined) {
    return []
  }
  const urls = new Set<string>()
  const direct = extractStringField(input, ["url", "uri", "href", "target", "endpoint"])
  if (direct !== null) {
    for (const u of extractUrlsFromText(direct)) {
      urls.add(u)
    }
  }
  for (const val of Object.values(input)) {
    if (typeof val === "string") {
      for (const u of extractUrlsFromText(val)) {
        urls.add(u)
      }
    }
  }
  return Array.from(urls)
}

function buildEventsForToolResult(params: {
  readonly event: PiToolResultEventLike
  readonly pending: PendingToolCall | undefined
  readonly nowMs: number
  readonly ctx: PiExtensionContextLike | undefined
  readonly env: Readonly<Record<string, string | undefined>>
}): ReadonlyArray<TelemetryEvent> {
  const { event, pending, nowMs, ctx, env } = params
  const input = event.input ?? pending?.input ?? {}
  const toolName = event.toolName
  const sessionId = pending?.sessionId ?? resolveSessionId(ctx, env)
  const taskId = pending?.taskId ?? resolveTaskId(env)
  const cwd = pending?.cwd ?? (typeof ctx?.cwd === "string" ? ctx.cwd : null)
  const spanCtx = pending?.spanContext ?? createSpanContext({ env })
  const durationMs = pending !== undefined ? Math.max(0, nowMs - pending.startedAtMs) : 0
  const outputText = extractResultText(event.content)
  const outputBytes = Buffer.byteLength(outputText, "utf8")

  const events: Array<TelemetryEvent> = []

  if (isBashToolName(toolName)) {
    const command = extractStringField(input, ["command", "CommandLine", "cmd"]) ?? ""
    const exitCode = extractExitCode(event)
    const status: TelemetryEventStatus = event.isError === true || exitCode !== 0 ? "error" : "ok"

    const commandEvent = makeTelemetryEvent({
      eventType: "command",
      source: "pi_extension",
      name: `tool.${toolName}`,
      status,
      durationMs,
      timestampMs: nowMs,
      sessionId,
      taskId,
      traceId: spanCtx.traceId,
      spanId: spanCtx.spanId,
      parentSpanId: spanCtx.parentSpanId,
      exitCode,
      bytesTransferred: outputBytes,
      attributes: {
        command: redactText(command),
        cwd,
        exitCode,
        toolName,
        toolCallId: event.toolCallId ?? null,
        outputBytes,
        isError: event.isError === true,
      },
    })
    events.push(commandEvent)

    const classified = classifyBashCommand(command)
    for (const rawUrl of classified.urls) {
      const childSpan = createChildSpanContext(spanCtx)
      const domain = extractDomainFromUrl(rawUrl)
      events.push(
        makeTelemetryEvent({
          eventType: "web_visit",
          source: "pi_extension",
          name: "command.url",
          status,
          durationMs,
          timestampMs: nowMs,
          sessionId,
          taskId,
          traceId: childSpan.traceId,
          spanId: childSpan.spanId,
          parentSpanId: childSpan.parentSpanId,
          domain,
          attributes: {
            url: redactUrl(rawUrl),
            domain,
            via: "command",
            toolName,
            toolCallId: event.toolCallId ?? null,
            command: redactText(command),
          },
        }),
      )
    }

    for (const download of classified.downloads) {
      const childSpan = createChildSpanContext(spanCtx)
      events.push(
        makeTelemetryEvent({
          eventType: "file_download",
          source: "pi_extension",
          name: `download.${download.via}`,
          status,
          durationMs,
          timestampMs: nowMs,
          sessionId,
          taskId,
          traceId: childSpan.traceId,
          spanId: childSpan.spanId,
          parentSpanId: childSpan.parentSpanId,
          domain: download.domain,
          attributes: {
            via: download.via,
            url: download.url !== null ? redactUrl(download.url) : null,
            domain: download.domain,
            filename: download.filename,
            destinationPath: download.destinationPath,
            toolName,
            toolCallId: event.toolCallId ?? null,
            command: redactText(command),
          },
        }),
      )
    }

    return events
  }

  if (isWebOrBrowserToolName(toolName)) {
    const status: TelemetryEventStatus = event.isError === true ? "error" : "ok"
    const urls = collectInputUrls(input)
    const query = extractStringField(input, ["query", "q", "search", "searchQuery"])
    const explicitDomain = extractStringField(input, ["domain", "host", "hostname"])

    if (urls.length > 0) {
      for (const rawUrl of urls) {
        const childSpan = urls.length === 1 ? spanCtx : createChildSpanContext(spanCtx)
        const domain = extractDomainFromUrl(rawUrl) ?? explicitDomain
        events.push(
          makeTelemetryEvent({
            eventType: "web_visit",
            source: "pi_extension",
            name: `tool.${toolName}`,
            status,
            durationMs,
            timestampMs: nowMs,
            sessionId,
            taskId,
            traceId: childSpan.traceId,
            spanId: childSpan.spanId,
            parentSpanId: childSpan.parentSpanId,
            domain,
            bytesTransferred: outputBytes,
            attributes: {
              url: redactUrl(rawUrl),
              domain,
              query: query !== null ? redactText(query) : null,
              toolName,
              toolCallId: event.toolCallId ?? null,
              via: "web_tool",
            },
          }),
        )
      }
    } else {
      events.push(
        makeTelemetryEvent({
          eventType: "web_visit",
          source: "pi_extension",
          name: `tool.${toolName}`,
          status,
          durationMs,
          timestampMs: nowMs,
          sessionId,
          taskId,
          traceId: spanCtx.traceId,
          spanId: spanCtx.spanId,
          parentSpanId: spanCtx.parentSpanId,
          domain: explicitDomain,
          bytesTransferred: outputBytes,
          attributes: {
            url: null,
            domain: explicitDomain,
            query: query !== null ? redactText(query) : null,
            toolName,
            toolCallId: event.toolCallId ?? null,
            via: "web_tool",
          },
        }),
      )
    }

    return events
  }

  if (isFileWriteToolName(toolName)) {
    const status: TelemetryEventStatus = event.isError === true ? "error" : "ok"
    const destPath = extractStringField(input, ["path", "Path", "filePath", "file_path"])
    const content = extractStringField(input, ["content", "Content", "text"])
    const bytesWritten = content !== null ? Buffer.byteLength(content, "utf8") : null
    const filename = destPath !== null ? path.basename(destPath) : null

    events.push(
      makeTelemetryEvent({
        eventType: "file_download",
        source: "pi_extension",
        name: `tool.${toolName}`,
        status,
        durationMs,
        timestampMs: nowMs,
        sessionId,
        taskId,
        traceId: spanCtx.traceId,
        spanId: spanCtx.spanId,
        parentSpanId: spanCtx.parentSpanId,
        bytesTransferred: bytesWritten,
        attributes: {
          via: "tool_write",
          destinationPath: destPath,
          filename,
          toolName,
          toolCallId: event.toolCallId ?? null,
        },
      }),
    )
  }

  return events
}

/**
 * Create a Pi extension factory capturing tool_call and tool_result telemetry events.
 * Storage errors are logged as warnings and never throw or block the agent turn.
 */
export function createTelemetryExtension(
  options: TelemetryExtensionOptions = {},
): (pi: PiExtensionAPILike) => void {
  return (pi: PiExtensionAPILike) => {
    const env = options.env ?? process.env
    const nowFn = options.now ?? (() => Date.now())
    const warn = options.warn ?? ((message: string) => {
      process.stderr.write(`[clanker-telemetry] WARN: ${redactText(message)}\n`)
    })

    const pendingCalls = new Map<string, PendingToolCall>()
    const pendingByToolName = new Map<string, Array<PendingToolCall>>()
    let activeStore: TelemetryStoreShape | undefined = options.store
    let ownsStore = options.store === undefined
    let storeInitFailed = false
    let storeInitPromise: Promise<TelemetryStoreShape | undefined> | undefined
    let shuttingDown = false

    const ensureStore = async (): Promise<TelemetryStoreShape | undefined> => {
      if (activeStore !== undefined) {
        return activeStore
      }
      if (storeInitFailed || shuttingDown) {
        return undefined
      }
      if (storeInitPromise !== undefined) {
        return storeInitPromise
      }
      const alertPolicy = options.storeOptions?.alertPolicy ?? readAlertPolicyFromEnv(env)
      const mergedOptions: TelemetryStoreOptions = {
        ...options.storeOptions,
        alertPolicy,
      }
      storeInitPromise = Effect.runPromiseExit(openTelemetryStore(mergedOptions))
        .then((exit) => {
          if (Exit.isFailure(exit)) {
            storeInitFailed = true
            warn(`failed to open telemetry store: ${String(Cause.squash(exit.cause))}`)
            return undefined
          }
          activeStore = exit.value
          ownsStore = true
          return activeStore
        })
        .finally(() => {
          storeInitPromise = undefined
        })
      return storeInitPromise
    }

    pi.on("tool_call", (event, ctx) => {
      try {
        const parentPending = event.parentToolCallId
          ? pendingCalls.get(event.parentToolCallId)
          : undefined
        const spanContext = parentPending !== undefined
          ? createChildSpanContext(parentPending.spanContext)
          : createSpanContext({ env })

        const entry: PendingToolCall = {
          startedAtMs: nowFn(),
          toolName: event.toolName,
          input: event.input ? { ...event.input } : {},
          cwd: typeof ctx?.cwd === "string" ? ctx.cwd : null,
          sessionId: resolveSessionId(ctx, env),
          taskId: resolveTaskId(env),
          spanContext,
        }

        if (event.toolCallId !== undefined) {
          pendingCalls.set(event.toolCallId, entry)
        } else {
          const queue = pendingByToolName.get(event.toolName)
          if (queue !== undefined) {
            queue.push(entry)
          } else {
            pendingByToolName.set(event.toolName, [entry])
          }
        }
      } catch (err) {
        warn(`tool_call telemetry error: ${err instanceof Error ? err.message : String(err)}`)
      }
    })

    pi.on("tool_result", async (event, ctx) => {
      try {
        const nowMs = nowFn()
        const key = event.toolCallId
        let pending: PendingToolCall | undefined
        if (key !== undefined) {
          pending = pendingCalls.get(key)
          pendingCalls.delete(key)
        } else {
          const queue = pendingByToolName.get(event.toolName)
          if (queue !== undefined && queue.length > 0) {
            pending = queue.shift()
            if (queue.length === 0) {
              pendingByToolName.delete(event.toolName)
            }
          }
        }

        const events = buildEventsForToolResult({
          event,
          pending,
          nowMs,
          ctx,
          env,
        })
        if (events.length === 0) {
          return
        }

        const store = await ensureStore()
        if (store === undefined) {
          return
        }

        for (const telemetryEvent of events) {
          const exit = await Effect.runPromiseExit(store.record(telemetryEvent))
          if (Exit.isFailure(exit)) {
            warn(`failed to record ${telemetryEvent.eventType}: ${String(Cause.squash(exit.cause))}`)
          }
        }
      } catch (err) {
        warn(`tool_result telemetry error: ${err instanceof Error ? err.message : String(err)}`)
      }
    })

    pi.on("session_shutdown", async () => {
      try {
        shuttingDown = true
        pendingCalls.clear()
        pendingByToolName.clear()
        if (storeInitPromise !== undefined) {
          await storeInitPromise
        }
        if (ownsStore && activeStore !== undefined) {
          const toClose = activeStore
          activeStore = undefined
          const exit = await Effect.runPromiseExit(toClose.close)
          if (Exit.isFailure(exit)) {
            warn(`failed to close telemetry store: ${String(Cause.squash(exit.cause))}`)
          }
        }
      } catch (err) {
        warn(`session_shutdown telemetry error: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  }
}

const defaultExtension = createTelemetryExtension()

export default function telemetryExtension(pi: PiExtensionAPILike): void {
  defaultExtension(pi)
}
