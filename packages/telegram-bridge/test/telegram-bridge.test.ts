import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import fs from "node:fs/promises"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { Cause, Duration, Effect, Exit, Fiber, Layer, Redacted, Schedule, Schema } from "effect"

import {
  BridgeConfig,
  BridgeLogger,
  ConfigError,
  FirstmateInbox,
  InboxCommandError,
  StateStore,
  StateStoreError,
  TelegramApiError,
  TelegramClient,
  chunkMessage,
  isAllowedMessageUpdate,
  loadState,
  makeBridgeRuntimeConfig,
  makeLiveBridgeLayer,
  makeLiveTelegramClient,
  makePollRetrySchedule,
  parseEnvFileContent,
  pollInboundOnce,
  pollOutboundOnce,
  redactSecrets,
  resolveConfig,
  runBridge,
  saveStateAtomic,
  sendOneShot,
  type FmInboxReply,
  type TelegramUpdate,
} from "../src/index.ts"

const execFileAsync = promisify(execFile)
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TEST_DIR, "..", "..", "..")
const SCRIPT_DIR = path.join(REPO_ROOT, "scripts")
const BRIDGE_TS_SCRIPT = path.join(SCRIPT_DIR, "telegram-bridge.ts")
const BRIDGE_MJS_SCRIPT = path.join(SCRIPT_DIR, "telegram-bridge.mjs")

const TEST_TOKEN = "999888777:TEST_SECRET_TOKEN_XYZ"
const ALLOWED_CHAT_ID = "555123456"

async function makeTempDir(t: TestContext, prefix = "tg-bridge-test-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  return dir
}

async function createStubFirstmateHome(
  t: TestContext,
  options: { readonly scriptBody: string },
): Promise<{ readonly homeDir: string; readonly inboxPath: string }> {
  const homeDir = await makeTempDir(t, "tg-bridge-fm-")
  const binDir = path.join(homeDir, "bin")
  await fs.mkdir(binDir, { recursive: true })
  const inboxPath = path.join(binDir, "fm-inbox.sh")
  await fs.writeFile(inboxPath, options.scriptBody, { mode: 0o755 })
  await fs.chmod(inboxPath, 0o755)
  return { homeDir, inboxPath }
}

interface MockRequest {
  readonly method: string | undefined
  readonly url: string | undefined
  readonly body: unknown
}

interface MockReply {
  readonly status?: number
  readonly json?: unknown
}

async function startMockTelegramServer(
  t: TestContext,
  handler: (req: MockRequest) => Promise<MockReply> | MockReply,
): Promise<{
  readonly baseUrl: string
  readonly requests: Array<MockRequest>
  readonly server: http.Server
}> {
  const requests: Array<MockRequest> = []
  const server = http.createServer(async (req, res) => {
    const chunks: Array<Buffer> = []
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
    }
    const rawBody = Buffer.concat(chunks).toString("utf8")
    let body: unknown = null
    try {
      body = rawBody ? JSON.parse(rawBody) : null
    } catch {
      body = rawBody
    }
    const entry: MockRequest = { method: req.method, url: req.url, body }
    requests.push(entry)

    const reply = await handler(entry)
    const status = reply.status ?? 200
    const json = reply.json ?? { ok: true, result: [] }
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(json))
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`

  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  return { baseUrl, requests, server }
}

function runNodeScript(
  scriptPath: string,
  args: ReadonlyArray<string>,
  options: { readonly env?: Record<string, string>; readonly stdinText?: string | null } = {},
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (d: string) => {
      stdout += d
    })
    child.stderr.on("data", (d: string) => {
      stderr += d
    })
    child.on("close", (code) => {
      resolve({ code, stdout, stderr })
    })
    if (options.stdinText !== undefined && options.stdinText !== null) {
      child.stdin.end(options.stdinText)
    } else {
      child.stdin.end()
    }
  })
}

function runEffectFailure<A, E>(effect: Effect.Effect<A, E>): Promise<E> {
  return Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) {
      assert.fail(`Expected effect to fail, but succeeded with: ${String(exit.value)}`)
    }
    const err = Cause.squash(exit.cause)
    return err as E
  })
}

// ---------------------------------------------------------------------------
// Unit tests: .gitignore, config, schemas, chunking, allowlist, Effect Layers
// ---------------------------------------------------------------------------

test(".gitignore ignores .env, .env.local, and state files while keeping .env.example", async () => {
  const ignoredPaths = [
    ".env",
    ".env.local",
    ".env.production",
    ".telegram-bridge-state.json",
    "custom.state.json",
  ]

  for (const relPath of ignoredPaths) {
    const { stdout } = await execFileAsync("git", ["-C", REPO_ROOT, "check-ignore", relPath])
    assert.equal(stdout.trim(), relPath, `${relPath} must be gitignored`)
  }

  await assert.rejects(
    () => execFileAsync("git", ["-C", REPO_ROOT, "check-ignore", ".env.example"]),
    (err: { code?: number }) => err.code === 1,
    ".env.example must NOT be gitignored",
  )
})

test("parseEnvFileContent and resolveConfig parse .env safely, redact token, and prefer process.env", async (t) => {
  const tmpDir = await makeTempDir(t)
  const envFile = path.join(tmpDir, ".env")
  await fs.writeFile(
    envFile,
    [
      "# comment line",
      `CLANKER_UPDATES_TOKEN="${TEST_TOKEN}" # trailing comment`,
      `export CLANKER_UPDATES_CHAT_ID='${ALLOWED_CHAT_ID}'`,
      "FIRSTMATE_HOME=/tmp/from-dotenv",
      "",
    ].join("\n"),
    "utf8",
  )

  const parsed = parseEnvFileContent(await fs.readFile(envFile, "utf8"))
  assert.equal(parsed.CLANKER_UPDATES_TOKEN, TEST_TOKEN)
  assert.equal(parsed.CLANKER_UPDATES_CHAT_ID, ALLOWED_CHAT_ID)
  assert.equal(parsed.FIRSTMATE_HOME, "/tmp/from-dotenv")

  const cfgFromFile = await Effect.runPromise(
    resolveConfig({
      argv: ["--env-file", envFile],
      env: {},
      homedir: "/tmp/home",
    }),
  )
  assert.equal(cfgFromFile.help, false)
  if (cfgFromFile.help) {
    assert.fail("Expected resolved config")
  }
  assert.equal(Redacted.value(cfgFromFile.token), TEST_TOKEN)
  assert.equal(String(cfgFromFile.token).includes(TEST_TOKEN), false)
  assert.equal(cfgFromFile.chatId, ALLOWED_CHAT_ID)
  assert.equal(cfgFromFile.firstmateHome, "/tmp/from-dotenv")

  const cfgOverride = await Effect.runPromise(
    resolveConfig({
      argv: ["--env-file", envFile, "--firstmate-home", "/tmp/from-flag"],
      env: { CLANKER_UPDATES_CHAT_ID: "777000111" },
      homedir: "/tmp/home",
    }),
  )
  assert.equal(cfgOverride.help, false)
  if (cfgOverride.help) {
    assert.fail("Expected resolved config")
  }
  assert.equal(cfgOverride.chatId, "777000111")
  assert.equal(cfgOverride.firstmateHome, "/tmp/from-flag")
})

