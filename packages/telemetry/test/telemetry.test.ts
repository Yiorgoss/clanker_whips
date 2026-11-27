import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import fs from "node:fs/promises"
import http from "node:http"
import net, { type AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { Cause, Effect, Exit } from "effect"

import {
  TelemetryConfigError,
  TelemetryStore,
  TelemetryStoreError,
  classifyBashCommand,
  createSpanContext,
  createTelemetryExtension,
  decodeTelemetryEventJson,
  detectHttpDownload,
  evaluateAlertPolicy,
  formatTraceparent,
  isDomainAllowed,
  makeTelemetryEvent,
  openTelemetryStore,
  parseConnectAuthority,
  parseDurationToSinceMs,
  parseTraceparent,
  redactHeaders,
  redactText,
  redactUrl,
  runTelemetryCli,
  startTelemetryProxy,
  validateTelemetryEvent,
  type PiEventHandler,
  type PiExtensionAPILike,
  type PiExtensionContextLike,
  type PiToolCallEventLike,
  type PiToolResultEventLike,
  type TelemetryEvent,
} from "../src/index.ts"

const execFileAsync = promisify(execFile)
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TEST_DIR, "..", "..", "..")
const TELEMETRY_CLI_SCRIPT = path.resolve(TEST_DIR, "..", "src", "cli.ts")

async function makeTempDir(t: TestContext, prefix = "clanker-telemetry-test-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  return dir
}

function createMockPiApi() {
  const toolCallHandlers: Array<PiEventHandler<PiToolCallEventLike>> = []
  const toolResultHandlers: Array<PiEventHandler<PiToolResultEventLike>> = []
  const shutdownHandlers: Array<PiEventHandler<Record<string, unknown>>> = []

  const api: PiExtensionAPILike = {
    on(event: string, handler: PiEventHandler<any>) {
      if (event === "tool_call") {
        toolCallHandlers.push(handler)
      } else if (event === "tool_result") {
        toolResultHandlers.push(handler)
      } else if (event === "session_shutdown") {
        shutdownHandlers.push(handler)
      }
    },
  }

  return {
    api,
    async emitToolCall(event: PiToolCallEventLike, ctx?: PiExtensionContextLike) {
      for (const handler of toolCallHandlers) {
        await handler(event, ctx)
      }
    },
    async emitToolResult(event: PiToolResultEventLike, ctx?: PiExtensionContextLike) {
      for (const handler of toolResultHandlers) {
        await handler(event, ctx)
      }
    },
    async emitShutdown(ctx?: PiExtensionContextLike) {
      for (const handler of shutdownHandlers) {
        await handler({ reason: "quit" }, ctx)
      }
    },
  }
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`Condition not met within ${timeoutMs}ms`)
}

// ---------------------------------------------------------------------------
// .gitignore, W3C traceparent, Schema, Redaction, Classifier, Alerts
// ---------------------------------------------------------------------------

test(".gitignore ignores telemetry databases, WAL/SHM files, JSONL files, and .telemetry/", async () => {
  const ignoredPaths = [
    "telemetry.db",
    "telemetry.db-wal",
    "telemetry.db-shm",
    "events.jsonl",
    ".telemetry/events.jsonl",
    ".telemetry/telemetry.db",
    "packages/telemetry/local.db",
  ]
  for (const relPath of ignoredPaths) {
    const { stdout } = await execFileAsync("git", ["-C", REPO_ROOT, "check-ignore", relPath])
    assert.equal(stdout.trim(), relPath, `${relPath} must be gitignored`)
  }
})

