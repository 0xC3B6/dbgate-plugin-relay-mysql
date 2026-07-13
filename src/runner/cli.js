'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { BoundedBuffer, BufferLimitError } = require('./bounded-buffer');
const {
  DEFAULT_TIMEOUT_MS,
  EXIT_CODES,
  MAX_RESULT_BYTES,
  MAX_SQL_BYTES,
  MAX_TIMEOUT_MS,
  PROTOCOL_VERSION,
  SAFE_ERRORS,
} = require('./constants');
const { encodeFrames, encodeSqlChunks } = require('./frame-codec');
const { FrameExtractor } = require('./frame-extractor');
const { loadProfile } = require('./profile-store');
const { buildRemoteScript } = require('./remote-script');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function parseArgs(argv) {
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error('Invalid runner arguments');
    const key = flag.slice(2);
    if (!['protocol-version', 'request-id', 'profile', 'database', 'timeout-ms', 'profile-file'].includes(key) || Object.hasOwn(values, key)) {
      throw new Error('Invalid runner arguments');
    }
    values[key] = value;
  }

  if (values['protocol-version'] !== String(PROTOCOL_VERSION)) throw new Error('Unsupported protocol version');
  if (!UUID.test(values['request-id'] || '')) throw new Error('Invalid request ID');
  if (!PROFILE.test(values.profile || '')) throw new Error('Invalid profile name');
  if (values.database !== undefined && (values.database.length > 256 || /[\0\r\n]/.test(values.database))) {
    throw new Error('Invalid database');
  }
  const timeoutMs = Number(values['timeout-ms'] ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new Error('Invalid timeout');

  return {
    database: values.database || '',
    profile: values.profile,
    profileFile: values['profile-file'],
    requestId: values['request-id'],
    timeoutMs,
  };
}

function locateExpectScript() {
  const candidates = [
    path.resolve(__dirname, '../../runner/relay-mysql.exp'),
    path.resolve(__dirname, '../runner/relay-mysql.exp'),
    path.resolve(process.cwd(), 'runner/relay-mysql.exp'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('Expect adapter is unavailable');
  return found;
}

async function readStdin(stream = process.stdin) {
  const result = new BoundedBuffer(MAX_SQL_BYTES);
  for await (const chunk of stream) result.push(chunk);
  return result.toBuffer().toString('utf8');
}

function sanitizedEnvironment(profile, source = process.env) {
  const env = Object.create(null);
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM']) {
    if (typeof source[name] === 'string') env[name] = source[name];
  }
  return env;
}

function terminateProcessGroup(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch {}
  }
  const timer = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {
      try { child.kill('SIGKILL'); } catch {}
    }
  }, 250);
  timer.unref();
}

function installLifecycleGuard(child, onParentLoss) {
  const parentPid = process.ppid;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    onParentLoss();
  };
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  for (const signal of signals) process.once(signal, stop);
  process.once('disconnect', stop);
  const watchdog = setInterval(() => {
    if (process.ppid !== parentPid || process.ppid === 1) {
      stop();
      return;
    }
    try {
      process.kill(parentPid, 0);
    } catch {
      stop();
    }
  }, 250);
  watchdog.unref();

  return () => {
    clearInterval(watchdog);
    for (const signal of signals) process.removeListener(signal, stop);
    process.removeListener('disconnect', stop);
  };
}

function runExpect({ args, profile, sql, expectPath = '/usr/bin/expect', expectScript = locateExpectScript() }) {
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const startMarker = `__DBGATE_RUNNER_${nonce}_BEGIN__\n`;
    const endMarker = `__DBGATE_RELAY_MYSQL_${nonce}_XML_END__`;
    const extractor = new FrameExtractor({ startMarker, endMarker, maxBytes: MAX_RESULT_BYTES });
    const child = spawn(expectPath, ['-f', expectScript], {
      detached: true,
      env: sanitizedEnvironment(profile),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let forcedCategory = null;
    let settled = false;
    const removeLifecycleGuard = installLifecycleGuard(child, () => {
      forcedCategory = 'runner';
      terminateProcessGroup(child);
    });

    const timer = setTimeout(() => {
      forcedCategory = 'timeout';
      terminateProcessGroup(child);
    }, args.timeoutMs);
    timer.unref();

    child.stdout.on('data', (chunk) => {
      if (forcedCategory) return;
      try {
        extractor.push(chunk);
      } catch (error) {
        forcedCategory = error instanceof BufferLimitError ? 'result_too_large' : 'runner';
        terminateProcessGroup(child);
      }
    });
    child.stderr.resume();
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeLifecycleGuard();
      reject(Object.assign(new Error('runner'), { category: 'runner' }));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeLifecycleGuard();
      if (forcedCategory) {
        reject(Object.assign(new Error(forcedCategory), { category: forcedCategory }));
        return;
      }
      if (code !== 0) {
        const category = Object.keys(EXIT_CODES).find((key) => EXIT_CODES[key] === code && key !== 'result_too_large') || 'runner';
        reject(Object.assign(new Error(category), { category }));
        return;
      }
      try {
        resolve(extractor.result());
      } catch {
        reject(Object.assign(new Error('runner'), { category: 'runner' }));
      }
    });

    const frames = encodeFrames({
      protocolVersion: PROTOCOL_VERSION,
      nonce,
      relayCommand: profile.relayCommand,
      relayArgs: profile.relayArgs.join('\n'),
      relayPrompt: profile.relayPrompt,
      relayPasswordPrompt: profile.relayPasswordPrompt,
      relayPassword: profile.relayPassword,
      sshTarget: profile.sshTarget,
      sshPrompt: profile.sshPrompt,
      sshPasswordPrompt: profile.sshPasswordPrompt,
      sshPassword: profile.sshPassword,
      mysqlCommand: profile.mysqlCommand,
      mysqlHost: profile.mysqlHost,
      mysqlPort: profile.mysqlPort,
      mysqlUser: profile.mysqlUser,
      mysqlPassword: profile.mysqlPassword,
      database: args.database,
      sqlChunks: encodeSqlChunks(sql),
      remoteScript: buildRemoteScript(),
    });
    child.stdin.on('error', () => {});
    child.stdin.end(frames);
  });
}

function failure(category, requestId) {
  const safeCategory = Object.hasOwn(SAFE_ERRORS, category) ? category : 'runner';
  const [message, retryable] = SAFE_ERRORS[safeCategory];
  return {
    code: EXIT_CODES[safeCategory],
    payload: {
      version: PROTOCOL_VERSION,
      category: safeCategory,
      message,
      retryable,
      requestId: requestId || 'unknown',
    },
  };
}

async function main(argv = process.argv.slice(2), io = process) {
  let args;
  try {
    args = parseArgs(argv);
    const profile = loadProfile(args.profile, { filePath: args.profileFile, env: io.env || process.env });
    const sql = await readStdin(io.stdin);
    const xml = await runExpect({ args, profile, sql });
    io.stdout.write(xml);
    return 0;
  } catch (error) {
    const result = failure(error.category || 'runner', args?.requestId);
    io.stderr.write(`${JSON.stringify(result.payload)}\n`);
    return result.code;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = {
  failure,
  installLifecycleGuard,
  locateExpectScript,
  main,
  parseArgs,
  readStdin,
  runExpect,
  sanitizedEnvironment,
  terminateProcessGroup,
};
