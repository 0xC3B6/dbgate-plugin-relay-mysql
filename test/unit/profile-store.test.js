'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadProfile } = require('../../src/runner/profile-store');

function writeProfile(mode = 0o600, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-profile-'));
  const filePath = path.join(directory, 'profiles.json');
  const profile = {
    relayCommand: '/safe/relay-cli',
    relayArgs: ['login'],
    relayPrompt: 'RELAY> $',
    sshTarget: 'reader@example.invalid',
    sshPrompt: 'REMOTE> $',
    mysqlCommand: 'mysql',
    mysqlHost: '127.0.0.1',
    mysqlPort: 3306,
    mysqlUserEnv: 'TEST_MYSQL_USER',
    mysqlPasswordEnv: 'TEST_MYSQL_PASSWORD',
    ...overrides,
  };
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, profiles: { example: profile } }), { mode });
  fs.chmodSync(filePath, mode);
  return filePath;
}

const secretEnv = { TEST_MYSQL_USER: 'reader', TEST_MYSQL_PASSWORD: 'test-only-password' };

test('profile resolves secret environment names from a 0600 file', () => {
  const profile = loadProfile('example', { filePath: writeProfile(), env: secretEnv });
  assert.equal(profile.mysqlUser, 'reader');
  assert.equal(profile.mysqlPassword, 'test-only-password');
});

test('profile rejects group-readable files', () => {
  assert.throws(() => loadProfile('example', { filePath: writeProfile(0o640), env: secretEnv }), /0600/);
});

test('profile rejects inline passwords', () => {
  const filePath = writeProfile(0o600, { mysqlPassword: 'must-not-be-here' });
  assert.throws(() => loadProfile('example', { filePath, env: secretEnv }), /inline secret/);
});

test('profile rejects missing secret environment values without echoing their names', () => {
  const filePath = writeProfile();
  assert.throws(() => loadProfile('example', { filePath, env: {} }), (error) => {
    assert.match(error.message, /unavailable/);
    assert.doesNotMatch(error.message, /TEST_MYSQL_PASSWORD/);
    return true;
  });
});

test('profile rejects terminal-control newlines in environment values without echoing them', () => {
  const filePath = writeProfile();
  const env = { ...secretEnv, TEST_MYSQL_PASSWORD: 'first-line\r\nsecond-line' };
  assert.throws(() => loadProfile('example', { filePath, env }), (error) => {
    assert.match(error.message, /unavailable/);
    assert.doesNotMatch(error.message, /TEST_MYSQL_PASSWORD|first-line|second-line/);
    return true;
  });
});