test("W3C TRACEPARENT parsing, validation, and child span propagation", () => {
  const validHeader = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
  const parsed = parseTraceparent(validHeader)
  assert.deepEqual(parsed, {
    version: "00",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    traceFlags: "01",
  })

  // Invalid traceparents must be rejected
  assert.equal(parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01"), undefined)
  assert.equal(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"), undefined)
  assert.equal(parseTraceparent("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"), undefined)
  assert.equal(parseTraceparent("not-a-traceparent"), undefined)

  // Propagates traceId and sets parentSpanId from env TRACEPARENT
  const child = createSpanContext({ env: { TRACEPARENT: validHeader } })
  assert.equal(child.traceId, "4bf92f3577b34da6a3ce929d0e0e4736")
  assert.equal(child.parentSpanId, "00f067aa0ba902b7")
  assert.notEqual(child.spanId, "00f067aa0ba902b7")
  assert.equal(
    child.traceparent,
    formatTraceparent({ traceId: child.traceId, spanId: child.spanId, traceFlags: "01" }),
  )

  // Mints a root trace when absent
  const root = createSpanContext({ env: {} })
  assert.match(root.traceId, /^[0-9a-f]{32}$/)
  assert.match(root.spanId, /^[0-9a-f]{16}$/)
  assert.equal(root.parentSpanId, null)
})

test("secret redaction strips Bearer tokens, Telegram tokens, API keys, env secrets, URL creds, and headers", () => {
  const fakeTgToken = "123456789:ABCDEF_fake_telegram_token_12345"
  const fakeGhToken = "ghp_1234567890abcdefghij1234567890"
  const fakeBearer = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig"

  const rawCmd =
    `CLANKER_UPDATES_TOKEN=${fakeTgToken} OPENAI_API_KEY="sk-testsecretkey1234567890" ` +
    `curl -H "Authorization: Bearer ${fakeBearer}" ` +
    `https://admin:hunter2@api.telegram.org/bot${fakeTgToken}/sendMessage?token=${fakeGhToken}&safe=1`

  const redacted = redactText(rawCmd, [fakeTgToken])
  assert.equal(redacted.includes(fakeTgToken), false)
  assert.equal(redacted.includes(fakeGhToken), false)
  assert.equal(redacted.includes(fakeBearer), false)
  assert.equal(redacted.includes("sk-testsecretkey1234567890"), false)
  assert.equal(redacted.includes("hunter2"), false)
  assert.ok(redacted.includes("CLANKER_UPDATES_TOKEN=[REDACTED]"))
  assert.ok(redacted.includes("Bearer [REDACTED]"))
  assert.ok(redacted.includes("/bot[REDACTED]"))
  assert.ok(redacted.includes("safe=1"))

  const redactedUrl = redactUrl(
    `https://alice:mysecretpass@example.com/bot${fakeTgToken}/file?api_key=secret123&page=2`,
    [fakeTgToken],
  )
  assert.equal(redactedUrl.includes("mysecretpass"), false)
  assert.equal(redactedUrl.includes("secret123"), false)
  assert.equal(redactedUrl.includes(fakeTgToken), false)
  assert.ok(redactedUrl.includes("page=2"))
  assert.ok(redactedUrl.includes("[REDACTED]"))

  const safeHeaders = redactHeaders({
    authorization: `Bearer ${fakeBearer}`,
    "proxy-authorization": "Basic dXNlcjpwYXNz",
    cookie: "session=supersecret",
    "x-api-key": "my-secret-key",
    "content-type": "application/json",
  })
  assert.equal(safeHeaders.authorization, "[REDACTED]")
  assert.equal(safeHeaders["proxy-authorization"], "[REDACTED]")
  assert.equal(safeHeaders.cookie, "[REDACTED]")
  assert.equal(safeHeaders["x-api-key"], "[REDACTED]")
  assert.equal(safeHeaders["content-type"], "application/json")

  const patCmd = redactText("git clone https://my_plain_pat_secret@github.com/org/repo.git")
  assert.equal(patCmd.includes("my_plain_pat_secret"), false)
  assert.equal(patCmd, "git clone https://[REDACTED]@github.com/org/repo.git")

  const queryEmail = redactText("curl https://example.com?email=user@example.com")
  assert.equal(queryEmail, "curl https://example.com?email=user@example.com")
})

test("Schema validation accepts well-formed events and rejects invalid trace IDs", async () => {
  const valid = makeTelemetryEvent({
    eventType: "command",
    source: "pi_extension",
    name: "tool.bash",
    status: "ok",
    durationMs: 42,
    exitCode: 0,
    attributes: { command: "ls -la" },
  })
  const checked = await Effect.runPromise(validateTelemetryEvent(valid))
  assert.equal(checked.traceId, valid.traceId)
  assert.equal(checked.eventType, "command")

  const badExit = await Effect.runPromiseExit(
    validateTelemetryEvent({ ...valid, traceId: "not-hex" }),
  )
  assert.ok(Exit.isFailure(badExit))
  assert.ok(Cause.squash(badExit.cause) instanceof TelemetryConfigError)
})

test("command and HTTP classifiers detect URLs, curl/wget/git/pnpm downloads, and attachment headers", () => {
  const curlClass = classifyBashCommand(
    "curl -fsSL -o /tmp/app.tar.gz https://downloads.example.com/v1/app.tar.gz && pnpm add effect",
  )
  assert.deepEqual(curlClass.urls, ["https://downloads.example.com/v1/app.tar.gz"])
  assert.equal(curlClass.downloads.length, 2)
  assert.equal(curlClass.downloads[0]?.via, "curl")
  assert.equal(curlClass.downloads[0]?.filename, "app.tar.gz")
  assert.equal(curlClass.downloads[0]?.domain, "downloads.example.com")
  assert.equal(curlClass.downloads[1]?.via, "pnpm_add")
  assert.equal(curlClass.downloads[1]?.filename, "effect")

  const gitAndWget = classifyBashCommand(
    "git clone https://github.com/org/repo.git myrepo && wget -O out.zip https://cdn.example.org/files/pkg.zip",
  )
  assert.equal(gitAndWget.downloads.length, 2)
  assert.equal(gitAndWget.downloads[0]?.via, "git_clone")
  assert.equal(gitAndWget.downloads[0]?.domain, "github.com")
  assert.equal(gitAndWget.downloads[0]?.filename, "myrepo")
  assert.equal(gitAndWget.downloads[1]?.via, "wget")
  assert.equal(gitAndWget.downloads[1]?.filename, "out.zip")

  const httpAttachment = detectHttpDownload({
    method: "GET",
    url: "http://example.com/download?id=42",
    contentDisposition: 'attachment; filename="report-2026.pdf"',
    contentType: "application/pdf",
  })
  assert.equal(httpAttachment.isDownload, true)
  assert.equal(httpAttachment.filename, "report-2026.pdf")
  assert.equal(httpAttachment.reason, "content-disposition")

  const htmlPage = detectHttpDownload({
    method: "GET",
    url: "http://example.com/docs/index.html",
    contentType: "text/html; charset=utf-8",
  })
  assert.equal(htmlPage.isDownload, false)

  assert.equal(classifyBashCommand("wget --help").downloads.length, 0)
  assert.equal(classifyBashCommand("git clone --help").downloads.length, 0)

  const attachedAndPiped = classifyBashCommand(
    "curl -o/tmp/a.tgz https://example.com/a.tgz && wget -Oout.zip https://example.com/pkg.zip && curl https://example.com/c.tgz >/tmp/c.tgz | echo ok | curl -o /tmp/b.tgz https://example.com/b.tgz",
  )
  assert.equal(attachedAndPiped.downloads.length, 4)
  assert.equal(attachedAndPiped.downloads[0]?.destinationPath, "/tmp/a.tgz")
  assert.equal(attachedAndPiped.downloads[1]?.destinationPath, "out.zip")
  assert.equal(attachedAndPiped.downloads[2]?.destinationPath, "/tmp/c.tgz")
  assert.equal(attachedAndPiped.downloads[3]?.destinationPath, "/tmp/b.tgz")
})

test("alert allowlist and large-download policy evaluation", () => {
  assert.equal(isDomainAllowed("api.github.com", ["*.github.com"]), true)
  assert.equal(isDomainAllowed("github.com", ["*.github.com"]), true)
  assert.equal(isDomainAllowed("evilgithub.com", ["*.github.com"]), false)
  assert.equal(isDomainAllowed("registry.npmjs.org", [".npmjs.org"]), true)

  const unexpectedEvent = makeTelemetryEvent({
    eventType: "web_visit",
    source: "proxy",
    name: "http.proxy.connect",
    domain: "suspicious.invalid",
    bytesTransferred: 512,
  })
  const domainAlert = evaluateAlertPolicy(unexpectedEvent, {
    allowedDomains: ["*.github.com", "registry.npmjs.org"],
  })
  assert.equal(domainAlert?.kind, "unexpected_domain")
  assert.equal(domainAlert?.domain, "suspicious.invalid")

  const largeEvent = makeTelemetryEvent({
    eventType: "file_download",
    source: "proxy",
    name: "http.proxy.download",
    domain: "github.com",
    bytesTransferred: 10_000,
    attributes: { filename: "big.tar.gz" },
  })
  const sizeAlert = evaluateAlertPolicy(largeEvent, {
    allowedDomains: ["github.com"],
    maxDownloadBytes: 5_000,
  })
  assert.equal(sizeAlert?.kind, "large_download")
})

// ---------------------------------------------------------------------------
// Store persistence (JSONL + SQLite, 0600 permissions, indexed queries) & CLI
// ---------------------------------------------------------------------------

test("TelemetryStore persists redacted OTel events to 0600 JSONL + SQLite and supports indexed queries + CLI", async (t) => {
  const dataDir = await makeTempDir(t, "telemetry-store-")
  const baseMs = Date.parse("2026-11-27T12:00:00.000Z")
  const secretToken = "987654321:SECRET_BOT_TOKEN_DO_NOT_LEAK_XYZ"

  const eventsToRecord: ReadonlyArray<TelemetryEvent> = [
    makeTelemetryEvent({
      eventType: "command",
      source: "pi_extension",
      name: "tool.bash",
      status: "ok",
      durationMs: 120,
      timestampMs: baseMs - 3_600_000 * 5, // 5 hours ago
      sessionId: "sess-old",
      taskId: "task-1",
      exitCode: 0,
      attributes: { command: "git status", cwd: "/repo" },
    }),
    makeTelemetryEvent({
      eventType: "command",
      source: "pi_extension",
      name: "tool.bash",
      status: "error",
      durationMs: 350,
      timestampMs: baseMs - 60_000, // 1 min ago
      sessionId: "sess-1",
      taskId: "task-2",
      exitCode: 2,
      attributes: {
        command: `CLANKER_UPDATES_TOKEN=${secretToken} pnpm test`,
        cwd: "/repo",
      },
    }),
    makeTelemetryEvent({
      eventType: "web_visit",
      source: "proxy",
      name: "http.proxy.request",
      status: "ok",
      durationMs: 80,
      timestampMs: baseMs - 30_000,
      sessionId: "sess-1",
      taskId: "task-2",
      domain: "docs.example.com",
      bytesTransferred: 4096,
      attributes: {
        url: `https://docs.example.com/api?token=${secretToken}`,
        statusCode: 200,
      },
    }),
    makeTelemetryEvent({
      eventType: "file_download",
      source: "proxy",
      name: "http.proxy.download",
      status: "ok",
      durationMs: 210,
      timestampMs: baseMs - 10_000,
      sessionId: "sess-1",
      taskId: "task-2",
      domain: "releases.example.com",
      bytesTransferred: 256_000,
      attributes: {
        url: "https://releases.example.com/tool-1.0.tar.gz",
        filename: "tool-1.0.tar.gz",
        via: "http_proxy",
        contentType: "application/gzip",
        statusCode: 200,
      },
    }),
  ]

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* TelemetryStore
        for (const ev of eventsToRecord) {
          yield* store.record(ev)
        }

        const allSummary = yield* store.querySummary()
        assert.equal(allSummary.totalEvents, 4)
        assert.equal(allSummary.commandCount, 2)
        assert.equal(allSummary.webVisitCount, 1)
        assert.equal(allSummary.fileDownloadCount, 1)
        assert.equal(allSummary.errorCount, 1)
        assert.equal(allSummary.totalBytesTransferred, 260_096)

        // Time window filter (last 10 minutes excludes 5h-old event)
        const recentCommands = yield* store.queryCommands({ sinceMs: baseMs - 600_000 })
        assert.equal(recentCommands.length, 1)
        assert.equal(recentCommands[0]?.exitCode, 2)
        assert.equal(recentCommands[0]?.command.includes(secretToken), false)
        assert.ok(recentCommands[0]?.command.includes("CLANKER_UPDATES_TOKEN=[REDACTED]"))

        // Filter by exit code
        const failedCmds = yield* store.queryCommands({ exitCode: 2 })
        assert.equal(failedCmds.length, 1)

        // Filter by session/task
        const sessDomains = yield* store.queryDomains({ sessionId: "sess-1", taskId: "task-2" })
        assert.equal(sessDomains.length, 2)

        const downloads = yield* store.queryDownloads({ domain: "releases.example.com" })
        assert.equal(downloads.length, 1)
        assert.equal(downloads[0]?.filename, "tool-1.0.tar.gz")
      }).pipe(Effect.provide(TelemetryStore.layerFile({ dataDir, extraSecrets: [secretToken] }))),
    ),
  )

  // Verify 0600 permissions and valid JSONL with zero leaked secrets
  const jsonlPath = path.join(dataDir, "events.jsonl")
  const dbPath = path.join(dataDir, "telemetry.db")
  const jsonlStat = await fs.stat(jsonlPath)
  const dbStat = await fs.stat(dbPath)
  assert.equal(jsonlStat.mode & 0o777, 0o600, "events.jsonl must have mode 0600")
  assert.equal(dbStat.mode & 0o777, 0o600, "telemetry.db must have mode 0600")

  const rawJsonl = await fs.readFile(jsonlPath, "utf8")
  assert.equal(rawJsonl.includes(secretToken), false, "JSONL must not contain raw secret")
  const lines = rawJsonl.trim().split("\n")
  assert.equal(lines.length, 4)
  for (const line of lines) {
    const decoded = await Effect.runPromise(decodeTelemetryEventJson(line))
    assert.equal(decoded.schemaVersion, 1)
  }

  // Verify CLI subcommands (summary, commands, domains, downloads) in both JSON and text modes
  const runCliCapture = async (argv: ReadonlyArray<string>) => {
    let stdout = ""
    let stderr = ""
    const code = await runTelemetryCli(argv, {
      stdout: (s) => {
        stdout += s
      },
      stderr: (s) => {
        stderr += s
      },
      nowMs: baseMs,
    })
    return { code, stdout, stderr }
  }

  const summaryRes = await runCliCapture(["--", "summary", "--dir", dataDir, "--since", "1h"])
  assert.equal(summaryRes.code, 0)
  assert.match(summaryRes.stdout, /3 events \(1 commands, 1 web visits, 1 downloads, 1 errors\)/)
  assert.match(summaryRes.stdout, /releases\.example\.com/)
  assert.match(summaryRes.stdout, /tool-1\.0\.tar\.gz/)

  const commandsJson = await runCliCapture([
    "commands",
    "--dir",
    dataDir,
    "--since",
    "1h",
    "--limit",
    "5",
    "--json",
  ])
  assert.equal(commandsJson.code, 0)
  const parsedCmds = JSON.parse(commandsJson.stdout) as Array<{ command: string; exitCode: number }>
  assert.equal(parsedCmds.length, 1)
  assert.equal(parsedCmds[0]?.exitCode, 2)

  const domainsRes = await runCliCapture(["domains", "--dir", dataDir, "--limit", "10"])
  assert.equal(domainsRes.code, 0)
  assert.match(domainsRes.stdout, /docs\.example\.com/)
  assert.match(domainsRes.stdout, /releases\.example\.com/)

  const downloadsRes = await runCliCapture(["downloads", "--dir", dataDir, "--limit", "10"])
  assert.equal(downloadsRes.code, 0)
  assert.match(downloadsRes.stdout, /tool-1\.0\.tar\.gz/)

  // Verify CLI errors on invalid flags
  const badDuration = await Effect.runPromiseExit(parseDurationToSinceMs("invalid-window"))
  assert.ok(Exit.isFailure(badDuration))
  const badFlag = await runCliCapture(["summary", "--unknown-option"])
  assert.equal(badFlag.code, 1)
  assert.match(badFlag.stderr, /Unknown option/)

  // Verify direct Node execution of CLI script
  const { stdout: helpOut } = await execFileAsync(process.execPath, [TELEMETRY_CLI_SCRIPT, "--help"])
  assert.match(helpOut, /clanker-telemetry/)
  assert.match(helpOut, /summary/)
  assert.match(helpOut, /proxy/)
})

