import { Context, Duration, Effect, Layer, Option, Redacted, Schema } from "effect"

import {
  BridgeConfig,
  DEFAULT_API_BASE,
  DEFAULT_MAX_CHUNK_LENGTH,
  DEFAULT_POLL_TIMEOUT_SECONDS,
  DEFAULT_SEND_TIMEOUT_MS,
} from "./config.ts"
import { TelegramApiError, redactSecrets } from "./errors.ts"
import {
  TelegramApiResponseJsonSchema,
  TelegramGetUpdatesResultSchema,
  TelegramSendMessageResultSchema,
  TelegramUpdateSchema,
  type TelegramMessage,
  type TelegramSendMessageResult,
  type TelegramUpdate,
} from "./schemas.ts"

const decodeApiResponseOption = Schema.decodeUnknownOption(TelegramApiResponseJsonSchema)
const decodeGetUpdatesResult = Schema.decodeUnknownEffect(TelegramGetUpdatesResultSchema)
const decodeSendMessageResult = Schema.decodeUnknownEffect(TelegramSendMessageResultSchema)
const decodeUpdateOption = Schema.decodeUnknownOption(TelegramUpdateSchema)

export type FetchLike = typeof globalThis.fetch

export interface AllowedMessageUpdate extends TelegramUpdate {
  readonly message: TelegramMessage
}

/**
 * Split long text into chunks <= maxLength at newline or space boundaries.
 */
export function chunkMessage(
  text: string,
  maxLength: number = DEFAULT_MAX_CHUNK_LENGTH,
): Array<string> {
  if (typeof text !== "string") {
    throw new Error("Message text must be a string")
  }
  if (!Number.isInteger(maxLength) || maxLength <= 0) {
    throw new Error("maxLength must be a positive integer")
  }
  if (text.trim().length === 0) {
    return []
  }
  if (text.length <= maxLength) {
    return [text]
  }

  const chunks: Array<string> = []
  let remaining = text
  const minPreferredSplit = Math.floor(maxLength * 0.5)

  while (remaining.length > maxLength) {
    const nlIndex = remaining.lastIndexOf("\n", maxLength)
    const spIndex = remaining.lastIndexOf(" ", maxLength)

    let splitIndex = -1
    let consumeSeparator = false

    if (nlIndex >= minPreferredSplit && hasNonWhitespace(remaining, nlIndex)) {
      splitIndex = nlIndex
      consumeSeparator = true
    } else if (spIndex >= minPreferredSplit && hasNonWhitespace(remaining, spIndex)) {
      splitIndex = spIndex
      consumeSeparator = true
    } else if (nlIndex > 0 && hasNonWhitespace(remaining, nlIndex)) {
      splitIndex = nlIndex
      consumeSeparator = true
    } else if (spIndex > 0 && hasNonWhitespace(remaining, spIndex)) {
      splitIndex = spIndex
      consumeSeparator = true
    } else {
      splitIndex = maxLength
      consumeSeparator = false
    }

    const chunk = remaining.slice(0, splitIndex)
    if (chunk.trim().length > 0) {
      chunks.push(chunk)
    }
    remaining = remaining.slice(consumeSeparator ? splitIndex + 1 : splitIndex)
  }

  if (remaining.length > 0 && remaining.trim().length > 0) {
    chunks.push(remaining)
  }

  return chunks
}

function hasNonWhitespace(str: string, endIndex: number): boolean {
  return str.slice(0, endIndex).trim().length > 0
}

/**
 * Strict allowlist: accept only private chats whose chat.id matches allowedChatId.
 */
export function isAllowedMessageUpdate(
  update: unknown,
  allowedChatId: string,
): update is AllowedMessageUpdate {
  const decoded = decodeUpdateOption(update)
  if (Option.isNone(decoded)) {
    return false
  }
  const msg = decoded.value.message
  if (msg === undefined) {
    return false
  }
  if (msg.chat.type !== "private") {
    return false
  }
  return String(msg.chat.id) === String(allowedChatId)
}

export interface TelegramClientShape {
  readonly call: (
    method: string,
    payload: Record<string, unknown>,
    options?: { readonly timeoutMs?: number | undefined },
  ) => Effect.Effect<unknown, TelegramApiError>
  readonly getUpdates: (options?: {
    readonly offset?: number | undefined
    readonly timeoutSeconds?: number | undefined
  }) => Effect.Effect<ReadonlyArray<TelegramUpdate>, TelegramApiError>
  readonly sendMessage: (
    chatId: string,
    text: string,
    options?: { readonly timeoutMs?: number | undefined },
  ) => Effect.Effect<TelegramSendMessageResult, TelegramApiError>
  readonly sendChunkedMessage: (
    chatId: string,
    text: string,
    options?: { readonly maxLength?: number | undefined },
  ) => Effect.Effect<number, TelegramApiError>
}

export interface TelegramClientLiveOptions {
  readonly token: Redacted.Redacted<string>
  readonly apiBase?: string | undefined
  readonly fetchImpl?: FetchLike | undefined
  readonly defaultSendTimeoutMs?: number | undefined
}

