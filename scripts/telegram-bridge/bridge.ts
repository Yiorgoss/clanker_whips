import { Context, Duration, Effect, Layer, Redacted, Ref, Schedule } from "effect"

import { BridgeConfig, type BridgeRuntimeConfig } from "./config.ts"
import {
  ConfigError,
  TelegramApiError,
  redactSecrets,
  type BridgeError,
} from "./errors.ts"
import { FirstmateInbox } from "./firstmate-inbox.ts"
import type { TelegramUpdate } from "./schemas.ts"
import { StateStore } from "./state-store.ts"
import { TelegramClient, isAllowedMessageUpdate, type FetchLike } from "./telegram-client.ts"

export interface BridgeLoggerShape {
  readonly info: (message: string) => Effect.Effect<void>
  readonly error: (message: string) => Effect.Effect<void>
}

export class BridgeLogger extends Context.Service<BridgeLogger, BridgeLoggerShape>()(
  "clanker-whips/telegram-bridge/BridgeLogger",
) {
  static readonly layer: Layer.Layer<BridgeLogger, never, BridgeConfig> = Layer.effect(
    BridgeLogger,
    Effect.gen(function*() {
      const config = yield* BridgeConfig
      return BridgeLogger.of({
        info: (message) =>
          Effect.sync(() => {
            process.stdout.write(`${redactSecrets(`[telegram-bridge] ${message}`, config.token)}\n`)
          }),
        error: (message) =>
          Effect.sync(() => {
            process.stderr.write(
              `${redactSecrets(`[telegram-bridge] ERROR: ${message}`, config.token)}\n`,
            )
          }),
      })
    }),
  )

  static layerCustom(options: {
    readonly token?: string | Redacted.Redacted<string> | undefined
    readonly stdout?: ((line: string) => void) | undefined
    readonly stderr?: ((line: string) => void) | undefined
  }): Layer.Layer<BridgeLogger> {
    const writeOut = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`))
    const writeErr = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`))
    return Layer.succeed(BridgeLogger, {
      info: (message) =>
        Effect.sync(() => {
          writeOut(redactSecrets(`[telegram-bridge] ${message}`, options.token))
        }),
      error: (message) =>
        Effect.sync(() => {
          writeErr(redactSecrets(`[telegram-bridge] ERROR: ${message}`, options.token))
        }),
    })
  }
}

export function computeBackoffDelayMs(
  err: unknown,
  currentBackoffMs: number,
  maxBackoffMs: number,
): number {
  if (
    err instanceof TelegramApiError &&
    err.retryAfterSeconds !== null &&
    err.retryAfterSeconds > 0
  ) {
    return Math.min(err.retryAfterSeconds * 1000, Math.max(maxBackoffMs, 120_000))
  }
  return Math.min(currentBackoffMs, maxBackoffMs)
}

export function makePollRetrySchedule(options: {
  readonly label: string
  readonly initialMs: number
  readonly maxMs: number
  readonly logger: BridgeLoggerShape
}) {
  return Schedule.min([
    Schedule.exponential(Duration.millis(options.initialMs)),
    Schedule.spaced(Duration.millis(options.maxMs)),
  ]).pipe(
    Schedule.setInputType<BridgeError>(),
    Schedule.modifyDelay(({ input, duration }) => {
      const computedMs = computeBackoffDelayMs(
        input,
        Duration.toMillis(duration),
        options.maxMs,
      )
      return Effect.succeed(Duration.millis(computedMs))
    }),
    Schedule.tap(({ input, duration }) =>
      options.logger.error(
        `${options.label} failed: ${input.message} (retrying in ${Duration.toMillis(duration)}ms)`,
      )
    ),
  )
}

const safeNotifyChat = Effect.fn("Bridge.safeNotifyChat")(function*(
  message: string,
): Effect.fn.Return<void, never, BridgeConfig | TelegramClient | BridgeLogger> {
  const config = yield* BridgeConfig
  const telegram = yield* TelegramClient
  const logger = yield* BridgeLogger

  yield* telegram
    .sendChunkedMessage(config.chatId, message, {
      maxLength: config.maxChunkLength,
    })
    .pipe(
      Effect.asVoid,
      Effect.catch((err) => logger.error(`failed to notify chat: ${err.message}`)),
    )
})

