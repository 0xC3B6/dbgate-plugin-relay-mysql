'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createBrokerServer } = require('../../src/broker/server');
const { BrokerClient } = require('../../src/backend/broker-client');

const root = path.resolve(__dirname, '../..');
const fakeBin = path.join(root, 'test/fixtures/fake-bin');

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-broker-'));
  fs.chmodSync(directory, 0o700);
  const profileFile = path.join(directory, 'profiles.json');
  fs.writeFileSync(profileFile, JSON.stringify({
    version: 1,
    profiles: {
      fake: {
        relayCommand: path.join(fakeBin, 'relay-cli'),
        relayArgs: [],
        relayPrompt: 'FAKE_RELAY> $',
        sshTarget: 'reader@example.invalid',
        sshPrompt: 'FAKE_SSH> $',
        mysqlCommand: 'mysql',
        mysqlHost: '127.0.0.1',
        mysqlPort: 3306,
        mysqlUserEnv: 'TEST_MYSQL_USER',
        mysqlPasswordEnv: 'TEST_MYSQL_PASSWORD',
      },
    },
  }), { mode: 0o600 });
  fs.chmodSync(profileFile, 0o600);
  return {
    directory,
    profileFile,
    socketPath: path.join(directory, 'broker.sock'),
    environment: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      HOME: directory,
      TEST_MYSQL_USER: 'reader',
      TEST_MYSQL_PASSWORD: 'test-only-password',
    },
  };
}

test('Unix-socket broker reuses one persistent session across separate clients', async t => {
  const fixture = setup();
  const server = createBrokerServer({ socketPath: fixture.socketPath, environment: fixture.environment });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(fixture.socketPath, resolve);
  });
  t.after(async () => {
    await new Promise(resolve => server.shutdown(resolve));
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  });

  const firstClient = new BrokerClient({ socketPath: fixture.socketPath, autoStart: false });
  const secondClient = new BrokerClient({ socketPath: fixture.socketPath, autoStart: false });
  const base = {
    relayProfile: 'fake', profileFile: fixture.profileFile, database: 'sample_db', timeoutMs: 5_000,
  };
  const [first, second] = await Promise.all([
    firstClient.run({ ...base, requestId: 'request-one', sql: 'SELECT 1' }),
    secondClient.run({ ...base, requestId: 'request-two', sql: 'SELECT 2' }),
  ]);

  assert.equal(first.persistent, true);
  assert.equal(second.persistent, true);
  assert.match(first.stdout.toString(), /<resultset/);
  const starts = fs.readFileSync(path.join(fixture.directory, 'relay-starts.txt'), 'utf8').trim().split('\n');
  assert.equal(starts.length, 1);
});
