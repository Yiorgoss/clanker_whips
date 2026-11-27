import http from "node:http"
import net, { type AddressInfo } from "node:net"
import type { Duplex } from "node:stream"
import { Cause, Effect, Exit } from "effect"

import type { AlertPolicy } from "./alerts.ts"
import { detectHttpDownload, extractDomainFromUrl } from "./classifier.ts"
import { TelemetryConfigError, TelemetryProxyError } from "./errors.ts"
import { redactHeaders, redactText, redactUrl } from "./redact.ts"
import { makeTelemetryEvent, type TelemetryEvent } from "./schemas.ts"
import {
  openTelemetryStore,
  type TelemetryStoreOptions,
  type TelemetryStoreShape,
} from "./store.ts"
import { createChildSpanContext, createSpanContext } from "./trace.ts"

export const DEFAULT_PROXY_HOST = "127.0.0.1"
export const DEFAULT_PROXY_PORT = 8899

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"])

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

export interface TelemetryProxyOptions {
  readonly host?: string | undefined
  readonly port?: number | undefined
  readonly store?: TelemetryStoreShape | undefined
  readonly storeOptions?: TelemetryStoreOptions | undefined
  readonly alertPolicy?: AlertPolicy | undefined
  readonly sessionId?: string | null | undefined
  readonly taskId?: string | null | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly onLog?: ((line: string) => void) | undefined
  readonly onError?: ((line: string) => void) | undefined
}

export interface RunningTelemetryProxy {
  readonly host: string
  readonly port: number
  readonly proxyUrl: string
  readonly server: http.Server
  readonly store: TelemetryStoreShape
  readonly stop: () => Promise<void>
}

export function parseConnectAuthority(
  authority: string | undefined,
): { readonly host: string; readonly port: number } | null {
  if (typeof authority !== "string") {
    return null
  }
  const trimmed = authority.trim()
  if (trimmed.length === 0) {
    return null
  }

  let host: string
  let portText: string

  if (trimmed.startsWith("[")) {
    const closeIdx = trimmed.indexOf("]")
    if (closeIdx === -1 || trimmed[closeIdx + 1] !== ":") {
      return null
    }
    host = trimmed.slice(1, closeIdx)
    portText = trimmed.slice(closeIdx + 2)
  } else {
    const colonIdx = trimmed.lastIndexOf(":")
    if (colonIdx <= 0) {
      return null
    }
    host = trimmed.slice(0, colonIdx)
    portText = trimmed.slice(colonIdx + 1)
  }

  if (host.length === 0 || !/^\d+$/.test(portText)) {
    return null
  }
  const port = Number.parseInt(portText, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null
  }
  return { host: host.toLowerCase(), port }
}

function resolveHttpTargetUrl(req: http.IncomingMessage): URL | null {
  const rawUrl = req.url ?? ""
  if (/^https?:\/\//i.test(rawUrl)) {
    try {
      return new URL(rawUrl)
    } catch {
      return null
    }
  }
  const hostHeader = req.headers.host
  if (typeof hostHeader === "string" && hostHeader.trim().length > 0) {
    try {
      return new URL(rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`, `http://${hostHeader}`)
    } catch {
      return null
    }
  }
  return null
}

function buildForwardHeaders(
  incoming: http.IncomingHttpHeaders,
  traceparent: string,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  const connectionTokens = new Set<string>()
  const rawConnection = incoming.connection
  if (typeof rawConnection === "string") {
    for (const token of rawConnection.split(",")) {
      const cleaned = token.trim().toLowerCase()
      if (cleaned.length > 0) {
        connectionTokens.add(cleaned)
      }
    }
  }

  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) {
      continue
    }
    const lower = key.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) || connectionTokens.has(lower)) {
      continue
    }
    out[key] = value
  }
  if (out.traceparent === undefined) {
    out.traceparent = traceparent
  }
  return out
}

function parseContentLength(header: string | ReadonlyArray<string> | undefined): number | null {
  const raw = Array.isArray(header) ? header[0] : header
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) {
    return null
  }
  const val = Number.parseInt(raw.trim(), 10)
  return Number.isSafeInteger(val) && val >= 0 ? val : null
}

