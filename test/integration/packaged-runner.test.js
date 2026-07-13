'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('packaged runner starts exactly once', () => {
  const executable = path.resolve(__dirname, '../../bin/relay-mysql-runner.js');
  const result = spawnSync(process.execPath, [executable, '--protocol-version', '1'], {
    encoding: 'utf8',
    input: '',
  });

  assert.equal(result.status, 15);
  assert.equal(result.stdout, '');
  const lines = result.stderr.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    version: 1,
    category: 'runner',
    message: 'The relay runner failed.',
    retryable: false,
    requestId: 'unknown',
  });
});