// ---------------------------------------------------------------------------
// Pi extension hook (tool_call / tool_result / session_shutdown / error resilience)
// ---------------------------------------------------------------------------

test("Pi extension records commands, web visits, downloads, file writes, redacts secrets, and correlates TRACEPARENT", async (t) => {
  const dataDir = await makeTempDir(t, "telemetry-pi-ext-")
  let clockMs = Date.parse("2026-11-27T15:00:00.000Z")
  const parentTraceparent = "00-11112222333344445555666677778888-aaaabbbbccccdddd-01"
  const secretBearer = "tok_live_super_secret_value_999"

  const mockPi = createMockPiApi()
  const warnings: Array<string> = []

  const extension = createTelemetryExtension({
    storeOptions: { dataDir, extraSecrets: [secretBearer] },
    env: {
      TRACEPARENT: parentTraceparent,
      CLANKER_TASK_ID: "task-telemetry-42",
    },
    now: () => clockMs,
    warn: (msg) => warnings.push(msg),
  })
  extension(mockPi.api)

  const ctx: PiExtensionContextLike = {
    cwd: "/workspace/clanker_whips",
    sessionManager: {
      getSessionId: () => "pi-session-99",
    },
  }

  // 1. Bash command that fetches a URL and downloads a file with a secret header
  const curlCmd =
    `curl -fsSL -H "Authorization: Bearer ${secretBearer}" -o /tmp/archive.tar.gz https://downloads.example.net/v2/archive.tar.gz`
  await mockPi.emitToolCall(
    { toolName: "bash", toolCallId: "call-1", input: { command: curlCmd } },
    ctx,
  )
  clockMs += 175
  await mockPi.emitToolResult(
    {
      toolName: "bash",
      toolCallId: "call-1",
      input: { command: curlCmd },
      content: [{ type: "text", text: "downloaded ok" }],
      details: { exitCode: 0 },
      isError: false,
    },
    ctx,
  )

  // 2. Web search / browser tool call
  await mockPi.emitToolCall(
    {
      toolName: "search_web",
      toolCallId: "call-2",
      input: { query: "effect v4 schema", url: "https://effect.website/docs" },
    },
    ctx,
  )
  clockMs += 90
  await mockPi.emitToolResult(
    {
      toolName: "search_web",
      toolCallId: "call-2",
      input: { query: "effect v4 schema", url: "https://effect.website/docs" },
      content: [{ type: "text", text: "search results..." }],
      isError: false,
    },
    ctx,
  )

  // 3. File write tool call
  await mockPi.emitToolCall(
    {
      toolName: "write",
      toolCallId: "call-3",
      input: { path: "/tmp/notes.md", content: "hello telemetry world" },
    },
    ctx,
  )
  clockMs += 15
  await mockPi.emitToolResult(
    {
      toolName: "write",
      toolCallId: "call-3",
      input: { path: "/tmp/notes.md", content: "hello telemetry world" },
      content: [{ type: "text", text: "wrote file" }],
      isError: false,
    },
    ctx,
  )

  await mockPi.emitShutdown(ctx)
  assert.deepEqual(warnings, [])

  // Verify persisted events in SQLite and JSONL
  const store = await Effect.runPromise(openTelemetryStore({ dataDir }))
  t.after(async () => {
    await Effect.runPromise(store.close)
  })

  const events = await Effect.runPromise(store.queryEvents({ limit: 20 }))
  const commands = events.filter((e) => e.eventType === "command")
  const webVisits = events.filter((e) => e.eventType === "web_visit")
  const downloads = events.filter((e) => e.eventType === "file_download")

  assert.equal(commands.length, 1)
  assert.equal(commands[0]?.traceId, "11112222333344445555666677778888")
  assert.equal(commands[0]?.parentSpanId, "aaaabbbbccccdddd")
  assert.equal(commands[0]?.durationMs, 175)
  assert.equal(commands[0]?.exitCode, 0)
  assert.equal(commands[0]?.sessionId, "pi-session-99")
  assert.equal(commands[0]?.taskId, "task-telemetry-42")
  assert.equal(String(commands[0]?.attributes.command).includes(secretBearer), false)
  assert.ok(String(commands[0]?.attributes.command).includes("Bearer [REDACTED]"))

  assert.equal(webVisits.length, 2)
  const curlVisit = webVisits.find((v) => v.domain === "downloads.example.net")
  const searchVisit = webVisits.find((v) => v.domain === "effect.website")
  assert.ok(curlVisit, "URL from bash curl command should be recorded as web_visit")
  assert.equal(curlVisit.parentSpanId, commands[0]?.spanId)
  assert.ok(searchVisit, "search_web tool call should be recorded as web_visit")

  assert.equal(downloads.length, 2)
  const curlDownload = downloads.find((d) => d.attributes.via === "curl")
  const writeDownload = downloads.find((d) => d.attributes.via === "tool_write")
  assert.ok(curlDownload, "curl -o should be recorded as file_download")
  assert.equal(curlDownload.parentSpanId, commands[0]?.spanId)
  assert.equal(curlDownload.attributes.filename, "archive.tar.gz")
  assert.ok(writeDownload, "write tool should be recorded as file_download")
  assert.equal(writeDownload.attributes.filename, "notes.md")
  assert.equal(writeDownload.bytesTransferred, Buffer.byteLength("hello telemetry world", "utf8"))
})

