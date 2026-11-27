#!/usr/bin/env node

import path from "node:path"
import { fileURLToPath } from "node:url"
import { Cause, Effect, Exit, Fiber, Layer, Option, Redacted } from "effect"

import {
  makeLiveBridgeLayer,
  runBridge,
  sendOneShot,
} from "./telegram-bridge/bridge.ts"
import {
  BridgeConfig,
  USAGE_TEXT,
  resolveConfig,
} from "./telegram-bridge/config.ts"
import { ConfigError, redactSecrets } from "./telegram-bridge/errors.ts"
import { TelegramClient } from "./telegram-bridge/telegram-client.ts"

export * from "./telegram-bridge/errors.ts"
export * from "./telegram-bridge/schemas.ts"
export * from "./telegram-bridge/config.ts"
export * from "./telegram-bridge/state-store.ts"
export * from "./telegram-bridge/telegram-client.ts"
export * from "./telegram-bridge/firstmate-inbox.ts"
export * from "./telegram-bridge/bridge.ts"

const readStdinText = Effect.tryPromise({
  try: async () => {
    const chunks: Array<Buffer> = []
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
    }
    return Buffer.concat(chunks).toString("utf8")
  },
  catch: (err) =>
    new ConfigError({
      message: `Failed to read stdin: ${err instanceof Error ? err.message : String(err)}`,
    }),
})

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

export async function runCli(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> {
  let tokenForRedaction: string | Redacted.Redacted<string> =
    process.env.CLANKER_UPDATES_TOKEN ?? ""

  const configExit = await Effect.runPromiseExit(resolveConfig({ argv }))
  if (Exit.isFailure(configExit)) {
    const message = redactSecrets(extractFailureMessage(configExit.cause), tokenForRedaction)
    process.stderr.write(`[telegram-bridge] ERROR: ${message}\n`)
    return 1
  }

  const config = configExit.value
  if (config.help) {
    process.stdout.write(USAGE_TEXT)
    return 0
  }

  tokenForRedaction = config.token

  if (config.sendText !== undefined) {
    const sendProgram = Effect.gen(function*() {
      const text = config.sendText === "-" ? yield* readStdinText : config.sendText!
      yield* sendOneShot(text)
    }).pipe(
      Effect.provide(
        TelegramClient.layer.pipe(Layer.provideMerge(BridgeConfig.layer(config))),
      ),
    )

    const sendExit = await Effect.runPromiseExit(sendProgram)
    if (Exit.isFailure(sendExit)) {
      const message = redactSecrets(extractFailureMessage(sendExit.cause), tokenForRedaction)
      process.stderr.write(`[telegram-bridge] ERROR: ${message}\n`)
      return 1
    }
    return 0
  }

  const bridgeProgram = runBridge().pipe(
    Effect.provide(makeLiveBridgeLayer(config)),
  )

  const fiber = Effect.runFork(bridgeProgram)

  let shuttingDown = false
  const onSignal = (signalName: NodeJS.Signals) => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    process.stdout.write(
      `${redactSecrets(`[telegram-bridge] received ${signalName}, shutting down`, tokenForRedaction)}\n`,
    )
    void Effect.runPromise(Fiber.interrupt(fiber))
  }

  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)

  let exit: Exit.Exit<void, unknown>
  try {
    exit = await Effect.runPromise(Fiber.await(fiber))
  } finally {
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
  }

  if (Exit.isSuccess(exit)) {
    return 0
  }

  if (Cause.hasInterruptsOnly(exit.cause)) {
    return 0
  }

  const message = redactSecrets(extractFailureMessage(exit.cause), tokenForRedaction)
  process.stderr.write(`[telegram-bridge] ERROR: ${message}\n`)
  return 1
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectExecution) {
  const exitCode = await runCli()
  process.exitCode = exitCode
}
