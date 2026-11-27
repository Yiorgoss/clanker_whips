#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_API_BASE = 'https://api.telegram.org';
export const DEFAULT_POLL_TIMEOUT_SECONDS = 30;
export const DEFAULT_REPLY_POLL_MS = 3000;
export const DEFAULT_MAX_CHUNK_LENGTH = 4000;
export const DEFAULT_BACKOFF_INITIAL_MS = 1000;
export const DEFAULT_BACKOFF_MAX_MS = 30000;
export const DEFAULT_ANNOUNCE_RETRIES = 3;
export const DEFAULT_ANNOUNCE_RETRY_DELAY_MS = 500;
export const DEFAULT_INBOX_TIMEOUT_MS = 15000;
export const DEFAULT_SEND_TIMEOUT_MS = 30000;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_ENV_FILE = path.join(REPO_ROOT, '.env');
const DEFAULT_STATE_FILE = path.join(REPO_ROOT, '.telegram-bridge-state.json');

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMERIC_CHAT_ID_RE = /^[1-9]\d*$/;
const UNSAFE_TOKEN_CHARS_RE = /[\s/?#]/;
const BOT_TOKEN_PATH_RE = /\/bot[^/\s?#]+/gi;

const USAGE_TEXT = `Usage: telegram-bridge.mjs [options]

Two-way Telegram bridge for firstmate.

Options:
  --send <text>            Send a one-shot Telegram message and exit (use '-' for stdin)
  --firstmate-home <dir>   Path to firstmate home (default: FIRSTMATE_HOME or $HOME/firstmate)
  --env-file <path>        Path to .env file (default: <repo>/.env)
  --state-file <path>      Path to state JSON file (default: <repo>/.telegram-bridge-state.json)
  --api-base <url>         Telegram API base URL (default: https://api.telegram.org)
  --poll-timeout <sec>     Telegram getUpdates long-poll timeout in seconds (default: 30)
  --reply-poll-ms <ms>     Interval between outbound reply polls in ms (default: 3000)
  -h, --help               Show this help message
`;

/**
 * Redact the bot token and any Telegram /bot<token> URL segment from a string.
 */
export function redactSecrets(input, token) {
  let text = String(input ?? '');
  if (typeof token === 'string' && token.length > 0) {
    text = text.split(token).join('[REDACTED]');
    const encoded = encodeURIComponent(token);
    if (encoded !== token) {
      text = text.split(encoded).join('[REDACTED]');
    }
  }
  return text.replace(BOT_TOKEN_PATH_RE, '/bot[REDACTED]');
}

/**
 * Safely parse a .env file without shell execution.
 */
export function parseEnvFileContent(content) {
  const result = {};
  const lines = String(content).split(/\r?\n/);

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const line = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).trimStart()
      : trimmed;

    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    if (!ENV_KEY_RE.test(key)) {
      continue;
    }

    const rawValue = line.slice(eqIndex + 1).trim();
    result[key] = parseEnvValue(rawValue);
  }

  return result;
}

function parseEnvValue(rawValue) {
  if (rawValue === '') {
    return '';
  }

  if (rawValue.startsWith('"')) {
    let out = '';
    for (let i = 1; i < rawValue.length; i += 1) {
      const ch = rawValue[i];
      if (ch === '\\' && i + 1 < rawValue.length) {
        const next = rawValue[i + 1];
        if (next === 'n') {
          out += '\n';
        } else if (next === 'r') {
          out += '\r';
        } else if (next === 't') {
          out += '\t';
        } else if (next === '"' || next === '\\') {
          out += next;
        } else {
          out += ch + next;
        }
        i += 1;
        continue;
      }
      if (ch === '"') {
        break;
      }
      out += ch;
    }
    return out;
  }

  if (rawValue.startsWith("'")) {
    const endQuote = rawValue.indexOf("'", 1);
    return endQuote === -1 ? rawValue.slice(1) : rawValue.slice(1, endQuote);
  }

  // Strip inline comments only when preceded by whitespace.
  const commentIndex = rawValue.search(/\s+#/);
  return (commentIndex === -1 ? rawValue : rawValue.slice(0, commentIndex)).trim();
}

export async function loadDotEnv(envFilePath) {
  try {
    const content = await fs.readFile(envFilePath, 'utf8');
    return parseEnvFileContent(content);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {};
    }
    throw err;
  }
}

