import { Schema } from "effect"

export class TelemetryConfigError extends Schema.TaggedError<TelemetryConfigError>()(
  "TelemetryConfigError",
  {
    message: Schema.String,
  },
) {}

export class TelemetryStoreError extends Schema.TaggedError<TelemetryStoreError>()(
  "TelemetryStoreError",
  {
    operation: Schema.Literals(["init", "write", "query", "close"]),
    path: Schema.String,
    message: Schema.String,
  },
) {}

export class TelemetryProxyError extends Schema.TaggedError<TelemetryProxyError>()(
  "TelemetryProxyError",
  {
    message: Schema.String,
  },
) {}

export class TelemetryAlertError extends Schema.TaggedError<TelemetryAlertError>()(
  "TelemetryAlertError",
  {
    command: Schema.String,
    exitCode: Schema.Int,
    stderr: Schema.String,
    message: Schema.String,
  },
) {}

export type TelemetryError =
  | TelemetryConfigError
  | TelemetryStoreError
  | TelemetryProxyError
  | TelemetryAlertError
