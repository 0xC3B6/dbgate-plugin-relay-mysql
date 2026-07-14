'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('manifest declares an external DbGate plugin with bundled entry points', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'dbgate-plugin-relay-mysql');
  assert.equal(manifest.main, 'dist/backend.js');
  assert.equal(manifest.license, 'GPL-3.0-only');
  assert.ok(manifest.keywords.includes('dbgateplugin'));
  assert.deepEqual(manifest.files, [
    'dist',
    'bin',
    'runner',
    'config/profile.example.json',
    'scripts/smoke-relay.js',
    'src',
    'README.md',
    'README.zh-CN.md',
    'LICENSE',
    'icon.svg',
  ]);
  assert.equal(fs.existsSync(path.join(root, 'README.zh-CN.md')), true);
});

test('source and build configuration expose frontend, backend, and runner entries', () => {
  for (const file of [
    'src/frontend/index.js',
    'src/backend/index.js',
    'src/runner/cli.js',
    'webpack-frontend.config.js',
    'webpack-backend.config.js',
  ]) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} must exist`);
  }

  const webpackConfig = require('../../webpack-backend.config');
  assert.deepEqual(Object.keys(webpackConfig.entry).sort(), ['backend', 'broker', 'runner']);
});
