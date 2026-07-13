'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const preload = path.resolve(__dirname, '../../scripts/log-level-preload.js');

test('DbGate preload suppresses info SQL logs at the warn default', () => {
  const script = [
    "const { getLogger } = require('dbgate-tools');",
    "const logger = getLogger('privacy-test');",
    "logger.info({ sql: 'privacy_probe_info' }, 'Processing query');",
    "logger.warn({ marker: 'privacy_probe_warn' }, 'Expected warning');",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--require', preload, '--eval', script], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      CONSOLE_LOG_LEVEL: 'warn',
      FILE_LOG_LEVEL: 'warn',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /privacy_probe_info/);
  assert.match(result.stdout, /privacy_probe_warn/);
});