function getHeaderString(header: string | ReadonlyArray<string> | undefined): string | undefined {
  if (header === undefined) {
    return undefined
  }
  return typeof header === "string" ? header : header.join(", ")
}

export const startTelemetryProxy = Effect.fn("startTelemetryProxy")(function*(
  options: TelemetryProxyOptions = {},
): Effect.fn.Return<RunningTelemetryProxy, TelemetryConfigError | TelemetryProxyError> {
  const host = (options.host ?? DEFAULT_PROXY_HOST).trim()
  const port = options.port ?? DEFAULT_PROXY_PORT
  const env = options.env ?? process.env

  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
    return yield* new TelemetryConfigError({
      message: `Refusing to bind proxy to non-loopback host "${host}". Only loopback hosts (127.0.0.1, ::1, localhost) are supported.`,
    })
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return yield* new TelemetryConfigError({
      message: `Invalid proxy port: ${String(port)}`,
    })
  }

  const onLog = options.onLog ?? (() => {})
  const onError = options.onError ?? ((msg: string) => {
    process.stderr.write(`[telemetry-proxy] ERROR: ${redactText(msg)}\n`)
  })

  const ownsStore = options.store === undefined
  const store = options.store ?? (yield* openTelemetryStore({
    ...options.storeOptions,
    alertPolicy: options.alertPolicy ?? options.storeOptions?.alertPolicy,
    onAlertError: onError,
  }).pipe(
    Effect.mapError((err) =>
      new TelemetryProxyError({
        message: err.message,
      })
    ),
  ))

  const sessionId = options.sessionId !== undefined
    ? options.sessionId
    : (env.PI_SESSION_ID ?? env.CLANKER_SESSION_ID ?? null)
  const taskId = options.taskId !== undefined
    ? options.taskId
    : (env.CLANKER_TASK_ID ?? env.FIRSTMATE_TASK_ID ?? env.TASK_ID ?? null)

  const activeSockets = new Set<Duplex>()
  const pendingWrites = new Set<Promise<void>>()

  const enqueueRecord = (event: TelemetryEvent): void => {
    const p = Effect.runPromiseExit(store.record(event))
      .then((exit) => {
        if (Exit.isFailure(exit)) {
          onError(`failed to store proxy telemetry: ${String(Cause.squash(exit.cause))}`)
        }
      })
      .catch((err) => {
        onError(`unexpected telemetry write error: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => {
        pendingWrites.delete(p)
      })
    pendingWrites.add(p)
  }

  const server = http.createServer((clientReq, clientRes) => {
    const startedAtMs = Date.now()
    const targetUrl = resolveHttpTargetUrl(clientReq)

    if (targetUrl === null || targetUrl.protocol !== "http:") {
      clientRes.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
      clientRes.end("Bad Proxy Request: expected absolute http:// URL\n")
      return
    }

    const incomingTraceparent = getHeaderString(clientReq.headers.traceparent)
    const spanCtx = createSpanContext({ traceparent: incomingTraceparent, env })
    const method = (clientReq.method ?? "GET").toUpperCase()
    const domain = extractDomainFromUrl(targetUrl.toString())
    const forwardHeaders = buildForwardHeaders(clientReq.headers, spanCtx.traceparent)

    let bytesOut = 0
    let bytesIn = 0
    let statusCode: number | null = null
    let contentType: string | undefined
    let contentDisposition: string | undefined
    let contentLength: number | null = null
    let recorded = false

    const finalize = (errorMessage?: string): void => {
      if (recorded) {
        return
      }
      recorded = true
      const nowMs = Date.now()
      const durationMs = Math.max(0, nowMs - startedAtMs)
      const isError = errorMessage !== undefined || (statusCode !== null && statusCode >= 400)
      const status = isError ? "error" : "ok"
      const redactedUrl = redactUrl(targetUrl.toString())

      const downloadInfo = detectHttpDownload({
        method,
        url: targetUrl.toString(),
        contentType,
        contentDisposition,
        contentLength: contentLength ?? undefined,
      })

      const visitEvent = makeTelemetryEvent({
        eventType: "web_visit",
        source: "proxy",
        name: "http.proxy.request",
        status,
        durationMs,
        timestampMs: nowMs,
        sessionId,
        taskId,
        traceId: spanCtx.traceId,
        spanId: spanCtx.spanId,
        parentSpanId: spanCtx.parentSpanId,
        domain,
        bytesTransferred: downloadInfo.isDownload ? bytesOut : bytesIn + bytesOut,
        attributes: {
          protocol: "http",
          tunnel: false,
          isDownload: downloadInfo.isDownload,
          method,
          url: redactedUrl,
          domain,
          port: targetUrl.port ? Number.parseInt(targetUrl.port, 10) : 80,
          statusCode,
          contentType: contentType ?? null,
          contentDisposition: contentDisposition ?? null,
          contentLength,
          bytesIn,
          bytesOut,
          requestHeaders: redactHeaders(clientReq.headers),
          errorMessage: errorMessage ? redactText(errorMessage) : null,
        },
      })
      enqueueRecord(visitEvent)

      if (downloadInfo.isDownload) {
        const childSpan = createChildSpanContext(spanCtx)
        const downloadEvent = makeTelemetryEvent({
          eventType: "file_download",
          source: "proxy",
          name: "http.proxy.download",
          status,
          durationMs,
          timestampMs: nowMs,
          sessionId,
          taskId,
          traceId: childSpan.traceId,
          spanId: childSpan.spanId,
          parentSpanId: childSpan.parentSpanId,
          domain,
          bytesTransferred: bytesIn,
          attributes: {
            via: "http_proxy",
            reason: downloadInfo.reason,
            filename: downloadInfo.filename,
            method,
            url: redactedUrl,
            domain,
            statusCode,
            contentType: contentType ?? null,
            contentDisposition: contentDisposition ?? null,
            contentLength,
            bytesIn,
            bytesOut,
          },
        })
        enqueueRecord(downloadEvent)
      }
    }

    const upstreamReq = http.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port ? Number.parseInt(targetUrl.port, 10) : 80,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method,
        headers: forwardHeaders,
      },
      (upstreamRes) => {
        statusCode = upstreamRes.statusCode ?? null
        contentType = getHeaderString(upstreamRes.headers["content-type"])
        contentDisposition = getHeaderString(upstreamRes.headers["content-disposition"])
        contentLength = parseContentLength(upstreamRes.headers["content-length"])

        clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)

        upstreamRes.on("data", (chunk: Buffer | string) => {
          bytesIn += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
        })
        upstreamRes.on("end", () => {
          finalize()
        })
        upstreamRes.on("error", (err) => {
          finalize(err.message)
          if (!clientRes.writableEnded) {
            clientRes.destroy()
          }
        })
        upstreamRes.pipe(clientRes)
      },
    )

    upstreamReq.on("error", (err) => {
      finalize(err.message)
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
        clientRes.end(`Bad Gateway: ${redactText(err.message)}\n`)
      } else if (!clientRes.writableEnded) {
        clientRes.destroy()
      }
    })

    clientReq.on("data", (chunk: Buffer | string) => {
      bytesOut += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
    })
    clientReq.on("aborted", () => {
      upstreamReq.destroy()
      finalize("Client aborted request")
    })
    clientReq.pipe(upstreamReq)
  })

  server.on("connection", (socket) => {
    activeSockets.add(socket)
    socket.on("close", () => {
      activeSockets.delete(socket)
    })
  })

  server.on("connect", (req, clientSocket, head) => {
    const startedAtMs = Date.now()
    const target = parseConnectAuthority(req.url)

    if (target === null) {
      clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n")
      clientSocket.destroy()
      return
    }

    const incomingTraceparent = getHeaderString(req.headers.traceparent)
    const spanCtx = createSpanContext({ traceparent: incomingTraceparent, env })

    let bytesIn = 0
    let bytesOut = head.length
    let tunnelEstablished = false
    let recorded = false
    let errorMessage: string | undefined

    const finalize = (): void => {
      if (recorded) {
        return
      }
      recorded = true
      const nowMs = Date.now()
      const durationMs = Math.max(0, nowMs - startedAtMs)
      const status = !tunnelEstablished || errorMessage !== undefined ? "error" : "ok"

      const event = makeTelemetryEvent({
        eventType: "web_visit",
        source: "proxy",
        name: "http.proxy.connect",
        status,
        durationMs,
        timestampMs: nowMs,
        sessionId,
        taskId,
        traceId: spanCtx.traceId,
        spanId: spanCtx.spanId,
        parentSpanId: spanCtx.parentSpanId,
        domain: target.host,
        bytesTransferred: bytesIn + bytesOut,
        attributes: {
          protocol: target.port === 443 ? "https" : "tcp",
          tunnel: true,
          method: "CONNECT",
          url: `https://${target.host}${target.port === 443 ? "" : `:${target.port}`}`,
          domain: target.host,
          port: target.port,
          bytesIn,
          bytesOut,
          errorMessage: errorMessage ? redactText(errorMessage) : null,
        },
      })
      enqueueRecord(event)
    }

    const upstreamSocket = net.connect({
      host: target.host,
      port: target.port,
    })

    activeSockets.add(clientSocket)
    activeSockets.add(upstreamSocket)

    const cleanupSockets = (): void => {
      activeSockets.delete(clientSocket)
      activeSockets.delete(upstreamSocket)
    }

    upstreamSocket.on("connect", () => {
      tunnelEstablished = true
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length > 0) {
        upstreamSocket.write(head)
      }
      upstreamSocket.on("data", (chunk: Buffer) => {
        bytesIn += chunk.length
      })
      clientSocket.on("data", (chunk: Buffer) => {
        bytesOut += chunk.length
      })
      upstreamSocket.pipe(clientSocket)
      clientSocket.pipe(upstreamSocket)
    })

    upstreamSocket.on("error", (err) => {
      errorMessage = err.message
      if (!tunnelEstablished && clientSocket.writable) {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n")
      }
      clientSocket.destroy()
      finalize()
    })

    clientSocket.on("error", (err) => {
      if (!errorMessage) {
        errorMessage = err.message
      }
      upstreamSocket.destroy()
      finalize()
    })

    upstreamSocket.on("close", () => {
      cleanupSockets()
      if (!clientSocket.destroyed) {
        clientSocket.end()
      }
      finalize()
    })

    clientSocket.on("close", () => {
      cleanupSockets()
      if (!upstreamSocket.destroyed) {
        upstreamSocket.end()
      }
      finalize()
    })
  })

  const boundAddress = yield* Effect.tryPromise({
    try: () =>
      new Promise<AddressInfo>((resolve, reject) => {
        const onListenError = (err: Error) => {
          server.removeListener("listening", onListening)
          reject(err)
        }
        const onListening = () => {
          server.removeListener("error", onListenError)
          const addr = server.address()
          if (addr === null || typeof addr === "string") {
            reject(new Error("Unexpected server address"))
            return
          }
          resolve(addr)
        }
        server.once("error", onListenError)
        server.once("listening", onListening)
        server.listen(port, host)
      }),
    catch: (err) =>
      new TelemetryProxyError({
        message: `Failed to bind telemetry proxy on ${host}:${port}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }),
  })

  const proxyUrl = `http://${host}:${boundAddress.port}`
  onLog(`[telemetry-proxy] listening on ${proxyUrl} (store: ${store.dbPath})`)

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) {
      return
    }
    stopped = true

    for (const sock of activeSockets) {
      sock.destroy()
    }
    activeSockets.clear()

    server.closeAllConnections?.()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })

    if (pendingWrites.size > 0) {
      await Promise.allSettled(Array.from(pendingWrites))
    }

    if (ownsStore) {
      await Effect.runPromiseExit(store.close)
    }
    onLog("[telemetry-proxy] stopped cleanly")
  }

  return {
    host,
    port: boundAddress.port,
    proxyUrl,
    server,
    store,
    stop,
  }
})
