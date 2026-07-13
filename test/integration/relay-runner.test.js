'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const cli = path.join(root, 'src/runner/cli.js');
const fakeBin = path.join(root, 'test/fixtures/fake-bin');
const requestId = '123e4567-e89b-42d3-a456-426614174000';

function setup(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-runner-'));
  const profileFile = path.join(directory, 'profiles.json');
  const auditFile = path.join(directory, 'mysql-audit.txt');
  const sqlFile = path.join(directory, 'mysql-sql.txt');
  const document = {
    version: 1,
    profiles: {
      fake: {
        relayCommand: path.join(fakeBin, 'relay-cli'),
        relayArgs: options.relayMode ? [options.relayMode] : [],
        relayPrompt: 'FAKE_RELAY> $',
        sshTarget: options.sshTarget || 'reader@example.invalid',
        sshPrompt: 'FAKE_SSH> $',
        mysqlCommand: 'mysql',
        mysqlHost: '127.0.0.1',
        mysqlPort: 3306,
        mysqlUserEnv: 'TEST_MYSQL_USER',
        mysqlPasswordEnv: 'TEST_MYSQL_PASSWORD',
      },
    },
  };
  fs.writeFileSync(profileFile, JSON.stringify(document), { mode: 0o600 });
  fs.chmodSync(profileFile, 0o600);
  return { auditFile, directory, profileFile, sqlFile };
}

function invoke(options = {}) {
  const fixture = setup(options);
  const timeoutMs = options.timeoutMs ?? 3_000;
  const args = [
    cli,
    '--protocol-version', '1',
    '--request-id', requestId,
    '--profile', 'fake',
    '--database', 'sample_db',
    '--timeout-ms', String(timeoutMs),
    '--profile-file', fixture.profileFile,
  ];
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    HOME: fixture.directory,
    LEAK_SENTINEL: 'must-not-reach-expect',
    TEST_MYSQL_USER: 'reader',
    TEST_MYSQL_PASSWORD: 'test-only-password',
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('close', (code, signal) => resolve({
      ...fixture,
      code,
      signal,
      stderr: Buffer.concat(stderr).toString(),
      stdout: Buffer.concat(stdout),
    }));
    if (options.signalWhenFile) {
      const signalPath = path.join(fixture.directory, options.signalWhenFile);
      const deadline = Date.now() + 2_000;
      const poll = () => {
        if (fs.existsSync(signalPath) || Date.now() >= deadline) {
          child.kill(options.signal || 'SIGTERM');
          return;
        }
        setTimeout(poll, 10);
      };
      poll();
    } else if (options.signalAfterMs) {
      setTimeout(() => child.kill(options.signal || 'SIGTERM'), options.signalAfterMs);
    }
    child.stdin.end(options.sql ?? "SELECT '$HOME', 'test-only-password'");
  });
}

test('real expect runs fake relay, ssh, and mysql while stdout stays XML-only', async () => {
  const result = await invoke();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout.toString(), /^<\?xml version="1\.0"\?>/);
  assert.match(result.stdout.toString(), /<field name="answer">1<\/field>/);
  assert.doesNotMatch(result.stdout.toString(), /FAKE_|test-only-password|ssh --|printf/);

  const audit = fs.readFileSync(result.auditFile, 'utf8');
  assert.match(audit, /arg=--xml/);
  assert.match(audit, /arg=--quick/);
  assert.match(audit, /arg=--binary-mode/);
  assert.match(audit, /arg=--init-command=SET SESSION TRANSACTION READ ONLY/);
  assert.match(audit, /password_env=present/);
  assert.match(audit, /leak=absent/);
  assert.doesNotMatch(audit, /test-only-password|SELECT|\$HOME/);
  assert.equal(fs.readFileSync(result.sqlFile, 'utf8'), "SELECT '$HOME', 'test-only-password'");
});

test('multi-chunk SQL crosses the PTY unchanged', async () => {
  const sql = `SELECT '${'你好-$HOME-'.repeat(2_000)}'`;
  const result = await invoke({ sql, timeoutMs: 5_000 });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(result.sqlFile, 'utf8'), sql);
});

for (const [mode, category, code, sql] of [
  ['connection', 'mysql_connection', 12, 'SELECT CONNECTION_FAILURE'],
  ['sql', 'sql_error', 13, 'SELECT SQL_FAILURE'],
]) {
  test(`mysql ${mode} failure is one safe JSON object with empty stdout`, async () => {
    const result = await invoke({ sql });
    assert.equal(result.code, code);
    assert.equal(result.stdout.length, 0);
    const payload = JSON.parse(result.stderr);
    assert.deepEqual(Object.keys(payload), ['version', 'category', 'message', 'retryable', 'requestId']);
    assert.equal(payload.category, category);
    assert.equal(payload.requestId, requestId);
    assert.doesNotMatch(result.stderr, /test-only-password|SELECT|FAKE_/);
  });
}

test('relay login failure maps to exit 10 without transcript forwarding', async () => {
  const result = await invoke({ relayMode: 'fail' });
  assert.equal(result.code, 10);
  assert.equal(result.stdout.length, 0);
  assert.equal(JSON.parse(result.stderr).category, 'relay_login');
  assert.doesNotMatch(result.stderr, /authentication failed/);
});

test('ssh failure maps to exit 11 without transcript forwarding', async () => {
  const result = await invoke({ sshTarget: 'fail@example.invalid' });
  assert.equal(result.code, 11);
  assert.equal(result.stdout.length, 0);
  assert.equal(JSON.parse(result.stderr).category, 'ssh');
  assert.doesNotMatch(result.stderr, /Permission denied/);
});

test('deadline kills the relay process group and emits timeout JSON', async () => {
  const started = Date.now();
  const result = await invoke({ relayMode: 'hang', timeoutMs: 250 });
  assert.equal(result.code, 14);
  assert.ok(Date.now() - started < 2_500);
  assert.equal(result.stdout.length, 0);
  assert.equal(JSON.parse(result.stderr).category, 'timeout');
});

test('SIGTERM to the Node runner terminates the detached expect and relay process group', async () => {
  const result = await invoke({ relayMode: 'hang', timeoutMs: 5_000, signalWhenFile: 'relay.pid' });
  assert.equal(result.code, 15);
  assert.equal(result.stdout.length, 0);
  assert.equal(JSON.parse(result.stderr).category, 'runner');

  const relayPid = Number(fs.readFileSync(path.join(result.directory, 'relay.pid'), 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(relayPid, 0), /ESRCH/);
});