test("Pi extension never throws or blocks when telemetry store fails", async () => {
  const warnings: Array<string> = []
  const mockPi = createMockPiApi()

  const brokenStore = {
    jsonlPath: "/nonexistent/events.jsonl",
    dbPath: "/nonexistent/telemetry.db",
    record: () =>
      Effect.fail(
        new TelemetryStoreError({
          operation: "write",
          path: "/nonexistent/telemetry.db",
          message: "simulated disk full",
        }),
      ),
    querySummary: () => Effect.die("unused"),
    queryCommands: () => Effect.die("unused"),
    queryDomains: () => Effect.die("unused"),
    queryDownloads: () => Effect.die("unused"),
    queryEvents: () => Effect.die("unused"),
    close: Effect.void,
  }

  const extension = createTelemetryExtension({
    store: brokenStore,
    warn: (msg) => warnings.push(msg),
  })
  extension(mockPi.api)

  await mockPi.emitToolCall({ toolName: "bash", toolCallId: "c1", input: { command: "echo hi" } })
  await mockPi.emitToolResult({
    toolName: "bash",
    toolCallId: "c1",
    input: { command: "echo hi" },
    content: [{ type: "text", text: "hi" }],
    details: { exitCode: 0 },
  })

  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /simulated disk full/)
})

