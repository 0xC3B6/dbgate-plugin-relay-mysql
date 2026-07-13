'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PersistentSession } = require('../../src/broker/persistent-session');
const { loadProfile } = require('../../src/runner/profile-store');

const root = path.resolve(__dirname, '../..');
const fakeBin = path.join(root, 'test/fixtures/fake-bin');

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-persistent-'));
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
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    HOME: directory,
    TEST_MYSQL_USER: 'reader',
    TEST_MYSQL_PASSWORD: 'test-only-password',
  };
  return { directory, env, profile: loadProfile('fake', { filePath: profileFile, env }) };
}

test('persistent session reuses one Relay and SSH login for sequential queries', async t => {
  const fixture = setup();
  const session = new PersistentSession(fixture.profile, { sourceEnvironment: fixture.env });
  t.after(() => {
    session.destroy();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  });

  const first = await session.execute({
    requestId: 'query-one', database: 'sample_db', sql: 'SELECT 1', timeoutMs: 5_000,
  });
  await assert.rejects(
    session.execute({
      requestId: 'query-error', database: 'sample_db', sql: 'SELECT SQL_FAILURE', timeoutMs: 5_000,
    }),
    error => error.category === 'sql_error'
  );
  const second = await session.execute({
    requestId: 'query-two', database: 'sample_db', sql: 'SELECT 2', timeoutMs: 5_000,
  });

  assert.match(first.toString(), /<field name="answer">1<\/field>/);
  assert.match(second.toString(), /<field name="answer">1<\/field>/);
  const starts = fs.readFileSync(path.join(fixture.directory, 'relay-starts.txt'), 'utf8').trim().split('\n');
  assert.equal(starts.length, 1);
  assert.equal(fs.readFileSync(path.join(fixture.directory, 'mysql-sql.txt'), 'utf8'), 'SELECT 2');
});