test("resolveConfig fails with ConfigError for missing/invalid token, non-numeric chat ID, or bad options", async (t) => {
  const tmpDir = await makeTempDir(t)
  const missingEnvFile = path.join(tmpDir, "does-not-exist.env")

  const missingTokenErr = await runEffectFailure(
    resolveConfig({ argv: ["--env-file", missingEnvFile], env: {} }),
  )
  assert.ok(missingTokenErr instanceof ConfigError)
  assert.match(missingTokenErr.message, /CLANKER_UPDATES_TOKEN/)

  const nonNumericChatErr = await runEffectFailure(
    resolveConfig({
      argv: ["--env-file", missingEnvFile],
      env: { CLANKER_UPDATES_TOKEN: TEST_TOKEN, CLANKER_UPDATES_CHAT_ID: "not-a-number" },
    }),
  )
  assert.ok(nonNumericChatErr instanceof ConfigError)
  assert.match(nonNumericChatErr.message, /CLANKER_UPDATES_CHAT_ID/)

  const negativeChatErr = await runEffectFailure(
    resolveConfig({
      argv: ["--env-file", missingEnvFile],
      env: { CLANKER_UPDATES_TOKEN: TEST_TOKEN, CLANKER_UPDATES_CHAT_ID: "-100123456" },
    }),
  )
  assert.ok(negativeChatErr instanceof ConfigError)
  assert.match(negativeChatErr.message, /CLANKER_UPDATES_CHAT_ID/)

  const badOptionErr = await runEffectFailure(
    resolveConfig({ argv: ["--unknown-flag"], env: {} }),
  )
  assert.ok(badOptionErr instanceof ConfigError)
  assert.match(badOptionErr.message, /Unknown option/)

  const missingValueErr = await runEffectFailure(
    resolveConfig({ argv: ["--send"], env: {} }),
  )
  assert.ok(missingValueErr instanceof ConfigError)
  assert.match(missingValueErr.message, /Missing value for option: --send/)
})

test("strict chat_id allowlist drops foreign private chats, groups, supergroups, and channels", () => {
  assert.equal(
    isAllowedMessageUpdate(
      { update_id: 1, message: { chat: { id: Number(ALLOWED_CHAT_ID), type: "private" }, text: "ok" } },
      ALLOWED_CHAT_ID,
    ),
    true,
  )
  assert.equal(
    isAllowedMessageUpdate(
      { update_id: 2, message: { chat: { id: 111222333, type: "private" }, text: "stranger" } },
      ALLOWED_CHAT_ID,
    ),
    false,
  )
  assert.equal(
    isAllowedMessageUpdate(
      { update_id: 3, message: { chat: { id: Number(ALLOWED_CHAT_ID), type: "group" }, text: "group" } },
      ALLOWED_CHAT_ID,
    ),
    false,
  )
  assert.equal(
    isAllowedMessageUpdate(
      { update_id: 4, message: { chat: { id: -100999, type: "supergroup" }, text: "supergroup" } },
      ALLOWED_CHAT_ID,
    ),
    false,
  )
  assert.equal(
    isAllowedMessageUpdate(
      { update_id: 5, channel_post: { chat: { id: Number(ALLOWED_CHAT_ID), type: "channel" }, text: "ch" } },
      ALLOWED_CHAT_ID,
    ),
    false,
  )
})

test("chunkMessage splits at newlines, spaces, and hard boundaries without dropping content or emitting blank chunks", () => {
  const nlChunks = chunkMessage("first line\nsecond line\nthird line", 20)
  assert.deepEqual(nlChunks, ["first line", "second line", "third line"])

  const spChunks = chunkMessage("alpha beta gamma delta", 12)
  assert.deepEqual(spChunks, ["alpha beta", "gamma delta"])

  const hardChunks = chunkMessage("x".repeat(25), 10)
  assert.deepEqual(hardChunks, ["x".repeat(10), "x".repeat(10), "x".repeat(5)])

  assert.deepEqual(chunkMessage("   \n\t  ", 10), [])
  assert.deepEqual(chunkMessage(" ".repeat(25), 10), [])

  const paddedChunks = chunkMessage(`${" ".repeat(25)}hello`, 10)
  assert.deepEqual(paddedChunks, ["     hello"])
  assert.ok(paddedChunks.every((chunk) => chunk.trim().length > 0 && chunk.length <= 10))

  const newlinePaddedChunks = chunkMessage(`${"\n".repeat(15)}tail`, 10)
  assert.deepEqual(newlinePaddedChunks, ["\n\n\n\n\ntail"])
})

