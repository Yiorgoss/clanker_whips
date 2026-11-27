import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  TelegramBridge,
  TelegramClient,
  chunkMessage,
  isAllowedMessageUpdate,
  loadState,
  parseEnvFileContent,
  redactSecrets,
  resolveConfig,
} from './telegram-bridge.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const BRIDGE_SCRIPT = path.join(SCRIPT_DIR, 'telegram-bridge.mjs');

const TEST_TOKEN = '999888777:TEST_SECRET_TOKEN_XYZ';
const ALLOWED_CHAT_ID = '555123456';

async function makeTempDir(t, prefix = 'tg-bridge-test-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function createStubFirstmateHome(t, { scriptBody }) {
  const homeDir = await makeTempDir(t, 'tg-bridge-fm-');
  const binDir = path.join(homeDir, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const inboxPath = path.join(binDir, 'fm-inbox.sh');
  await fs.writeFile(inboxPath, scriptBody, { mode: 0o755 });
  await fs.chmod(inboxPath, 0o755);
  return { homeDir, inboxPath };
}

async function startMockTelegramServer(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      body = rawBody;
    }
    const entry = { method: req.method, url: req.url, body };
    requests.push(entry);

    const reply = await handler(entry);
    const status = reply?.status ?? 200;
    const json = reply?.json ?? { ok: true, result: [] };
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  return { baseUrl, requests, server };
}

function runNodeScript(args, { env = {}, stdinText = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE_SCRIPT, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    if (stdinText !== null) {
      child.stdin.end(stdinText);
    } else {
      child.stdin.end();
    }
  });
}

test('.gitignore ignores .env, .env.local, and state files while keeping .env.example', async () => {
  const ignoredPaths = [
    '.env',
    '.env.local',
    '.env.production',
    '.telegram-bridge-state.json',
    'custom.state.json',
  ];

  for (const relPath of ignoredPaths) {
    const { stdout } = await execFileAsync('git', ['-C', REPO_ROOT, 'check-ignore', relPath]);
    assert.equal(stdout.trim(), relPath, `${relPath} must be gitignored`);
  }

  await assert.rejects(
    () => execFileAsync('git', ['-C', REPO_ROOT, 'check-ignore', '.env.example']),
    (err) => err.code === 1,
    '.env.example must NOT be gitignored',
  );
});

test('parseEnvFileContent and resolveConfig parse .env safely and prefer process.env', async (t) => {
  const tmpDir = await makeTempDir(t);
  const envFile = path.join(tmpDir, '.env');
  await fs.writeFile(
    envFile,
    [
      '# comment line',
      `CLANKER_UPDATES_TOKEN="${TEST_TOKEN}" # trailing comment`,
      `export CLANKER_UPDATES_CHAT_ID='${ALLOWED_CHAT_ID}'`,
      'FIRSTMATE_HOME=/tmp/from-dotenv',
      '',
    ].join('\n'),
    'utf8',
  );

  const parsed = parseEnvFileContent(await fs.readFile(envFile, 'utf8'));
  assert.equal(parsed.CLANKER_UPDATES_TOKEN, TEST_TOKEN);
  assert.equal(parsed.CLANKER_UPDATES_CHAT_ID, ALLOWED_CHAT_ID);
  assert.equal(parsed.FIRSTMATE_HOME, '/tmp/from-dotenv');

  const cfgFromFile = await resolveConfig({
    argv: ['--env-file', envFile],
    env: {},
    homedir: '/tmp/home',
  });
  assert.equal(cfgFromFile.token, TEST_TOKEN);
  assert.equal(cfgFromFile.chatId, ALLOWED_CHAT_ID);
  assert.equal(cfgFromFile.firstmateHome, '/tmp/from-dotenv');

  const cfgOverride = await resolveConfig({
    argv: ['--env-file', envFile, '--firstmate-home', '/tmp/from-flag'],
    env: { CLANKER_UPDATES_CHAT_ID: '777000111' },
    homedir: '/tmp/home',
  });
  assert.equal(cfgOverride.chatId, '777000111');
  assert.equal(cfgOverride.firstmateHome, '/tmp/from-flag');
});