const retryAnnounce = Effect.fn("Bridge.retryAnnounce")(function*(
  requestId: string,
  noteId: string | null,
  originalText: string,
  initialStderr: string,
): Effect.fn.Return<
  { readonly ok: boolean; readonly exitCode: number; readonly stderr: string },
  never,
  BridgeConfig | FirstmateInbox | BridgeLogger
> {
  const config = yield* BridgeConfig
  const inbox = yield* FirstmateInbox
  const logger = yield* BridgeLogger

  if (config.announceRetries <= 0) {
    return { ok: false, exitCode: 3, stderr: initialStderr }
  }

  const attemptRef = yield* Ref.make(0)

  const singleAttempt = Effect.gen(function*() {
    const attempt = yield* Ref.updateAndGet(attemptRef, (n) => n + 1)
    yield* Effect.sleep(Duration.millis(config.announceRetryDelayMs * attempt))

    const res = noteId !== null
      ? yield* inbox.announceNote(noteId)
      : yield* inbox.submitNote(requestId, originalText).pipe(
        Effect.map((outcome) =>
          outcome.status === "ok"
            ? { ok: true, exitCode: 0, stderr: "" }
            : { ok: false, exitCode: outcome.exitCode, stderr: outcome.stderr }
        ),
      )

    if (res.ok) {
      return res
    }

    yield* logger.error(
      `announce retry ${attempt}/${config.announceRetries} for ${
        noteId ?? requestId
      } failed (exit ${res.exitCode})`,
    )
    return yield* Effect.fail(res)
  })

  return yield* singleAttempt.pipe(
    Effect.retry(Schedule.recurs(config.announceRetries - 1)),
    Effect.catch((lastFailed) => Effect.succeed(lastFailed)),
  )
})

const submitInboundText = Effect.fn("Bridge.submitInboundText")(function*(
  updateId: number,
  text: string,
): Effect.fn.Return<void, never, BridgeConfig | FirstmateInbox | TelegramClient | BridgeLogger> {
  const inbox = yield* FirstmateInbox
  const logger = yield* BridgeLogger
  const requestId = `tg-${updateId}`

  const result = yield* inbox.submitNote(requestId, text)

  if (result.status === "ok") {
    yield* logger.info(`inbound ${requestId} -> ${result.noteId} (${result.outcome})`)
    return
  }

  if (result.status === "announce_failed") {
    const repaired = yield* retryAnnounce(requestId, result.noteId, text, result.stderr)
    if (repaired.ok) {
      yield* logger.info(
        `inbound ${requestId} -> ${result.noteId ?? "unknown"} (announce repaired)`,
      )
      return
    }
    yield* logger.error(
      `inbound ${requestId} saved (${
        result.noteId ?? "unknown id"
      }) but announce failed (exit ${repaired.exitCode}): ${repaired.stderr.trim()}`,
    )
    yield* safeNotifyChat(
      `Note saved (${
        result.noteId ?? requestId
      }), but waking firstmate failed (exit ${repaired.exitCode}).`,
    )
    return
  }

  yield* logger.error(
    `inbound ${requestId} failed (exit ${result.exitCode}): ${
      result.stderr.trim() || "unknown error"
    }`,
  )
  yield* safeNotifyChat(`Failed to deliver note to firstmate (exit ${result.exitCode}).`)
})

export const handleUpdate = Effect.fn("Bridge.handleUpdate")(function*(
  update: TelegramUpdate,
) {
  const config = yield* BridgeConfig
  const stateStore = yield* StateStore

  if (isAllowedMessageUpdate(update, config.chatId)) {
    const text = update.message.text
    if (typeof text === "string" && text.trim().length > 0) {
      yield* submitInboundText(update.update_id, text)
    }
  }

  yield* stateStore.advanceOffset(update.update_id + 1)
})

