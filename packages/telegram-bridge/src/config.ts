import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Effect, Layer, Redacted, Schema } from "effect"

import { ConfigError } from "./errors.ts"
import {
  ApiBaseUrlSchema,
  BotTokenSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
  PrivateChatIdSchema,
} from "./schemas.ts"

export const DEFAULT_API_BASE = "https://api.telegram.org"
export const DEFAULT_POLL_TIMEOUT_SECONDS = 30
export const DEFAULT_REPLY_POLL_MS = 3000
export const DEFAULT_MAX_CHUNK_LENGTH = 4000
export const DEFAULT_BACKOFF_INITIAL_MS = 1000
export const DEFAULT_BACKOFF_MAX_MS = 30000
export const DEFAULT_ANNOUNCE_RETRIES = 3
export const DEFAULT_ANNOUNCE_RETRY_DELAY_MS = 500
export const DEFAULT_INBOX_TIMEOUT_MS = 15000
export const DEFAULT_SEND_TIMEOUT_MS = 30000

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(MODULE_DIR, "..", "..", "..")
export const DEFAULT_ENV_FILE = path.join(REPO_ROOT, ".env")
export const DEFAULT_STATE_FILE = path.join(REPO_ROOT, ".telegram-bridge-state.json")

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export const USAGE_TEXT = `Usage: telegram-bridge.ts [options]

Two-way Telegram bridge for firstmate (Effect-TS).

Options:
  --send <text>            Send a one-shot Telegram message and exit (use '-' for stdin)
  --firstmate-home <dir>   Path to firstmate home (default: FIRSTMATE_HOME or $HOME/firstmate)
  --env-file <path>        Path to .env file (default: <repo>/.env)
  --state-file <path>      Path to state JSON file (default: <repo>/.telegram-bridge-state.json)
  --api-base <url>         Telegram API base URL (default: https://api.telegram.org)
  --poll-timeout <sec>     Telegram getUpdates long-poll timeout in seconds (default: 30)
  --reply-poll-ms <ms>     Interval between outbound reply polls in ms (default: 3000)
  -h, --help               Show this help message
`

export interface ParsedCliArgs {
  readonly help: boolean
  readonly sendText: string | undefined
  readonly firstmateHome: string | undefined
  readonly envFile: string | undefined
  readonly stateFile: string | undefined
  readonly apiBase: string | undefined
  readonly pollTimeoutSeconds: number | undefined
  readonly replyPollMs: number | undefined
}

export interface BridgeRuntimeConfig {
  readonly help: false
  readonly token: Redacted.Redacted<string>
  readonly chatId: string
  readonly firstmateHome: string
  readonly envFilePath: string
  readonly stateFilePath: string
  readonly apiBase: string
  readonly sendText: string | undefined
  readonly pollTimeoutSeconds: number
  readonly replyPollMs: number
  readonly maxChunkLength: number
  readonly backoffInitialMs: number
  readonly backoffMaxMs: number
  readonly announceRetries: number
  readonly announceRetryDelayMs: number
  readonly inboxTimeoutMs: number
  readonly sendTimeoutMs: number
}

export type ResolveConfigResult =
  | { readonly help: true }
  | BridgeRuntimeConfig

export interface ResolveConfigOptions {
  readonly argv?: ReadonlyArray<string> | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly defaultEnvFile?: string | undefined
  readonly defaultStateFile?: string | undefined
  readonly homedir?: string | undefined
}

const decodeToken = Schema.decodeUnknownEffect(BotTokenSchema)
const decodeChatId = Schema.decodeUnknownEffect(PrivateChatIdSchema)
const decodeApiBase = Schema.decodeUnknownEffect(ApiBaseUrlSchema)
const decodeNonNegativeInt = Schema.decodeUnknownEffect(NonNegativeIntSchema)
const decodePositiveInt = Schema.decodeUnknownEffect(PositiveIntSchema)

/**
 * Safely parse a .env file without shell execution.
 */
export function parseEnvFileContent(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  const lines = String(content).split(/\r?\n/)

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue
    }

    const line = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trimStart()
      : trimmed

    const eqIndex = line.indexOf("=")
    if (eqIndex <= 0) {
      continue
    }

    const key = line.slice(0, eqIndex).trim()
    if (!ENV_KEY_RE.test(key)) {
      continue
    }

    const rawValue = line.slice(eqIndex + 1).trim()
    result[key] = parseEnvValue(rawValue)
  }

  return result
}