test('resolveConfig refuses missing or invalid token and non-numeric chat ID', async (t) => {
  const tmpDir = await makeTempDir(t);
  const missingEnvFile = path.join(tmpDir, 'does-not-exist.env');

  await assert.rejects(
    () => resolveConfig({ argv: ['--env-file', missingEnvFile], env: {} }),
    /CLANKER_UPDATES_TOKEN/,
  );

  await assert.rejects(
    () =>
      resolveConfig({
        argv: ['--env-file', missingEnvFile],
        env: { CLANKER_UPDATES_TOKEN: TEST_TOKEN, CLANKER_UPDATES_CHAT_ID: 'not-a-number' },
      }),
    /CLANKER_UPDATES_CHAT_ID/,
  );

  await assert.rejects(
    () =>
      resolveConfig({
        argv: ['--env-file', missingEnvFile],
        env: { CLANKER_UPDATES_TOKEN: TEST_TOKEN, CLANKER_UPDATES_CHAT_ID: '-100123456' },
      }),
    /CLANKER_UPDATES_CHAT_ID/,
  );
});

test('strict chat_id allowlist drops foreign private chats, groups, supergroups, and channels', () => {
  assert.equal(
    isAllowedMessageUpdate(
      { update_id: 1, message: { chat: { id: Number(ALLOWED_CHAT_ID), type: 'private' }, text: 'ok' } },
      ALLOWED_CHAT_ID,
    ),
    true,
  );
  assert.equal(
    isAllowedMessageUpdate(
      { update_id: 2, message: { chat: { id: 111222333, type: 'private' }, text: 'stranger' } },
      ALLOWED_CHAT_ID,
    ),
    false,
  );
  assert.equal(
    isAllowedMessageUpdate(
      { update_id: 3, message: { chat: { id: Number(ALLOWED_CHAT_ID), type: 'group' }, text: 'group' } },
      ALLOWED_CHAT_ID,
    ),
    false,
  );
  assert.equal(
    isAllowedMessageUpdate(
      { update_id: 4, message: { chat: { id: -100999, type: 'supergroup' }, text: 'supergroup' } },
      ALLOWED_CHAT_ID,
    ),
    false,
  );
  assert.equal(
    isAllowedMessageUpdate(
      { update_id: 5, channel_post: { chat: { id: Number(ALLOWED_CHAT_ID), type: 'channel' }, text: 'ch' } },
      ALLOWED_CHAT_ID,
    ),
    false,
  );
});

test('inbound getUpdates submits allowed text via fm-inbox.sh, ignores foreign/group chats, and persists offset with 0600 mode', async (t) => {
  const tmpDir = await makeTempDir(t);
  const stateFile = path.join(tmpDir, '.telegram-bridge-state.json');
  const logFile = path.join(tmpDir, 'inbox-invocations.jsonl');

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
  });

  const updates = [
    { update_id: 100, message: { chat: { id: 999000, type: 'private' }, text: 'foreign user' } },
    { update_id: 101, message: { chat: { id: Number(ALLOWED_CHAT_ID), type: 'group' }, text: 'group msg' } },
    {
      update_id: 102,
      message: {
        chat: { id: Number(ALLOWED_CHAT_ID), type: 'private' },
        text: 'check status; $(rm -rf /)',
      },
    },
  ];

  let pollCount = 0;
  const { baseUrl, requests } = await startMockTelegramServer(t, async (req) => {
    if (req.url === `/bot${TEST_TOKEN}/getUpdates`) {
      pollCount += 1;
      return { json: { ok: true, result: pollCount === 1 ? updates : [] } };
    }
    return { status: 404, json: { ok: false, description: 'unexpected call' } };
  });

  const bridge = new TelegramBridge(
    {
      token: TEST_TOKEN,
      chatId: ALLOWED_CHAT_ID,
      firstmateHome: homeDir,
      stateFilePath: stateFile,
      apiBase: baseUrl,
      pollTimeoutSeconds: 0,
      replyPollMs: 100,
    },
    { logStdout: () => {}, logStderr: () => {} },
  );

  await bridge.init();
  const count = await bridge.pollInboundOnce();
  assert.equal(count, 3);

  const calls = (await fs.readFile(logFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  assert.equal(calls.length, 1, 'only the allowed private message should be submitted');
  assert.deepEqual(calls[0], [
    'note',
    '--request-id',
    'tg-102',
    '--json',
    '--',
    'check status; $(rm -rf /)',
  ]);

  const savedState = await loadState(stateFile);
  assert.equal(savedState.offset, 103);

  const stat = await fs.stat(stateFile);
  assert.equal(stat.mode & 0o777, 0o600, 'state file must have mode 0600');

  // Second poll must pass persisted offset=103
  await bridge.pollInboundOnce();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.offset, 103);
});

