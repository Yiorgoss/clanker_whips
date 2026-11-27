import { execFile, spawn } from "node:child_process"
import path from "node:path"
import { Context, Effect, Layer, Option, Schema } from "effect"

import { BridgeConfig, DEFAULT_INBOX_TIMEOUT_MS } from "./config.ts"
import { InboxCommandError } from "./errors.ts"
import {
  FmInboxNoteResponseJsonSchema,
  FmInboxReceiptsResponseJsonSchema,
  FmInboxReplySchema,
  type FmInboxReply,
} from "./schemas.ts"

const decodeNoteResponseOption = Schema.decodeUnknownOption(FmInboxNoteResponseJsonSchema)
const decodeReceiptsResponse = Schema.decodeUnknownEffect(FmInboxReceiptsResponseJsonSchema)
const decodeReplyOption = Schema.decodeUnknownOption(FmInboxReplySchema)

export interface FmInboxExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface ExecFmInboxOptions {
  readonly firstmateHome?: string | undefined
  readonly timeoutMs?: number | undefined
  readonly stdinText?: string | null | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
}

export type SubmitNoteOutcome =
  | {
    readonly status: "ok"
    readonly noteId: string
    readonly outcome: string
  }
  | {
    readonly status: "announce_failed"
    readonly noteId: string | null
    readonly exitCode: number
    readonly stderr: string
  }
  | {
    readonly status: "failed"
    readonly exitCode: number
    readonly stderr: string
  }

export interface AnnounceOutcome {
  readonly ok: boolean
  readonly exitCode: number
  readonly stderr: string
}

export interface FirstmateInboxShape {
  readonly submitNote: (
    requestId: string,
    text: string,
  ) => Effect.Effect<SubmitNoteOutcome>
  readonly announceNote: (
    noteId: string,
  ) => Effect.Effect<AnnounceOutcome>
  readonly fetchReceipts: Effect.Effect<ReadonlyArray<FmInboxReply>, InboxCommandError>
}

/**
 * Execute fm-inbox.sh directly without a shell.
 * When stdinText is provided, writes it to stdin and closes stdin so literal '-' bodies never hang.
 * Interrupting the Effect cleanly kills the child process.
 */
export function execFmInbox(
  fmInboxPath: string,
  args: ReadonlyArray<string>,
  options: ExecFmInboxOptions = {},
): Effect.Effect<FmInboxExecResult> {
  const firstmateHome = options.firstmateHome
  const timeoutMs = options.timeoutMs ?? DEFAULT_INBOX_TIMEOUT_MS
  const stdinText = options.stdinText ?? null
  const env = options.env ?? process.env

  const childEnv: NodeJS.ProcessEnv = { ...env }
  if (firstmateHome) {
    childEnv.FM_HOME = firstmateHome
  }

  if (stdinText !== null) {
    return Effect.callback<FmInboxExecResult>((resume) => {
      const child = spawn(fmInboxPath, [...args], {
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      })

      let stdout = ""
      let stderr = ""
      let settled = false

      const finish = (result: FmInboxExecResult): void => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resume(Effect.succeed(result))
        }
      }

      const timer = setTimeout(() => {
        child.kill("SIGTERM")
        finish({
          code: -1,
          stdout,
          stderr: `${stderr}\nTimed out after ${timeoutMs}ms`.trim(),
        })
      }, timeoutMs)
      timer.unref?.()

      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk
      })
      child.on("error", (error) => {
        finish({ code: -1, stdout, stderr: error.message })
      })
      child.on("close", (code) => {
        finish({ code: code ?? -1, stdout, stderr })
      })

      child.stdin.on("error", () => {})
      child.stdin.end(stdinText)

      return Effect.sync(() => {
        clearTimeout(timer)
        if (!settled) {
          settled = true
          child.kill("SIGTERM")
        }
      })
    })
  }

  return Effect.callback<FmInboxExecResult>((resume) => {
    let settled = false

    const child = execFile(
      fmInboxPath,
      [...args],
      {
        env: childEnv,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (settled) {
          return
        }
        settled = true
        if (!error) {
          resume(
            Effect.succeed({
              code: 0,
              stdout: String(stdout),
              stderr: String(stderr),
            }),
          )
          return
        }
        const exitCode = typeof error.code === "number" ? error.code : -1
        resume(
          Effect.succeed({
            code: exitCode,
            stdout: String(stdout ?? ""),
            stderr: String(stderr || error.message || ""),
          }),
        )
      },
    )
    child.stdin?.end()

    return Effect.sync(() => {
      if (!settled) {
        settled = true
        child.kill("SIGTERM")
      }
    })
  })
}

