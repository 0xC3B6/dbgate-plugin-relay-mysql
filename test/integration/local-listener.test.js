'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('loopback preload rewrites server.listen(port, callback)', () => {
  const preload = path.resolve(__dirname, '../../scripts/loopback-preload.js');
  const probe = [
    "const http = require('node:http');",
    "const server = http.createServer((request, response) => response.end('ok'));",
    'server.listen(0, () => {',
    '  process.stdout.write(JSON.stringify(server.address()));',
    '  server.close();',
    '});',
  ].join('\n');

  const stdout = execFileSync(process.execPath, ['--require', preload, '--eval', probe], {
    encoding: 'utf8',
  });
  const address = JSON.parse(stdout);
  assert.equal(address.address, '127.0.0.1');
  assert.equal(address.family, 'IPv4');
});