test('inbound handles fm-inbox.sh exit 3 by retrying announce and handles non-zero exit without crashing', async (t) => {
  const tmpDir = await makeTempDir(t);
  const stateFile = path.join(tmpDir, '.telegram-bridge-state.json');
  const logFile = path.join(tmpDir, 'calls.jsonl');

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
  });

  const sentMessages = [];
  const { baseUrl } = await startMockTelegramServer(t, async (req) => {
    if (req.url === `/bot${TEST_TOKEN}/getUpdates`) {
      return {
        json: {
          ok: true,
          result: [
            { update_id: 200, message: { chat: { id: Number(ALLOWED_CHAT_ID), type: 'private' }, text: 'retry wake' } },
            { update_id: 201, message: { chat: { id: Number(ALLOWED_CHAT_ID), type: 'private' }, text: 'will fail' } },
          ],
        },
      };
    }
    if (req.url === `/bot${TEST_TOKEN}/sendMessage`) {
      sentMessages.push(req.body);
      return { json: { ok: true, result: { message_id: sentMessages.length } } };
    }
    return { status: 404, json: { ok: false, description: 'not found' } };
  });

  const stderrLines = [];
  const bridge = new TelegramBridge(
    {
      token: TEST_TOKEN,
      chatId: ALLOWED_CHAT_ID,
      firstmateHome: homeDir,
      stateFilePath: stateFile,
      apiBase: baseUrl,
      pollTimeoutSeconds: 0,
      replyPollMs: 100,
    },
    {
      announceRetries: 2,
      announceRetryDelayMs: 5,
      logStdout: () => {},
      logStderr: (line) => stderrLines.push(line),
    },
  );

  await bridge.init();
  await bridge.pollInboundOnce();

  const calls = (await fs.readFile(logFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  assert.deepEqual(calls, [
    ['note', '--request-id', 'tg-200', '--json', '--', 'retry wake'],
    ['announce', '--json', 'note-200'],
    ['note', '--request-id', 'tg-201', '--json', '--', 'will fail'],
  ]);

  assert.equal(sentMessages.length, 1, 'should notify chat once for the exit-1 failure');
  assert.equal(sentMessages[0].chat_id, ALLOWED_CHAT_ID);
  assert.match(sentMessages[0].text, /Failed to deliver note to firstmate \(exit 1\)/);
  assert.ok(stderrLines.some((line) => line.includes('exit 1')));

  const savedState = await loadState(stateFile);
  assert.equal(savedState.offset, 202);
});

test('outbound reply polling delivers each new reply once and chunks long text cleanly', async (t) => {
  const tmpDir = await makeTempDir(t);
  const stateFile = path.join(tmpDir, '.telegram-bridge-state.json');

  const paragraphA = 'Alpha line '.repeat(220).trim(); // ~2420 chars
  const paragraphB = 'Beta line '.repeat(220).trim(); // ~2200 chars
  const longBody = `${paragraphA}\n${paragraphB}`;
  assert.ok(longBody.length > 4000);

  const receiptsPayload = {
    schema: 'fm-inbox-receipts.v1',
    home: 'test/firstmate',
    generated: '2026-11-27T13:30:00Z',
    pending: [],
    handled: [],
    replies: [
      { id: 'note-1', at: '2026-11-27T13:30:01Z', body: 'Short reply', cursor: '000000000001' },
      { id: 'note-2', at: '2026-11-27T13:30:02Z', body: longBody, cursor: '000000000002' },
    ],
    reply_cursor: '000000000002',
    omitted: [],
  };

  const { homeDir } = await createStubFirstmateHome(t, {
    scriptBody: `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'receipts' && args.includes('--all-replies')) {
  process.stdout.write(${JSON.stringify(JSON.stringify(receiptsPayload))} + '\\n');
  process.exit(0);
}
process.exit(1);
`,
  });

  const sentMessages = [];
  const { baseUrl } = await startMockTelegramServer(t, async (req) => {
    if (req.url === `/bot${TEST_TOKEN}/sendMessage`) {
      sentMessages.push(req.body);
      return { json: { ok: true, result: { message_id: sentMessages.length } } };
    }
    return { status: 404, json: { ok: false, description: 'not found' } };
  });

  const bridge = new TelegramBridge(
    {
      token: TEST_TOKEN,
      chatId: ALLOWED_CHAT_ID,
      firstmateHome: homeDir,
      stateFilePath: stateFile,
      apiBase: baseUrl,
      pollTimeoutSeconds: 0,
      replyPollMs: 100,
    },
    { logStdout: () => {}, logStderr: () => {} },
  );

  await bridge.init();
  const deliveredFirst = await bridge.pollOutboundOnce();
  assert.equal(deliveredFirst, 2);

  assert.equal(sentMessages.length, 3, 'short reply (1 chunk) + long reply (2 chunks)');
  assert.equal(sentMessages[0].chat_id, ALLOWED_CHAT_ID);
  assert.equal(sentMessages[0].text, 'Short reply');
  assert.equal(sentMessages[1].text, paragraphA);
  assert.equal(sentMessages[2].text, paragraphB);
  assert.ok(sentMessages.every((m) => m.text.length <= 4000));

  // Polling again must deliver 0 new replies
  const deliveredSecond = await bridge.pollOutboundOnce();
  assert.equal(deliveredSecond, 0);
  assert.equal(sentMessages.length, 3);

  // A restarted bridge loading the same state file must also not re-deliver
  const restartedBridge = new TelegramBridge(
    {
      token: TEST_TOKEN,
      chatId: ALLOWED_CHAT_ID,
      firstmateHome: homeDir,
      stateFilePath: stateFile,
      apiBase: baseUrl,
      pollTimeoutSeconds: 0,
      replyPollMs: 100,
    },
    { logStdout: () => {}, logStderr: () => {} },
  );
  await restartedBridge.init();
  assert.equal(await restartedBridge.pollOutboundOnce(), 0);
  assert.equal(sentMessages.length, 3);
});

