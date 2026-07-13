'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { parseArgs, runSmoke } = require('../../scripts/smoke-relay');

test('smoke CLI requires a bounded profile and timeout', () => {
  assert.deepEqual(parseArgs(['--profile', 'fixture', '--timeout-ms', '1234']), {
    profile: 'fixture',
    profileFile: null,
    runner: null,
    timeoutMs: 1234,
  });
  assert.throws(() => parseArgs([]), /invalid_profile/);
  assert.throws(() => parseArgs(['--profile', '../unsafe']), /invalid_profile/);
  assert.throws(() => parseArgs(['--profile', 'fixture', '--timeout-ms', '10']), /invalid_timeout/);
});

test('smoke query works with the synthetic runner and returns only summary metadata', async () => {
  const result = await runSmoke({
    profile: 'fixture',
    profileFile: null,
    runner: path.resolve(__dirname, '../fixtures/fake-runner.js'),
    timeoutMs: 5_000,
  });

  assert.equal(typeof result.durationMs, 'number');
  assert.match(result.queryId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(Object.keys(result).sort(), ['durationMs', 'queryId']);
});
