'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { BrokerClient } = require('../../src/backend/broker-client');

const root = path.resolve(__dirname, '../..');
const fakeBin = path.join(root, 'test/fixtures/fake-bin');

test('packaged broker serves one persistent query session', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-packaged-broker-'));
  fs.chmodSync(directory, 0o700);
  const socketPath = path.join(directory, 'broker.sock');
  const profileFile = path.join(directory, 'profiles.json');
  fs.writeFileSync(profileFile, JSON.stringify({
    version: 1,
    profiles: {
      fake: {
        relayCommand: path.join(fakeBin, 'relay-cli'), relayArgs: [], relayPrompt: 'FAKE_RELAY> $',
        sshTarget: 'reader@example.invalid', sshPrompt: 'FAKE_SSH> $', mysqlCommand: 'mysql',
        mysqlHost: '127.0.0.1', mysqlPort: 3306,
        mysqlUserEnv: 'TEST_MYSQL_USER', mysqlPasswordEnv: 'TEST_MYSQL_PASSWORD',
      },
    },
  }), { mode: 0o600 });
  fs.chmodSync(profileFile, 0o600);
  const environment = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    HOME: directory,
    TEST_MYSQL_USER: 'reader',
    TEST_MYSQL_PASSWORD: 'test-only-password',
  };
  const child = spawn(process.execPath, [path.join(root, 'dist/broker.js'), '--socket', socketPath], {
    env: environment,
    stdio: 'ignore',
  });
  child.on('error', () => {});
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(socketPath) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(fs.existsSync(socketPath), true);

  const client = new BrokerClient({ socketPath, autoStart: false });
  const result = await client.run({
    requestId: 'packaged-request', relayProfile: 'fake', profileFile,
    database: 'sample_db', timeoutMs: 5_000, sql: 'SELECT 1',
  });
  assert.match(result.stdout.toString(), /<resultset/);
});

test('concurrent clients auto-start only one packaged broker', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-auto-broker-'));
  fs.chmodSync(directory, 0o700);
  const socketPath = path.join(directory, 'broker.sock');
  const profileFile = path.join(directory, 'profiles.json');
  fs.writeFileSync(profileFile, JSON.stringify({
    version: 1,
    profiles: {
      fake: {
        relayCommand: path.join(fakeBin, 'relay-cli'), relayArgs: [], relayPrompt: 'FAKE_RELAY> $',
        sshTarget: 'reader@example.invalid', sshPrompt: 'FAKE_SSH> $', mysqlCommand: 'mysql',
        mysqlHost: '127.0.0.1', mysqlPort: 3306,
        mysqlUserEnv: 'TEST_MYSQL_USER', mysqlPasswordEnv: 'TEST_MYSQL_PASSWORD',
      },
    },
  }), { mode: 0o600 });
  fs.chmodSync(profileFile, 0o600);
  const environment = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    HOME: directory,
    TEST_MYSQL_USER: 'reader',
    TEST_MYSQL_PASSWORD: 'test-only-password',
  };
  const children = [];
  const captureSpawn = (...args) => {
    const child = spawn(...args);
    children.push(child);
    return child;
  };
  t.after(async () => {
    for (const child of children) child.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 250));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const brokerPath = path.join(root, 'dist/broker.js');
  const firstClient = new BrokerClient({ socketPath, brokerPath, environment, spawn: captureSpawn });
  const secondClient = new BrokerClient({ socketPath, brokerPath, environment, spawn: captureSpawn });
  const base = { relayProfile: 'fake', profileFile, database: 'sample_db', timeoutMs: 5_000 };
  const [first, second] = await Promise.all([
    firstClient.run({ ...base, requestId: 'auto-one', sql: 'SELECT 1' }),
    secondClient.run({ ...base, requestId: 'auto-two', sql: 'SELECT 2' }),
  ]);

  assert.equal(children.length, 1);
  assert.equal(first.persistent, true);
  assert.equal(second.persistent, true);
  const starts = fs.readFileSync(path.join(directory, 'relay-starts.txt'), 'utf8').trim().split('\n');
  assert.equal(starts.length, 1);
});