test("Pi extension handles non-error stdout exit-code text, missing toolCallId correlation, and concurrent store init", async (t) => {
  const dataDir = await makeTempDir(t, "telemetry-pi-edge-")
  let clockMs = Date.parse("2026-11-27T16:00:00.000Z")
  const warnings: Array<string> = []
  const mockPi = createMockPiApi()

  const extension = createTelemetryExtension({
    storeOptions: { dataDir },
    now: () => clockMs,
    warn: (msg) => warnings.push(msg),
  })
  extension(mockPi.api)

  await mockPi.emitToolCall({ toolName: "bash", input: { command: "rg 'exited with code 1' src/" } })
  clockMs += 55
  await mockPi.emitToolCall({ toolName: "bash", toolCallId: "par-1", input: { command: "echo one" } })
  await mockPi.emitToolCall({ toolName: "bash", toolCallId: "par-2", input: { command: "echo two" } })
  clockMs += 20

  await Promise.all([
    mockPi.emitToolResult({
      toolName: "bash",
      content: [{ type: "text", text: "match: process exited with code 1" }],
      isError: false,
    }),
    mockPi.emitToolResult({
      toolName: "bash",
      toolCallId: "par-1",
      content: [{ type: "text", text: "one" }],
      isError: false,
    }),
    mockPi.emitToolResult({
      toolName: "bash",
      toolCallId: "par-2",
      content: [{ type: "text", text: "two" }],
      isError: false,
    }),
  ])

  await mockPi.emitShutdown()
  assert.deepEqual(warnings, [])

  const store = await Effect.runPromise(openTelemetryStore({ dataDir }))
  t.after(async () => {
    await Effect.runPromise(store.close)
  })

  const cmds = await Effect.runPromise(store.queryCommands({ limit: 10 }))
  assert.equal(cmds.length, 3)
  const rgCmd = cmds.find((c) => c.command.includes("rg "))
  assert.ok(rgCmd)
  assert.equal(rgCmd.exitCode, 0)
  assert.equal(rgCmd.status, "ok")
  assert.equal(rgCmd.durationMs, 75)
})

