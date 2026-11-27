import { Effect, Schema } from "effect"

import { TelemetryConfigError } from "./errors.ts"
import { collectEnvSecrets, redactRecord, redactText } from "./redact.ts"
import { createSpanContext } from "./trace.ts"

export const NonNegativeIntSchema = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
)

export const NonNegativeNumberSchema = Schema.Number.pipe(
  Schema.check(Schema.isFinite()),
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
)

export const TraceIdSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{32}$/)),
)

export const SpanIdSchema = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{16}$/)),
)

export const EventTypeSchema = Schema.Literals([
  "command",
  "web_visit",
  "file_download",
])

export type TelemetryEventType = typeof EventTypeSchema["Type"]

export const EventStatusSchema = Schema.Literals([
  "ok",
  "error",
  "blocked",
  "unknown",
])

export type TelemetryEventStatus = typeof EventStatusSchema["Type"]

export const EventSourceSchema = Schema.Literals([
  "pi_extension",
  "proxy",
  "cli",
])

export type TelemetryEventSource = typeof EventSourceSchema["Type"]

export const TelemetryEventSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  traceId: TraceIdSchema,
  spanId: SpanIdSchema,
  parentSpanId: Schema.NullOr(SpanIdSchema),
  timestamp: Schema.NonEmptyString,
  timestampMs: NonNegativeIntSchema,
  sessionId: Schema.NullOr(Schema.String),
  taskId: Schema.NullOr(Schema.String),
  source: EventSourceSchema,
  eventType: EventTypeSchema,
  name: Schema.NonEmptyString,
  durationMs: NonNegativeNumberSchema,
  status: EventStatusSchema,
  domain: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Int),
  bytesTransferred: Schema.NullOr(NonNegativeIntSchema),
  attributes: Schema.Record(Schema.String, Schema.Unknown),
})

export type TelemetryEvent = typeof TelemetryEventSchema["Type"]

export const TelemetryEventJsonSchema = Schema.fromJsonString(TelemetryEventSchema)

export const decodeTelemetryEvent = Schema.decodeUnknownEffect(TelemetryEventSchema)
export const decodeTelemetryEventJson = Schema.decodeUnknownEffect(TelemetryEventJsonSchema)
export const encodeTelemetryEventJson = Schema.encodeEffect(TelemetryEventJsonSchema)

export interface MakeTelemetryEventInput {
  readonly eventType: TelemetryEventType
  readonly source: TelemetryEventSource
  readonly name: string
  readonly status?: TelemetryEventStatus | undefined
  readonly durationMs?: number | undefined
  readonly timestampMs?: number | undefined
  readonly sessionId?: string | null | undefined
  readonly taskId?: string | null | undefined
  readonly traceId?: string | undefined
  readonly spanId?: string | undefined
  readonly parentSpanId?: string | null | undefined
  readonly traceparent?: string | null | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly domain?: string | null | undefined
  readonly exitCode?: number | null | undefined
  readonly bytesTransferred?: number | null | undefined
  readonly attributes?: Readonly<Record<string, unknown>> | undefined
  readonly extraSecrets?: ReadonlyArray<string> | undefined
}

export function redactTelemetryEvent(
  event: TelemetryEvent,
  extraSecrets: ReadonlyArray<string> = [],
): TelemetryEvent {
  const combinedSecrets = extraSecrets.length > 0
    ? [...collectEnvSecrets(), ...extraSecrets]
    : collectEnvSecrets()

  return {
    ...event,
    name: redactText(event.name, combinedSecrets),
    sessionId: event.sessionId === null ? null : redactText(event.sessionId, combinedSecrets),
    taskId: event.taskId === null ? null : redactText(event.taskId, combinedSecrets),
    domain: event.domain === null ? null : redactText(event.domain, combinedSecrets).toLowerCase(),
    attributes: redactRecord(event.attributes, combinedSecrets),
  }
}

export function makeTelemetryEvent(input: MakeTelemetryEventInput): TelemetryEvent {
  const nowMs = Math.max(0, Math.round(input.timestampMs ?? Date.now()))
  const spanCtx = createSpanContext({
    traceparent: input.traceparent,
    env: input.env,
    traceId: input.traceId,
    parentSpanId: input.parentSpanId,
  })
  const spanId = input.spanId ?? spanCtx.spanId
  const durationMs = Math.max(0, Number.isFinite(input.durationMs) ? (input.durationMs ?? 0) : 0)
  const bytesTransferred = input.bytesTransferred === undefined || input.bytesTransferred === null
    ? null
    : Math.max(0, Math.round(input.bytesTransferred))

  const raw: TelemetryEvent = {
    schemaVersion: 1,
    traceId: spanCtx.traceId,
    spanId,
    parentSpanId: spanCtx.parentSpanId,
    timestamp: new Date(nowMs).toISOString(),
    timestampMs: nowMs,
    sessionId: input.sessionId ?? null,
    taskId: input.taskId ?? null,
    source: input.source,
    eventType: input.eventType,
    name: input.name,
    durationMs,
    status: input.status ?? "ok",
    domain: input.domain ? input.domain.toLowerCase() : null,
    exitCode: input.exitCode ?? null,
    bytesTransferred,
    attributes: { ...(input.attributes ?? {}) },
  }

  return redactTelemetryEvent(raw, input.extraSecrets)
}

export const validateTelemetryEvent = Effect.fn("validateTelemetryEvent")(function*(
  event: unknown,
): Effect.fn.Return<TelemetryEvent, TelemetryConfigError> {
  return yield* decodeTelemetryEvent(event).pipe(
    Effect.mapError((err) =>
      new TelemetryConfigError({
        message: `Invalid telemetry event: ${err.message}`,
      })
    ),
  )
})