function parseEnvValue(rawValue: string): string {
  if (rawValue === "") {
    return ""
  }

  if (rawValue.startsWith('"')) {
    let out = ""
    for (let i = 1; i < rawValue.length; i += 1) {
      const ch = rawValue[i]
      if (ch === "\\" && i + 1 < rawValue.length) {
        const next = rawValue[i + 1]
        if (next === "n") {
          out += "\n"
        } else if (next === "r") {
          out += "\r"
        } else if (next === "t") {
          out += "\t"
        } else if (next === '"' || next === "\\") {
          out += next
        } else {
          out += ch + next
        }
        i += 1
        continue
      }
      if (ch === '"') {
        break
      }
      out += ch
    }
    return out
  }

  if (rawValue.startsWith("'")) {
    const endQuote = rawValue.indexOf("'", 1)
    return endQuote === -1 ? rawValue.slice(1) : rawValue.slice(1, endQuote)
  }

  // Strip inline comments only when preceded by whitespace.
  const commentIndex = rawValue.search(/\s+#/)
  return (commentIndex === -1 ? rawValue : rawValue.slice(0, commentIndex)).trim()
}

export const loadDotEnv = Effect.fn("loadDotEnv")(function*(
  envFilePath: string,
): Effect.fn.Return<Record<string, string>, ConfigError> {
  return yield* Effect.tryPromise({
    try: async () => {
      try {
        const content = await fs.readFile(envFilePath, "utf8")
        return parseEnvFileContent(content)
      } catch (err) {
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          err.code === "ENOENT"
        ) {
          return {}
        }
        throw err
      }
    },
    catch: (err) =>
      new ConfigError({
        message: `Failed to read env file ${envFilePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }),
  })
})

const parseNonNegativeIntArg = Effect.fnUntraced(function*(
  raw: string,
  label: string,
): Effect.fn.Return<number, ConfigError> {
  if (!/^\d+$/.test(raw)) {
    return yield* new ConfigError({
      message: `${label} must be a non-negative integer`,
    })
  }
  const value = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(value)) {
    return yield* new ConfigError({
      message: `${label} is out of range`,
    })
  }
  return yield* decodeNonNegativeInt(value).pipe(
    Effect.mapError(() =>
      new ConfigError({ message: `${label} must be a non-negative integer` })
    ),
  )
})

const parsePositiveIntArg = Effect.fnUntraced(function*(
  raw: string,
  label: string,
): Effect.fn.Return<number, ConfigError> {
  const value = yield* parseNonNegativeIntArg(raw, label)
  return yield* decodePositiveInt(value).pipe(
    Effect.mapError(() =>
      new ConfigError({ message: `${label} must be greater than zero` })
    ),
  )
})

export const parseCliArgs = Effect.fn("parseCliArgs")(function*(
  argv: ReadonlyArray<string>,
): Effect.fn.Return<ParsedCliArgs, ConfigError> {
  let help = false
  let sendText: string | undefined
  let firstmateHome: string | undefined
  let envFile: string | undefined
  let stateFile: string | undefined
  let apiBase: string | undefined
  let pollTimeoutSeconds: number | undefined
  let replyPollMs: number | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) {
      continue
    }
    if (arg === "-h" || arg === "--help") {
      help = true
      continue
    }

    const eqIdx = arg.indexOf("=")
    const flag = eqIdx === -1 ? arg : arg.slice(0, eqIdx)

    const readValue = (): Effect.Effect<string, ConfigError> => {
      if (eqIdx !== -1) {
        return Effect.succeed(arg.slice(eqIdx + 1))
      }
      const next = argv[i + 1]
      if (next === undefined) {
        return Effect.fail(
          new ConfigError({
            message: `Missing value for option: ${flag}`,
          }),
        )
      }
      i += 1
      return Effect.succeed(next)
    }

    switch (flag) {
      case "--send":
        sendText = yield* readValue()
        break
      case "--firstmate-home":
        firstmateHome = yield* readValue()
        break
      case "--env-file":
        envFile = yield* readValue()
        break
      case "--state-file":
        stateFile = yield* readValue()
        break
      case "--api-base":
        apiBase = yield* readValue()
        break
      case "--poll-timeout":
        pollTimeoutSeconds = yield* parseNonNegativeIntArg(yield* readValue(), "--poll-timeout")
        break
      case "--reply-poll-ms":
        replyPollMs = yield* parsePositiveIntArg(yield* readValue(), "--reply-poll-ms")
        break
      default:
        return yield* new ConfigError({
          message: `Unknown option: ${arg}`,
        })
    }
  }

  return {
    help,
    sendText,
    firstmateHome,
    envFile,
    stateFile,
    apiBase,
    pollTimeoutSeconds,
    replyPollMs,
  }
})

export const validateConfig = Effect.fn("validateConfig")(function*(input: {
  readonly token: string
  readonly chatId: string
  readonly apiBase: string
}): Effect.fn.Return<
  { readonly token: Redacted.Redacted<string>; readonly chatId: string; readonly apiBase: string },
  ConfigError
> {
  const validToken = yield* decodeToken(input.token).pipe(
    Effect.mapError(() =>
      new ConfigError({
        message: "CLANKER_UPDATES_TOKEN is missing or invalid",
      })
    ),
  )
  const validChatId = yield* decodeChatId(input.chatId).pipe(
    Effect.mapError(() =>
      new ConfigError({
        message: "CLANKER_UPDATES_CHAT_ID must be a positive numeric private chat ID",
      })
    ),
  )
  const validApiBase = yield* decodeApiBase(input.apiBase).pipe(
    Effect.mapError(() =>
      new ConfigError({
        message: "Telegram API base URL must start with http:// or https://",
      })
    ),
  )

  return {
    token: Redacted.make(validToken),
    chatId: validChatId,
    apiBase: validApiBase,
  }
})

export const resolveConfig = Effect.fn("resolveConfig")(function*(
  options: ResolveConfigOptions = {},
): Effect.fn.Return<ResolveConfigResult, ConfigError> {
  const argv = options.argv ?? []
  const env = options.env ?? process.env
  const defaultEnvFile = options.defaultEnvFile ?? DEFAULT_ENV_FILE
  const defaultStateFile = options.defaultStateFile ?? DEFAULT_STATE_FILE
  const homedir = options.homedir ?? os.homedir()

  const cli = yield* parseCliArgs(argv)
  if (cli.help) {
    return { help: true } as const
  }

  const envFilePath = cli.envFile ? path.resolve(cli.envFile) : defaultEnvFile
  const dotEnv = yield* loadDotEnv(envFilePath)

  const readSetting = (key: string): string => {
    const fromEnv = env[key]
    if (fromEnv !== undefined && fromEnv !== "") {
      return fromEnv
    }
    const fromFile = dotEnv[key]
    if (fromFile !== undefined && fromFile !== "") {
      return fromFile
    }
    return ""
  }

  const rawToken = readSetting("CLANKER_UPDATES_TOKEN").trim()
  const rawChatId = readSetting("CLANKER_UPDATES_CHAT_ID").trim()
  const firstmateHomeRaw = cli.firstmateHome || readSetting("FIRSTMATE_HOME") ||
    path.join(homedir, "firstmate")
  const rawApiBase = (cli.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "")
  const stateFilePath = cli.stateFile ? path.resolve(cli.stateFile) : defaultStateFile

  const validated = yield* validateConfig({
    token: rawToken,
    chatId: rawChatId,
    apiBase: rawApiBase,
  })

  return {
    help: false,
    token: validated.token,
    chatId: validated.chatId,
    firstmateHome: path.resolve(firstmateHomeRaw),
    envFilePath,
    stateFilePath,
    apiBase: validated.apiBase,
    sendText: cli.sendText,
    pollTimeoutSeconds: cli.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS,
    replyPollMs: cli.replyPollMs ?? DEFAULT_REPLY_POLL_MS,
    maxChunkLength: DEFAULT_MAX_CHUNK_LENGTH,
    backoffInitialMs: DEFAULT_BACKOFF_INITIAL_MS,
    backoffMaxMs: DEFAULT_BACKOFF_MAX_MS,
    announceRetries: DEFAULT_ANNOUNCE_RETRIES,
    announceRetryDelayMs: DEFAULT_ANNOUNCE_RETRY_DELAY_MS,
    inboxTimeoutMs: DEFAULT_INBOX_TIMEOUT_MS,
    sendTimeoutMs: DEFAULT_SEND_TIMEOUT_MS,
  }
})

export function makeBridgeRuntimeConfig(input: {
  readonly token: string | Redacted.Redacted<string>
  readonly chatId: string
  readonly firstmateHome: string
  readonly stateFilePath: string
  readonly envFilePath?: string | undefined
  readonly apiBase?: string | undefined
  readonly sendText?: string | undefined
  readonly pollTimeoutSeconds?: number | undefined
  readonly replyPollMs?: number | undefined
  readonly maxChunkLength?: number | undefined
  readonly backoffInitialMs?: number | undefined
  readonly backoffMaxMs?: number | undefined
  readonly announceRetries?: number | undefined
  readonly announceRetryDelayMs?: number | undefined
  readonly inboxTimeoutMs?: number | undefined
  readonly sendTimeoutMs?: number | undefined
}): BridgeRuntimeConfig {
  return {
    help: false,
    token: Redacted.isRedacted(input.token) ? input.token : Redacted.make(input.token),
    chatId: input.chatId,
    firstmateHome: input.firstmateHome,
    envFilePath: input.envFilePath ?? DEFAULT_ENV_FILE,
    stateFilePath: input.stateFilePath,
    apiBase: (input.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, ""),
    sendText: input.sendText,
    pollTimeoutSeconds: input.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS,
    replyPollMs: input.replyPollMs ?? DEFAULT_REPLY_POLL_MS,
    maxChunkLength: input.maxChunkLength ?? DEFAULT_MAX_CHUNK_LENGTH,
    backoffInitialMs: input.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS,
    backoffMaxMs: input.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
    announceRetries: input.announceRetries ?? DEFAULT_ANNOUNCE_RETRIES,
    announceRetryDelayMs: input.announceRetryDelayMs ?? DEFAULT_ANNOUNCE_RETRY_DELAY_MS,
    inboxTimeoutMs: input.inboxTimeoutMs ?? DEFAULT_INBOX_TIMEOUT_MS,
    sendTimeoutMs: input.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
  }
}

export class BridgeConfig extends Context.Service<BridgeConfig, BridgeRuntimeConfig>()(
  "clanker-whips/telegram-bridge/BridgeConfig",
) {
  static layer(config: BridgeRuntimeConfig): Layer.Layer<BridgeConfig> {
    return Layer.succeed(BridgeConfig, config)
  }
}