test("StateStore loadState validates schema, deduplicates reply IDs, and fails with StateStoreError on corrupt files", async (t) => {
  const tmpDir = await makeTempDir(t)
  const stateFile = path.join(tmpDir, "state.json")

  const initial = await Effect.runPromise(loadState(stateFile))
  assert.deepEqual(initial, { version: 1, offset: 0, deliveredReplyIds: [] })

  await fs.writeFile(
    stateFile,
    JSON.stringify({ version: 1, offset: 42, deliveredReplyIds: ["r1", "r2", "r1"] }),
    "utf8",
  )
  const loaded = await Effect.runPromise(loadState(stateFile))
  assert.deepEqual(loaded, { version: 1, offset: 42, deliveredReplyIds: ["r1", "r2"] })

  await fs.writeFile(stateFile, JSON.stringify({ offset: -5 }), "utf8")
  const badOffsetErr = await runEffectFailure(loadState(stateFile))
  assert.ok(badOffsetErr instanceof StateStoreError)
  assert.equal(badOffsetErr.operation, "load")

  await fs.writeFile(stateFile, "not valid json", "utf8")
  const badJsonErr = await runEffectFailure(loadState(stateFile))
  assert.ok(badJsonErr instanceof StateStoreError)

  const outFile = path.join(tmpDir, "atomic.json")
  await Effect.runPromise(
    saveStateAtomic(outFile, { version: 1, offset: 7, deliveredReplyIds: ["n1"] }),
  )
  const stat = await fs.stat(outFile)
  assert.equal(stat.mode & 0o777, 0o600)
})

test("StateStore updates in-memory state before persisting so transient save failures do not duplicate outbound deliveries or inbound offsets", async (t) => {
  const sentMessages: Array<{ readonly chatId: string; readonly text: string }> = []
  let saveAttempts = 0
  let savedStates: Array<{ readonly offset: number; readonly deliveredReplyIds: ReadonlyArray<string> }> = []
  let replies: ReadonlyArray<FmInboxReply> = [{ id: "reply-1", body: "Only once" }]

  const config = makeBridgeRuntimeConfig({
    token: TEST_TOKEN,
    chatId: ALLOWED_CHAT_ID,
    firstmateHome: "/unused",
    stateFilePath: "/unused/state.json",
  })

  const memoryLayer = Layer.mergeAll(
    BridgeConfig.layer(config),
    BridgeLogger.layerCustom({ token: config.token, stdout: () => {}, stderr: () => {} }),
    StateStore.layerMemory({
      onSave: (state) => {
        saveAttempts += 1
        if (saveAttempts === 1) {
          return Effect.fail(
            new StateStoreError({
              operation: "save",
              path: "/unused/state.json",
              message: "transient ENOSPC",
            }),
          )
        }
        savedStates.push({ offset: state.offset, deliveredReplyIds: [...state.deliveredReplyIds] })
        return Effect.void
      },
    }),
    TelegramClient.layerTest({
      call: () => Effect.succeed({}),
      getUpdates: () => Effect.succeed([]),
      sendMessage: () => Effect.succeed({ message_id: 1 }),
      sendChunkedMessage: (chatId, text) =>
        Effect.sync(() => {
          sentMessages.push({ chatId, text })
          return 1
        }),
    }),
    FirstmateInbox.layerTest({
      submitNote: () => Effect.succeed({ status: "ok" as const, noteId: "n1", outcome: "created" }),
      announceNote: () => Effect.succeed({ ok: true, exitCode: 0, stderr: "" }),
      fetchReceipts: Effect.sync(() => replies),
    }),
  )

  const memResult = await Effect.runPromise(
    Effect.gen(function*() {
      const store = yield* StateStore
      const firstExit = yield* Effect.exit(pollOutboundOnce())
      const deliveredAfterFail = yield* store.hasDeliveredReply("reply-1")
      const retryDelivered = yield* pollOutboundOnce()
      replies = [
        { id: "reply-1", body: "Only once" },
        { id: "reply-2", body: "Second reply" },
      ]
      const recoveredDelivered = yield* pollOutboundOnce()
      const finalState = yield* store.get
      return { firstExit, deliveredAfterFail, retryDelivered, recoveredDelivered, finalState }
    }).pipe(Effect.provide(memoryLayer)),
  )

  assert.ok(Exit.isFailure(memResult.firstExit))
  assert.ok(Cause.squash(memResult.firstExit.cause) instanceof StateStoreError)
  assert.equal(memResult.deliveredAfterFail, true)
  assert.equal(memResult.retryDelivered, 0)
  assert.equal(memResult.recoveredDelivered, 1)
  assert.deepEqual(sentMessages, [
    { chatId: ALLOWED_CHAT_ID, text: "Only once" },
    { chatId: ALLOWED_CHAT_ID, text: "Second reply" },
  ])
  assert.deepEqual(memResult.finalState.deliveredReplyIds, ["reply-1", "reply-2"])
  assert.deepEqual(savedStates.at(-1)?.deliveredReplyIds, ["reply-1", "reply-2"])

  const tmpDir = await makeTempDir(t)
  const stateFile = path.join(tmpDir, "state.json")
  const fileLayer = StateStore.layerFile(stateFile)

  await Effect.runPromise(
    Effect.gen(function*() {
      const store = yield* StateStore
      yield* Effect.promise(() => fs.mkdir(stateFile, { recursive: true }))

      const replyFailExit = yield* Effect.exit(store.markReplyDelivered("file-reply-1"))
      assert.ok(Exit.isFailure(replyFailExit))
      assert.ok(Cause.squash(replyFailExit.cause) instanceof StateStoreError)
      assert.equal(yield* store.hasDeliveredReply("file-reply-1"), true)

      const offsetFailExit = yield* Effect.exit(store.advanceOffset(42))
      assert.ok(Exit.isFailure(offsetFailExit))
      assert.ok(Cause.squash(offsetFailExit.cause) instanceof StateStoreError)
      assert.equal((yield* store.get).offset, 42)

      yield* Effect.promise(() => fs.rmdir(stateFile))
      assert.equal(yield* store.markReplyDelivered("file-reply-2"), true)
    }).pipe(Effect.provide(fileLayer)),
  )

  const persisted = await Effect.runPromise(loadState(stateFile))
  assert.deepEqual(persisted, {
    version: 1,
    offset: 42,
    deliveredReplyIds: ["file-reply-1", "file-reply-2"],
  })
})

