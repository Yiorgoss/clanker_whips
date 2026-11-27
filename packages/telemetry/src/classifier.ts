import path from "node:path"

const URL_RE = /https?:\/\/[^\s"'`<>()[\]{}]+/gi
const TRAILING_PUNCTUATION_RE = /[.,;:!?)]+$/

const DOWNLOAD_BINARY_CONTENT_TYPES = [
  "application/octet-stream",
  "application/zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/x-bzip2",
  "application/x-xz",
  "application/x-7z-compressed",
  "application/pdf",
  "application/wasm",
  "application/java-archive",
  "application/x-executable",
  "application/x-msdownload",
  "application/vnd.debian.binary-package",
  "application/x-rpm",
  "application/x-apple-diskimage",
]

const DOWNLOAD_EXTENSIONS = [
  ".tar.gz",
  ".tar.bz2",
  ".tar.xz",
  ".tar.zst",
  ".tgz",
  ".tbz2",
  ".txz",
  ".zip",
  ".gz",
  ".bz2",
  ".xz",
  ".7z",
  ".deb",
  ".rpm",
  ".dmg",
  ".pkg",
  ".exe",
  ".msi",
  ".whl",
  ".jar",
  ".apk",
  ".pdf",
  ".iso",
  ".wasm",
  ".bin",
]

export interface DetectedCommandDownload {
  readonly via: string
  readonly url: string | null
  readonly domain: string | null
  readonly destinationPath: string | null
  readonly filename: string | null
}

export interface BashClassification {
  readonly urls: ReadonlyArray<string>
  readonly downloads: ReadonlyArray<DetectedCommandDownload>
}

export interface HttpDownloadDetection {
  readonly isDownload: boolean
  readonly filename: string | null
  readonly reason: string | null
}

export function extractUrlsFromText(text: string): ReadonlyArray<string> {
  const matches = text.match(URL_RE)
  if (matches === null) {
    return []
  }
  const unique = new Set<string>()
  for (const raw of matches) {
    const cleaned = raw.replace(TRAILING_PUNCTUATION_RE, "")
    if (cleaned.length > 0) {
      try {
        // Validate parseable URL
        const parsed = new URL(cleaned)
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          unique.add(cleaned)
        }
      } catch {
        // ignore unparseable URL fragments
      }
    }
  }
  return Array.from(unique)
}

export function extractDomainFromUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl)
    return parsed.hostname.length > 0 ? parsed.hostname.toLowerCase() : null
  } catch {
    return null
  }
}

export function extractFilenameFromUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl)
    const base = path.posix.basename(parsed.pathname)
    if (base.length === 0 || base === "/" || base === ".") {
      return null
    }
    return decodeURIComponent(base)
  } catch {
    return null
  }
}

export function parseContentDispositionFilename(header: string | undefined): string | null {
  if (typeof header !== "string" || header.trim().length === 0) {
    return null
  }
  // RFC 5987 filename*=UTF-8''...
  const starMatch = /filename\*\s*=\s*(?:[A-Za-z0-9_-]+''|)([^;\r\n]+)/i.exec(header)
  if (starMatch?.[1]) {
    const raw = starMatch[1].trim().replace(/^["']|["']$/g, "")
    try {
      return path.posix.basename(decodeURIComponent(raw))
    } catch {
      return path.posix.basename(raw)
    }
  }
  const plainMatch = /filename\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\r\n]+))/i.exec(header)
  const raw = plainMatch?.[1] ?? plainMatch?.[2] ?? plainMatch?.[3]
  if (!raw) {
    return null
  }
  const cleaned = raw.trim()
  return cleaned.length > 0 ? path.posix.basename(cleaned) : null
}

