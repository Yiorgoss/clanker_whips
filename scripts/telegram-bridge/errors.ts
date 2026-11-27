import { Redacted, Schema } from "effect"

const BOT_TOKEN_PATH_RE = /\/bot[^/\s?#]+/gi

/**
 * Redact the bot token and any Telegram /bot<token> URL segment from a value.
 */
export function redactSecrets(
  input: unknown,
  token?: string | Redacted.Redacted<string>,
): string {
  let text = String(input ?? "")
  const rawToken = token === undefined
    ? undefined
    : Redacted.isRedacted(token)
    ? Redacted.value(token)
    : token

  if (typeof rawToken === "string" && rawToken.length > 0) {
    text = text.split(rawToken).join("[REDACTED]")
    const encoded = encodeURIComponent(rawToken)
    if (encoded !== rawToken) {
      text = text.split(encoded).join("[REDACTED]")
    }
  }
  return text.replace(BOT_TOKEN_PATH_RE, "/bot[REDACTED]")
}

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
}) {}

export class TelegramApiError extends Schema.TaggedError<TelegramApiError>()("TelegramApiError", {
  method: Schema.String,
  message: Schema.String,
  statusCode: Schema.NullOr(Schema.Int),
  retryAfterSeconds: Schema.NullOr(Schema.Int),
}) {}

export class InboxCommandError extends Schema.TaggedError<InboxCommandError>()("InboxCommandError", {
  command: Schema.String,
  exitCode: Schema.Int,
  stderr: Schema.String,
  message: Schema.String,
}) {}

export class StateStoreError extends Schema.TaggedError<StateStoreError>()("StateStoreError", {
  operation: Schema.Literals(["load", "save"]),
  path: Schema.String,
  message: Schema.String,
}) {}

export type BridgeError =
  | ConfigError
  | TelegramApiError
  | InboxCommandError
  | StateStoreError