test("Effect Layer unit test: pollInboundOnce & pollOutboundOnce with in-memory service layers", async () => {
  const submittedNotes: Array<{ readonly requestId: string; readonly text: string }> = []
  const announcedNotes: Array<string> = []
  const sentMessages: Array<{ readonly chatId: string; readonly text: string }> = []
  const infoLogs: Array<string> = []
  const errorLogs: Array<string> = []

  const updates: ReadonlyArray<TelegramUpdate> = [
    { update_id: 10, message: { chat: { id: 999999, type: "private" }, text: "foreign" } },
    { update_id: 11, message: { chat: { id: Number(ALLOWED_CHAT_ID), type: "private" }, text: "   " } },
    { update_id: 12, message: { chat: { id: Number(ALLOWED_CHAT_ID), type: "private" }, text: "hello" } },
    { update_id: 13, message: { chat: { id: Number(ALLOWED_CHAT_ID), type: "private" }, text: "needs-retry" } },
    { update_id: 14, message: { chat: { id: Number(ALLOWED_CHAT_ID), type: "private" }, text: "always-fails" } },
  ]

  const replies: ReadonlyArray<FmInboxReply> = [
    { id: "reply-1", body: "First reply" },
    { id: "reply-2", body: "alpha beta gamma delta" },
  ]

  const config = makeBridgeRuntimeConfig({
    token: TEST_TOKEN,
    chatId: ALLOWED_CHAT_ID,
    firstmateHome: "/unused",
    stateFilePath: "/unused/state.json",
    maxChunkLength: 12,
    announceRetries: 2,
    announceRetryDelayMs: 1,
  })

  const testLayer = Layer.mergeAll(
    BridgeConfig.layer(config),
    BridgeLogger.layerCustom({
      token: config.token,
      stdout: (line) => infoLogs.push(line),
      stderr: (line) => errorLogs.push(line),
    }),
    StateStore.layerMemory(),
    TelegramClient.layerTest({
      call: () => Effect.succeed({}),
      getUpdates: () => Effect.succeed(updates),
      sendMessage: (chatId, text) =>
        Effect.sync(() => {
          sentMessages.push({ chatId, text })
          return { message_id: sentMessages.length }
        }),
      sendChunkedMessage: (chatId, text, opts) =>
        Effect.sync(() => {
          const chunks = chunkMessage(text, opts?.maxLength ?? 4000)
          for (const chunk of chunks) {
            sentMessages.push({ chatId, text: chunk })
          }
          return chunks.length
        }),
    }),
    FirstmateInbox.layerTest({
      submitNote: (requestId, text) =>
        Effect.sync(() => {
          submittedNotes.push({ requestId, text })
          if (text === "hello") {
            return { status: "ok" as const, noteId: "n-12", outcome: "created" }
          }
          if (text === "needs-retry") {
            return {
              status: "announce_failed" as const,
              noteId: "n-13",
              exitCode: 3,
              stderr: "busy",
            }
          }
          return {
            status: "announce_failed" as const,
            noteId: "n-14",
            exitCode: 3,
            stderr: "still busy",
          }
        }),
      announceNote: (noteId) =>
        Effect.sync(() => {
          announcedNotes.push(noteId)
          if (noteId === "n-13") {
            return { ok: true, exitCode: 0, stderr: "" }
          }
          return { ok: false, exitCode: 3, stderr: "still busy" }
        }),
      fetchReceipts: Effect.succeed(replies),
    }),
  )

  const result = await Effect.runPromise(
    Effect.gen(function*() {
      const inboundCount = yield* pollInboundOnce()
      const outboundFirst = yield* pollOutboundOnce()
      const outboundSecond = yield* pollOutboundOnce()
      const store = yield* StateStore
      const finalState = yield* store.get
      return { inboundCount, outboundFirst, outboundSecond, finalState }
    }).pipe(Effect.provide(testLayer)),
  )

  assert.equal(result.inboundCount, 5)
  assert.deepEqual(submittedNotes, [
    { requestId: "tg-12", text: "hello" },
    { requestId: "tg-13", text: "needs-retry" },
    { requestId: "tg-14", text: "always-fails" },
  ])
  assert.deepEqual(announcedNotes, ["n-13", "n-14", "n-14"])
  assert.equal(result.outboundFirst, 2)
  assert.equal(result.outboundSecond, 0)
  assert.deepEqual(result.finalState, {
    version: 1,
    offset: 15,
    deliveredReplyIds: ["reply-1", "reply-2"],
  })
  // Exhausted announce notification (chunked to <=12 chars) + 1 chunk for reply-1 + 2 chunks for reply-2
  assert.ok(sentMessages.every((m) => m.chatId === ALLOWED_CHAT_ID && m.text.length <= 12))
  const replyChunks = sentMessages.slice(-3).map((m) => m.text)
  assert.deepEqual(replyChunks, ["First reply", "alpha beta", "gamma delta"])
  const notifyRejoined = sentMessages
    .slice(0, -3)
    .map((m) => m.text)
    .join(" ")
  assert.match(notifyRejoined, /Note saved \(n-14\), but waking firstmate failed/)
  assert.ok(infoLogs.some((l) => l.includes("announce repaired")))
  assert.ok(errorLogs.some((l) => l.includes("announce retry 2/2 for n-14")))
})

test("Effect Layer unit test: sendOneShot rejects empty text and makePollRetrySchedule honors retry_after", async () => {
  const config = makeBridgeRuntimeConfig({
    token: TEST_TOKEN,
    chatId: ALLOWED_CHAT_ID,
    firstmateHome: "/unused",
    stateFilePath: "/unused/state.json",
  })

  const emptyErr = await runEffectFailure(
    sendOneShot("   \n\t  ").pipe(
      Effect.provide(
        Layer.mergeAll(
          BridgeConfig.layer(config),
          TelegramClient.layerTest({
            call: () => Effect.succeed({}),
            getUpdates: () => Effect.succeed([]),
            sendMessage: () => Effect.succeed({ message_id: 1 }),
            sendChunkedMessage: () => Effect.succeed(0),
          }),
        ),
      ),
    ),
  )
  assert.ok(emptyErr instanceof ConfigError)
  assert.match(emptyErr.message, /empty message/)

  // Verify Schedule.modifyDelay honors Telegram retryAfterSeconds and caps exponential backoff
  const logged: Array<string> = []
  const schedule = makePollRetrySchedule({
    label: "inbound poll",
    initialMs: 100,
    maxMs: 250,
    logger: {
      info: () => Effect.void,
      error: (m) => Effect.sync(() => logged.push(m)),
    },
  })

  const delays = await Effect.runPromise(
    Effect.gen(function*() {
      const step = yield* Schedule.toStep(schedule)
      const [, d1] = yield* step(
        0,
        new TelegramApiError({
          method: "getUpdates",
          message: "HTTP 502",
          statusCode: 502,
          retryAfterSeconds: null,
        }),
      )
      const [, d2] = yield* step(
        100,
        new TelegramApiError({
          method: "getUpdates",
          message: "HTTP 429",
          statusCode: 429,
          retryAfterSeconds: 2,
        }),
      )
      const [, d3] = yield* step(
        2100,
        new InboxCommandError({
          command: "receipts",
          exitCode: 1,
          stderr: "boom",
          message: "boom",
        }),
      )
      return [Duration.toMillis(d1), Duration.toMillis(d2), Duration.toMillis(d3)]
    }),
  )

  assert.equal(delays[0], 100)
  assert.equal(delays[1], 2000)
  assert.equal(delays[2], 250)
  assert.equal(logged.length, 3)
  assert.ok(logged[1]!.includes("retrying in 2000ms"))
})