test("TelemetryStore releases writeLock before executing alert commands", async (t) => {
  const dataDir = await makeTempDir(t, "telemetry-store-lock-")
  let releaseAlert!: () => void
  let alertStarted = false
  let secondRecordFinishedBeforeAlertRelease = false

  const store = await Effect.runPromise(
    openTelemetryStore({
      dataDir,
      alertDispatcher: {
        inspectAndAlert: (event) =>
          event.domain === "slow.invalid"
            ? Effect.promise(
              () =>
                new Promise((resolve) => {
                  alertStarted = true
                  releaseAlert = () => resolve(null)
                }),
            )
            : Effect.succeed(null),
      },
    }),
  )
  t.after(async () => {
    await Effect.runPromise(store.close)
  })

  const slowRecordPromise = Effect.runPromise(
    store.record(
      makeTelemetryEvent({
        eventType: "web_visit",
        source: "proxy",
        name: "http.proxy.request",
        domain: "slow.invalid",
      }),
    ),
  )

  await waitForCondition(async () => alertStarted, 1000)

  await Effect.runPromise(
    store.record(
      makeTelemetryEvent({
        eventType: "command",
        source: "pi_extension",
        name: "tool.bash",
        attributes: { command: "echo fast" },
      }),
    ),
  )
  secondRecordFinishedBeforeAlertRelease = true
  releaseAlert()
  await slowRecordPromise

  assert.equal(secondRecordFinishedBeforeAlertRelease, true)
  const events = await Effect.runPromise(store.queryEvents({ limit: 10 }))
  assert.equal(events.length, 2)
})

// ---------------------------------------------------------------------------
// End-to-end local outbound HTTP / HTTPS CONNECT metadata proxy & alerts
// ---------------------------------------------------------------------------