export function parseCliArgs(argv) {
  const parsed = {
    help: false,
    sendText: undefined,
    firstmateHome: undefined,
    envFile: undefined,
    stateFile: undefined,
    apiBase: undefined,
    pollTimeoutSeconds: undefined,
    replyPollMs: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
      continue;
    }

    const eqIdx = arg.indexOf('=');
    const flag = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
    const readValue = () => {
      if (eqIdx !== -1) {
        return arg.slice(eqIdx + 1);
      }
      if (i + 1 >= argv.length) {
        throw new Error(`Missing value for option: ${flag}`);
      }
      i += 1;
      return argv[i];
    };

    switch (flag) {
      case '--send':
        parsed.sendText = readValue();
        break;
      case '--firstmate-home':
        parsed.firstmateHome = readValue();
        break;
      case '--env-file':
        parsed.envFile = readValue();
        break;
      case '--state-file':
        parsed.stateFile = readValue();
        break;
      case '--api-base':
        parsed.apiBase = readValue();
        break;
      case '--poll-timeout':
        parsed.pollTimeoutSeconds = parseNonNegativeInt(readValue(), '--poll-timeout');
        break;
      case '--reply-poll-ms':
        parsed.replyPollMs = parsePositiveInt(readValue(), '--reply-poll-ms');
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return parsed;
}

function parseNonNegativeInt(raw, label) {
  if (!/^\d+$/.test(String(raw))) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} is out of range`);
  }
  return value;
}

function parsePositiveInt(raw, label) {
  const value = parseNonNegativeInt(raw, label);
  if (value <= 0) {
    throw new Error(`${label} must be greater than zero`);
  }
  return value;
}

export async function resolveConfig({
  argv = [],
  env = process.env,
  defaultEnvFile = DEFAULT_ENV_FILE,
  defaultStateFile = DEFAULT_STATE_FILE,
  homedir = os.homedir(),
} = {}) {
  const cli = parseCliArgs(argv);
  if (cli.help) {
    return { help: true };
  }

  const envFilePath = cli.envFile ? path.resolve(cli.envFile) : defaultEnvFile;
  const dotEnv = await loadDotEnv(envFilePath);

  const readSetting = (key) => {
    if (env[key] !== undefined && env[key] !== '') {
      return env[key];
    }
    if (dotEnv[key] !== undefined && dotEnv[key] !== '') {
      return dotEnv[key];
    }
    return '';
  };

  const token = readSetting('CLANKER_UPDATES_TOKEN').trim();
  const chatId = readSetting('CLANKER_UPDATES_CHAT_ID').trim();
  const firstmateHomeRaw = cli.firstmateHome || readSetting('FIRSTMATE_HOME') || path.join(homedir, 'firstmate');
  const apiBase = (cli.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
  const stateFilePath = cli.stateFile ? path.resolve(cli.stateFile) : defaultStateFile;

  validateConfig({ token, chatId, apiBase });

  return {
    help: false,
    token,
    chatId,
    firstmateHome: path.resolve(firstmateHomeRaw),
    envFilePath,
    stateFilePath,
    apiBase,
    sendText: cli.sendText,
    pollTimeoutSeconds: cli.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS,
    replyPollMs: cli.replyPollMs ?? DEFAULT_REPLY_POLL_MS,
  };
}

export function validateConfig({ token, chatId, apiBase }) {
  if (typeof token !== 'string' || token.length === 0 || UNSAFE_TOKEN_CHARS_RE.test(token)) {
    throw new Error('CLANKER_UPDATES_TOKEN is missing or invalid');
  }
  if (typeof chatId !== 'string' || !NUMERIC_CHAT_ID_RE.test(chatId)) {
    throw new Error('CLANKER_UPDATES_CHAT_ID must be a positive numeric private chat ID');
  }
  if (typeof apiBase !== 'string' || (!apiBase.startsWith('https://') && !apiBase.startsWith('http://'))) {
    throw new Error('Telegram API base URL must start with http:// or https://');
  }
}

/**
 * Split long text into chunks <= maxLength at newline or space boundaries.
 */
export function chunkMessage(text, maxLength = DEFAULT_MAX_CHUNK_LENGTH) {
  if (typeof text !== 'string') {
    throw new Error('Message text must be a string');
  }
  if (!Number.isInteger(maxLength) || maxLength <= 0) {
    throw new Error('maxLength must be a positive integer');
  }
  if (text.length === 0) {
    return [];
  }
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks = [];
  let remaining = text;
  const minPreferredSplit = Math.floor(maxLength * 0.5);

  while (remaining.length > maxLength) {
    const nlIndex = remaining.lastIndexOf('\n', maxLength);
    const spIndex = remaining.lastIndexOf(' ', maxLength);

    let splitIndex = -1;
    let consumeSeparator = false;

    if (nlIndex >= minPreferredSplit && hasNonWhitespace(remaining, nlIndex)) {
      splitIndex = nlIndex;
      consumeSeparator = true;
    } else if (spIndex >= minPreferredSplit && hasNonWhitespace(remaining, spIndex)) {
      splitIndex = spIndex;
      consumeSeparator = true;
    } else if (nlIndex > 0 && hasNonWhitespace(remaining, nlIndex)) {
      splitIndex = nlIndex;
      consumeSeparator = true;
    } else if (spIndex > 0 && hasNonWhitespace(remaining, spIndex)) {
      splitIndex = spIndex;
      consumeSeparator = true;
    } else {
      splitIndex = maxLength;
      consumeSeparator = false;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(consumeSeparator ? splitIndex + 1 : splitIndex);
  }

  if (remaining.length > 0 && remaining.trim().length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function hasNonWhitespace(str, endIndex) {
  return str.slice(0, endIndex).trim().length > 0;
}

/**
 * Strict allowlist: accept only private chats whose chat.id matches allowedChatId.
 */
export function isAllowedMessageUpdate(update, allowedChatId) {
  if (!update || typeof update !== 'object') {
    return false;
  }
  const msg = update.message;
  if (!msg || typeof msg !== 'object') {
    return false;
  }
  const chat = msg.chat;
  if (!chat || typeof chat !== 'object') {
    return false;
  }
  if (chat.type !== 'private') {
    return false;
  }
  if (chat.id === undefined || chat.id === null) {
    return false;
  }
  return String(chat.id) === String(allowedChatId);
}

export async function loadState(stateFilePath) {
  try {
    const raw = await fs.readFile(stateFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('State file root must be a JSON object');
    }
    const offset = parsed.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error('State file offset must be a non-negative integer');
    }
    const deliveredReplyIds = parsed.deliveredReplyIds ?? [];
    if (
      !Array.isArray(deliveredReplyIds) ||
      !deliveredReplyIds.every((id) => typeof id === 'string' && id.length > 0)
    ) {
      throw new Error('State file deliveredReplyIds must be an array of non-empty strings');
    }
    return {
      version: 1,
      offset,
      deliveredReplyIds: Array.from(new Set(deliveredReplyIds)),
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {
        version: 1,
        offset: 0,
        deliveredReplyIds: [],
      };
    }
    throw err;
  }
}

export async function saveStateAtomic(stateFilePath, state) {
  const dir = path.dirname(stateFilePath);
  await fs.mkdir(dir, { recursive: true });
  const payload = JSON.stringify(
    {
      version: 1,
      offset: state.offset,
      deliveredReplyIds: state.deliveredReplyIds,
    },
    null,
    2,
  ) + '\n';

  const uniqueSuffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 10)}`;
  const tmpPath = `${stateFilePath}.tmp.${uniqueSuffix}`;
  try {
    await fs.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(tmpPath, 0o600);
    await fs.rename(tmpPath, stateFilePath);
    await fs.chmod(stateFilePath, 0o600);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

export class TelegramApiError extends Error {
  constructor(message, { statusCode = null, retryAfterSeconds = null } = {}) {
    super(message);
    this.name = 'TelegramApiError';
    this.statusCode = statusCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class TelegramClient {
  constructor({ token, apiBase = DEFAULT_API_BASE, fetchImpl = globalThis.fetch }) {
    this.token = token;
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  async call(method, payload, { signal, timeoutMs = DEFAULT_SEND_TIMEOUT_MS } = {}) {
    const url = `${this.apiBase}/bot${this.token}/${method}`;
    const combinedSignal = createTimeoutSignal(timeoutMs, signal);

    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: combinedSignal.signal,
      });
    } catch (err) {
      combinedSignal.cleanup();
      if (signal && signal.aborted) {
        const abortErr = new Error('Request aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      const detail = err?.cause?.message || err?.message || String(err);
      throw new TelegramApiError(
        redactSecrets(`Telegram ${method} network error: ${detail}`, this.token),
      );
    }
    combinedSignal.cleanup();

    const rawBody = await response.text().catch(() => '');
    let data = null;
    try {
      data = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      data = null;
    }

    if (!response.ok || !data || data.ok !== true) {
      const description = data?.description || rawBody.slice(0, 200) || response.statusText || 'unknown error';
      const retryAfter = Number.isInteger(data?.parameters?.retry_after)
        ? data.parameters.retry_after
        : null;
      throw new TelegramApiError(
        redactSecrets(
          `Telegram ${method} failed (HTTP ${response.status}): ${description}`,
          this.token,
        ),
        { statusCode: response.status, retryAfterSeconds: retryAfter },
      );
    }

    return data.result;
  }

  async getUpdates({ offset = 0, timeoutSeconds = DEFAULT_POLL_TIMEOUT_SECONDS, signal } = {}) {
    const payload = {
      timeout: timeoutSeconds,
      allowed_updates: ['message'],
    };
    if (offset > 0) {
      payload.offset = offset;
    }
    const timeoutMs = (timeoutSeconds + 15) * 1000;
    const result = await this.call('getUpdates', payload, { signal, timeoutMs });
    if (!Array.isArray(result)) {
      throw new TelegramApiError('Telegram getUpdates returned non-array result');
    }
    return result;
  }

  async sendMessage(chatId, text, { signal, timeoutMs = DEFAULT_SEND_TIMEOUT_MS } = {}) {
    return this.call(
      'sendMessage',
      { chat_id: chatId, text },
      { signal, timeoutMs },
    );
  }

  async sendChunkedMessage(chatId, text, { maxLength = DEFAULT_MAX_CHUNK_LENGTH, signal } = {}) {
    const chunks = chunkMessage(text, maxLength);
    for (const chunk of chunks) {
      await this.sendMessage(chatId, chunk, { signal });
    }
    return chunks.length;
  }
}

function createTimeoutSignal(timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();

  const onExternalAbort = () => {
    controller.abort(externalSignal.reason);
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timer);
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}

/**
 * Execute fm-inbox.sh without a shell.
 * When stdinText is provided, writes it to stdin and closes stdin so literal '-' bodies never hang.
 */
export function runFmInbox(
  fmInboxPath,
  args,
  { firstmateHome, timeoutMs = DEFAULT_INBOX_TIMEOUT_MS, stdinText = null, env = process.env } = {},
) {
  const childEnv = { ...env };
  if (firstmateHome) {
    childEnv.FM_HOME = firstmateHome;
  }

  if (stdinText !== null) {
    return new Promise((resolve) => {
      const child = spawn(fmInboxPath, args, {
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill('SIGTERM');
          resolve({ code: -1, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms`.trim(), error: null });
        }
      }, timeoutMs);
      timer.unref?.();

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ code: -1, stdout, stderr: error.message, error });
        }
      });
      child.on('close', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ code: code ?? -1, stdout, stderr, error: null });
        }
      });

      child.stdin.on('error', () => {});
      child.stdin.end(stdinText);
    });
  }

  return new Promise((resolve) => {
    const child = execFile(
      fmInboxPath,
      args,
      {
        env: childEnv,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout: String(stdout), stderr: String(stderr), error: null });
          return;
        }
        const exitCode = typeof error.code === 'number' ? error.code : -1;
        resolve({
          code: exitCode,
          stdout: String(stdout ?? ''),
          stderr: String(stderr || error.message || ''),
          error,
        });
      },
    );
    child.stdin?.end();
  });
}

function tryParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sleepAbortable(ms, signal) {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class TelegramBridge {
  constructor(config, options = {}) {
    this.config = config;
    this.fmInboxPath = path.join(config.firstmateHome, 'bin', 'fm-inbox.sh');
    this.telegram =
      options.telegramClient ||
      new TelegramClient({
        token: config.token,
        apiBase: config.apiBase,
        fetchImpl: options.fetchImpl || globalThis.fetch,
      });
    this.runInbox = options.runInbox || runFmInbox;
    this.maxChunkLength = options.maxChunkLength ?? DEFAULT_MAX_CHUNK_LENGTH;
    this.backoffInitialMs = options.backoffInitialMs ?? DEFAULT_BACKOFF_INITIAL_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.announceRetries = options.announceRetries ?? DEFAULT_ANNOUNCE_RETRIES;
    this.announceRetryDelayMs = options.announceRetryDelayMs ?? DEFAULT_ANNOUNCE_RETRY_DELAY_MS;
    this.logStdout = options.logStdout || ((line) => process.stdout.write(`${line}\n`));
    this.logStderr = options.logStderr || ((line) => process.stderr.write(`${line}\n`));

    this.state = { version: 1, offset: 0, deliveredReplyIds: [] };
    this.deliveredReplySet = new Set();
    this.stateSaveChain = Promise.resolve();
    this.abortController = new AbortController();
  }

  logInfo(message) {
    this.logStdout(redactSecrets(`[telegram-bridge] ${message}`, this.config.token));
  }

  logError(message) {
    this.logStderr(redactSecrets(`[telegram-bridge] ERROR: ${message}`, this.config.token));
  }

  async init() {
    this.state = await loadState(this.config.stateFilePath);
    this.deliveredReplySet = new Set(this.state.deliveredReplyIds);
  }

  persistState() {
    const snapshot = {
      version: 1,
      offset: this.state.offset,
      deliveredReplyIds: [...this.state.deliveredReplyIds],
    };
    const nextSave = this.stateSaveChain
      .catch(() => {})
      .then(() => saveStateAtomic(this.config.stateFilePath, snapshot));
    this.stateSaveChain = nextSave;
    return nextSave;
  }

  stop() {
    if (!this.abortController.signal.aborted) {
      this.abortController.abort();
    }
  }

  async handleUpdate(update) {
    if (!update || typeof update !== 'object' || !Number.isInteger(update.update_id)) {
      return;
    }

    const nextOffset = Math.max(this.state.offset, update.update_id + 1);

    if (isAllowedMessageUpdate(update, this.config.chatId)) {
      const text = update.message.text;
      if (typeof text === 'string' && text.trim().length > 0) {
        await this.submitInboundText(update.update_id, text);
      }
    }

    if (nextOffset !== this.state.offset) {
      this.state.offset = nextOffset;
      await this.persistState();
    }
  }

  async submitInboundText(updateId, text) {
    const requestId = `tg-${updateId}`;
    const args = ['note', '--request-id', requestId, '--json', '--', text];
    const stdinText = text === '-' ? '-' : null;

    const result = await this.runInbox(this.fmInboxPath, args, {
      firstmateHome: this.config.firstmateHome,
      stdinText,
    });

    if (result.code === 0) {
      const parsed = tryParseJson(result.stdout);
      const outcome = parsed?.outcome || 'ok';
      const noteId = parsed?.id || 'unknown';
      this.logInfo(`inbound ${requestId} -> ${noteId} (${outcome})`);
      return;
    }

    if (result.code === 3) {
      const parsed = tryParseJson(result.stdout);
      const noteId = typeof parsed?.id === 'string' && parsed.id.length > 0 ? parsed.id : null;
      const repaired = await this.retryAnnounce(requestId, noteId, args, stdinText);
      if (repaired.ok) {
        this.logInfo(`inbound ${requestId} -> ${noteId || 'unknown'} (announce repaired)`);
        return;
      }
      this.logError(
        `inbound ${requestId} saved (${noteId || 'unknown id'}) but announce failed (exit ${repaired.code}): ${repaired.stderr.trim()}`,
      );
      await this.safeNotifyChat(
        `Note saved (${noteId || requestId}), but waking firstmate failed (exit ${repaired.code}).`,
      );
      return;
    }

    this.logError(
      `inbound ${requestId} failed (exit ${result.code}): ${result.stderr.trim() || 'unknown error'}`,
    );
    await this.safeNotifyChat(`Failed to deliver note to firstmate (exit ${result.code}).`);
  }

  async retryAnnounce(requestId, noteId, noteArgs, stdinText) {
    let lastCode = 3;
    let lastStderr = '';

    for (let attempt = 1; attempt <= this.announceRetries; attempt += 1) {
      if (this.abortController.signal.aborted) {
        break;
      }
      await sleepAbortable(this.announceRetryDelayMs * attempt, this.abortController.signal);
      if (this.abortController.signal.aborted) {
        break;
      }

      const retryArgs = noteId ? ['announce', '--json', noteId] : noteArgs;
      const retryStdin = noteId ? null : stdinText;
      const retryResult = await this.runInbox(this.fmInboxPath, retryArgs, {
        firstmateHome: this.config.firstmateHome,
        stdinText: retryStdin,
      });

      if (retryResult.code === 0) {
        return { ok: true, code: 0, stderr: '' };
      }

      lastCode = retryResult.code;
      lastStderr = retryResult.stderr || '';
      this.logError(
        `announce retry ${attempt}/${this.announceRetries} for ${noteId || requestId} failed (exit ${lastCode})`,
      );
    }

    return { ok: false, code: lastCode, stderr: lastStderr };
  }

  async safeNotifyChat(message) {
    try {
      await this.telegram.sendChunkedMessage(this.config.chatId, message, {
        maxLength: this.maxChunkLength,
        signal: this.abortController.signal,
      });
    } catch (err) {
      this.logError(`failed to notify chat: ${err?.message || String(err)}`);
    }
  }

  async pollInboundOnce() {
    const updates = await this.telegram.getUpdates({
      offset: this.state.offset,
      timeoutSeconds: this.config.pollTimeoutSeconds,
      signal: this.abortController.signal,
    });
    for (const update of updates) {
      if (this.abortController.signal.aborted) {
        break;
      }
      await this.handleUpdate(update);
    }
    return updates.length;
  }

  async pollOutboundOnce() {
    const result = await this.runInbox(this.fmInboxPath, ['receipts', '--all-replies'], {
      firstmateHome: this.config.firstmateHome,
    });
    if (result.code !== 0) {
      throw new Error(
        `fm-inbox.sh receipts failed (exit ${result.code}): ${result.stderr.trim() || 'unknown error'}`,
      );
    }

    const parsed = tryParseJson(result.stdout);
    if (!parsed || !Array.isArray(parsed.replies)) {
      throw new Error('fm-inbox.sh receipts returned invalid JSON');
    }

    let deliveredCount = 0;
    for (const reply of parsed.replies) {
      if (this.abortController.signal.aborted) {
        break;
      }
      if (!reply || typeof reply.id !== 'string' || reply.id.length === 0) {
        continue;
      }
      if (this.deliveredReplySet.has(reply.id)) {
        continue;
      }
      if (typeof reply.body !== 'string' || reply.body.trim().length === 0) {
        continue;
      }

      await this.telegram.sendChunkedMessage(this.config.chatId, reply.body, {
        maxLength: this.maxChunkLength,
        signal: this.abortController.signal,
      });

      this.deliveredReplySet.add(reply.id);
      this.state.deliveredReplyIds.push(reply.id);
      await this.persistState();
      deliveredCount += 1;
      this.logInfo(`outbound reply ${reply.id} delivered`);
    }

    return deliveredCount;
  }

  async runInboundLoop() {
    let backoffMs = this.backoffInitialMs;
    while (!this.abortController.signal.aborted) {
      try {
        await this.pollInboundOnce();
        backoffMs = this.backoffInitialMs;
      } catch (err) {
        if (this.abortController.signal.aborted || err?.name === 'AbortError') {
          break;
        }
        const delayMs = computeBackoffDelayMs(err, backoffMs, this.backoffMaxMs);
        this.logError(`inbound poll failed: ${err?.message || String(err)} (retrying in ${delayMs}ms)`);
        await sleepAbortable(delayMs, this.abortController.signal);
        backoffMs = Math.min(backoffMs * 2, this.backoffMaxMs);
      }
    }
  }

  async runOutboundLoop() {
    let backoffMs = this.backoffInitialMs;
    while (!this.abortController.signal.aborted) {
      try {
        await this.pollOutboundOnce();
        backoffMs = this.backoffInitialMs;
        await sleepAbortable(this.config.replyPollMs, this.abortController.signal);
      } catch (err) {
        if (this.abortController.signal.aborted || err?.name === 'AbortError') {
          break;
        }
        const delayMs = computeBackoffDelayMs(err, backoffMs, this.backoffMaxMs);
        this.logError(`outbound poll failed: ${err?.message || String(err)} (retrying in ${delayMs}ms)`);
        await sleepAbortable(delayMs, this.abortController.signal);
        backoffMs = Math.min(backoffMs * 2, this.backoffMaxMs);
      }
    }
  }

  async run() {
    await this.init();
    this.logInfo(
      `started (firstmateHome=${this.config.firstmateHome}, stateFile=${this.config.stateFilePath})`,
    );
    await Promise.all([this.runInboundLoop(), this.runOutboundLoop()]);
    await this.stateSaveChain;
    this.logInfo('stopped cleanly');
  }
}

function computeBackoffDelayMs(err, currentBackoffMs, maxBackoffMs) {
  if (err && Number.isInteger(err.retryAfterSeconds) && err.retryAfterSeconds > 0) {
    return Math.min(err.retryAfterSeconds * 1000, Math.max(maxBackoffMs, 120000));
  }
  return Math.min(currentBackoffMs, maxBackoffMs);
}

async function readStdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function runCli(argv = process.argv.slice(2)) {
  let tokenForRedaction = process.env.CLANKER_UPDATES_TOKEN || '';
  try {
    const config = await resolveConfig({ argv });
    if (config.help) {
      process.stdout.write(USAGE_TEXT);
      return 0;
    }
    tokenForRedaction = config.token;

    if (config.sendText !== undefined) {
      const text = config.sendText === '-' ? await readStdinText() : config.sendText;
      if (text.trim().length === 0) {
        throw new Error('Refusing to send an empty message');
      }
      const client = new TelegramClient({
        token: config.token,
        apiBase: config.apiBase,
      });
      await client.sendChunkedMessage(config.chatId, text);
      return 0;
    }

    const bridge = new TelegramBridge(config);
    const onSignal = (signalName) => {
      bridge.logInfo(`received ${signalName}, shutting down`);
      bridge.stop();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      await bridge.run();
    } finally {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
    return 0;
  } catch (err) {
    const message = redactSecrets(err?.message || String(err), tokenForRedaction);
    process.stderr.write(`[telegram-bridge] ERROR: ${message}\n`);
    return 1;
  }
}

const isDirectExecution =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  const exitCode = await runCli();
  process.exitCode = exitCode;
}
