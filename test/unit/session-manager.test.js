'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DEFAULT_SESSION_IDLE_TTL_MS } = require('../../src/broker/session-manager');

test('persistent Relay sessions use a one-hour idle TTL', () => {
  assert.equal(DEFAULT_SESSION_IDLE_TTL_MS, 60 * 60 * 1000);
});
