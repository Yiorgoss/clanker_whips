import { spawn } from "node:child_process"
import { Effect } from "effect"

import { tokenizeCommand } from "./classifier.ts"
import { TelemetryAlertError } from "./errors.ts"
import { redactText } from "./redact.ts"
import type { TelemetryEvent } from "./schemas.ts"

export interface AlertPolicy {
  readonly alertCmd?: string | undefined
  readonly allowedDomains?: ReadonlyArray<string> | undefined
  readonly maxDownloadBytes?: number | undefined
  readonly timeoutMs?: number | undefined
  readonly cooldownMs?: number | undefined
}

export interface AlertTrigger {
  readonly kind: "unexpected_domain" | "large_download"
  readonly key: string
  readonly domain: string | null
  readonly message: string
}

export interface AlertExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export const DEFAULT_ALERT_TIMEOUT_MS = 15_000
export const DEFAULT_ALERT_COOLDOWN_MS = 60_000

/**
 * Check whether a hostname matches an allowlist entry.
 * Supports exact domains ("github.com"), suffix wildcards (".github.com" or "*.github.com"),
 * and loopback hosts ("localhost", "127.0.0.1", "::1").
 */
export function isDomainAllowed(
  domain: string,
  allowedDomains: ReadonlyArray<string>,
): boolean {
  const normalized = domain.trim().toLowerCase().replace(/\.$/, "")
  if (normalized.length === 0) {
    return true
  }
  for (const rawRule of allowedDomains) {
    const rule = rawRule.trim().toLowerCase().replace(/\.$/, "")
    if (rule.length === 0) {
      continue
    }
    if (rule === "*") {
      return true
    }
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(2)
      if (normalized === suffix || normalized.endsWith(`.${suffix}`)) {
        return true
      }
      continue
    }
    if (rule.startsWith(".")) {
      const suffix = rule.slice(1)
      if (normalized === suffix || normalized.endsWith(`.${suffix}`)) {
        return true
      }
      continue
    }
    if (normalized === rule) {
      return true
    }
  }
  return false
}

/**
 * Evaluate whether a recorded telemetry event should trigger an anomaly alert.
 */
export function evaluateAlertPolicy(
  event: TelemetryEvent,
  policy: AlertPolicy,
): AlertTrigger | null {
  const hasAllowlist =
    policy.allowedDomains !== undefined && policy.allowedDomains.length > 0

  if (
    hasAllowlist &&
    (event.eventType === "web_visit" || event.eventType === "file_download") &&
    event.domain !== null &&
    !isDomainAllowed(event.domain, policy.allowedDomains!)
  ) {
    return {
      kind: "unexpected_domain",
      key: `domain:${event.domain}`,
      domain: event.domain,
      message: [
        `[telemetry alert] Unexpected outbound domain: ${event.domain}`,
        `event=${event.eventType} source=${event.source} status=${event.status}`,
        `traceId=${event.traceId}`,
      ].join("\n"),
    }
  }

  if (
    policy.maxDownloadBytes !== undefined &&
    policy.maxDownloadBytes > 0 &&
    event.bytesTransferred !== null &&
    event.bytesTransferred >= policy.maxDownloadBytes &&
    (event.eventType === "file_download" ||
      (event.eventType === "web_visit" && event.attributes.isDownload !== true))
  ) {
    const filename = typeof event.attributes.filename === "string"
      ? event.attributes.filename
      : null
    return {
      kind: "large_download",
      key: `download:${event.domain ?? "local"}:${filename ?? event.name}`,
      domain: event.domain,
      message: [
        `[telemetry alert] Large transfer detected: ${event.bytesTransferred} bytes (limit ${policy.maxDownloadBytes})`,
        `domain=${event.domain ?? "n/a"} file=${filename ?? "n/a"} event=${event.eventType}`,
        `traceId=${event.traceId}`,
      ].join("\n"),
    }
  }

  return null
}

/**
 * Execute an external alert command without a shell, passing the redacted alert text on stdin
 * and via CLANKER_ALERT_* environment variables.
 */