export function makeLiveTelegramClient(
  options: TelegramClientLiveOptions,
): TelegramClientShape {
  const token = options.token
  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "")
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const defaultSendTimeoutMs = options.defaultSendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS

  const call = Effect.fn("TelegramClient.call")(function*(
    method: string,
    payload: Record<string, unknown>,
    callOptions: { readonly timeoutMs?: number | undefined } = {},
  ): Effect.fn.Return<unknown, TelegramApiError> {
    const timeoutMs = callOptions.timeoutMs ?? defaultSendTimeoutMs
    const url = `${apiBase}/bot${Redacted.value(token)}/${method}`

    const httpResult = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        })
        const rawBody = await response.text()
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          rawBody,
        }
      },
      catch: (err) => {
        const detail = extractErrorDetail(err)
        return new TelegramApiError({
          method,
          message: redactSecrets(`Telegram ${method} network error: ${detail}`, token),
          statusCode: null,
          retryAfterSeconds: null,
        })
      },
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () =>
          Effect.fail(
            new TelegramApiError({
              method,
              message: redactSecrets(
                `Telegram ${method} network error: Timed out after ${timeoutMs}ms`,
                token,
              ),
              statusCode: null,
              retryAfterSeconds: null,
            }),
          ),
      }),
    )

    const parsedOption = httpResult.rawBody.length > 0
      ? decodeApiResponseOption(httpResult.rawBody)
      : Option.none()

    if (!httpResult.ok || Option.isNone(parsedOption) || parsedOption.value.ok !== true) {
      const parsed = Option.isSome(parsedOption) ? parsedOption.value : undefined
      const description = parsed?.description ||
        httpResult.rawBody.slice(0, 200) ||
        httpResult.statusText ||
        "unknown error"
      const retryAfter = parsed?.parameters?.retry_after ?? null

      return yield* new TelegramApiError({
        method,
        message: redactSecrets(
          `Telegram ${method} failed (HTTP ${httpResult.status}): ${description}`,
          token,
        ),
        statusCode: httpResult.status,
        retryAfterSeconds: retryAfter,
      })
    }

    return parsedOption.value.result
  })

  const getUpdates = Effect.fn("TelegramClient.getUpdates")(function*(
    opts: {
      readonly offset?: number | undefined
      readonly timeoutSeconds?: number | undefined
    } = {},
  ): Effect.fn.Return<ReadonlyArray<TelegramUpdate>, TelegramApiError> {
    const offset = opts.offset ?? 0
    const timeoutSeconds = opts.timeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS
    const payload: Record<string, unknown> = {
      timeout: timeoutSeconds,
      allowed_updates: ["message"],
    }
    if (offset > 0) {
      payload.offset = offset
    }
    const timeoutMs = (timeoutSeconds + 15) * 1000
    const result = yield* call("getUpdates", payload, { timeoutMs })
    return yield* decodeGetUpdatesResult(result).pipe(
      Effect.mapError((err) =>
        new TelegramApiError({
          method: "getUpdates",
          message: redactSecrets(
            `Telegram getUpdates returned invalid result: ${err.message}`,
            token,
          ),
          statusCode: null,
          retryAfterSeconds: null,
        })
      ),
    )
  })

  const sendMessage = Effect.fn("TelegramClient.sendMessage")(function*(
    chatId: string,
    text: string,
    opts: { readonly timeoutMs?: number | undefined } = {},
  ): Effect.fn.Return<TelegramSendMessageResult, TelegramApiError> {
    const result = yield* call(
      "sendMessage",
      { chat_id: chatId, text },
      { timeoutMs: opts.timeoutMs ?? defaultSendTimeoutMs },
    )
    return yield* decodeSendMessageResult(result).pipe(
      Effect.mapError((err) =>
        new TelegramApiError({
          method: "sendMessage",
          message: redactSecrets(
            `Telegram sendMessage returned invalid result: ${err.message}`,
            token,
          ),
          statusCode: null,
          retryAfterSeconds: null,
        })
      ),
    )
  })

  const sendChunkedMessage = Effect.fn("TelegramClient.sendChunkedMessage")(function*(
    chatId: string,
    text: string,
    opts: { readonly maxLength?: number | undefined } = {},
  ): Effect.fn.Return<number, TelegramApiError> {
    const chunks = chunkMessage(text, opts.maxLength ?? DEFAULT_MAX_CHUNK_LENGTH)
    for (const chunk of chunks) {
      yield* sendMessage(chatId, chunk)
    }
    return chunks.length
  })

  return {
    call,
    getUpdates,
    sendMessage,
    sendChunkedMessage,
  }
}

function extractErrorDetail(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    if (
      "cause" in err &&
      typeof err.cause === "object" &&
      err.cause !== null &&
      "message" in err.cause &&
      typeof err.cause.message === "string"
    ) {
      return err.cause.message
    }
    if ("message" in err && typeof err.message === "string") {
      return err.message
    }
  }
  return String(err)
}

export class TelegramClient extends Context.Service<TelegramClient, TelegramClientShape>()(
  "clanker-whips/telegram-bridge/TelegramClient",
) {
  static readonly layer: Layer.Layer<TelegramClient, never, BridgeConfig> = Layer.effect(
    TelegramClient,
    Effect.gen(function*() {
      const config = yield* BridgeConfig
      return TelegramClient.of(
        makeLiveTelegramClient({
          token: config.token,
          apiBase: config.apiBase,
          defaultSendTimeoutMs: config.sendTimeoutMs,
        }),
      )
    }),
  )

  static layerWithFetch(
    fetchImpl: FetchLike,
  ): Layer.Layer<TelegramClient, never, BridgeConfig> {
    return Layer.effect(
      TelegramClient,
      Effect.gen(function*() {
        const config = yield* BridgeConfig
        return TelegramClient.of(
          makeLiveTelegramClient({
            token: config.token,
            apiBase: config.apiBase,
            fetchImpl,
            defaultSendTimeoutMs: config.sendTimeoutMs,
          }),
        )
      }),
    )
  }

  static layerTest(impl: TelegramClientShape): Layer.Layer<TelegramClient> {
    return Layer.succeed(TelegramClient, impl)
  }
}