test("proxy refuses non-loopback binding and parses CONNECT authorities", async (t) => {
  const dataDir = await makeTempDir(t, "telemetry-proxy-guard-")
  const exit = await Effect.runPromiseExit(
    startTelemetryProxy({ host: "0.0.0.0", port: 0, storeOptions: { dataDir } }),
  )
  assert.ok(Exit.isFailure(exit))
  assert.ok(Cause.squash(exit.cause) instanceof TelemetryConfigError)

  let stderr = ""
  const cliCode = await runTelemetryCli(["proxy", "--allow-non-loopback"], {
    stdout: () => {},
    stderr: (chunk) => {
      stderr += chunk
    },
  })
  assert.equal(cliCode, 1)
  assert.match(stderr, /Unknown option: --allow-non-loopback/)

  assert.deepEqual(parseConnectAuthority("example.com:443"), { host: "example.com", port: 443 })
  assert.deepEqual(parseConnectAuthority("[::1]:8443"), { host: "::1", port: 8443 })
  assert.equal(parseConnectAuthority("no-port"), null)
  assert.equal(parseConnectAuthority("example.com:99999"), null)
})

test("E2E proxy forwards HTTP requests + downloads, tunnels HTTPS CONNECT without MITM, records telemetry, and triggers alerts", async (t) => {
  const dataDir = await makeTempDir(t, "telemetry-proxy-e2e-")
  const alertLogFile = path.join(dataDir, "alerts.jsonl")
  const alertScriptPath = path.join(dataDir, "alert-hook.mjs")

  await fs.writeFile(
    alertScriptPath,
    `#!/usr/bin/env node
import fs from "node:fs";
const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
}
const body = Buffer.concat(chunks).toString("utf8").trim();
fs.appendFileSync(${JSON.stringify(alertLogFile)}, JSON.stringify({
  kind: process.env.CLANKER_ALERT_KIND,
  domain: process.env.CLANKER_ALERT_DOMAIN,
  body,
}) + "\\n");
`,
    { mode: 0o755 },
  )

  // 1. Mock upstream HTTP origin server (serves JSON page + binary attachment download)
  let receivedTraceparent: string | undefined
  const downloadPayload = Buffer.from("X".repeat(2048), "utf8")

  const mockHttpOrigin = http.createServer((req, res) => {
    receivedTraceparent = typeof req.headers.traceparent === "string"
      ? req.headers.traceparent
      : undefined
    if (req.url?.startsWith("/files/bundle")) {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="bundle-v1.tar.gz"',
        "content-length": String(downloadPayload.length),
      })
      res.end(downloadPayload)
      return
    }
    const body = JSON.stringify({ ok: true, path: req.url })
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    })
    res.end(body)
  })

  await new Promise<void>((resolve) => mockHttpOrigin.listen(0, "127.0.0.1", resolve))
  const originPort = (mockHttpOrigin.address() as AddressInfo).port
  t.after(async () => {
    mockHttpOrigin.closeAllConnections?.()
    await new Promise<void>((resolve) => mockHttpOrigin.close(() => resolve()))
  })

  // 2. Mock upstream TCP server for HTTPS CONNECT tunnel test (echoes raw bytes untouched)
  const mockTunnelTarget = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      socket.write(Buffer.concat([Buffer.from("ECHO:"), buf]))
      socket.end()
    })
  })
  await new Promise<void>((resolve) => mockTunnelTarget.listen(0, "127.0.0.1", resolve))
  const tunnelPort = (mockTunnelTarget.address() as AddressInfo).port
  t.after(async () => {
    await new Promise<void>((resolve) => mockTunnelTarget.close(() => resolve()))
  })

  // 3. Start local telemetry proxy with allowlist + size threshold + alert hook
  const proxy = await Effect.runPromise(
    startTelemetryProxy({
      host: "127.0.0.1",
      port: 0,
      storeOptions: { dataDir },
      sessionId: "proxy-sess-1",
      taskId: "proxy-task-1",
      alertPolicy: {
        alertCmd: `${process.execPath} ${alertScriptPath}`,
        allowedDomains: ["127.0.0.1"],
        maxDownloadBytes: 1024,
        cooldownMs: 0,
      },
    }),
  )
  t.after(async () => {
    await proxy.stop()
  })

  const incomingTraceparent = "00-aaaa1111bbbb2222cccc3333dddd4444-1234567890abcdef-01"

  // 4. Send normal plain HTTP request through proxy (with secret query + auth header)
  const jsonResponse = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxy.port,
        method: "GET",
        path: `http://127.0.0.1:${originPort}/api/status?token=super_secret_qs&ok=1`,
        headers: {
          host: `127.0.0.1:${originPort}`,
          authorization: "Bearer top_secret_proxy_bearer",
          traceparent: incomingTraceparent,
        },
      },
      (res) => {
        const chunks: Array<Buffer> = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })
        })
      },
    )
    req.on("error", reject)
    req.end()
  })
  assert.equal(jsonResponse.status, 200)
  assert.match(jsonResponse.body, /"ok":true/)
  assert.equal(receivedTraceparent, incomingTraceparent)

  // 5. Send download HTTP request through proxy (triggers file_download + large_download alert)
  const dlResponse = await new Promise<{ status: number; bytes: number }>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxy.port,
        method: "GET",
        path: `http://127.0.0.1:${originPort}/files/bundle`,
        headers: { host: `127.0.0.1:${originPort}` },
      },
      (res) => {
        let bytes = 0
        res.on("data", (c: Buffer) => {
          bytes += c.length
        })
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, bytes })
        })
      },
    )
    req.on("error", reject)
    req.end()
  })
  assert.equal(dlResponse.status, 200)
  assert.equal(dlResponse.bytes, 2048)

  // 6. Send HTTPS-style CONNECT tunnel through proxy (using localhost to trigger unexpected_domain alert!)
  const tunnelEcho = await new Promise<string>((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: proxy.port,
      method: "CONNECT",
      path: `localhost:${tunnelPort}`,
      headers: {
        host: `localhost:${tunnelPort}`,
        traceparent: incomingTraceparent,
      },
    })
    req.on("connect", (res, socket, head) => {
      assert.equal(res.statusCode, 200)
      const chunks: Array<Buffer> = head.length > 0 ? [head] : []
      socket.on("data", (chunk: Buffer) => chunks.push(chunk))
      socket.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf8"))
      })
      socket.on("error", reject)
      socket.write("OPAQUE_TLS_BYTES_HELLO")
    })
    req.on("error", reject)
    req.end()
  })
  assert.equal(tunnelEcho, "ECHO:OPAQUE_TLS_BYTES_HELLO")

  // Wait for async proxy writes + alert hook scripts (both large_download and unexpected_domain) to finish
  await waitForCondition(async () => {
    const events = await Effect.runPromise(proxy.store.queryEvents({ limit: 20 }))
    return events.length >= 4
  })

  await waitForCondition(async () => {
    try {
      const content = await fs.readFile(alertLogFile, "utf8")
      const rows = content.trim().split("\n").map((line) => JSON.parse(line) as { kind: string })
      return rows.some((r) => r.kind === "large_download") &&
        rows.some((r) => r.kind === "unexpected_domain")
    } catch {
      return false
    }
  })

  const events = await Effect.runPromise(proxy.store.queryEvents({ limit: 20 }))
  const summary = await Effect.runPromise(proxy.store.querySummary())
  const domains = await Effect.runPromise(proxy.store.queryDomains())
  await proxy.stop()
  const visits = events.filter((e) => e.eventType === "web_visit")
  const downloads = events.filter((e) => e.eventType === "file_download")

  assert.equal(visits.length, 3, "expected 2 HTTP visits + 1 CONNECT tunnel visit")
  assert.equal(downloads.length, 1, "expected 1 HTTP attachment download")

  const expectedHttpBytes = Buffer.byteLength(jsonResponse.body, "utf8") + downloadPayload.length
  const expectedTunnelBytes =
    Buffer.byteLength("OPAQUE_TLS_BYTES_HELLO") + Buffer.byteLength("ECHO:OPAQUE_TLS_BYTES_HELLO")
  assert.equal(summary.totalBytesTransferred, expectedHttpBytes + expectedTunnelBytes)
  const loopbackDomain = domains.find((d) => d.domain === "127.0.0.1")
  assert.equal(loopbackDomain?.totalBytes, expectedHttpBytes)

  const statusVisit = visits.find((v) => String(v.attributes.url).includes("/api/status"))
  assert.ok(statusVisit)
  assert.equal(statusVisit.traceId, "aaaa1111bbbb2222cccc3333dddd4444")
  assert.equal(statusVisit.parentSpanId, "1234567890abcdef")
  assert.equal(String(statusVisit.attributes.url).includes("super_secret_qs"), false)
  assert.equal(JSON.stringify(statusVisit.attributes).includes("top_secret_proxy_bearer"), false)

  const connectVisit = visits.find((v) => v.name === "http.proxy.connect")
  assert.ok(connectVisit)
  assert.equal(connectVisit.domain, "localhost")
  assert.equal(connectVisit.attributes.tunnel, true)
  assert.equal(connectVisit.attributes.port, tunnelPort)
  assert.equal(connectVisit.attributes.bytesOut, Buffer.byteLength("OPAQUE_TLS_BYTES_HELLO"))
  assert.equal(connectVisit.attributes.bytesIn, Buffer.byteLength("ECHO:OPAQUE_TLS_BYTES_HELLO"))

  const bundleDownload = downloads[0]!
  assert.equal(bundleDownload.attributes.filename, "bundle-v1.tar.gz")
  assert.equal(bundleDownload.attributes.contentType, "application/octet-stream")
  assert.equal(bundleDownload.bytesTransferred, 2048)

  const alertEntries = (await fs.readFile(alertLogFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { kind: string; domain: string; body: string })

  assert.equal(
    alertEntries.filter((a) => a.kind === "large_download" && a.domain === "127.0.0.1").length,
    1,
    "expected exactly one large_download alert",
  )
  assert.ok(
    alertEntries.some((a) => a.kind === "unexpected_domain" && a.domain === "localhost"),
    "expected unexpected_domain alert for non-allowlisted domain",
  )
})

test("CLI proxy subcommand starts on 127.0.0.1, serves traffic, and shuts down cleanly on SIGTERM", async (t) => {
  const dataDir = await makeTempDir(t, "telemetry-proxy-cli-")

  const child = spawn(
    process.execPath,
    [TELEMETRY_CLI_SCRIPT, "proxy", "--port", "0", "--dir", dataDir],
    {
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk
  })

  const exitPromise = new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code))
  })

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM")
      await exitPromise
    }
  })

  await waitForCondition(async () => /listening on http:\/\/127\.0\.0\.1:\d+/.test(stdout), 5000)

  child.kill("SIGTERM")
  const exitCode = await exitPromise
  assert.equal(exitCode, 0, `expected clean SIGTERM exit, got code=${exitCode}, stderr=${stderr}`)
  assert.match(stdout, /stopped cleanly/)
})