export function detectHttpDownload(input: {
  readonly method: string
  readonly url: string
  readonly contentType?: string | undefined
  readonly contentDisposition?: string | undefined
  readonly contentLength?: number | undefined
}): HttpDownloadDetection {
  const method = input.method.toUpperCase()
  if (method === "HEAD" || method === "OPTIONS") {
    return { isDownload: false, filename: null, reason: null }
  }

  const disposition = input.contentDisposition?.trim() ?? ""
  const dispositionFilename = parseContentDispositionFilename(disposition)
  if (/\battachment\b/i.test(disposition) || dispositionFilename !== null) {
    return {
      isDownload: true,
      filename: dispositionFilename ?? extractFilenameFromUrl(input.url),
      reason: "content-disposition",
    }
  }

  const normalizedType = (input.contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
  if (
    normalizedType.length > 0 &&
    DOWNLOAD_BINARY_CONTENT_TYPES.some((t) => normalizedType === t || normalizedType.startsWith("application/vnd."))
  ) {
    return {
      isDownload: true,
      filename: extractFilenameFromUrl(input.url),
      reason: `content-type:${normalizedType}`,
    }
  }

  const urlFilename = extractFilenameFromUrl(input.url)
  if (urlFilename !== null) {
    const lowerName = urlFilename.toLowerCase()
    if (DOWNLOAD_EXTENSIONS.some((ext) => lowerName.endsWith(ext))) {
      return {
        isDownload: true,
        filename: urlFilename,
        reason: "url-extension",
      }
    }
  }

  return { isDownload: false, filename: null, reason: null }
}

/**
 * Split a shell command string into simple pipeline/list segments for classification.
 */
function splitShellSegments(command: string): ReadonlyArray<string> {
  return command
    .split(/(?:&&|\|\||\||;|\n)/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
}

export function tokenizeCommand(segment: string): ReadonlyArray<string> {
  const tokens: Array<string> = []
  let current = ""
  let quote: '"' | "'" | null = null

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]
    if (ch === undefined) {
      continue
    }
    if (quote !== null) {
      if (ch === "\\" && quote === '"' && i + 1 < segment.length) {
        current += segment[i + 1] ?? ""
        i += 1
        continue
      }
      if (ch === quote) {
        quote = null
        continue
      }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === "\\" && i + 1 < segment.length) {
      current += segment[i + 1] ?? ""
      i += 1
      continue
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += ch
  }
  if (current.length > 0) {
    tokens.push(current)
  }
  return tokens
}

function stripLeadingEnvAssignments(tokens: ReadonlyArray<string>): ReadonlyArray<string> {
  let idx = 0
  while (idx < tokens.length) {
    const tok = tokens[idx]
    if (tok !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      idx += 1
      continue
    }
    if (tok === "env" || tok === "sudo" || tok === "timeout") {
      idx += 1
      if (tok === "timeout" && idx < tokens.length && /^\d+[smhd]?$/.test(tokens[idx] ?? "")) {
        idx += 1
      }
      continue
    }
    break
  }
  return tokens.slice(idx)
}

function extractRedirectionTarget(
  tokens: ReadonlyArray<string>,
  index: number,
): { readonly path: string; readonly advance: number } | null {
  const tok = tokens[index]
  if (tok === undefined) {
    return null
  }
  if (tok === ">" || tok === ">>" || tok === "1>" || tok === "1>>") {
    const next = tokens[index + 1]
    if (next && next !== "/dev/null" && !next.startsWith("&")) {
      return { path: next, advance: 1 }
    }
    return null
  }
  const attached = /^(?:1)?>>?(.+)$/.exec(tok)
  const target = attached?.[1]
  if (target && target !== "/dev/null" && !target.startsWith("&")) {
    return { path: target, advance: 0 }
  }
  return null
}

function detectCurlDownload(
  tokens: ReadonlyArray<string>,
  segmentUrls: ReadonlyArray<string>,
): DetectedCommandDownload | null {
  const url = segmentUrls[0] ?? null
  if (url === null) {
    return null
  }

  let outputPath: string | null = null
  let remoteName = false

  for (let i = 1; i < tokens.length; i += 1) {
    const tok = tokens[i]
    if (tok === undefined) {
      continue
    }
    if (tok === "-o" || tok === "--output") {
      const next = tokens[i + 1]
      if (next && next !== "-") {
        outputPath = next
      }
      i += 1
      continue
    }
    if (tok.startsWith("--output=")) {
      const val = tok.slice("--output=".length)
      if (val && val !== "-") {
        outputPath = val
      }
      continue
    }
    if (tok.startsWith("-o") && tok.length > 2) {
      const val = tok.slice(2)
      if (val !== "-") {
        outputPath = val
      }
      continue
    }
    if (tok === "-O" || tok === "--remote-name" || tok === "--remote-name-all") {
      remoteName = true
      continue
    }
    if (/^-[A-Za-z]*O[A-Za-z]*$/.test(tok)) {
      remoteName = true
      continue
    }
    const redir = extractRedirectionTarget(tokens, i)
    if (redir !== null) {
      outputPath = redir.path
      i += redir.advance
    }
  }

  if (outputPath === null && !remoteName) {
    return null
  }

  const filename = outputPath !== null
    ? path.basename(outputPath)
    : extractFilenameFromUrl(url)

  return {
    via: "curl",
    url,
    domain: extractDomainFromUrl(url),
    destinationPath: outputPath,
    filename,
  }
}

function detectWgetDownload(
  tokens: ReadonlyArray<string>,
  segmentUrls: ReadonlyArray<string>,
): DetectedCommandDownload | null {
  const url = segmentUrls[0] ?? null
  if (url === null) {
    return null
  }

  let outputPath: string | null = null
  let stdoutOnly = false

  for (let i = 1; i < tokens.length; i += 1) {
    const tok = tokens[i]
    if (tok === undefined) {
      continue
    }
    if (tok === "-O" || tok === "--output-document") {
      const next = tokens[i + 1]
      if (next === "-") {
        stdoutOnly = true
      } else if (next) {
        outputPath = next
      }
      i += 1
      continue
    }
    if (tok.startsWith("--output-document=")) {
      const val = tok.slice("--output-document=".length)
      if (val === "-") {
        stdoutOnly = true
      } else if (val) {
        outputPath = val
      }
      continue
    }
    const attachedO = /^-[A-Za-z]*O(.+)$/.exec(tok)
    if (attachedO?.[1] !== undefined) {
      const val = attachedO[1]
      if (val === "-") {
        stdoutOnly = true
      } else {
        outputPath = val
      }
      continue
    }
    const redir = extractRedirectionTarget(tokens, i)
    if (redir !== null) {
      outputPath = redir.path
      i += redir.advance
    }
  }

  if (stdoutOnly && outputPath === null) {
    return null
  }

  const filename = outputPath !== null
    ? path.basename(outputPath)
    : extractFilenameFromUrl(url)

  return {
    via: "wget",
    url,
    domain: extractDomainFromUrl(url),
    destinationPath: outputPath,
    filename,
  }
}

function detectGitClone(
  tokens: ReadonlyArray<string>,
  segmentUrls: ReadonlyArray<string>,
): DetectedCommandDownload | null {
  const cloneIdx = tokens.indexOf("clone")
  if (cloneIdx === -1) {
    return null
  }
  const positional: Array<string> = []
  for (let i = cloneIdx + 1; i < tokens.length; i += 1) {
    const tok = tokens[i]
    if (tok === undefined) {
      continue
    }
    if (tok.startsWith("-")) {
      if (["-b", "--branch", "--depth", "-o", "--origin", "--reference"].includes(tok)) {
        i += 1
      }
      continue
    }
    positional.push(tok)
  }

  const repoRef = positional[0] ?? segmentUrls[0] ?? null
  if (repoRef === null) {
    return null
  }
  const destDir = positional[1] ?? null
  const url = segmentUrls[0] ?? (/^https?:\/\//i.test(repoRef) ? repoRef : null)
  let domain = url ? extractDomainFromUrl(url) : null
  if (domain === null) {
    const sshMatch = /^[^@\s]+@([^:\s]+):/.exec(repoRef)
    if (sshMatch?.[1]) {
      domain = sshMatch[1].toLowerCase()
    }
  }
  const filename = destDir
    ? path.basename(destDir)
    : path.basename(repoRef.replace(/\.git$/, ""))

  return {
    via: "git_clone",
    url,
    domain,
    destinationPath: destDir,
    filename,
  }
}

function detectPackageManagerDownload(
  bin: string,
  tokens: ReadonlyArray<string>,
): DetectedCommandDownload | null {
  const sub = tokens[1]?.toLowerCase()
  const rest = tokens.slice(2).filter((t) => !t.startsWith("-"))

  if (bin === "pnpm" && (sub === "add" || sub === "install" || sub === "i" || sub === "dlx")) {
    return {
      via: `pnpm_${sub}`,
      url: null,
      domain: "registry.npmjs.org",
      destinationPath: null,
      filename: rest.length > 0 ? rest.join(",") : null,
    }
  }
  if (bin === "npm" && (sub === "install" || sub === "i" || sub === "ci" || sub === "add")) {
    return {
      via: `npm_${sub}`,
      url: null,
      domain: "registry.npmjs.org",
      destinationPath: null,
      filename: rest.length > 0 ? rest.join(",") : null,
    }
  }
  if (bin === "npx") {
    const pkg = tokens.slice(1).find((t) => !t.startsWith("-")) ?? null
    return {
      via: "npx",
      url: null,
      domain: "registry.npmjs.org",
      destinationPath: null,
      filename: pkg,
    }
  }
  if ((bin === "pip" || bin === "pip3") && sub === "install") {
    return {
      via: "pip_install",
      url: null,
      domain: "pypi.org",
      destinationPath: null,
      filename: rest.length > 0 ? rest.join(",") : null,
    }
  }
  if (bin === "uv" && sub === "pip" && tokens[2]?.toLowerCase() === "install") {
    const pkgs = tokens.slice(3).filter((t) => !t.startsWith("-"))
    return {
      via: "uv_pip_install",
      url: null,
      domain: "pypi.org",
      destinationPath: null,
      filename: pkgs.length > 0 ? pkgs.join(",") : null,
    }
  }
  if (bin === "cargo" && sub === "install") {
    return {
      via: "cargo_install",
      url: null,
      domain: "crates.io",
      destinationPath: null,
      filename: rest.length > 0 ? rest.join(",") : null,
    }
  }
  if (bin === "gh" && sub === "release" && tokens[2]?.toLowerCase() === "download") {
    return {
      via: "gh_release_download",
      url: null,
      domain: "github.com",
      destinationPath: null,
      filename: tokens.slice(3).find((t) => !t.startsWith("-")) ?? null,
    }
  }
  if ((bin === "apt" || bin === "apt-get" || bin === "brew") && sub === "install") {
    return {
      via: `${bin}_install`,
      url: null,
      domain: null,
      destinationPath: null,
      filename: rest.length > 0 ? rest.join(",") : null,
    }
  }
  return null
}

/**
 * Inspect a bash command string to extract referenced HTTP(S) URLs and download actions.
 */
export function classifyBashCommand(command: string): BashClassification {
  const urls = extractUrlsFromText(command)
  const downloads: Array<DetectedCommandDownload> = []

  for (const segment of splitShellSegments(command)) {
    const rawTokens = tokenizeCommand(segment)
    const tokens = stripLeadingEnvAssignments(rawTokens)
    const first = tokens[0]
    if (first === undefined) {
      continue
    }
    const bin = path.basename(first).toLowerCase()
    const segmentUrls = extractUrlsFromText(segment)

    if (bin === "curl") {
      const detected = detectCurlDownload(tokens, segmentUrls)
      if (detected !== null) {
        downloads.push(detected)
      }
      continue
    }
    if (bin === "wget") {
      const detected = detectWgetDownload(tokens, segmentUrls)
      if (detected !== null) {
        downloads.push(detected)
      }
      continue
    }
    if (bin === "git") {
      const detected = detectGitClone(tokens, segmentUrls)
      if (detected !== null) {
        downloads.push(detected)
      }
      continue
    }
    const pkgDownload = detectPackageManagerDownload(bin, tokens)
    if (pkgDownload !== null) {
      downloads.push(pkgDownload)
    }
  }

  return { urls, downloads }
}

export function isBashToolName(toolName: string): boolean {
  const lower = toolName.toLowerCase()
  return lower === "bash" || lower === "run_command" || lower === "execute" || lower === "shell"
}

export function isWebOrBrowserToolName(toolName: string): boolean {
  const lower = toolName.toLowerCase()
  return (
    lower === "search_web" ||
    lower === "web_search" ||
    lower === "web_fetch" ||
    lower === "fetch" ||
    lower === "read_url_content" ||
    lower === "open_url" ||
    lower.includes("browser") ||
    lower.includes("chrome") ||
    lower.includes("navigate")
  )
}

export function isFileWriteToolName(toolName: string): boolean {
  const lower = toolName.toLowerCase()
  return lower === "write" || lower === "write_file"
}
