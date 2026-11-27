import crypto from "node:crypto"

export interface TraceContext {
  readonly version: string
  readonly traceId: string
  readonly spanId: string
  readonly traceFlags: string
}

export interface SpanContext {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | null
  readonly traceFlags: string
  readonly traceparent: string
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/
const ALL_ZERO_TRACE_ID = "00000000000000000000000000000000"
const ALL_ZERO_SPAN_ID = "0000000000000000"

export function generateTraceId(): string {
  while (true) {
    const candidate = crypto.randomBytes(16).toString("hex")
    if (candidate !== ALL_ZERO_TRACE_ID) {
      return candidate
    }
  }
}

export function generateSpanId(): string {
  while (true) {
    const candidate = crypto.randomBytes(8).toString("hex")
    if (candidate !== ALL_ZERO_SPAN_ID) {
      return candidate
    }
  }
}

/**
 * Parse a W3C traceparent header value (`00-<traceId>-<spanId>-<flags>`).
 * Returns undefined if missing, malformed, version ff, or all-zero IDs.
 */
export function parseTraceparent(header: string | undefined | null): TraceContext | undefined {
  if (typeof header !== "string") {
    return undefined
  }
  const normalized = header.trim().toLowerCase()
  const match = TRACEPARENT_RE.exec(normalized)
  if (match === null) {
    return undefined
  }
  const version = match[1]
  const traceId = match[2]
  const spanId = match[3]
  const traceFlags = match[4]
  if (
    version === undefined ||
    traceId === undefined ||
    spanId === undefined ||
    traceFlags === undefined
  ) {
    return undefined
  }
  if (version === "ff" || traceId === ALL_ZERO_TRACE_ID || spanId === ALL_ZERO_SPAN_ID) {
    return undefined
  }
  return {
    version,
    traceId,
    spanId,
    traceFlags,
  }
}

export function formatTraceparent(context: {
  readonly traceId: string
  readonly spanId: string
  readonly traceFlags?: string | undefined
}): string {
  const flags = context.traceFlags ?? "01"
  return `00-${context.traceId}-${context.spanId}-${flags}`
}

/**
 * Create a child span context from an explicit W3C traceparent, environment TRACEPARENT,
 * or mint a brand new root trace if none is present or valid.
 */
export function createSpanContext(options: {
  readonly traceparent?: string | undefined | null
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly traceId?: string | undefined
  readonly parentSpanId?: string | null | undefined
  readonly traceFlags?: string | undefined
} = {}): SpanContext {
  const envTraceparent = options.env?.TRACEPARENT ?? options.env?.traceparent
  const parsed = parseTraceparent(options.traceparent) ?? parseTraceparent(envTraceparent)

  const traceId = options.traceId ?? parsed?.traceId ?? generateTraceId()
  const parentSpanId = options.parentSpanId !== undefined
    ? options.parentSpanId
    : (parsed?.spanId ?? null)
  const traceFlags = options.traceFlags ?? parsed?.traceFlags ?? "01"
  const spanId = generateSpanId()

  return {
    traceId,
    spanId,
    parentSpanId,
    traceFlags,
    traceparent: formatTraceparent({ traceId, spanId, traceFlags }),
  }
}

export function createChildSpanContext(parent: {
  readonly traceId: string
  readonly spanId: string
  readonly traceFlags?: string | undefined
}): SpanContext {
  return createSpanContext({
    traceId: parent.traceId,
    parentSpanId: parent.spanId,
    traceFlags: parent.traceFlags ?? "01",
  })
}