export const pollInboundOnce = Effect.fn("Bridge.pollInboundOnce")(function*() {
  const config = yield* BridgeConfig
  const telegram = yield* TelegramClient
  const stateStore = yield* StateStore

  const state = yield* stateStore.get
  const updates = yield* telegram.getUpdates({
    offset: state.offset,
    timeoutSeconds: config.pollTimeoutSeconds,
  })

  for (const update of updates) {
    yield* handleUpdate(update)
  }

  return updates.length
})

export const pollOutboundOnce = Effect.fn("Bridge.pollOutboundOnce")(function*() {
  const config = yield* BridgeConfig
  const inbox = yield* FirstmateInbox
  const telegram = yield* TelegramClient
  const stateStore = yield* StateStore
  const logger = yield* BridgeLogger

  const replies = yield* inbox.fetchReceipts

  let deliveredCount = 0
  for (const reply of replies) {
    const alreadyDelivered = yield* stateStore.hasDeliveredReply(reply.id)
    if (alreadyDelivered) {
      continue
    }

    yield* telegram.sendChunkedMessage(config.chatId, reply.body, {
      maxLength: config.maxChunkLength,
    })

    yield* stateStore.markReplyDelivered(reply.id)
    deliveredCount += 1
    yield* logger.info(`outbound reply ${reply.id} delivered`)
  }

  return deliveredCount
})

export const runBridge = Effect.fn("Bridge.run")(function*() {
  const config = yield* BridgeConfig
  const logger = yield* BridgeLogger

  yield* logger.info(
    `started (firstmateHome=${config.firstmateHome}, stateFile=${config.stateFilePath})`,
  )

  const inboundRetry = makePollRetrySchedule({
    label: "inbound poll",
    initialMs: config.backoffInitialMs,
    maxMs: config.backoffMaxMs,
    logger,
  })

  const outboundRetry = makePollRetrySchedule({
    label: "outbound poll",
    initialMs: config.backoffInitialMs,
    maxMs: config.backoffMaxMs,
    logger,
  })

  const inboundLoop = pollInboundOnce().pipe(
    Effect.retry(inboundRetry),
    Effect.repeat(Schedule.forever),
  )

  const outboundLoop = pollOutboundOnce().pipe(
    Effect.retry(outboundRetry),
    Effect.repeat(Schedule.spaced(Duration.millis(config.replyPollMs))),
  )

  yield* Effect.all([inboundLoop, outboundLoop], {
    concurrency: "unbounded",
  }).pipe(
    Effect.asVoid,
    Effect.ensuring(logger.info("stopped cleanly")),
  )
})

export const sendOneShot = Effect.fn("Bridge.sendOneShot")(function*(
  text: string,
): Effect.fn.Return<number, ConfigError | TelegramApiError, BridgeConfig | TelegramClient> {
  if (text.trim().length === 0) {
    return yield* new ConfigError({
      message: "Refusing to send an empty message",
    })
  }
  const config = yield* BridgeConfig
  const telegram = yield* TelegramClient
  return yield* telegram.sendChunkedMessage(config.chatId, text, {
    maxLength: config.maxChunkLength,
  })
})

export function makeLiveBridgeLayer(
  config: BridgeRuntimeConfig,
  options: {
    readonly fetchImpl?: FetchLike | undefined
    readonly stdout?: ((line: string) => void) | undefined
    readonly stderr?: ((line: string) => void) | undefined
  } = {},
) {
  const configLayer = BridgeConfig.layer(config)
  const loggerLayer = options.stdout || options.stderr
    ? BridgeLogger.layerCustom({
      token: config.token,
      stdout: options.stdout,
      stderr: options.stderr,
    })
    : BridgeLogger.layer
  const telegramLayer = options.fetchImpl
    ? TelegramClient.layerWithFetch(options.fetchImpl)
    : TelegramClient.layer
  const stateLayer = StateStore.layerFile(config.stateFilePath)

  return Layer.mergeAll(
    loggerLayer,
    telegramLayer,
    FirstmateInbox.layer,
    stateLayer,
  ).pipe(Layer.provideMerge(configLayer))
}