export function runAlertCommand(
  alertCmd: string,
  trigger: AlertTrigger,
  options: { readonly timeoutMs?: number | undefined } = {},
): Effect.Effect<AlertExecResult, TelemetryAlertError> {
  const tokens = tokenizeCommand(alertCmd)
  const bin = tokens[0]
  if (bin === undefined || bin.length === 0) {
    return Effect.fail(
      new TelemetryAlertError({
        command: alertCmd,
        exitCode: -1,
        stderr: "Empty alert command",
        message: "Alert command is empty",
      }),
    )
  }

  const args = tokens.slice(1)
  const timeoutMs = options.timeoutMs ?? DEFAULT_ALERT_TIMEOUT_MS
  const safeMessage = redactText(trigger.message)

  return Effect.callback<AlertExecResult, TelemetryAlertError>((resume) => {
    const child = spawn(bin, args, {
      env: {
        ...process.env,
        CLANKER_ALERT_KIND: trigger.kind,
        CLANKER_ALERT_DOMAIN: trigger.domain ?? "",
        CLANKER_ALERT_MESSAGE: safeMessage,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let settled = false

    const finish = (effect: Effect.Effect<AlertExecResult, TelemetryAlertError>): void => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resume(effect)
      }
    }

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      finish(
        Effect.fail(
          new TelemetryAlertError({
            command: alertCmd,
            exitCode: -1,
            stderr: redactText(stderr),
            message: `Alert command timed out after ${timeoutMs}ms`,
          }),
        ),
      )
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

    child.on("error", (err) => {
      finish(
        Effect.fail(
          new TelemetryAlertError({
            command: alertCmd,
            exitCode: -1,
            stderr: redactText(err.message),
            message: `Failed to execute alert command: ${redactText(err.message)}`,
          }),
        ),
      )
    })

    child.on("close", (code) => {
      const exitCode = code ?? -1
      if (exitCode === 0) {
        finish(Effect.succeed({ exitCode, stdout, stderr }))
      } else {
        finish(
          Effect.fail(
            new TelemetryAlertError({
              command: alertCmd,
              exitCode,
              stderr: redactText(stderr.trim()),
              message: `Alert command exited with code ${exitCode}: ${
                redactText(stderr.trim()) || "unknown error"
              }`,
            }),
          ),
        )
      }
    })

    child.stdin.on("error", () => {})
    child.stdin.end(`${safeMessage}\n`)

    return Effect.sync(() => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        child.kill("SIGTERM")
      }
    })
  })
}

export interface AlertDispatcher {
  readonly inspectAndAlert: (event: TelemetryEvent) => Effect.Effect<AlertTrigger | null>
}

export function createAlertDispatcher(
  policy: AlertPolicy,
  options: {
    readonly onError?: ((message: string) => void) | undefined
    readonly onTrigger?: ((trigger: AlertTrigger) => void) | undefined
    readonly now?: (() => number) | undefined
  } = {},
): AlertDispatcher {
  const lastFiredByKey = new Map<string, number>()
  const cooldownMs = policy.cooldownMs ?? DEFAULT_ALERT_COOLDOWN_MS
  const nowFn = options.now ?? (() => Date.now())
  const onError = options.onError ?? ((msg) => {
    process.stderr.write(`[telemetry] WARN: ${msg}\n`)
  })

  return {
    inspectAndAlert: (event) =>
      Effect.gen(function*() {
        const trigger = evaluateAlertPolicy(event, policy)
        if (trigger === null) {
          return null
        }

        const nowMs = nowFn()
        const prevMs = lastFiredByKey.get(trigger.key)
        if (cooldownMs > 0 && prevMs !== undefined && nowMs - prevMs < cooldownMs) {
          return null
        }
        lastFiredByKey.set(trigger.key, nowMs)
        options.onTrigger?.(trigger)

        if (policy.alertCmd && policy.alertCmd.trim().length > 0) {
          yield* runAlertCommand(policy.alertCmd, trigger, {
            timeoutMs: policy.timeoutMs,
          }).pipe(
            Effect.asVoid,
            Effect.catch((err) =>
              Effect.sync(() => {
                onError(err.message)
              })
            ),
          )
        }

        return trigger
      }),
  }
}