// ---------------------------------------------------------------------------
// End-to-end integration tests: mock Telegram HTTP server, stub fm-inbox.sh,
// atomic 0600 state persistence, CLI (.ts and .mjs), token redaction, signals
// ---------------------------------------------------------------------------

test("inbound getUpdates submits allowed text via fm-inbox.sh, ignores foreign/group chats, and persists offset with 0600 mode", async (t) => {
  const tmpDir = await makeTempDir(t)
  const stateFile = path.join(tmpDir, ".telegram-bridge-state.json")
  const logFile = path.join(tmpDir, "inbox-invocations.jsonl")

  const { homeDir } = await createStubFirstmateHome(t, {
    scriptBody: `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + '\\n');
if (args[0] === 'note') {
  const reqIdx = args.indexOf('--request-id');
  const reqId = reqIdx !== -1 ? args[reqIdx + 1] : null;
  process.stdout.write(JSON.stringify({
    schema: 'fm-inbox-note.v1',
    outcome: 'created',
    id: 'note-100',
    request_id: reqId,
    saved: true,
    announced: true,
    acknowledged: false,
  }) + '\\n');
  process.exit(0);
}
process.exit(1);
`,
  })

  const updates = [
    { update_id: 100, message: { chat: { id: 999000, type: "private" }, text: "foreign user" } },
    { update_id: 101, message: { chat: { id: Number(ALLOWED_CHAT_ID), type: "group" }, text: "group msg" } },
    {
      update_id: 102,
      message: {
        chat: { id: Number(ALLOWED_CHAT_ID), type: "private" },
        text: "check status; $(rm -rf /)",
      },
    },
  ]

  let pollCount = 0
  const { baseUrl, requests } = await startMockTelegramServer(t, async (req) => {
    if (req.url === `/bot${TEST_TOKEN}/getUpdates`) {
      pollCount += 1
      return { json: { ok: true, result: pollCount === 1 ? updates : [] } }
    }
    return { status: 404, json: { ok: false, description: "unexpected call" } }
  })

  const config = makeBridgeRuntimeConfig({
    token: TEST_TOKEN,
    chatId: ALLOWED_CHAT_ID,
    firstmateHome: homeDir,
    stateFilePath: stateFile,
    apiBase: baseUrl,
    pollTimeoutSeconds: 0,
    replyPollMs: 100,
  })
  const layer = makeLiveBridgeLayer(config, { stdout: () => {}, stderr: () => {} })

  const count = await Effect.runPromise(
    Effect.gen(function*() {
      const firstCount = yield* pollInboundOnce()
      // Second poll must pass persisted offset=103
      yield* pollInboundOnce()
      return firstCount
    }).pipe(Effect.provide(layer)),
  )

  assert.equal(count, 3)

  const calls = (await fs.readFile(logFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Array<string>)

  assert.equal(calls.length, 1, "only the allowed private message should be submitted")
  assert.deepEqual(calls[0], [
    "note",
    "--request-id",
    "tg-102",
    "--json",
    "--",
    "check status; $(rm -rf /)",
  ])

  const savedState = await Effect.runPromise(loadState(stateFile))
  assert.equal(savedState.offset, 103)

  const stat = await fs.stat(stateFile)
  assert.equal(stat.mode & 0o777, 0o600, "state file must have mode 0600")

  assert.equal(requests.length, 2)
  assert.equal((requests[1]!.body as { offset?: number }).offset, 103)
})

test("inbound handles fm-inbox.sh exit 3 by retrying announce and handles non-zero exit without crashing", async (t) => {
  const tmpDir = await makeTempDir(t)
  const stateFile = path.join(tmpDir, ".telegram-bridge-state.json")
  const logFile = path.join(tmpDir, "calls.jsonl")

  const { homeDir } = await createStubFirstmateHome(t, {
    scriptBody: `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + '\\n');
if (args[0] === 'note' && args.includes('tg-200')) {
  process.stdout.write(JSON.stringify({
    schema: 'fm-inbox-note.v1',
    outcome: 'created',
    id: 'note-200',
    request_id: 'tg-200',
    saved: true,
    announced: false,
    acknowledged: false,
  }) + '\\n');
  process.stderr.write('wake lock busy\\n');
  process.exit(3);
}
if (args[0] === 'announce' && args[2] === 'note-200') {
  process.stdout.write(JSON.stringify({
    schema: 'fm-inbox-note.v1',
    outcome: 'created',
    id: 'note-200',
    saved: true,
    announced: true,
  }) + '\\n');
  process.exit(0);
}
if (args[0] === 'note' && args.includes('tg-201')) {
  process.stderr.write('disk write error\\n');
  process.exit(1);
}
process.exit(1);
`,
  })

  const sentMessages: Array<{ readonly chat_id: string; readonly text: string }> = []
  const { baseUrl } = await startMockTelegramServer(t, async (req) => {
    if (req.url === `/bot${TEST_TOKEN}/getUpdates`) {
      return {
        json: {
          ok: true,
          result: [
            { update_id: 200, message: { chat: { id: Number(ALLOWED_CHAT_ID), type: "private" }, text: "retry wake" } },
            { update_id: 201, message: { chat: { id: Number(ALLOWED_CHAT_ID), type: "private" }, text: "will fail" } },
          ],
        },
      }
    }
    if (req.url === `/bot${TEST_TOKEN}/sendMessage`) {
      sentMessages.push(req.body as { readonly chat_id: string; readonly text: string })
      return { json: { ok: true, result: { message_id: sentMessages.length } } }
    }
    return { status: 404, json: { ok: false, description: "not found" } }
  })

  const stderrLines: Array<string> = []
  const config = makeBridgeRuntimeConfig({
    token: TEST_TOKEN,
    chatId: ALLOWED_CHAT_ID,
    firstmateHome: homeDir,
    stateFilePath: stateFile,
    apiBase: baseUrl,
    pollTimeoutSeconds: 0,
    replyPollMs: 100,
    announceRetries: 2,
    announceRetryDelayMs: 5,
  })
  const layer = makeLiveBridgeLayer(config, {
    stdout: () => {},
    stderr: (line) => stderrLines.push(line),
  })

  await Effect.runPromise(pollInboundOnce().pipe(Effect.provide(layer)))

  const calls = (await fs.readFile(logFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Array<string>)

  assert.deepEqual(calls, [
    ["note", "--request-id", "tg-200", "--json", "--", "retry wake"],
    ["announce", "--json", "note-200"],
    ["note", "--request-id", "tg-201", "--json", "--", "will fail"],
  ])

  assert.equal(sentMessages.length, 1, "should notify chat once for the exit-1 failure")
  assert.equal(sentMessages[0]!.chat_id, ALLOWED_CHAT_ID)
  assert.match(sentMessages[0]!.text, /Failed to deliver note to firstmate \(exit 1\)/)
  assert.ok(stderrLines.some((line) => line.includes("exit 1")))

  const savedState = await Effect.runPromise(loadState(stateFile))
  assert.equal(savedState.offset, 202)
})

test("outbound reply polling delivers each new reply once and chunks long text cleanly", async (t) => {
  const tmpDir = await makeTempDir(t)
  const stateFile = path.join(tmpDir, ".telegram-bridge-state.json")

  const paragraphA = "Alpha line ".repeat(220).trim()
  const paragraphB = "Beta line ".repeat(220).trim()
  const longBody = `${paragraphA}\n${paragraphB}`
  assert.ok(longBody.length > 4000)

  const receiptsPayload = {
    schema: "fm-inbox-receipts.v1",
    home: "test/firstmate",
    generated: "2026-11-27T13:30:00Z",
    pending: [],
    handled: [],
    replies: [
      { id: "note-1", at: "2026-11-27T13:30:01Z", body: "Short reply", cursor: "000000000001" },
      { id: "note-2", at: "2026-11-27T13:30:02Z", body: longBody, cursor: "000000000002" },
    ],
    reply_cursor: "000000000002",
    omitted: [],
  }

  const { homeDir } = await createStubFirstmateHome(t, {
    scriptBody: `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'receipts' && args.includes('--all-replies')) {
  process.stdout.write(${JSON.stringify(JSON.stringify(receiptsPayload))} + '\\n');
  process.exit(0);
}
process.exit(1);
`,
  })

  const sentMessages: Array<{ readonly chat_id: string; readonly text: string }> = []
  const { baseUrl } = await startMockTelegramServer(t, async (req) => {
    if (req.url === `/bot${TEST_TOKEN}/sendMessage`) {
      sentMessages.push(req.body as { readonly chat_id: string; readonly text: string })
      return { json: { ok: true, result: { message_id: sentMessages.length } } }
    }
    return { status: 404, json: { ok: false, description: "not found" } }
  })

  const config = makeBridgeRuntimeConfig({
    token: TEST_TOKEN,
    chatId: ALLOWED_CHAT_ID,
    firstmateHome: homeDir,
    stateFilePath: stateFile,
    apiBase: baseUrl,
    pollTimeoutSeconds: 0,
    replyPollMs: 100,
  })
  const layer = makeLiveBridgeLayer(config, { stdout: () => {}, stderr: () => {} })

  const { deliveredFirst, deliveredSecond } = await Effect.runPromise(
    Effect.gen(function*() {
      const first = yield* pollOutboundOnce()
      const second = yield* pollOutboundOnce()
      return { deliveredFirst: first, deliveredSecond: second }
    }).pipe(Effect.provide(layer)),
  )

  assert.equal(deliveredFirst, 2)
  assert.equal(deliveredSecond, 0)
  assert.equal(sentMessages.length, 3, "short reply (1 chunk) + long reply (2 chunks)")
  assert.equal(sentMessages[0]!.chat_id, ALLOWED_CHAT_ID)
  assert.equal(sentMessages[0]!.text, "Short reply")
  assert.equal(sentMessages[1]!.text, paragraphA)
  assert.equal(sentMessages[2]!.text, paragraphB)
  assert.ok(sentMessages.every((m) => m.text.length <= 4000))

  // A restarted bridge loading the same state file must also not re-deliver
  const restartedLayer = makeLiveBridgeLayer(config, { stdout: () => {}, stderr: () => {} })
  const deliveredAfterRestart = await Effect.runPromise(
    pollOutboundOnce().pipe(Effect.provide(restartedLayer)),
  )
  assert.equal(deliveredAfterRestart, 0)
  assert.equal(sentMessages.length, 3)
})

test("--send one-shot CLI mode works via both telegram-bridge.ts and telegram-bridge.mjs shim", async (t) => {
  const tmpDir = await makeTempDir(t)
  const envFile = path.join(tmpDir, ".env")
  await fs.writeFile(
    envFile,
    `CLANKER_UPDATES_TOKEN=${TEST_TOKEN}\nCLANKER_UPDATES_CHAT_ID=${ALLOWED_CHAT_ID}\n`,
    "utf8",
  )

  const sentMessages: Array<{ readonly chat_id: string; readonly text: string }> = []
  const { baseUrl } = await startMockTelegramServer(t, async (req) => {
    if (req.url === `/bot${TEST_TOKEN}/sendMessage`) {
      sentMessages.push(req.body as { readonly chat_id: string; readonly text: string })
      return { json: { ok: true, result: { message_id: sentMessages.length } } }
    }
    return { status: 404, json: { ok: false, description: "not found" } }
  })

  const tsDirectRes = await runNodeScript(BRIDGE_TS_SCRIPT, [
    "--env-file",
    envFile,
    "--api-base",
    baseUrl,
    "--send",
    "Alarm from TS",
  ])
  assert.equal(tsDirectRes.code, 0, tsDirectRes.stderr)

  const mjsDirectRes = await runNodeScript(BRIDGE_MJS_SCRIPT, [
    "--env-file",
    envFile,
    "--api-base",
    baseUrl,
    "--send",
    "Alarm from MJS shim",
  ])
  assert.equal(mjsDirectRes.code, 0, mjsDirectRes.stderr)

  const stdinRes = await runNodeScript(
    BRIDGE_MJS_SCRIPT,
    ["--env-file", envFile, "--api-base", baseUrl, "--send", "-"],
    { stdinText: "Line one from stdin\nLine two from stdin" },
  )
  assert.equal(stdinRes.code, 0, stdinRes.stderr)

  assert.deepEqual(sentMessages, [
    { chat_id: ALLOWED_CHAT_ID, text: "Alarm from TS" },
    { chat_id: ALLOWED_CHAT_ID, text: "Alarm from MJS shim" },
    { chat_id: ALLOWED_CHAT_ID, text: "Line one from stdin\nLine two from stdin" },
  ])
})

test("bot token is always redacted from error messages and CLI stderr logs", async (t) => {
  const raw = `request to https://api.telegram.org/bot${TEST_TOKEN}/getUpdates failed with ${TEST_TOKEN}`
  const redacted = redactSecrets(raw, TEST_TOKEN)
  assert.equal(redacted.includes(TEST_TOKEN), false)
  assert.ok(redacted.includes("/bot[REDACTED]/getUpdates"))
  assert.equal(redactSecrets("robot bottom", TEST_TOKEN), "robot bottom")

  const failingClient = makeLiveTelegramClient({
    token: Redacted.make(TEST_TOKEN),
    apiBase: "https://api.telegram.org",
    fetchImpl: async (url) => {
      throw new Error(`connect ECONNREFUSED ${String(url)}`)
    },
  })

  const clientErr = await runEffectFailure(
    failingClient.sendMessage(ALLOWED_CHAT_ID, "hello"),
  )
  assert.ok(clientErr instanceof TelegramApiError)
  assert.equal(clientErr.message.includes(TEST_TOKEN), false)
  assert.ok(clientErr.message.includes("/bot[REDACTED]/sendMessage"))

  // End-to-end CLI stderr redaction on HTTP 500 that echoes the token back
  const { baseUrl } = await startMockTelegramServer(t, async (req) => ({
    status: 500,
    json: { ok: false, description: `upstream failure for ${req.url} token=${TEST_TOKEN}` },
  }))

  const cliRes = await runNodeScript(
    BRIDGE_TS_SCRIPT,
    ["--api-base", baseUrl, "--send", "test alert"],
    {
      env: {
        CLANKER_UPDATES_TOKEN: TEST_TOKEN,
        CLANKER_UPDATES_CHAT_ID: ALLOWED_CHAT_ID,
      },
    },
  )
  assert.notEqual(cliRes.code, 0)
  assert.equal(cliRes.stderr.includes(TEST_TOKEN), false, "token must never appear in stderr")
  assert.equal(cliRes.stdout.includes(TEST_TOKEN), false, "token must never appear in stdout")
  assert.ok(cliRes.stderr.includes("[REDACTED]"))
})

test("bridge recovers from transient Telegram errors with backoff and shuts down cleanly on SIGTERM", async (t) => {
  const tmpDir = await makeTempDir(t)
  const stateFile = path.join(tmpDir, ".telegram-bridge-state.json")
  const logFile = path.join(tmpDir, "notes.jsonl")

  const { homeDir } = await createStubFirstmateHome(t, {
    scriptBody: `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'note') {
  fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + '\\n');
  process.stdout.write(JSON.stringify({ schema: 'fm-inbox-note.v1', outcome: 'created', id: 'note-dash', saved: true, announced: true }) + '\\n');
  process.exit(0);
}
if (args[0] === 'receipts') {
  process.stdout.write(JSON.stringify({ schema: 'fm-inbox-receipts.v1', replies: [], reply_cursor: '', omitted: [] }) + '\\n');
  process.exit(0);
}
process.exit(1);
`,
  })

  let getUpdatesCalls = 0
  let resolveDelivered!: () => void
  const deliveredPromise = new Promise<void>((resolve) => {
    resolveDelivered = resolve
  })

  const { baseUrl } = await startMockTelegramServer(t, async (req) => {
    if (req.url === `/bot${TEST_TOKEN}/getUpdates`) {
      getUpdatesCalls += 1
      if (getUpdatesCalls === 1) {
        return { status: 502, json: { ok: false, description: "Bad Gateway" } }
      }
      if (getUpdatesCalls === 2) {
        return {
          json: {
            ok: true,
            result: [
              { update_id: 500, message: { chat: { id: Number(ALLOWED_CHAT_ID), type: "private" }, text: "-" } },
            ],
          },
        }
      }
      resolveDelivered()
      await new Promise((resolve) => setTimeout(resolve, 100))
      return { json: { ok: true, result: [] } }
    }
    return { status: 404, json: { ok: false, description: "not found" } }
  })

  const stdoutLines: Array<string> = []
  const stderrLines: Array<string> = []
  const config = makeBridgeRuntimeConfig({
    token: TEST_TOKEN,
    chatId: ALLOWED_CHAT_ID,
    firstmateHome: homeDir,
    stateFilePath: stateFile,
    apiBase: baseUrl,
    pollTimeoutSeconds: 0,
    replyPollMs: 50,
    backoffInitialMs: 10,
    backoffMaxMs: 25,
  })
  const layer = makeLiveBridgeLayer(config, {
    stdout: (line) => stdoutLines.push(line),
    stderr: (line) => stderrLines.push(line),
  })

  const fiber = Effect.runFork(runBridge().pipe(Effect.provide(layer)))
  await deliveredPromise
  await Effect.runPromise(Fiber.interrupt(fiber))
  const exit = await Effect.runPromise(Fiber.await(fiber))
  assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))

  assert.ok(stderrLines.some((line) => line.includes("HTTP 502")))
  assert.ok(stderrLines.every((line) => !line.includes(TEST_TOKEN)))
  assert.ok(stdoutLines.some((line) => line.includes("stopped cleanly")))

  const calls = (await fs.readFile(logFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Array<string>)
  assert.deepEqual(calls, [["note", "--request-id", "tg-500", "--json", "--", "-"]])

  // Verify real CLI processes (.ts and .mjs) exit 0 cleanly on SIGTERM
  for (const scriptPath of [BRIDGE_TS_SCRIPT, BRIDGE_MJS_SCRIPT]) {
    const child = spawn(
      process.execPath,
      [
        scriptPath,
        "--firstmate-home",
        homeDir,
        "--state-file",
        stateFile,
        "--api-base",
        baseUrl,
        "--poll-timeout",
        "0",
        "--reply-poll-ms",
        "100",
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CLANKER_UPDATES_TOKEN: TEST_TOKEN,
          CLANKER_UPDATES_CHAT_ID: ALLOWED_CHAT_ID,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    let stdout = ""
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("bridge did not start in time")), 5000)
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk
        if (stdout.includes("started")) {
          clearTimeout(timeout)
          resolve()
        }
      })
      child.on("exit", (code) => {
        clearTimeout(timeout)
        reject(new Error(`bridge exited early with code ${code}`))
      })
    })

    child.kill("SIGTERM")
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code))
    })
    assert.equal(exitCode, 0, `${path.basename(scriptPath)} must exit 0 on SIGTERM`)
    assert.ok(stdout.includes("stopped cleanly"))
  }
})

