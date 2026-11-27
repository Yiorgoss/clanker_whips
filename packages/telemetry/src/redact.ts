const REDACTED = "[REDACTED]"

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "api-key",
  "apikey",
  "x-telegram-bot-api-secret-token",
])

const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "auth",
  "auth_token",
  "api_key",
  "apikey",
  "key",
  "secret",
  "client_secret",
  "password",
  "passwd",
  "pwd",
  "sig",
  "signature",
  "x-amz-signature",
  "x-amz-security-token",
  "x-amz-credential",
])

const SENSITIVE_KEY_NAME_RE =
  /(?:^|[_-])(token|secret|password|passwd|pwd|api[_-]?key|apikey|auth(?:orization)?|credential|private[_-]?key|cookie)(?:$|[_-])/i

const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi
const BASIC_RE = /\b(Basic)\s+[A-Za-z0-9+/=]{6,}/gi
const TELEGRAM_BOT_PATH_RE = /\/bot[^/\s?#"'`]+/gi
const TELEGRAM_BOT_TOKEN_RE = /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g
const KNOWN_KEY_PREFIX_RE =
  /\b(?:ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghu_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})\b/g

// Env assignments like CLANKER_UPDATES_TOKEN=xyz, OPENAI_API_KEY="abc", export PASSWORD='123'
const ENV_SECRET_ASSIGN_RE =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|AUTH_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Za-z0-9_]*)\s*(=)\s*(?:"[^"]*"|'[^']*'|[^\s"'`;|&]+)/gi

// Explicit Authorization / API-Key header values in CLI strings (preserving Bearer/Basic [REDACTED])
const INLINE_AUTH_HEADER_RE =
  /\b(Authorization|Proxy-Authorization|X-API-Key|X-Auth-Token|Cookie)\s*:\s*(?!Bearer\s+\[REDACTED\]|Basic\s+\[REDACTED\])([^\s"'\r\n][^"'\r\n]*)/gi

// CLI flags carrying credentials like --token xyz, --password=xyz, --api-key "xyz"
const CLI_SECRET_FLAG_RE =
  /(--?(?:token|api-key|apikey|secret|password|passwd|auth-token|access-token))(?:\s+|=)(?:"[^"]*"|'[^']*'|[^\s"'`;|&]+)/gi

// Credentials inside URLs: https://user:pass@host or https://token@host
const URL_USERINFO_RE = /(https?:\/\/)([^\s/?#@"'`]+)@/gi

// Sensitive query parameters inside freeform text URLs
const QUERY_SECRET_RE =
  /([?&](?:token|access_token|refresh_token|id_token|auth|auth_token|api_key|apikey|key|secret|client_secret|password|passwd|pwd|sig|signature|x-amz-signature|x-amz-security-token)=)([^&#\s"'`]+)/gi

export function collectEnvSecrets(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlyArray<string> {
  const secrets: Array<string> = []
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length < 6) {
      continue
    }
    if (key === "CLANKER_UPDATES_TOKEN" || SENSITIVE_KEY_NAME_RE.test(key)) {
      secrets.push(value)
    }
  }
  return secrets
}

function replaceExplicitSecrets(text: string, extraSecrets: ReadonlyArray<string>): string {
  let out = text
  for (const secret of extraSecrets) {
    if (typeof secret !== "string" || secret.length < 4) {
      continue
    }
    out = out.split(secret).join(REDACTED)
    const encoded = encodeURIComponent(secret)
    if (encoded !== secret && encoded.length >= 4) {
      out = out.split(encoded).join(REDACTED)
    }
  }
  return out
}

/**
 * Redact tokens, API keys, credentials, auth headers, and sensitive env assignments from text.
 */
export function redactText(
  input: string,
  extraSecrets: ReadonlyArray<string> = [],
): string {
  let text = replaceExplicitSecrets(input, extraSecrets)

  text = text.replace(TELEGRAM_BOT_PATH_RE, `/bot${REDACTED}`)
  text = text.replace(TELEGRAM_BOT_TOKEN_RE, REDACTED)
  text = text.replace(BEARER_RE, `$1 ${REDACTED}`)
  text = text.replace(BASIC_RE, `$1 ${REDACTED}`)
  text = text.replace(KNOWN_KEY_PREFIX_RE, REDACTED)
  text = text.replace(URL_USERINFO_RE, `$1${REDACTED}@`)
  text = text.replace(QUERY_SECRET_RE, `$1${REDACTED}`)
  text = text.replace(ENV_SECRET_ASSIGN_RE, `$1$2${REDACTED}`)
  text = text.replace(INLINE_AUTH_HEADER_RE, `$1: ${REDACTED}`)
  text = text.replace(CLI_SECRET_FLAG_RE, `$1 ${REDACTED}`)

  return text
}

/**
 * Redact credentials, /bot<token> segments, and sensitive query parameters from a URL.
 */
export function redactUrl(
  rawUrl: string,
  extraSecrets: ReadonlyArray<string> = [],
): string {
  const preRedacted = replaceExplicitSecrets(rawUrl, extraSecrets)
  try {
    const parsed = new URL(preRedacted)
    const hadCredentials = parsed.username.length > 0 || parsed.password.length > 0
    if (hadCredentials) {
      parsed.username = ""
      parsed.password = ""
    }
    parsed.pathname = parsed.pathname.replace(TELEGRAM_BOT_PATH_RE, `/bot${REDACTED}`)
    for (const [key] of parsed.searchParams.entries()) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase()) || SENSITIVE_KEY_NAME_RE.test(key)) {
        parsed.searchParams.set(key, REDACTED)
      }
    }
    let result = parsed.toString()
    if (hadCredentials) {
      result = result.replace(`${parsed.protocol}//`, `${parsed.protocol}//${REDACTED}@`)
    }
    return redactText(result, extraSecrets)
  } catch {
    return redactText(preRedacted, extraSecrets)
  }
}

export function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return SENSITIVE_HEADER_NAMES.has(lower) || SENSITIVE_KEY_NAME_RE.test(lower)
}

export function redactHeaders(
  headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
  extraSecrets: ReadonlyArray<string> = [],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) {
      continue
    }
    const key = rawKey.toLowerCase()
    if (isSensitiveHeader(key)) {
      out[key] = REDACTED
      continue
    }
    const joined = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue)
    out[key] = redactText(joined, extraSecrets)
  }
  return out
}

export function redactUnknown(
  value: unknown,
  extraSecrets: ReadonlyArray<string> = [],
  keyHint?: string,
  depth = 0,
): unknown {
  if (depth > 8) {
    return "[TRUNCATED]"
  }
  if (keyHint !== undefined && SENSITIVE_KEY_NAME_RE.test(keyHint)) {
    return REDACTED
  }
  if (typeof value === "string") {
    if (keyHint === "url" || /^https?:\/\//i.test(value)) {
      return redactUrl(value, extraSecrets)
    }
    return redactText(value, extraSecrets)
  }
  if (value === null || typeof value !== "object") {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, extraSecrets, undefined, depth + 1))
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactUnknown(v, extraSecrets, k, depth + 1)
  }
  return out
}

export function redactRecord(
  record: Readonly<Record<string, unknown>>,
  extraSecrets: ReadonlyArray<string> = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    out[key] = redactUnknown(value, extraSecrets, key, 0)
  }
  return out
}