export class FirstmateInbox extends Context.Service<FirstmateInbox, FirstmateInboxShape>()(
  "clanker-whips/telegram-bridge/FirstmateInbox",
) {
  static readonly layer: Layer.Layer<FirstmateInbox, never, BridgeConfig> = Layer.effect(
    FirstmateInbox,
    Effect.gen(function*() {
      const config = yield* BridgeConfig
      const fmInboxPath = path.join(config.firstmateHome, "bin", "fm-inbox.sh")

      const submitNote = Effect.fn("FirstmateInbox.submitNote")(function*(
        requestId: string,
        text: string,
      ): Effect.fn.Return<SubmitNoteOutcome> {
        const args = ["note", "--request-id", requestId, "--json", "--", text]
        const stdinText = text === "-" ? "-" : null
        const result = yield* execFmInbox(fmInboxPath, args, {
          firstmateHome: config.firstmateHome,
          timeoutMs: config.inboxTimeoutMs,
          stdinText,
        })

        const parsed = decodeNoteResponseOption(result.stdout)

        if (result.code === 0) {
          return {
            status: "ok" as const,
            noteId: Option.isSome(parsed) ? (parsed.value.id ?? "unknown") : "unknown",
            outcome: Option.isSome(parsed) ? (parsed.value.outcome ?? "ok") : "ok",
          }
        }

        if (result.code === 3) {
          return {
            status: "announce_failed" as const,
            noteId: Option.isSome(parsed) ? (parsed.value.id ?? null) : null,
            exitCode: 3,
            stderr: result.stderr,
          }
        }

        return {
          status: "failed" as const,
          exitCode: result.code,
          stderr: result.stderr,
        }
      })

      const announceNote = Effect.fn("FirstmateInbox.announceNote")(function*(
        noteId: string,
      ): Effect.fn.Return<AnnounceOutcome> {
        const result = yield* execFmInbox(fmInboxPath, ["announce", "--json", noteId], {
          firstmateHome: config.firstmateHome,
          timeoutMs: config.inboxTimeoutMs,
        })
        return {
          ok: result.code === 0,
          exitCode: result.code,
          stderr: result.stderr,
        }
      })

      const fetchReceipts = Effect.gen(function*() {
        const result = yield* execFmInbox(fmInboxPath, ["receipts", "--all-replies"], {
          firstmateHome: config.firstmateHome,
          timeoutMs: config.inboxTimeoutMs,
        })

        if (result.code !== 0) {
          return yield* new InboxCommandError({
            command: "receipts --all-replies",
            exitCode: result.code,
            stderr: result.stderr.trim(),
            message: `fm-inbox.sh receipts failed (exit ${result.code}): ${
              result.stderr.trim() || "unknown error"
            }`,
          })
        }

        const parsed = yield* decodeReceiptsResponse(result.stdout).pipe(
          Effect.mapError(() =>
            new InboxCommandError({
              command: "receipts --all-replies",
              exitCode: 0,
              stderr: result.stderr.trim(),
              message: "fm-inbox.sh receipts returned invalid JSON",
            })
          ),
        )

        const validReplies: Array<FmInboxReply> = []
        for (const item of parsed.replies) {
          const decoded = decodeReplyOption(item)
          if (Option.isSome(decoded) && decoded.value.body.trim().length > 0) {
            validReplies.push(decoded.value)
          }
        }
        return validReplies
      })

      return FirstmateInbox.of({
        submitNote,
        announceNote,
        fetchReceipts,
      })
    }),
  )

  static layerTest(impl: FirstmateInboxShape): Layer.Layer<FirstmateInbox> {
    return Layer.succeed(FirstmateInbox, impl)
  }
}
