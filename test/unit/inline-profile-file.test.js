'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { loadProfile } = require('../../src/runner/profile-store');
const {
  INLINE_PROFILE_NAME,
  createInlineProfileFile,
} = require('../../src/backend/inline-profile-file');

function inlineConnection(overrides = {}) {
  return {
    relayCommand: '/safe/relay-cli',
    relayArgs: ['login', '-u', 'relay-reader'],
    relayPrompt: 'RELAY> $',
    relayPasswordPrompt: '(?i)password:',
    relayPasswordEnv: 'TEST_RELAY_PASSWORD',
    sshTarget: 'reader@example.invalid',
    sshPrompt: 'REMOTE> $',
    sshPasswordPrompt: '(?i)password:',
    sshPasswordEnv: 'TEST_SSH_PASSWORD',
    mysqlCommand: 'mysql',
    mysqlHost: '127.0.0.1',
    mysqlPort: 3306,
    mysqlUserEnv: 'TEST_MYSQL_USER',
    mysqlPasswordEnv: 'TEST_MYSQL_PASSWORD',
    ...overrides,
  };
}

test('inline connection becomes a private runner-compatible profile without secret values', () => {
  const created = createInlineProfileFile(inlineConnection());
  try {
    const stat = fs.lstatSync(created.filePath);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(created.profileName, INLINE_PROFILE_NAME);

    const raw = fs.readFileSync(created.filePath, 'utf8');
    assert.doesNotMatch(raw, /relay-test-password|ssh-test-password|mysql-test-password/);
    assert.match(raw, /TEST_MYSQL_PASSWORD/);

    const runtime = loadProfile(created.profileName, {
      filePath: created.filePath,
      env: {
        TEST_RELAY_PASSWORD: 'relay-test-password',
        TEST_SSH_PASSWORD: 'ssh-test-password',
        TEST_MYSQL_USER: 'reader',
        TEST_MYSQL_PASSWORD: 'mysql-test-password',
      },
    });
    assert.equal(runtime.mysqlUser, 'reader');
    assert.equal(runtime.mysqlPassword, 'mysql-test-password');
  } finally {
    created.cleanup();
  }
  assert.equal(fs.existsSync(created.filePath), false);
  assert.doesNotThrow(() => created.cleanup());
});

test('inline profile creation rejects secret-shaped connection properties', () => {
  assert.throws(
    () => createInlineProfileFile(inlineConnection({ mysqlPassword: 'must-not-be-stored' })),
    /inline secret/
  );
});