test('chunkMessage splits at newlines, spaces, and hard boundaries without dropping content', () => {
  const nlChunks = chunkMessage('first line\nsecond line\nthird line', 20);
  assert.deepEqual(nlChunks, ['first line', 'second line', 'third line']);

  const spChunks = chunkMessage('alpha beta gamma delta', 12);
  assert.deepEqual(spChunks, ['alpha beta', 'gamma delta']);

  const hardChunks = chunkMessage('x'.repeat(25), 10);
  assert.deepEqual(hardChunks, ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
});

test('--send one-shot CLI mode sends direct text and stdin (-) without needing firstmate', async (t) => {
  const tmpDir = await makeTempDir(t);
  const envFile = path.join(tmpDir, '.env');
  await fs.writeFile(
    envFile,
    `CLANKER_UPDATES_TOKEN=${TEST_TOKEN}\nCLANKER_UPDATES_CHAT_ID=${ALLOWED_CHAT_ID}\n`,
    'utf8',
  );

  const sentMessages = [];
  const { baseUrl } = await startMockTelegramServer(t, async (req) => {
    if (req.url === `/bot${TEST_TOKEN}/sendMessage`) {
      sentMessages.push(req.body);
      return { json: { ok: true, result: { message_id: sentMessages.length } } };
    }
    return { status: 404, json: { ok: false, description: 'not found' } };
  });

  const directRes = await runNodeScript([
    '--env-file',
    envFile,
    '--api-base',
    baseUrl,
    '--send',
    'Alarm: worker wedged',
  ]);
  assert.equal(directRes.code, 0, directRes.stderr);

  const stdinRes = await runNodeScript(
    ['--env-file', envFile, '--api-base', baseUrl, '--send', '-'],
    { stdinText: 'Line one from stdin\nLine two from stdin' },
  );
  assert.equal(stdinRes.code, 0, stdinRes.stderr);

  assert.equal(sentMessages.length, 2);
  assert.deepEqual(sentMessages[0], { chat_id: ALLOWED_CHAT_ID, text: 'Alarm: worker wedged' });
  assert.deepEqual(sentMessages[1], {
    chat_id: ALLOWED_CHAT_ID,
    text: 'Line one from stdin\nLine two from stdin',
  });
});

test('bot token is always redacted from error messages and CLI stderr logs', async (t) => {
  const raw = `request to https://api.telegram.org/bot${TEST_TOKEN}/getUpdates failed with ${TEST_TOKEN}`;
  const redacted = redactSecrets(raw, TEST_TOKEN);
  assert.equal(redacted.includes(TEST_TOKEN), false);
  assert.ok(redacted.includes('/bot[REDACTED]/getUpdates'));
  assert.equal(redactSecrets('robot bottom', TEST_TOKEN), 'robot bottom');

  const failingClient = new TelegramClient({
    token: TEST_TOKEN,
    apiBase: 'https://api.telegram.org',
    fetchImpl: async (url) => {
      throw new Error(`connect ECONNREFUSED ${url}`);
    },
  });

  await assert.rejects(
    () => failingClient.sendMessage(ALLOWED_CHAT_ID, 'hello'),
    (err) => {
      assert.equal(err.message.includes(TEST_TOKEN), false, 'token must not appear in thrown error');
      assert.ok(err.message.includes('/bot[REDACTED]/sendMessage'));
      return true;
    },
  );

  // Also verify end-to-end CLI stderr redaction on HTTP 500 that echoes the token back
  const { baseUrl } = await startMockTelegramServer(t, async (req) => ({
    status: 500,
    json: { ok: false, description: `upstream failure for ${req.url} token=${TEST_TOKEN}` },
  }));

  const cliRes = await runNodeScript(['--api-base', baseUrl, '--send', 'test alert'], {
    env: {
      CLANKER_UPDATES_TOKEN: TEST_TOKEN,
      CLANKER_UPDATES_CHAT_ID: ALLOWED_CHAT_ID,
    },
  });
  assert.notEqual(cliRes.code, 0);
  assert.equal(cliRes.stderr.includes(TEST_TOKEN), false, 'token must never appear in stderr');
  assert.equal(cliRes.stdout.includes(TEST_TOKEN), false, 'token must never appear in stdout');
  assert.ok(cliRes.stderr.includes('[REDACTED]'));
});

test('bridge recovers from transient Telegram errors with backoff and shuts down cleanly on SIGTERM', async (t) => {
  const tmpDir = await makeTempDir(t);
  const stateFile = path.join(tmpDir, '.telegram-bridge-state.json');
  const logFile = path.join(tmpDir, 'notes.jsonl');

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
  });

  let getUpdatesCalls = 0;
  let resolveDelivered;
  const deliveredPromise = new Promise((resolve) => {
    resolveDelivered = resolve;
  });

  const { baseUrl } = await startMockTelegramServer(t, async (req) => {
    if (req.url === `/bot${TEST_TOKEN}/getUpdates`) {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return { status: 502, json: { ok: false, description: 'Bad Gateway' } };
      }
      if (getUpdatesCalls === 2) {
        return {
          json: {
            ok: true,
            result: [
              { update_id: 500, message: { chat: { id: Number(ALLOWED_CHAT_ID), type: 'private' }, text: '-' } },
            ],
          },
        };
      }
      resolveDelivered();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { json: { ok: true, result: [] } };
    }
    return { status: 404, json: { ok: false, description: 'not found' } };
  });

  const stderrLines = [];
  const bridge = new TelegramBridge(
    {
      token: TEST_TOKEN,
      chatId: ALLOWED_CHAT_ID,
      firstmateHome: homeDir,
      stateFilePath: stateFile,
      apiBase: baseUrl,
      pollTimeoutSeconds: 0,
      replyPollMs: 50,
    },
    {
      backoffInitialMs: 10,
      backoffMaxMs: 25,
      logStdout: () => {},
      logStderr: (line) => stderrLines.push(line),
    },
  );

  const runPromise = bridge.run();
  await deliveredPromise;
  bridge.stop();
  await runPromise;

  assert.ok(stderrLines.some((line) => line.includes('HTTP 502')));
  assert.ok(stderrLines.every((line) => !line.includes(TEST_TOKEN)));

  const calls = (await fs.readFile(logFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(calls, [['note', '--request-id', 'tg-500', '--json', '--', '-']]);

  // Verify real CLI process exits 0 cleanly on SIGTERM
  const child = spawn(
    process.execPath,
    [
      BRIDGE_SCRIPT,
      '--firstmate-home',
      homeDir,
      '--state-file',
      stateFile,
      '--api-base',
      baseUrl,
      '--poll-timeout',
      '0',
      '--reply-poll-ms',
      '100',
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CLANKER_UPDATES_TOKEN: TEST_TOKEN,
        CLANKER_UPDATES_CHAT_ID: ALLOWED_CHAT_ID,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('bridge did not start in time')), 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('started')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`bridge exited early with code ${code}`));
    });
  });

  child.kill('SIGTERM');
  const exitCode = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code));
  });
  assert.equal(exitCode, 0, 'bridge CLI must exit 0 on SIGTERM');
});

