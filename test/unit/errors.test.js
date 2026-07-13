'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { RelayMysqlError } = require('../../src/backend/errors');

test('includes a safe query ID in the DbGate-visible error message', () => {
  const error = new RelayMysqlError('timeout', 'Relay query timed out', {
    queryId: 'request-fixture:42',
  });

  assert.equal(error.queryId, 'request-fixture:42');
  assert.equal(error.message, 'Relay query timed out (query ID: request-fixture:42)');
});

test('does not interpolate an unsafe query ID into the error message', () => {
  const error = new RelayMysqlError('runner', 'Relay query failed', {
    queryId: 'request-fixture\nforged log line',
  });

  assert.equal(error.queryId, 'request-fixture\nforged log line');
  assert.equal(error.message, 'Relay query failed');
});