test("TelegramClient.call aborts stalled response bodies on timeout and fiber interruption", async (t) => {
  let headersSentResolve!: () => void
  let headersSentPromise = new Promise<void>((resolve) => {
    headersSentResolve = resolve
  })

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.flushHeaders()
    headersSentResolve()
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${port}`

  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const client = makeLiveTelegramClient({
    token: Redacted.make(TEST_TOKEN),
    apiBase: baseUrl,
  })

  const timeoutErr = await runEffectFailure(
    client.call("getUpdates", {}, { timeoutMs: 80 }),
  )
  assert.ok(timeoutErr instanceof TelegramApiError)
  assert.equal(timeoutErr.message.includes(TEST_TOKEN), false)
  assert.match(timeoutErr.message, /Timed out after 80ms/)

  headersSentPromise = new Promise<void>((resolve) => {
    headersSentResolve = resolve
  })
  const fiber = Effect.runFork(client.call("getUpdates", {}, { timeoutMs: 5000 }))
  await headersSentPromise
  await Effect.runPromise(Fiber.interrupt(fiber))
  const interruptExit = await Effect.runPromise(Fiber.await(fiber))
  assert.ok(Exit.isFailure(interruptExit) && Cause.hasInterruptsOnly(interruptExit.cause))
})

test("bridge shuts down cleanly even when the last state save failed", async (t) => {
  const tmpDir = await makeTempDir(t)
  const stateFile = path.join(tmpDir, ".telegram-bridge-state.json")

  const { homeDir } = await createStubFirstmateHome(t, {
    scriptBody: `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'note') {
  process.stdout.write(JSON.stringify({ schema: 'fm-inbox-note.v1', outcome: 'created', id: 'note-1', saved: true, announced: true }) + '\\n');
  process.exit(0);
}
if (args[0] === 'receipts') {
  process.stdout.write(JSON.stringify({ schema: 'fm-inbox-receipts.v1', replies: [], reply_cursor: '', omitted: [] }) + '\\n');
  process.exit(0);
}
process.exit(1);
`,
  })

  let getUpdatesCalls = 0
  let resolveSaveFailed!: () => void
  const saveFailedPromise = new Promise<void>((resolve) => {
    resolveSaveFailed = resolve
  })

  const { baseUrl } = await startMockTelegramServer(t, async (req) => {
    if (req.url === `/bot${TEST_TOKEN}/getUpdates`) {
      getUpdatesCalls += 1
      if (getUpdatesCalls === 1) {
        await fs.mkdir(stateFile, { recursive: true })
        return {
          json: {
            ok: true,
            result: [
              { update_id: 600, message: { chat: { id: Number(ALLOWED_CHAT_ID), type: "private" }, text: "hello" } },
            ],
          },
        }
      }
      return { json: { ok: true, result: [] } }
    }
    return { status: 404, json: { ok: false, description: "not found" } }
  })

  const stderrLines: Array<string> = []
  const config = makeBridgeRuntimeConfig({
    token: TEST_TOKEN,
    chatId: ALLOWED_CHAT_ID,
    firstmateHome: homeDir,
    stateFilePath: stateFile,
    apiBase: baseUrl,
    pollTimeoutSeconds: 0,
    replyPollMs: 50,
    backoffInitialMs: 5000,
    backoffMaxMs: 5000,
  })
  const layer = makeLiveBridgeLayer(config, {
    stdout: () => {},
    stderr: (line) => {
      stderrLines.push(line)
      if (line.includes("inbound poll failed")) {
        resolveSaveFailed()
      }
    },
  })

  const fiber = Effect.runFork(runBridge().pipe(Effect.provide(layer)))
  await saveFailedPromise
  await Effect.runPromise(Fiber.interrupt(fiber))
  const exit = await Effect.runPromise(Fiber.await(fiber))
  assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
  assert.ok(stderrLines.some((line) => line.includes("inbound poll failed")))
})

test("Schema.TaggedError types expose expected tags for typed error handling", () => {
  const cfgErr = new ConfigError({ message: "bad config" })
  const tgErr = new TelegramApiError({
    method: "sendMessage",
    message: "failed",
    statusCode: 500,
    retryAfterSeconds: null,
  })
  const inboxErr = new InboxCommandError({
    command: "receipts",
    exitCode: 1,
    stderr: "err",
    message: "failed",
  })
  const stateErr = new StateStoreError({
    operation: "save",
    path: "/tmp/s.json",
    message: "failed",
  })

  assert.equal(cfgErr._tag, "ConfigError")
  assert.equal(tgErr._tag, "TelegramApiError")
  assert.equal(inboxErr._tag, "InboxCommandError")
  assert.equal(stateErr._tag, "StateStoreError")
  assert.ok(Schema.isSchema(ConfigError))
})
